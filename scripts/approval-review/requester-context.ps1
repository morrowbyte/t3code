param(
    [Parameter(Mandatory)][ValidateSet('install','verify','rollback')][string]$Action,
    [string]$NodeSource,
    [string]$CodexSource,
    [string]$RequesterSource = (Join-Path $PSScriptRoot 'request.mjs'),
    [string]$RequestTokenSource,
    [string]$ForbiddenPathsFile
)
$ErrorActionPreference = 'Stop'
$Name = 'T3ApprovalRequester'
$Root = 'C:\ProgramData\T3ApprovalRequester'
$Marker = Join-Path $Root 'owner.json'
$Admin = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if ($Action -eq 'verify') {
    $Owner = Get-Content -LiteralPath $Marker -Raw | ConvertFrom-Json
    $Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if ($Identity.User.Value -ne $Owner.sid -or $Admin.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run verify personally inside the new non-elevated account.'
    }
    $Groups = @($Identity.Groups | ForEach-Object Value)
    if ($Groups -contains 'S-1-5-32-544') { throw 'Administrator membership remains outside this standard context.' }
    $SandboxGroup = Get-LocalGroup -Name CodexSandboxUsers -ErrorAction SilentlyContinue
    if ($SandboxGroup -and $Groups -contains $SandboxGroup.SID.Value) { throw 'Unexpected sandbox group membership.' }
    $Paths = @(Get-Content -LiteralPath $ForbiddenPathsFile -Raw | ConvertFrom-Json)
    if ($Paths.Count -lt 6) { throw 'Supply the inventoried six credential paths, plus any additional management paths.' }
    $Rows = foreach ($Path in $Paths) {
        $Readable = $false
        $Failure = $null
        try {
            $Stream = [IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite,Delete')
            $Stream.Dispose()
            $Readable = $true
        } catch { $Failure = $_.Exception.GetBaseException().GetType().Name }
        @{path=$Path;readable=$Readable;error=$Failure}
    }
    $Report = @{sid=$Identity.User.Value;groups=$Groups;at=[DateTime]::UtcNow.ToString('o');readability=@($Rows)}
    $Report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $Root 'workspace\context-check.json')
    if (@($Rows | Where-Object readable).Count) { throw 'Credential isolation gate remains open.' }
    if (@($Rows | Where-Object {$_.error -notmatch 'UnauthorizedAccessException'}).Count) {
        throw 'Missing paths or other errors do not prove access denial.'
    }
    Write-Output 'Specified credential opens denied; server-mediated rights and the actual provider token still require review.'
    return
}
if (-not $Admin.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Owner must run this explicit account step in an elevated PowerShell; no elevation is attempted.'
}
if ($Action -eq 'install') {
    if ((Test-Path -LiteralPath $Root) -or (Get-LocalUser -Name $Name -ErrorAction SilentlyContinue)) {
        throw 'Refusing existing account or directory.'
    }
    foreach ($Path in @($NodeSource,$CodexSource,$RequesterSource,$RequestTokenSource)) {
        if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'Explicit standalone public runtimes and request-only token file required.' }
    }
    # Password is entered only by the owner in this local elevated console.
    $Password = Read-Host 'New standard requester account password' -AsSecureString
    New-Item -ItemType Directory -Path $Root | Out-Null
    $Acl = [Security.AccessControl.DirectorySecurity]::new()
    $Acl.SetAccessRuleProtection($true,$false)
    foreach ($Sid in @('S-1-5-18','S-1-5-32-544')) {
        $Acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($Sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
    }
    Set-Acl -LiteralPath $Root -AclObject $Acl
    $Progress = @{sid=$null;name=$Name;root=$Root;state='root_prepared';createdAt=[DateTime]::UtcNow.ToString('o')}
    $Progress | ConvertTo-Json | Set-Content -LiteralPath $Marker
    $User = New-LocalUser -Name $Name -Password $Password -Description 'Isolated approval requester; no management or SSH credentials'
    try {
        $Progress.sid=$User.SID.Value
        $Progress.state='account_created'
        $TemporaryMarker=Join-Path $Root ('.owner-'+[guid]::NewGuid()+'.tmp')
        $Progress | ConvertTo-Json | Set-Content -LiteralPath $TemporaryMarker
        [IO.File]::Move($TemporaryMarker,$Marker,$true)
    } catch {
        # This SID was returned by this invocation; never infer ownership from the name.
        Disable-LocalUser -SID $User.SID
        $Sessions=@(Get-CimInstance Win32_LogonSession | ForEach-Object { Get-CimAssociatedInstance -InputObject $_ -Association Win32_LoggedOnUser -ErrorAction Stop } | Where-Object SID -eq $User.SID.Value)
        if(-not $Sessions.Count){Remove-LocalUser -SID $User.SID}
        throw
    }
    Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $User
    $Acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($User.SID,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'))
    Set-Acl -LiteralPath $Root -AclObject $Acl
    New-Item -ItemType Directory -Path (Join-Path $Root 'runtime'),(Join-Path $Root 'workspace') | Out-Null
    Copy-Item -LiteralPath $NodeSource -Destination (Join-Path $Root 'runtime\node.exe')
    Copy-Item -LiteralPath $CodexSource -Destination (Join-Path $Root 'runtime\codex.exe')
    Copy-Item -LiteralPath $RequesterSource -Destination (Join-Path $Root 'runtime\request.mjs')
    Copy-Item -LiteralPath $RequestTokenSource -Destination (Join-Path $Root 'requester.token')
    Copy-Item -LiteralPath $PSCommandPath -Destination (Join-Path $Root 'requester-context.ps1')
    $Workspace = Join-Path $Root 'workspace'
    $WorkspaceAcl = Get-Acl -LiteralPath $Workspace
    $WorkspaceAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($User.SID,'Modify','ContainerInherit,ObjectInherit','None','Allow'))
    Set-Acl -LiteralPath $Workspace -AclObject $WorkspaceAcl
    $Progress.state='prepared'
    $TemporaryMarker=Join-Path $Root ('.owner-'+[guid]::NewGuid()+'.tmp')
    $Progress | ConvertTo-Json | Set-Content -LiteralPath $TemporaryMarker
    [IO.File]::Move($TemporaryMarker,$Marker,$true)
    Write-Output 'Prepared standard account. Owner must sign in personally, verify denied credential reads, and log in to Codex in the new profile.'
    return
}
$Owner = Get-Content -LiteralPath $Marker -Raw | ConvertFrom-Json
$User = Get-LocalUser -Name $Name -ErrorAction SilentlyContinue
if(-not $Owner.sid -and -not $User -and $Owner.root -eq $Root -and $Owner.name -eq $Name){
    Write-Output 'Only the prepared protected root remains; no owned account exists. Files retained for deliberate cleanup.'
    return
}
if ($User.SID.Value -ne $Owner.sid -or $Owner.root -ne $Root) { throw 'Account/root identity mismatch.' }
$Sessions = @(Get-CimInstance Win32_LogonSession | ForEach-Object { Get-CimAssociatedInstance -InputObject $_ -Association Win32_LoggedOnUser -ErrorAction SilentlyContinue } | Where-Object SID -eq $Owner.sid)
if ($Sessions.Count) { throw 'Sign out of all requester sessions before rollback.' }
Remove-LocalUser -SID $User.SID
Write-Output 'Only the owned account was removed. Protected runtime, workspace, receipts and the separate user profile are retained for deliberate cleanup.'
