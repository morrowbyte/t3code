param([Parameter(Mandatory)][string]$OutputDirectory, [Parameter(Mandatory)][string[]]$CredentialPaths, [int[]]$ProcessIds = @())
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
if (Test-Path (Join-Path $OutputDirectory 'dacl-original.json')) { throw 'Refusing to replace original DACL backup.' }
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
public static class ApprovalTokenAudit {
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, int size, out int needed);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool DuplicateToken(IntPtr existing, int level, out IntPtr duplicate);
    static int Info(IntPtr token, int kind) {
        int needed;
        GetTokenInformation(token, kind, IntPtr.Zero, 0, out needed);
        IntPtr data = Marshal.AllocHGlobal(needed);
        try {
            if (!GetTokenInformation(token, kind, data, needed, out needed)) throw new System.ComponentModel.Win32Exception();
            // TokenHasRestrictions is BOOLEAN, the other queried fields start with DWORD.
            return kind == 21 ? Marshal.ReadByte(data) : Marshal.ReadInt32(data);
        } finally { Marshal.FreeHGlobal(data); }
    }
    public static object Inspect(int pid, string[] paths) {
        IntPtr process = OpenProcess(0x1000, false, pid), token = IntPtr.Zero, duplicate = IntPtr.Zero;
        try {
            if (process == IntPtr.Zero || !OpenProcessToken(process, 0x000A, out token)) throw new System.ComponentModel.Win32Exception();
            string sid = new WindowsIdentity(token).User.Value;
            int restrictedSidCount = Info(token, 11), hasRestrictions = Info(token, 21), appContainer = Info(token, 29);
            if (!DuplicateToken(token, 2, out duplicate)) throw new System.ComponentModel.Win32Exception();
            var readability = new System.Collections.Generic.List<object>();
            using (var safe = new SafeAccessTokenHandle(duplicate)) {
                duplicate = IntPtr.Zero;
                WindowsIdentity.RunImpersonated(safe, () => {
                    foreach (var path in paths) {
                        bool readable = false;
                        string error = null;
                        try { using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) { readable = true; } }
                        catch (Exception exception) { error = exception.GetType().Name; }
                        readability.Add(new { path, readable, error });
                    }
                });
            }
            return new { pid, sid, restrictedSidCount, hasRestrictions, appContainer, readability };
        } finally {
            if (duplicate != IntPtr.Zero) CloseHandle(duplicate);
            if (token != IntPtr.Zero) CloseHandle(token);
            if (process != IntPtr.Zero) CloseHandle(process);
        }
    }
}
'@
$Original = @()
foreach ($Path in $CredentialPaths) {
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        $Acl = Get-Acl -LiteralPath $Path
        $Original += @{path=$Path;sddl=$Acl.Sddl;owner=$Acl.Owner;access=@($Acl.Access|ForEach-Object{@{identity=$_.IdentityReference.Value;rights=[int]$_.FileSystemRights;type=$_.AccessControlType.ToString();inherited=$_.IsInherited}})}
    }
}
# SDDL is metadata, but this rollback material remains private and outside Git.
$Original | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 -LiteralPath (Join-Path $OutputDirectory 'dacl-original.json')
$Rows = @()
foreach ($ProcessId in (@($PID)+$ProcessIds | Select-Object -Unique)) {
    try { $Rows += [ApprovalTokenAudit]::Inspect($ProcessId, $CredentialPaths) }
    catch { $Rows += @{pid=$ProcessId;error=$_.Exception.GetType().Name} }
}
$Rows | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 -LiteralPath (Join-Path $OutputDirectory 'token-readability.json')
@{capturedAt=[DateTime]::UtcNow.ToString('o');processCount=$Rows.Count;credentialCount=$Original.Count;outputDirectory=$OutputDirectory} | ConvertTo-Json -Compress
