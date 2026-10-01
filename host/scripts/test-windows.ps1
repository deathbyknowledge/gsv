param([Parameter(Mandatory=$true)][string]$BinDir)
$ErrorActionPreference = 'Stop'
$bin = (Resolve-Path $BinDir).Path
$cli = Join-Path $bin 'gsv.exe'
$root = Join-Path $env:TEMP ('gsv-service-test-' + [Guid]::NewGuid().ToString('N'))
if (Get-Service gsvd -ErrorAction SilentlyContinue) { throw 'SCM smoke test requires a clean machine' }
New-Item -ItemType Directory -Path $root | Out-Null
$workspace = Join-Path $root 'workspace with spaces 日本語'
New-Item -ItemType Directory -Path $workspace | Out-Null
$config = Join-Path $root 'config.toml'
$toml = "[device]`nid = 'windows-ci'`nworkspace = '$workspace'`n"
[IO.File]::WriteAllText($config, $toml, [Text.UTF8Encoding]::new($false))
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
try {
  & $cli daemon windows-install --config $config --owner-sid $owner
  if ($LASTEXITCODE) { throw 'Service installation failed' }
  $service = Get-CimInstance Win32_Service -Filter "Name='gsvd'"
  if ($service.StartMode -ne 'Auto' -or $service.StartName -ne 'NT SERVICE\gsvd') { throw 'Service must boot under its own account' }
  foreach ($action in @('status', 'diagnostics', 'restart', 'stop', 'start')) {
    & $cli daemon $action
    if ($LASTEXITCODE) { throw "daemon $action failed" }
  }
  $service = Get-Service gsvd
  if ($service.Status -ne 'Running') { throw 'Service did not survive restart' }
  $assets = Join-Path $root 'assets'
  $destination = Join-Path $root 'installed with spaces 日本語'
  New-Item -ItemType Directory -Path $assets | Out-Null
  Copy-Item $cli (Join-Path $assets 'gsv-windows-x64.exe')
  Copy-Item (Join-Path $bin 'gsvd.exe') (Join-Path $assets 'gsvd-windows-x64.exe')
  function Write-Checksums {
    $lines = Get-ChildItem $assets -Filter '*.exe' | ForEach-Object {
      (Get-FileHash -Algorithm SHA256 $_.FullName).Hash.ToLowerInvariant() + '  ' + $_.Name
    }
    [IO.File]::WriteAllLines((Join-Path $assets 'checksums.txt'), $lines, [Text.UTF8Encoding]::new($false))
  }
  Write-Checksums
  $installer = Join-Path $PSScriptRoot '../../install.ps1'
  & $installer -Destination $destination -AssetDirectory $assets -UserConfigDirectory (Join-Path $root 'user-config') -Headless -SkipUserSetup
  if (-not (Test-Path (Join-Path $destination 'gsv.exe'))) { throw 'Installer did not install the CLI' }
  if ((Get-Service gsvd).Status -ne 'Running') { throw 'Installer did not restore the service' }
  $serviceBinary = Join-Path $env:ProgramFiles 'GSV/service/gsvd.exe'
  $before = (Get-FileHash $serviceBinary).Hash
  [IO.File]::WriteAllText((Join-Path $assets 'gsvd-windows-x64.exe'), 'invalid executable for rollback test')
  Write-Checksums
  $rejected = $false
  try {
    & $installer -Destination $destination -AssetDirectory $assets -UserConfigDirectory (Join-Path $root 'user-config') -Headless -SkipUserSetup
  } catch { $rejected = $true }
  if (-not $rejected) { throw 'Installer accepted a daemon that could not start' }
  if ((Get-FileHash $serviceBinary).Hash -ne $before) { throw 'Failed update did not restore the daemon' }
  if ((Get-Service gsvd).Status -ne 'Running') { throw 'Failed update did not recover the service' }
  & $cli daemon uninstall
  if ($LASTEXITCODE) { throw 'Service uninstall failed' }
  Start-Sleep -Seconds 1
  if (Get-Service gsvd -ErrorAction SilentlyContinue) { throw 'Service still registered' }
  $tokens = $null
  $errors = $null
  [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '../../install.ps1'), [ref]$tokens, [ref]$errors) | Out-Null
  if ($errors.Count) { throw ($errors | Out-String) }
} finally {
  if (Get-Service gsvd -ErrorAction SilentlyContinue) {
    Stop-Service gsvd -ErrorAction SilentlyContinue
    & sc.exe delete gsvd | Out-Null
  }
  Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force (Join-Path $env:ProgramData 'GSV') -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force (Join-Path $env:ProgramFiles 'GSV') -ErrorAction SilentlyContinue
}
