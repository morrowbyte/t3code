param([Parameter(Mandatory)][ValidateSet('start','status','stop','restart','register','unregister')][string]$Action,[Parameter(Mandatory)][string]$Config)
$ErrorActionPreference='Stop'
$ConfigPath=(Resolve-Path -LiteralPath $Config).Path
$Settings=Get-Content -LiteralPath $ConfigPath -Raw|ConvertFrom-Json
$State=$Settings.state
$Receipt=Join-Path $State 'launcher-receipt.json'
$StopFile=Join-Path $State 'stop'
$TaskName='T3ApprovalDev20261022'
$PowerShell=(Get-Command pwsh).Source
$TaskArguments='-NoProfile -NonInteractive -File "'+$PSCommandPath+'" -Action start -Config "'+$ConfigPath+'"'
if($Action -in @('register','unregister')) {
 $Task=Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
 if($Task -and ($Task.Actions.Count -ne 1 -or $Task.Actions[0].Execute -ne $PowerShell -or $Task.Actions[0].Arguments -ne $TaskArguments)) {throw 'Existing task identity differs; no task changed.'}
 if($Action -eq 'register') {
  if($Task){throw 'Owned task already registered.'}
  $UserSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  Register-ScheduledTask -TaskName $TaskName -Action (New-ScheduledTaskAction -Execute $PowerShell -Argument $TaskArguments) -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $UserSid) -Principal (New-ScheduledTaskPrincipal -UserId $UserSid -LogonType Interactive -RunLevel Limited)|Out-Null
  @{task=$TaskName;registered=$true;context='current-user-interactive-logon-not-service'}|ConvertTo-Json -Compress
  return
 }
 if($Task){Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false}
 $Action='stop'
}
function OwnedProcess {
 if(-not(Test-Path -LiteralPath $Receipt)){return $null}
 $Saved=Get-Content -LiteralPath $Receipt -Raw|ConvertFrom-Json -DateKind String
 $Process=Get-Process -Id $Saved.pid -ErrorAction SilentlyContinue
 if(-not $Process){return $null}
 if($Process.StartTime.ToUniversalTime().ToString('o') -ne $Saved.startedAt -or $Process.Path -ne $Saved.python -or $Saved.config -ne $ConfigPath){throw 'Owned launcher identity mismatch; no process stopped.'}
 return $Process
}
function Health {
 $Response=Invoke-WebRequest -Uri 'http://127.0.0.1:43879/.well-known/t3/environment' -TimeoutSec 2
 return ($Response.Content|ConvertFrom-Json).environmentId
}
$Process=OwnedProcess
if($Action -eq 'status') {
 $Environment=$null
 if($Process){try{$Environment=Health}catch{}}
 @{running=[bool]$Process;pid=if($Process){$Process.Id}else{$null};environmentId=$Environment;state=$State}|ConvertTo-Json -Compress
 return
}
$ExpectedEnvironment=$null
if($Process){try{$ExpectedEnvironment=Health}catch{}}
if($Action -in @('stop','restart') -and $Process) {
 [IO.File]::WriteAllText($StopFile,'owned stop')
 if(-not $Process.WaitForExit(20000)){throw 'Owned launcher did not stop; no forced kill or new instance.'}
 $Process=$null
}
if($Action -eq 'stop') {
 @{running=$false;stopRequested=$true;state=$State}|ConvertTo-Json -Compress
 return
}
if($Process){throw 'Owned launcher already running.'}
if(Get-NetTCPConnection -State Listen -LocalPort 43879,5733 -ErrorAction SilentlyContinue){throw 'Dev ports occupied; no existing process stopped.'}
New-Item -ItemType Directory -Force -Path $State|Out-Null
$Stamp=[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffffffZ')
$Args=@('-B',('"'+$PSScriptRoot+'\dev-host.py"'),'--source',('"'+$Settings.source+'"'),'--node',('"'+$Settings.node+'"'),'--state',('"'+$State+'"'))
if($Settings.targets){$Args+=@('--targets',('"'+$Settings.targets+'"'))}
$Process=Start-Process -FilePath $Settings.python -ArgumentList $Args -WorkingDirectory $State -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $State "$Stamp.stdout.log") -RedirectStandardError (Join-Path $State "$Stamp.stderr.log")
$Saved=@{pid=$Process.Id;startedAt=$Process.StartTime.ToUniversalTime().ToString('o');python=$Settings.python;config=$ConfigPath;state=$State}
$Saved|ConvertTo-Json|Set-Content -LiteralPath $Receipt
$Deadline=[DateTime]::UtcNow.AddSeconds(45)
$Environment=$null
while([DateTime]::UtcNow -lt $Deadline) {
 if($Process.HasExited){throw 'Owned launcher exited; inspect private logs.'}
 try{$Environment=Health;break}catch{Start-Sleep -Milliseconds 500}
}
if(-not $Environment){throw 'No API readiness within 45s; owned process retained for diagnosis.'}
if($ExpectedEnvironment -and $ExpectedEnvironment -ne $Environment){throw 'Environment identity changed across restart.'}
@{running=$true;pid=$Process.Id;environmentId=$Environment;state=$State}|ConvertTo-Json -Compress
