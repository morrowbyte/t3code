$ErrorActionPreference = 'Stop'
if (!$env:GITHUB_ENV -or !$env:GITHUB_PATH) { throw 'GitHub job environment files are required.' }

function Find-Python3([string]$Candidate) {
  if (!$Candidate -or $Candidate -like '*\Microsoft\WindowsApps\*' -or
      !(Test-Path -LiteralPath $Candidate -PathType Leaf)) { return $null }
  try {
    $executable = (& $Candidate -c 'import sys; assert sys.version_info.major == 3; print(sys.executable)' 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -eq 0 -and $executable -and (Test-Path -LiteralPath $executable -PathType Leaf)) {
      return $executable
    }
  } catch { }
  return $null
}

$candidates = @($env:npm_config_python, $env:PYTHON)
$candidates += @(Get-Command python.exe, python3.exe -All -CommandType Application -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })
$launcher = Get-Command py.exe -CommandType Application -ErrorAction SilentlyContinue
if ($launcher) {
  try {
    foreach ($line in (& $launcher.Source -0p 2>$null)) {
      if ($line -match '((?:[A-Za-z]:\\|\\\\).+\.exe)\s*$') { $candidates += $Matches[1].Trim() }
    }
  } catch { }
}
if ($env:LOCALAPPDATA) {
  $candidates += @(Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Programs/Python/Python*/python.exe') -File -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
}
foreach ($programRoot in @($env:ProgramFiles, [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'))) {
  if ($programRoot) {
    $candidates += @(Get-ChildItem (Join-Path $programRoot 'Python*/python.exe') -File -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
  }
}
foreach ($cacheRoot in @($env:RUNNER_TOOL_CACHE, $env:RUNNER_TEMP)) {
  if ($cacheRoot) {
    foreach ($pattern in @('Python/*/*/python.exe', 'morrowbyte-python/*/python.exe')) {
      $candidates += @(Get-ChildItem (Join-Path $cacheRoot $pattern) -File -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
    }
  }
}
$python = $null
foreach ($candidate in ($candidates | Select-Object -Unique)) {
  $python = Find-Python3 $candidate
  if ($python) { break }
}

if (!$python) {
  if (!$env:RUNNER_TEMP) { throw 'RUNNER_TEMP is required to prepare Python.' }
  $version = '3.14.10'
  $archiveSha256 = '90905e64a840557d8c1bc4f5b74db3d7ee85e3ffb217611cac1c7813acea4159'
  $cacheRoot = if ($env:RUNNER_TOOL_CACHE) { $env:RUNNER_TOOL_CACHE } else { $env:RUNNER_TEMP }
  $cacheParent = Join-Path $cacheRoot 'morrowbyte-python'
  $runtime = Join-Path $cacheParent "$version-x64"
  if (Test-Path -LiteralPath $runtime) { throw "A non-working Python cache already exists at $runtime." }
  $taskRoot = Join-Path $env:RUNNER_TEMP ("morrowbyte-python-" + [Guid]::NewGuid().ToString('N'))
  $stagedRuntime = Join-Path $cacheParent ("staging-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $taskRoot | Out-Null
  try {
    $archive = Join-Path $taskRoot 'python.zip'
    Invoke-WebRequest -UseBasicParsing -Uri "https://www.python.org/ftp/python/$version/python-$version-embed-amd64.zip" -OutFile $archive
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $archiveSha256) {
      throw 'Official CPython archive SHA256 does not match.'
    }
    New-Item -ItemType Directory -Path $cacheParent -Force | Out-Null
    Expand-Archive -LiteralPath $archive -DestinationPath $stagedRuntime
    if (!(Find-Python3 (Join-Path $stagedRuntime 'python.exe'))) { throw 'Downloaded runtime is not usable Python 3.' }
    [IO.Directory]::Move($stagedRuntime, $runtime)
    $python = Find-Python3 (Join-Path $runtime 'python.exe')
    if (!$python) { throw 'Cached runtime is not usable Python 3.' }
  } finally {
    if (Test-Path -LiteralPath $stagedRuntime) { Remove-Item -LiteralPath $stagedRuntime -Recurse -Force }
    Remove-Item -LiteralPath $taskRoot -Recurse -Force
  }
}

$env:PYTHON = $python
$env:npm_config_python = $python
@("PYTHON=$python", "npm_config_python=$python") | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
(Split-Path $python) | Out-File -FilePath $env:GITHUB_PATH -Encoding utf8 -Append
Write-Host 'Python 3 is available for node-gyp.'
