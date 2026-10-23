param(
 [Parameter(Mandatory)][ValidateSet('pair','bind')][string]$Action,
 [string]$Config=(Join-Path $PSScriptRoot 'operator-windows.json'),
 [string]$SessionId,
 [string]$Subject,
 [switch]$Activate
)
$ErrorActionPreference='Stop'
$Settings=Get-Content -LiteralPath $Config -Raw|ConvertFrom-Json
$Dev=Get-Content -LiteralPath $Settings.devConfigFile -Raw|ConvertFrom-Json
if($Action -eq 'pair') {
 $Label='Owner-personal-WindowsHost-'+[guid]::NewGuid()
 $Private=Join-Path (Split-Path -Parent $Config) ($Label+'.pairing.json')
 Push-Location $Settings.appRoot
 try {
  & $Settings.node apps/server/src/bin.ts auth pairing create --base-dir $Settings.home --scope orchestration:read --scope orchestration:operate --label $Label --ttl 10m --base-url 'http://localhost:5733' --json > $Private
  if($LASTEXITCODE -ne 0){throw 'Personal pairing issue failed.'}
  $Grant=Get-Content -LiteralPath $Private -Raw|ConvertFrom-Json
  Start-Process $Grant.pairUrl
  Write-Output 'Complete pairing personally. Read sessionId and subject at http://localhost:5733/api/approval-review/identity, then run this script with -Action bind and those two fields. No package has been approved.'
 } finally {Pop-Location}
 return
}
if(-not $SessionId -or -not $Subject){throw 'Exact browser identity sessionId and subject required.'}
$Arguments=@('-B',(Join-Path $PSScriptRoot 'bind-approver.py'),'--config',$Config,'--session-id',$SessionId,'--subject',$Subject)
if($Activate){$Arguments+='--activate'}
& $Dev.python @Arguments
if($LASTEXITCODE -ne 0){throw 'Personal browser binding failed closed.'}
