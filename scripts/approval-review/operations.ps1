param(
    [Parameter(Mandatory)][ValidateSet('start','status','stop','restart','register','unregister')][string]$Action,
    [Parameter(Mandatory)][string]$Config,
    [Parameter(Mandatory)][string]$Python,
    [string]$TaskName = 'T3-ApprovalReview-OwnedWorker'
)
$ErrorActionPreference = 'Stop'
$Config = (Resolve-Path -LiteralPath $Config).Path
$Python = (Resolve-Path -LiteralPath $Python).Path
$Settings = Get-Content -Raw -LiteralPath $Config | ConvertFrom-Json
$Directory = Split-Path -Parent $Config
$Record = Join-Path $Directory 'worker-process.json'
$Worker = Join-Path $PSScriptRoot 'worker.py'

function Read-OwnedProcess {
    if (!(Test-Path -LiteralPath $Record)) { return $null }
    $Saved = Get-Content -Raw -LiteralPath $Record | ConvertFrom-Json -DateKind String
    $Process = Get-Process -Id $Saved.pid -ErrorAction SilentlyContinue
    if (!$Process) { return $null }
    if ($Process.StartTime.ToUniversalTime().ToString('o') -ne $Saved.startedAt -or $Process.Path -ne $Python) {
        throw 'Process identity differs from owned spawn receipt; refusing to control it.'
    }
    return $Process
}
function Stop-OwnedWorker {
    [IO.File]::WriteAllText($Settings.stopFile, 'stop')
    $Process = Read-OwnedProcess
    if ($Process -and !$Process.WaitForExit(45000)) { throw 'Owned worker did not stop; no force kill performed.' }
}
function Start-OwnedWorker {
    if (Read-OwnedProcess) { throw 'Owned worker already running.' }
    Remove-Item -LiteralPath $Settings.stopFile -ErrorAction SilentlyContinue
    $Stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffffffZ')
    $Out = Join-Path $Directory "worker-$Stamp.stdout.log"
    $Err = Join-Path $Directory "worker-$Stamp.stderr.log"
    $Process = Start-Process -FilePath $Python -ArgumentList @('-u',('"'+$Worker+'"'),'--config',('"'+$Config+'"')) -WorkingDirectory $PSScriptRoot -PassThru -WindowStyle Hidden -RedirectStandardOutput $Out -RedirectStandardError $Err
    @{pid=$Process.Id;startedAt=$Process.StartTime.ToUniversalTime().ToString('o');python=$Python;worker=$Worker;config=$Config;stdout=$Out;stderr=$Err} | ConvertTo-Json | Set-Content -Encoding utf8 -LiteralPath $Record
    Start-Sleep -Milliseconds 500
    if (!(Read-OwnedProcess)) { throw "Worker exited; inspect $Err" }
}
switch ($Action) {
    'start' { Start-OwnedWorker }
    'stop' { Stop-OwnedWorker }
    'restart' { Stop-OwnedWorker; Start-OwnedWorker }
    'register' {
        # Current user at logon: no saved password, elevation or new OS authority.
        if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { throw 'Task already exists; inspect before replacing.' }
        $Arguments = '-NoProfile -NonInteractive -File "'+$PSCommandPath+'" -Action start -Config "'+$Config+'" -Python "'+$Python+'"'
        $TaskAction = New-ScheduledTaskAction -Execute (Get-Process -Id $PID).Path -Argument $Arguments -WorkingDirectory $PSScriptRoot
        $Trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
        $Principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
        Register-ScheduledTask -TaskName $TaskName -Action $TaskAction -Trigger $Trigger -Principal $Principal -Description 'Owned approval worker; narrow execute credential, pinned target, durable claim ledger.' | Out-Null
    }
    'unregister' {
        $Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($Task) {
            if ($Task.Actions.Count -ne 1 -or !$Task.Actions[0].Arguments.Contains($PSCommandPath) -or !$Task.Actions[0].Arguments.Contains($Config)) { throw 'Task identity mismatch.' }
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        }
        Stop-OwnedWorker
    }
}
$Owned = Read-OwnedProcess
@{running=[bool]$Owned;pid=$(if($Owned){$Owned.Id}else{$null});stopRequested=(Test-Path -LiteralPath $Settings.stopFile);processReceipt=$Record;taskRegistered=[bool](Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)} | ConvertTo-Json -Compress
