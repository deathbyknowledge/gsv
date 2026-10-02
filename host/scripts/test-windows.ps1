param([Parameter(Mandatory=$true)][string]$BinDir)
$ErrorActionPreference = 'Stop'
$bin = (Resolve-Path $BinDir).Path
$cli = Join-Path $bin 'gsv.exe'
$root = Join-Path $env:TEMP ('gsv-service-test-' + [Guid]::NewGuid().ToString('N'))
$cliConfig = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'gsv'
if (Get-Service gsvd -ErrorAction SilentlyContinue) { throw 'SCM smoke test requires a clean machine' }
foreach ($directory in @((Join-Path $env:ProgramData 'GSV'), (Join-Path $env:ProgramFiles 'GSV'), $cliConfig)) {
  if (Test-Path -LiteralPath $directory) { throw "SCM smoke test requires a clean machine; existing directory: $directory" }
}
New-Item -ItemType Directory -Path $root | Out-Null
$workspace = Join-Path $root 'workspace with spaces 日本語'
New-Item -ItemType Directory -Path $workspace | Out-Null
$config = Join-Path $root 'config.toml'
$toml = "[device]`nid = 'windows-ci'`nworkspace = '$workspace'`n"
[IO.File]::WriteAllText($config, $toml, [Text.UTF8Encoding]::new($false))
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$daemonSource = Join-Path $bin 'gsvd.exe'
$daemonHash = (Get-FileHash -Algorithm SHA256 $daemonSource).Hash
$previousOverride = $env:GSV_GSVD_PATH
$previousMarker = $env:GSV_TEST_DAEMON_MARKER
$marker = Join-Path $root 'untrusted-daemon-executed'
$trap = Join-Path $root 'untrusted-gsvd.cmd'
$protectedWorkspace = Join-Path $env:ProgramFiles ('gsv-workspace-test-' + [Guid]::NewGuid().ToString('N'))
$version = (& $daemonSource --version).Trim()
[IO.File]::WriteAllText($trap, "@echo off`r`necho executed> `"%GSV_TEST_DAEMON_MARKER%`"`r`necho $version`r`n")
try {
  New-Item -ItemType Directory -Path $cliConfig | Out-Null
  Copy-Item $config (Join-Path $cliConfig 'config.toml')
  $env:GSV_TEST_DAEMON_MARKER = $marker
  & $trap --version
  if ($LASTEXITCODE -or -not (Test-Path $marker)) { throw 'Untrusted daemon fixture did not run' }
  Remove-Item $marker
  $env:GSV_GSVD_PATH = $trap
  New-Item -ItemType Directory -Path $protectedWorkspace | Out-Null
  $protectedAcl = Get-Acl $protectedWorkspace
  $protectedAcl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
  Set-Acl -LiteralPath $protectedWorkspace -AclObject $protectedAcl
  $protectedSddl = (Get-Acl $protectedWorkspace).Sddl
  & $cli daemon windows-install --config $config --owner-sid $owner --workspace $protectedWorkspace --daemon-source $daemonSource --daemon-sha256 $daemonHash
  if ($LASTEXITCODE) { throw 'Service registration failed' }
  if ((Get-Acl $protectedWorkspace).Sddl -ne $protectedSddl) { throw 'Elevated registration changed the protected workspace ACL' }
  if ((Get-Service gsvd).Status -ne 'Stopped') { throw 'Elevated registration started the service before the caller granted workspace access' }
  $ownerPath = Join-Path $env:ProgramData 'GSV/owner.sid'
  if ([IO.File]::ReadAllText($ownerPath).Trim() -ne $owner) { throw 'Missing protected enrollment owner' }
  foreach ($protectedPath in @($ownerPath, (Split-Path -Parent $ownerPath))) {
    $acl = Get-Acl $protectedPath
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-18', 'S-1-5-32-544')) { throw 'Enrollment owner path is not administrator-owned' }
    $rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
    if (-not $rules.Count) { throw 'Enrollment owner path has no protective ACL' }
    foreach ($rule in $rules) {
      # Write, delete, owner/DACL changes, and generic write/all rights.
      if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @('S-1-5-18', 'S-1-5-32-544') -and ([int]$rule.FileSystemRights -band 0x500D0156)) {
        throw 'An unprivileged identity can modify or replace the enrollment owner'
      }
    }
  }
  & $cli daemon install
  if ($LASTEXITCODE) { throw 'Service installation failed' }
  if (Test-Path $marker) { throw 'Service installation executed the inherited daemon override' }
  $env:GSV_GSVD_PATH = $previousOverride
  # Daemon-writable lookalikes must not select the service control-pipe owner.
  [IO.File]::WriteAllText((Join-Path $env:ProgramData 'GSV/daemon/owner.sid'), 'S-1-5-7')
  $service = Get-CimInstance Win32_Service -Filter "Name='gsvd'"
  if ($service.StartMode -ne 'Auto' -or $service.StartName -ne 'NT SERVICE\gsvd') { throw 'Service must boot under its own account' }
  $serviceBinary = Join-Path $env:ProgramFiles 'GSV/service/gsvd.exe'
  $installedHash = (Get-FileHash $serviceBinary).Hash
  $installedPid = $service.ProcessId
  $changedPackage = Join-Path $root 'changed package'
  New-Item -ItemType Directory -Path $changedPackage | Out-Null
  Copy-Item $cli (Join-Path $changedPackage 'gsv.exe')
  $env:GSV_GSVD_PATH = $trap
  & (Join-Path $changedPackage 'gsv.exe') daemon install
  if (-not $LASTEXITCODE) { throw 'Service installation accepted a missing bundled daemon' }
  if (Test-Path $marker) { throw 'Service installation fell back to the inherited daemon override' }
  $changedDaemon = Join-Path $changedPackage 'gsvd.exe'
  [IO.File]::WriteAllText($changedDaemon, 'daemon replaced after selection')
  & (Join-Path $changedPackage 'gsv.exe') daemon windows-install --config $config --owner-sid $owner --workspace $workspace --daemon-source $changedDaemon --daemon-sha256 $daemonHash
  if (-not $LASTEXITCODE) { throw 'Elevated installation accepted changed daemon bytes' }
  & $cli daemon windows-install --config $config --owner-sid $owner --workspace $workspace --daemon-source $trap --daemon-sha256 (Get-FileHash $trap).Hash
  if (-not $LASTEXITCODE) { throw 'Elevated installation accepted an unbundled daemon' }
  if (Test-Path $marker) { throw 'Elevated installation executed an unbundled daemon' }
  $env:GSV_GSVD_PATH = $previousOverride
  $service = Get-CimInstance Win32_Service -Filter "Name='gsvd'"
  if ($service.State -ne 'Running' -or $service.ProcessId -ne $installedPid -or (Get-FileHash $serviceBinary).Hash -ne $installedHash) {
    throw 'Rejected daemon changed the existing service'
  }
  foreach ($action in @('doctor', 'status', 'diagnostics', 'reload', 'restart', 'stop', 'start')) {
    & $cli daemon $action
    if ($LASTEXITCODE) { throw "daemon $action failed" }
  }
  $service = Get-Service gsvd
  if ($service.Status -ne 'Running') { throw 'Service did not survive restart' }
  $nextWorkspace = Join-Path $root 'replacement workspace'
  New-Item -ItemType Directory -Path $nextWorkspace | Out-Null
  $nextToml = "[device]`nid = 'windows-ci'`nworkspace = '$nextWorkspace'`n"
  [IO.File]::WriteAllText($config, $nextToml, [Text.UTF8Encoding]::new($false))
  Copy-Item $config (Join-Path $cliConfig 'config.toml') -Force
  $env:GSV_GSVD_PATH = $trap
  & $cli daemon install
  if ($LASTEXITCODE) { throw 'Workspace replacement failed' }
  if (Test-Path $marker) { throw 'Elevated installation executed the inherited daemon override' }
  $env:GSV_GSVD_PATH = $previousOverride
  $serviceSid = ([Security.Principal.NTAccount]::new('NT SERVICE', 'gsvd')).Translate([Security.Principal.SecurityIdentifier]).Value
  $oldRules = (Get-Acl $workspace).GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier])
  if ($oldRules | Where-Object { $_.IdentityReference.Value -eq $serviceSid }) { throw 'Previous workspace retained its service grant' }
  & $cli daemon reload
  if ($LASTEXITCODE) { throw 'Configuration reload rejected the unchanged workspace' }
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
  $env:GSV_GSVD_PATH = $previousOverride
  $env:GSV_TEST_DAEMON_MARKER = $previousMarker
  if (Get-Service gsvd -ErrorAction SilentlyContinue) {
    Stop-Service gsvd -ErrorAction SilentlyContinue
    & sc.exe delete gsvd | Out-Null
  }
  Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $protectedWorkspace -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $cliConfig -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force (Join-Path $env:ProgramData 'GSV') -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force (Join-Path $env:ProgramFiles 'GSV') -ErrorAction SilentlyContinue
}
