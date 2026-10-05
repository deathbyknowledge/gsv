param(
  [Parameter(Mandatory=$true)][string]$BinDir,
  [string]$Output = 'release',
  [switch]$ZipOnly
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$bin = (Resolve-Path $BinDir).Path
New-Item -ItemType Directory -Force -Path $Output | Out-Null
$outputDir = (Resolve-Path $Output).Path
$stage = Join-Path ([IO.Path]::GetTempPath()) ('gsv-windows-package-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
  foreach ($name in @('gsv', 'gsvd', 'gsv-desktop', 'gsv-transcribe', 'gsv-vision')) {
    Copy-Item (Join-Path $bin "$name.exe") (Join-Path $stage "$name-windows-x64.exe")
  }
  & python (Join-Path $root 'host/scripts/package-transcriber.py') --binary-dir $bin --platform windows-x64 --output $stage
  if ($LASTEXITCODE) { throw 'Transcription runtime packaging failed' }
  Copy-Item (Join-Path $root 'install.ps1') $stage
  Copy-Item (Join-Path $root 'host/helpers/transcriber/THIRD_PARTY.md') (Join-Path $stage 'gsv-transcribe-THIRD_PARTY.md')
  Copy-Item (Join-Path $root 'host/helpers/gestures/models/LICENSE.apache-2.0') (Join-Path $stage 'gsv-vision-LICENSE.apache-2.0')
  Copy-Item (Join-Path $root 'host/helpers/gestures/models/PROVENANCE.md') (Join-Path $stage 'gsv-vision-PROVENANCE.md')
  Copy-Item (Join-Path $root 'host/helpers/gestures/THIRD_PARTY.md') (Join-Path $stage 'gsv-vision-THIRD_PARTY.md')
  $manifest = (Get-ChildItem -File $stage | Sort-Object Name | ForEach-Object {
    (Get-FileHash -Algorithm SHA256 $_.FullName).Hash.ToLowerInvariant() + '  ' + $_.Name
  }) -join "`n"
  [IO.File]::WriteAllText((Join-Path $stage 'checksums.txt'), $manifest + "`n", [Text.UTF8Encoding]::new($false))
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath (Join-Path $outputDir 'gsv-desktop-windows-x64.zip') -Force
  if (-not $ZipOnly) {
    . (Join-Path $root 'host/packaging/windows/setup-bootstrap.ps1')
    $bootstrap = Get-SetupBootstrap (Get-FileHash (Join-Path $stage 'install.ps1')).Hash (Get-FileHash (Join-Path $stage 'checksums.txt')).Hash
    # Reserve space for the trusted PowerShell path and its command-line flags.
    if ($bootstrap.Length -gt 650) { throw 'Setup bootstrap exceeds the NSIS string budget' }
    $definition = '!define GSV_SETUP_CODE `' + $bootstrap.Replace('$', '$$') + '`'
    [IO.File]::WriteAllText((Join-Path $stage 'setup-bootstrap.nsh'), $definition, [Text.UTF8Encoding]::new($false))
    $makensis = Get-Command makensis.exe -ErrorAction SilentlyContinue
    $compiler = if ($makensis) { $makensis.Source } else { Join-Path ${env:ProgramFiles(x86)} 'NSIS/makensis.exe' }
    if (-not (Test-Path $compiler)) { throw 'Install NSIS to build the Windows setup executable' }
    $version = (Get-Content -Raw (Join-Path $root 'VERSION')).Trim().TrimStart('v')
    & $compiler "/DSTAGE=$stage" "/DOUTPUT=$outputDir" "/DVERSION=$version" (Join-Path $root 'host/packaging/windows/gsv.nsi')
    if ($LASTEXITCODE) { throw 'NSIS packaging failed' }
  }
} finally { Remove-Item -Recurse -Force $stage }
