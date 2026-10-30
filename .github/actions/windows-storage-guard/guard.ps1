$ErrorActionPreference = 'Stop'
$reserveBytes = [long]$env:GUARDED_RESERVE_GIB * 1GB
if ($reserveBytes -lt 1GB) { throw 'Storage reserve must be at least 1 GiB.' }
$roots = @($env:GITHUB_WORKSPACE, $env:RUNNER_TEMP) |
  ForEach-Object { [IO.Path]::GetPathRoot($_) } | Select-Object -Unique
function Test-StorageReserve {
  foreach ($root in $roots) {
    $drive = [IO.DriveInfo]::new($root)
    if (-not $drive.IsReady) { throw "Cannot measure build volume $root" }
    if ($drive.AvailableFreeSpace -lt $reserveBytes) {
      throw "Build volume $root has $($drive.AvailableFreeSpace) bytes free; reserve is $reserveBytes."
    }
  }
}
Test-StorageReserve
$taskDirectory = Join-Path $env:RUNNER_TEMP ('windows-storage-guard-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $taskDirectory | Out-Null
$scriptPath = Join-Path $taskDirectory 'build.sh'
$process = $null
try {
  [IO.File]::WriteAllText($scriptPath, "set -euo pipefail`n" + $env:GUARDED_COMMAND + "`n", [Text.UTF8Encoding]::new($false))
  $gitRoot = Split-Path (Split-Path (Get-Command git.exe -ErrorAction Stop).Source)
  $bash = Join-Path $gitRoot 'bin/bash.exe'
  if (-not (Test-Path -LiteralPath $bash)) {
    throw "Native Git Bash is missing at $bash; refusing the WSL bash shim."
  }
  $process = Start-Process -FilePath $bash -ArgumentList @('"' + $scriptPath + '"') -WorkingDirectory $env:GITHUB_WORKSPACE -NoNewWindow -PassThru
  $null = $process.Handle
  Write-Host "Monitoring owned build PID $($process.Id), reserve $env:GUARDED_RESERVE_GIB GiB."
  while (-not $process.WaitForExit(5000)) { Test-StorageReserve }
  $process.WaitForExit()
  $code = $process.ExitCode
  Test-StorageReserve
  if ($code -ne 0) { throw "Guarded build exited with code $code." }
} catch {
  if ($null -ne $process -and -not $process.HasExited) {
    Write-Host "Stopping owned build process tree $($process.Id)."
    & taskkill.exe /PID $process.Id /T /F | Out-Host
    $process.WaitForExit()
  }
  throw
} finally {
  Remove-Item -LiteralPath $taskDirectory -Recurse -Force
}
