param(
    [Parameter(Mandatory)][ValidateSet('install','start','status','stop','restart','rollback')][string]$Action,
    [string]$Root = 'C:\ProgramData\T3ApprovalWorker',
    [string]$RuntimeSource,
    [string]$ConfigSource,
    [string]$TokenSource,
    [string]$KeySource,
    [string]$KnownHostsSource
)
$ErrorActionPreference = 'Stop'
$Name = 'T3ApprovalWorker'
$Account = 'NT SERVICE\T3ApprovalWorker'
if ($Root -ne 'C:\ProgramData\T3ApprovalWorker') { throw 'Use the single owned service root.' }
if (!([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Owner must run this exact script in an elevated PowerShell. No automatic UAC bypass.'
}
function Invoke-Sc([string[]]$Arguments) {
    & "$env:SystemRoot\System32\sc.exe" @Arguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "SCM operation failed: $($Arguments[0]) exit=$LASTEXITCODE" }
}
$Binary = '"'+$Root+'\runtime\python.exe" -I -B "'+$Root+'\service.py" --config "'+$Root+'\worker.json"'
$Existing = Get-CimInstance Win32_Service -Filter "Name='$Name'"
if ($Existing -and ($Existing.PathName -ne $Binary -or $Existing.StartName -ne $Account)) { throw 'Existing service identity differs; refusing to change it.' }
if ($Action -eq 'install') {
    if ($Existing -or (Test-Path -LiteralPath $Root)) { throw 'Service/root already exists; inspect or roll back explicitly.' }
    foreach ($Path in @($RuntimeSource,$ConfigSource,$TokenSource,$KeySource,$KnownHostsSource)) { if (!$Path -or !(Test-Path -LiteralPath $Path)) { throw 'Missing explicit operator-provided input.' } }
    if (!(Test-Path (Join-Path $RuntimeSource 'python.exe')) -or !(Test-Path (Join-Path $RuntimeSource 'Lib\os.py'))) { throw 'Provide a complete standalone Python base runtime, not a venv launcher.' }
    $Settings = Get-Content -Raw -LiteralPath $ConfigSource | ConvertFrom-Json
    if ($Settings.executionEnabled -ne $false) { throw 'Install with executionEnabled=false; enable only after isolation/authority/transport gates.' }
    New-Item -ItemType Directory -Path $Root | Out-Null
    $Acl = [Security.AccessControl.DirectorySecurity]::new()
    $Acl.SetSecurityDescriptorSddlForm('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')
    Set-Acl -LiteralPath $Root -AclObject $Acl
    foreach ($File in @('worker.py','create_file_once.py','service.py')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $File) -Destination $Root }
    Copy-Item -LiteralPath $RuntimeSource -Destination (Join-Path $Root 'runtime') -Recurse
    New-Item -ItemType Directory -Path "$Root\private","$Root\state" | Out-Null
    Copy-Item -LiteralPath $TokenSource -Destination "$Root\private\execute.token"
    Copy-Item -LiteralPath $KeySource -Destination "$Root\private\identity"
    Copy-Item -LiteralPath $KnownHostsSource -Destination "$Root\private\known_hosts"
    [IO.File]::WriteAllText("$Root\private\ssh_config", '')
    $Settings.ledgerFile="$Root\state\claims.sqlite"
    $Settings.stopFile="$Root\state\stop"
    $Settings.tokenFile="$Root\private\execute.token"
    $Settings.ssh.configFile="$Root\private\ssh_config"
    $Settings.ssh.identityFile="$Root\private\identity"
    $Settings.ssh.knownHostsFile="$Root\private\known_hosts"
    $Settings | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8 -LiteralPath "$Root\worker.json"
    Invoke-Sc -Arguments @('create',$Name,'binPath=',$Binary,'start=','demand','obj=',$Account,'DisplayName=','T3 Approval Worker')
    Invoke-Sc -Arguments @('sidtype',$Name,'unrestricted')
    $Sid=([Security.Principal.NTAccount]::new($Account)).Translate([Security.Principal.SecurityIdentifier])
    $Acl=Get-Acl -LiteralPath $Root
    $Acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($Sid,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'))
    Set-Acl -LiteralPath $Root -AclObject $Acl
    $StateAcl=Get-Acl -LiteralPath "$Root\state"
    $StateAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($Sid,'Modify','ContainerInherit,ObjectInherit','None','Allow'))
    Set-Acl -LiteralPath "$Root\state" -AclObject $StateAcl
    Invoke-Sc -Arguments @('failure',$Name,'reset=','86400','actions=','restart/10000/restart/30000/restart/60000')
    # Deliberately demand-start until the owner observes a successful controlled restart.
    @{name=$Name;account=$Account;root=$Root;installedAt=[DateTime]::UtcNow.ToString('o');executionEnabled=$false} | ConvertTo-Json | Set-Content "$Root\install-receipt.json"
}
if ($Action -in @('stop','restart','rollback') -and $Existing) {
    Stop-Service -Name $Name
    (Get-Service -Name $Name).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(60))
}
if ($Action -in @('start','restart')) {
    Start-Service -Name $Name
    (Get-Service -Name $Name).WaitForStatus('Running',[TimeSpan]::FromSeconds(15))
}
if ($Action -eq 'rollback' -and $Existing) {
    Invoke-Sc -Arguments @('delete',$Name)
    # Protected keys, ledger and original receipts remain for deliberate audit/cleanup.
}
$Service=Get-CimInstance Win32_Service -Filter "Name='$Name'"
@{name=$Name;state=$Service.State;pid=$Service.ProcessId;account=$Service.StartName;root=$Root;retainedProtectedFiles=(Test-Path $Root)} | ConvertTo-Json -Compress
