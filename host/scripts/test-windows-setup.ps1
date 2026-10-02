$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../packaging/windows/setup-bootstrap.ps1')
$root = Join-Path ([IO.Path]::GetTempPath()) ('gsv-setup-test-' + [Guid]::NewGuid().ToString('N'))
$source = Join-Path $root "setup's payload 日本語"
$destination = Join-Path $root "user's applications 日本語"
$previousSource = $env:GSV_SETUP_SOURCE
$previousDestination = $env:GSV_SETUP_DESTINATION
$powershell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell/v1.0/powershell.exe'
try {
  New-Item -ItemType Directory -Path $source, $destination | Out-Null
  $scriptPath = Join-Path $source 'install.ps1'
  $manifestPath = Join-Path $source 'checksums.txt'
  $resultPath = Join-Path $destination 'result.json'
  $markerPath = Join-Path $destination 'untrusted-script-ran'
  $script = @'
param([string]$Destination, [string]$AssetDirectory, [string]$ExpectedChecksums)
[IO.File]::WriteAllText([IO.Path]::Combine($Destination, 'result.json'), (@{ Destination = $Destination; Source = $AssetDirectory; Manifest = $ExpectedChecksums } | ConvertTo-Json))
'@
  $manifest = "pinned manifest with spaces and Unicode 日本語`n"
  [IO.File]::WriteAllText($scriptPath, $script, [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($manifestPath, $manifest, [Text.UTF8Encoding]::new($false))
  $command = Get-SetupBootstrap (Get-FileHash $scriptPath).Hash (Get-FileHash $manifestPath).Hash
  $nativeCommand = '"' + $powershell + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "' + $command + '"'
  if ($nativeCommand.Length -ge 1024 -or $command.Length -gt 650) { throw 'Setup bootstrap exceeds the NSIS command buffer' }
  # Compile the shipped invocation, including NSIS macro expansion and quoting.
  $definition = '!define GSV_SETUP_CODE `' + $command.Replace('$', '$$') + '`'
  [IO.File]::WriteAllText((Join-Path $root 'setup-bootstrap.nsh'), $definition, [Text.UTF8Encoding]::new($false))
  $invocation = Get-Content (Join-Path $PSScriptRoot '../packaging/windows/gsv.nsi') |
    Where-Object { $_ -match 'nsExec::ExecToLog.*GSV_SETUP_CODE' } | Select-Object -First 1
  if (-not $invocation) { throw 'Missing shipped setup invocation' }
  $fixture = @'
Unicode true
!include "x64.nsh"
!include "setup-bootstrap.nsh"
OutFile "setup.exe"
RequestExecutionLevel user
SilentInstall silent
Section
  ${DisableX64FSRedirection}
  INVOCATION
  Pop $0
  SetErrorLevel $0
SectionEnd
'@
  $fixturePath = Join-Path $root 'setup.nsi'
  [IO.File]::WriteAllText($fixturePath, $fixture.Replace('INVOCATION', $invocation), [Text.UTF8Encoding]::new($false))
  $makensis = Get-Command makensis.exe -ErrorAction SilentlyContinue
  $compiler = if ($makensis) { $makensis.Source } else { Join-Path ${env:ProgramFiles(x86)} 'NSIS/makensis.exe' }
  & $compiler $fixturePath
  if ($LASTEXITCODE) { throw 'Could not compile the setup bootstrap fixture' }
  $setup = Join-Path $root 'setup.exe'
  $env:GSV_SETUP_SOURCE = $source
  $env:GSV_SETUP_DESTINATION = $destination
  foreach ($path in @($scriptPath, $manifestPath)) {
    $original = [IO.File]::ReadAllBytes($path)
    try {
      [IO.File]::WriteAllText($path, "[IO.File]::WriteAllText([IO.Path]::Combine(`$env:GSV_SETUP_DESTINATION,'untrusted-script-ran'),'executed')")
      $process = Start-Process -FilePath $setup -Wait -PassThru
      if (-not $process.ExitCode) { throw 'Setup accepted content replaced after packaging' }
      if ((Test-Path $markerPath) -or (Test-Path $resultPath)) { throw 'Setup executed an untrusted script or consumed a replaced manifest' }
    } finally { [IO.File]::WriteAllBytes($path, $original) }
  }
  $process = Start-Process -FilePath $setup -Wait -PassThru
  if ($process.ExitCode) { throw 'Verified setup bootstrap failed' }
  $result = Get-Content -Raw -LiteralPath $resultPath | ConvertFrom-Json
  if ($result.Destination -ne $destination -or $result.Source -ne $source -or $result.Manifest -cne $manifest) { throw 'Setup did not preserve its paths and pinned manifest' }
} finally {
  $env:GSV_SETUP_SOURCE = $previousSource
  $env:GSV_SETUP_DESTINATION = $previousDestination
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
