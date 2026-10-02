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
$sc = Join-Path ([Environment]::SystemDirectory) 'sc.exe'
function Get-ServiceRegistration {
  $settings = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\gsvd' |
    Select-Object ImagePath, Type, Start, ErrorControl, DisplayName, ObjectName, Description, RequiredPrivileges, ServiceSidType, FailureActions, FailureActionsOnNonCrashFailures, DependOnService, DependOnGroup |
    ConvertTo-Json -Compress -Depth 3
  $security = (& $sc sdshow gsvd | Out-String).Trim()
  if ($LASTEXITCODE) { throw 'Could not read service security for the rollback check' }
  return "$settings;$security"
}
[IO.File]::WriteAllText($trap, "@echo off`r`necho executed> `"%GSV_TEST_DAEMON_MARKER%`"`r`necho $version`r`n")
try {
  New-Item -ItemType Directory -Path $cliConfig | Out-Null
  Copy-Item $config (Join-Path $cliConfig 'config.toml')
  # A colliding SCM name is not permission to replace another service.
  & $sc create gsvd binPath= ((Join-Path ([Environment]::SystemDirectory) 'cmd.exe') + ' /c exit 1') start= demand DisplayName= 'Unrelated service fixture'
  if ($LASTEXITCODE) { throw 'Could not create the service collision fixture' }
  $foreignRegistration = Get-ServiceRegistration
  & $cli daemon windows-install --config $config --owner-sid $owner --workspace $workspace --daemon-source $daemonSource --daemon-sha256 $daemonHash
  if (-not $LASTEXITCODE) { throw 'Installation accepted a conflicting service registration' }
  if ((Get-ServiceRegistration) -ne $foreignRegistration -or (Get-Service gsvd).Status -ne 'Stopped') { throw 'Rejected collision changed the existing service' }
  if (Test-Path (Join-Path $env:ProgramFiles 'GSV')) { throw 'Rejected collision changed GSV service files' }
  & $sc delete gsvd
  if ($LASTEXITCODE) { throw 'Could not remove the service collision fixture' }
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
  $privileges = (& (Join-Path ([Environment]::SystemDirectory) 'sc.exe') qprivs gsvd | Out-String)
  if ($LASTEXITCODE -or [regex]::Matches($privileges, 'Se\w+Privilege').Count -ne 1 -or $privileges -notmatch 'SeChangeNotifyPrivilege') { throw 'Service retains unnecessary token privileges' }

  $serviceBinary = Join-Path $env:ProgramFiles 'GSV/service/gsvd.exe'
  $installedHash = (Get-FileHash $serviceBinary).Hash
  $installedPid = $service.ProcessId
  # Administrator choices survive both successful replacements and rollback.
  & $sc config gsvd start= demand DisplayName= 'Custom GSV machine'
  if ($LASTEXITCODE) { throw 'Could not configure custom startup settings' }
  & $sc description gsvd 'Custom recovery fixture'
  if ($LASTEXITCODE) { throw 'Could not configure a custom description' }
  & $sc failure gsvd reset= 1234 actions= restart/7000/restart/19000
  if ($LASTEXITCODE) { throw 'Could not configure custom recovery actions' }
  & $sc failureflag gsvd 0
  if ($LASTEXITCODE) { throw 'Could not configure custom recovery policy' }
  $registration = Get-ServiceRegistration
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
  # Replacement must recover even after SCM stops or enrollment writing fails.
  Copy-Item $daemonSource $changedDaemon -Force
  $image = [IO.File]::Open($changedDaemon, [IO.FileMode]::Append)
  try { $image.WriteByte(0) } finally { $image.Dispose() }
  $replacementHash = (Get-FileHash $changedDaemon).Hash
  foreach ($lockedPath in @($serviceBinary, (Join-Path $env:ProgramData 'GSV/daemon/config.toml'))) {
    $locked = [IO.File]::Open($lockedPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
      & (Join-Path $changedPackage 'gsv.exe') daemon windows-install --config $config --owner-sid $owner --workspace $workspace --daemon-source $changedDaemon --daemon-sha256 $replacementHash
      if (-not $LASTEXITCODE) { throw 'Reinstallation unexpectedly replaced a locked file' }
    } finally { $locked.Dispose() }
    if ((Get-FileHash $serviceBinary).Hash -ne $installedHash -or (Get-Service gsvd).Status -ne 'Running') { throw 'Failed reinstall did not restore the previous running daemon' }
    if ((Get-ServiceRegistration) -ne $registration) { throw 'Failed reinstall changed SCM configuration' }
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
  $env:GSV_GSVD_PATH = $trap
  & $cli daemon install --workspace $nextWorkspace
  if ($LASTEXITCODE) { throw 'Workspace replacement failed' }
  if ((Get-ServiceRegistration) -ne $registration) { throw 'Workspace replacement changed SCM configuration' }
  if (Test-Path $marker) { throw 'Elevated installation executed the inherited daemon override' }
  $env:GSV_GSVD_PATH = $previousOverride
  $serviceSid = ([Security.Principal.NTAccount]::new('NT SERVICE', 'gsvd')).Translate([Security.Principal.SecurityIdentifier]).Value
  $oldRules = (Get-Acl $workspace).GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier])
  if ($oldRules | Where-Object { $_.IdentityReference.Value -eq $serviceSid }) { throw 'Previous workspace retained its service grant' }
  & $cli daemon reload
  if ($LASTEXITCODE) { throw 'Configuration reload rejected the unchanged workspace' }
  # A version-compatible executable that cannot enter SCM must roll back the
  # complete public install, including both workspace grants and prior config.
  $failedWorkspace = Join-Path $root 'workspace for failed startup'
  New-Item -ItemType Directory -Path $failedWorkspace | Out-Null
  function Get-WorkspacePermissions([string]$Path) {
    $acl = Get-Acl $Path
    # SetSecurityInfo can mark an ACL as auto-inherited without changing access.
    # Compare owner/group, inheritance protection, and every ordered ACE instead.
    $rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {
      "$($_.IdentityReference.Value):$($_.AccessControlType):$([int]$_.FileSystemRights):$($_.InheritanceFlags):$($_.PropagationFlags):$($_.IsInherited)"
    }
    return "$($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value);$($acl.GetGroup([Security.Principal.SecurityIdentifier]).Value);$($acl.AreAccessRulesProtected);$($rules -join ';')"
  }
  $descendantAcls = @{}
  foreach ($index in 1..128) {
    $child = Join-Path $failedWorkspace ("child-" + $index)
    New-Item -ItemType Directory -Path $child | Out-Null
    $leaf = Join-Path $child 'file.txt'
    [IO.File]::WriteAllText($leaf, 'workspace rollback fixture')
    $descendantAcls[$child] = Get-WorkspacePermissions $child
    $descendantAcls[$leaf] = Get-WorkspacePermissions $leaf
  }
  $failedAcl = Get-WorkspacePermissions $failedWorkspace
  $priorAcl = Get-WorkspacePermissions $nextWorkspace
  $fixtureSource = Join-Path $root 'failed-service.cs'
  $fixtureCode = @"
class FailedService {
  static int Main(string[] args) {
    if (args.Length == 1 && args[0] == "--version") {
      System.Console.WriteLine("$version");
      return 0;
    }
    System.Threading.Thread.Sleep(5000);
    return 1;
  }
}
"@
  [IO.File]::WriteAllText($fixtureSource, $fixtureCode)
  Remove-Item $changedDaemon
  $compiler = Join-Path ([Environment]::GetFolderPath('Windows')) 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
  & $compiler /nologo /target:exe ("/out:" + $changedDaemon) $fixtureSource
  if ($LASTEXITCODE) { throw 'Could not compile the failed-service fixture' }
  [IO.File]::WriteAllText((Join-Path $cliConfig 'config.toml'), "[device]`nid = 'windows-ci'`nworkspace = '$failedWorkspace'`n", [Text.UTF8Encoding]::new($false))
  & (Join-Path $changedPackage 'gsv.exe') daemon install
  if (-not $LASTEXITCODE) { throw 'Installation accepted a daemon that failed to start' }
  if ((Get-Service gsvd).Status -ne 'Running' -or (Get-FileHash $serviceBinary).Hash -ne $installedHash) { throw 'Startup failure did not restore the running daemon' }
  if ((Get-ServiceRegistration) -ne $registration) { throw 'Startup failure changed SCM configuration' }
  $restoredFailedAcl = Get-WorkspacePermissions $failedWorkspace
  $restoredPriorAcl = Get-WorkspacePermissions $nextWorkspace
  if ($restoredFailedAcl -ne $failedAcl -or $restoredPriorAcl -ne $priorAcl) {
    throw "Startup failure did not restore workspace permissions. Selected before: $failedAcl; after: $restoredFailedAcl. Prior before: $priorAcl; after: $restoredPriorAcl"
  }
  # TOML serialization may normalize formatting; the persisted workspace must match.
  & $cli daemon diagnostics --json *> $null
  if ($LASTEXITCODE) { throw 'Rolled-back daemon control is unavailable' }
  Copy-Item $config (Join-Path $cliConfig 'config.toml') -Force
  & $cli daemon reload
  if ($LASTEXITCODE) { throw 'Startup rollback did not restore the previous enrollment workspace' }
  # Kill as soon as the first grant is visible, without waiting for propagation
  # through the subtree or the old grant's revocation. No ACL worker may outlive it.
  [IO.File]::WriteAllText((Join-Path $cliConfig 'config.toml'), "[device]`nid = 'windows-ci'`nworkspace = '$failedWorkspace'`n", [Text.UTF8Encoding]::new($false))
  $enrolling = Start-Process -FilePath (Join-Path $changedPackage 'gsv.exe') -ArgumentList 'daemon install' -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $root 'cancelled-install.out') -RedirectStandardError (Join-Path $root 'cancelled-install.err')
  try {
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
      $enrolling.Refresh()
      if ($enrolling.HasExited) { throw 'Enrollment exited before the cancellation test reached its ACL changes' }
      $granted = (Get-Acl $failedWorkspace).GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference.Value -eq $serviceSid }
      if ($granted) { break }
      if ([DateTime]::UtcNow -gt $deadline) { throw 'Enrollment did not reach the cancellation boundary' }
      Start-Sleep -Milliseconds 50
    } while ($true)
    $enrolling.Kill()
    $enrolling.WaitForExit()
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
      $restored = (Get-Service gsvd).Status -eq 'Running' -and (Get-FileHash $serviceBinary).Hash -eq $installedHash -and (Get-WorkspacePermissions $failedWorkspace) -eq $failedAcl -and (Get-WorkspacePermissions $nextWorkspace) -eq $priorAcl
      if ($restored) { break }
      if ([DateTime]::UtcNow -gt $deadline) { throw 'Caller exit did not restore the running daemon and both workspace ACLs' }
      Start-Sleep -Milliseconds 100
    } while ($true)
  } finally {
    $enrolling.Refresh()
    if (-not $enrolling.HasExited) { $enrolling.Kill(); $enrolling.WaitForExit() }
    $enrolling.Dispose()
  }
  Copy-Item $config (Join-Path $cliConfig 'config.toml') -Force
  & $cli daemon reload
  if ($LASTEXITCODE) { throw 'Caller-exit rollback did not restore enrollment configuration' }
  if ((Get-ServiceRegistration) -ne $registration) { throw 'Caller-exit rollback changed SCM configuration' }
  foreach ($entry in $descendantAcls.GetEnumerator()) {
    if ((Get-WorkspacePermissions $entry.Key) -ne $entry.Value) { throw "Caller exit left changed descendant permissions: $($entry.Key)" }
  }



  # Administrators may give a custom execution account explicit state access.
  $stateDirectory = Join-Path $env:ProgramData 'GSV/daemon'
  $stateAcl = Get-Acl $stateDirectory
  $stateAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
    [Security.Principal.SecurityIdentifier]::new('S-1-5-19'),
    [Security.AccessControl.FileSystemRights]::Modify,
    [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow))
  Set-Acl -LiteralPath $stateDirectory -AclObject $stateAcl
  $statePermissions = Get-WorkspacePermissions $stateDirectory
  & $cli daemon stop
  if ($LASTEXITCODE) { throw 'Could not stop the service to configure its custom account' }
  & $sc config gsvd obj= 'NT AUTHORITY\LocalService'
  if ($LASTEXITCODE) { throw 'Could not configure the custom service account' }
  & $cli daemon start
  if ($LASTEXITCODE) { throw 'Custom service account cannot start the daemon' }
  $registration = Get-ServiceRegistration
  & $cli daemon install
  if ($LASTEXITCODE) { throw 'Custom service account reinstallation failed' }
  if ((Get-ServiceRegistration) -ne $registration -or (Get-WorkspacePermissions $stateDirectory) -ne $statePermissions) { throw 'Reinstallation changed the custom service account or its state permissions' }
  & (Join-Path $changedPackage 'gsv.exe') daemon install
  if (-not $LASTEXITCODE) { throw 'Custom service account accepted a daemon that cannot start' }
  if ((Get-ServiceRegistration) -ne $registration -or (Get-WorkspacePermissions $stateDirectory) -ne $statePermissions) { throw 'Failed reinstallation changed the custom service account or its state permissions' }
  if ((Get-Service gsvd).Status -ne 'Running' -or (Get-FileHash $serviceBinary).Hash -ne $installedHash) { throw 'Custom service account rollback did not recover the daemon' }
  & $cli daemon diagnostics --json *> $null
  if ($LASTEXITCODE) { throw 'Custom service account lost access to its daemon state after rollback' }

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
  # Exercise exactly the code sent across UAC, with files changed afterwards.
  $parseTokens = $null
  $parseErrors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile($installer, [ref]$parseTokens, [ref]$parseErrors)
  if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
  $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-ServiceUpdateCommand' }, $false)
  . ([scriptblock]::Create($definition.Extent.Text))
  $pinnedCliHash = (Get-FileHash (Join-Path $assets 'gsv-windows-x64.exe')).Hash
  $pinnedDaemonHash = (Get-FileHash (Join-Path $assets 'gsvd-windows-x64.exe')).Hash
  $updateCommand = Get-ServiceUpdateCommand $assets $pinnedCliHash $pinnedDaemonHash
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($updateCommand))
  if ($encoded.Length -gt 30000) { throw 'Service bootstrap exceeds the Windows command-line budget' }
  $beforePid = (Get-CimInstance Win32_Service -Filter "Name='gsvd'").ProcessId
  foreach ($asset in @('gsv-windows-x64.exe', 'gsvd-windows-x64.exe')) {
    $path = Join-Path $assets $asset
    $original = [IO.File]::ReadAllBytes($path)
    try {
      [IO.File]::WriteAllText($path, 'changed during UAC')
      [IO.File]::WriteAllText((Join-Path $assets 'install.ps1'), "throw 'Untrusted installer executed'")
      Write-Checksums
      & (Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell/v1.0/powershell.exe') -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded
      if (-not $LASTEXITCODE) { throw 'Elevated bootstrap accepted bytes or checksums replaced during UAC' }
      if ((Get-CimInstance Win32_Service -Filter "Name='gsvd'").ProcessId -ne $beforePid) { throw 'Rejected update stopped the running daemon' }
    } finally { [IO.File]::WriteAllBytes($path, $original) }
  }
  Write-Checksums
  $setupChecksums = Get-Content -Raw -LiteralPath (Join-Path $assets 'checksums.txt')
  $assetPath = Join-Path $assets 'gsv-windows-x64.exe'
  $original = [IO.File]::ReadAllBytes($assetPath)
  try {
    [IO.File]::WriteAllText($assetPath, 'payload changed after setup authenticated its manifest')
    Write-Checksums
    $rejected = $false
    try {
      & $installer -Destination $destination -AssetDirectory $assets -ExpectedChecksums $setupChecksums -UserConfigDirectory (Join-Path $root 'user-config') -Headless -SkipUserSetup
    } catch {
      if ($_.Exception.Message -notmatch 'Checksum verification failed') { throw }
      $rejected = $true
    }
    if (-not $rejected) { throw 'Setup trusted an attacker-replaced payload and checksum manifest' }
    if ((Get-CimInstance Win32_Service -Filter "Name='gsvd'").ProcessId -ne $beforePid) { throw 'Rejected setup payload changed the running daemon' }
  } finally { [IO.File]::WriteAllBytes($assetPath, $original) }
  [IO.File]::WriteAllText((Join-Path $assets 'checksums.txt'), 'manifest replaced after setup verification')
  & $installer -Destination $destination -AssetDirectory $assets -ExpectedChecksums $setupChecksums -UserConfigDirectory (Join-Path $root 'user-config') -Headless -SkipUserSetup
  if (-not (Test-Path (Join-Path $destination 'gsv.exe'))) { throw 'Installer did not install the CLI' }
  if ((Get-Service gsvd).Status -ne 'Running') { throw 'Installer did not restore the service' }
  if ((Get-ServiceRegistration) -ne $registration) { throw 'Installer changed SCM configuration' }
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
  if ((Get-ServiceRegistration) -ne $registration) { throw 'Failed update changed SCM configuration' }
  & $cli daemon uninstall
  if ($LASTEXITCODE) { throw 'Service uninstall failed' }
  Start-Sleep -Seconds 1
  if (Get-Service gsvd -ErrorAction SilentlyContinue) { throw 'Service still registered' }
  foreach ($damage in @('malformed', 'unreadable')) {
    & $cli daemon install
    if ($LASTEXITCODE) { throw 'Could not reinstall the service for the damaged-state teardown test' }
    $stateConfig = Join-Path $env:ProgramData 'GSV/daemon/config.toml'
    $original = [IO.File]::ReadAllBytes($stateConfig)
    $locked = $null
    try {
      if ($damage -eq 'malformed') {
        [IO.File]::WriteAllText($stateConfig, '[broken configuration')
      } else {
        $locked = [IO.File]::Open($stateConfig, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
      }
      & $cli daemon uninstall
      if ($LASTEXITCODE) { throw "Service teardown failed with $damage configuration" }
      Start-Sleep -Seconds 1
      if (Get-Service gsvd -ErrorAction SilentlyContinue) { throw "Service remains installed with $damage configuration" }
      if ($damage -eq 'malformed') {
        & $cli daemon install
        if ($LASTEXITCODE) { throw 'Retained damaged state prevented a fresh installation' }
        if ((Get-Service gsvd).Status -ne 'Running') { throw 'Fresh installation did not start after damaged-state teardown' }
        & $cli daemon uninstall
        if ($LASTEXITCODE) { throw 'Recovered service could not be removed' }
        Start-Sleep -Seconds 1
      }
    } finally {
      if ($locked) { $locked.Dispose() }
      [IO.File]::WriteAllBytes($stateConfig, $original)
    }
  }
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
