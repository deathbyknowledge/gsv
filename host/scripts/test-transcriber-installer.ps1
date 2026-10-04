$ErrorActionPreference = 'Stop'
$installer = Join-Path $PSScriptRoot '../../install.ps1'
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Resolve-Path $installer), [ref]$tokens, [ref]$errors)
if ($errors) { throw $errors }
foreach ($function in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
  Invoke-Expression $function.Extent.Text
}

$root = Join-Path ([IO.Path]::GetTempPath()) ('gsv-runtime-test-' + [Guid]::NewGuid().ToString('N'))
$InstallDir = Join-Path $root 'installed with spaces'
$AssetDirectory = Join-Path $root 'assets'
$Version = 'v-test'
$DevReleaseTag = 'dev'
$Platform = 'windows-x64'
$Headless = $false
$ExpectedChecksums = ''
function Get-CimInstance { return $null }
function Get-Process { return $null }
function Ensure-HostRuntimes {}
function Ensure-ConfigFile {}
$previousSigningThumbprint = $env:GSV_WINDOWS_SIGNING_THUMBPRINT
$signed = [Collections.Generic.List[string]]::new()
function signtool.exe { $signed.Add([string]$args[-1]); $global:LASTEXITCODE = 0 }
function Get-AuthenticodeSignature { return @{ Status = 'Valid' } }
try {
  New-Item -ItemType Directory -Force $AssetDirectory | Out-Null
  foreach ($name in @('gsv', 'gsvd', 'gsv-desktop', 'gsv-transcribe', 'gsv-vision')) {
    [IO.File]::WriteAllText((Join-Path $AssetDirectory "$name-windows-x64.exe"), 'binary-v1')
  }
  foreach ($name in @('gsv-transcribe-THIRD_PARTY.md', 'gsv-vision-LICENSE.apache-2.0', 'gsv-vision-PROVENANCE.md', 'gsv-vision-THIRD_PARTY.md')) {
    [IO.File]::WriteAllText((Join-Path $AssetDirectory $name), 'license')
  }
  $runtime = Join-Path $root 'build/gsv-transcribe-runtime'
  New-Item -ItemType Directory -Force $runtime | Out-Null
  [IO.File]::WriteAllText((Join-Path $runtime 'ggml-cpu-x64.dll'), 'baseline')
  $helper = Join-Path $root 'build/gsv-transcribe.exe'
  [IO.File]::WriteAllText($helper, 'helper')
  New-Item -ItemType Directory -Force (Join-Path $root 'build/deps') | Out-Null
  [IO.File]::WriteAllText((Join-Path $root 'build/deps/unshipped.dll'), 'build dependency')
  foreach ($version in @('v1', 'v2')) {
    [IO.File]::WriteAllText((Join-Path $runtime 'transcribe.dll'), "runtime-$version")
    $env:GSV_WINDOWS_SIGNING_THUMBPRINT = 'fixture-certificate'
    $signed.Clear()
    & (Join-Path $PSScriptRoot 'sign-windows.ps1') -Directory (Split-Path $runtime)
    $expected = @($helper, (Join-Path $runtime 'ggml-cpu-x64.dll'), (Join-Path $runtime 'transcribe.dll'))
    if ((($signed | Sort-Object) -join "`n") -ne (($expected | Sort-Object) -join "`n")) {
      throw 'Signing must cover the helper and runtime DLLs, excluding build dependencies'
    }
    & python (Join-Path $PSScriptRoot 'package-transcriber.py') --binary-dir (Split-Path $runtime) --platform windows-x64 --output $AssetDirectory
    if ($LASTEXITCODE) { throw 'Runtime packaging failed' }
    $checksums = (Get-ChildItem -File $AssetDirectory | Where-Object Name -ne 'checksums.txt' | ForEach-Object {
      (Get-FileHash $_.FullName).Hash.ToLowerInvariant() + '  ' + $_.Name
    }) -join "`n"
    [IO.File]::WriteAllText((Join-Path $AssetDirectory 'checksums.txt'), $checksums)
    if ($version -eq 'v1') {
      Install-GsvHost
    } else {
      function Ensure-ConfigFile { throw 'fixture rollback' }
      try { Install-GsvHost; throw 'Installer failed to roll back' } catch {
        if ($_.Exception.Message -notmatch 'fixture rollback') { throw }
      }
    }
    if ((Get-Content -Raw (Join-Path $InstallDir 'gsv-transcribe-runtime/transcribe.dll')) -ne 'runtime-v1') {
      throw 'Runtime directory was not installed or restored with the helper'
    }
    if (Get-ChildItem $InstallDir | Where-Object Name -Match '\.(new|backup)\.') { throw 'Installer left staged files' }
  }
} finally {
  $env:GSV_WINDOWS_SIGNING_THUMBPRINT = $previousSigningThumbprint
  Remove-Item -LiteralPath $root -Recurse -Force
}
Write-Host 'Transcription runtime install and rollback passed'
