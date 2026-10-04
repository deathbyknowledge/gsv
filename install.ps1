param(
  [string]$Destination = "",
  [string]$AssetDirectory = "",
  [string]$ExpectedChecksums = "",
  [string]$UserConfigDirectory = "",
  [switch]$SkipUserSetup,
  [switch]$SkipRuntimeSetup,
  [switch]$Headless
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Repo = "deathbyknowledge/gsv"
$InstallDir = if ($Destination) {
  $Destination
} elseif ($env:GSV_INSTALL_DIR) {
  $env:GSV_INSTALL_DIR
} else {
  Join-Path $env:LOCALAPPDATA "Programs\gsv\bin"
}
$Channel = if ($env:GSV_CHANNEL) { $env:GSV_CHANNEL } else { "stable" }
$Version = if ($env:GSV_VERSION) { $env:GSV_VERSION } else { "" }
$ConfigRoot = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $env:USERPROFILE "AppData\Roaming" }
$ConfigDir = if ($UserConfigDirectory) { $UserConfigDirectory } else { Join-Path $ConfigRoot "gsv" }
$DevReleaseTag = "dev"
$Platform = "windows-x64"

function Write-Info([string]$Message) { Write-Host "  -> $Message" -ForegroundColor Cyan }
function Write-Success([string]$Message) { Write-Host "  OK $Message" -ForegroundColor Green }
function Write-Warn([string]$Message) { Write-Host "  !! $Message" -ForegroundColor Yellow }

function Resolve-ReleaseRef {
  if ($Version) {
    if ($Version -notmatch "^[A-Za-z0-9._-]+$") { throw "Invalid GSV_VERSION release tag" }
    return $Version
  }
  if ($Channel -eq "stable") { return "latest" }
  if ($Channel -ne "dev") { throw "Invalid GSV_CHANNEL '$Channel' (must be stable or dev)" }
  return $DevReleaseTag
}

function Release-AssetUrl([string]$ReleaseRef, [string]$Asset) {
  if ($ReleaseRef -eq "latest") {
    return "https://github.com/$Repo/releases/latest/download/$Asset"
  }
  return "https://github.com/$Repo/releases/download/$ReleaseRef/$Asset"
}

function Add-CacheBustIfMutable([string]$ReleaseRef, [string]$Url) {
  if ($ReleaseRef -ne "latest" -and $ReleaseRef -ne $DevReleaseTag) { return $Url }
  return "$Url`?ts=$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
}

function Get-ReleaseChecksums([string]$ReleaseRef) {
  if ($ExpectedChecksums) { return $ExpectedChecksums }
  if ($AssetDirectory) {
    return Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $AssetDirectory "checksums.txt")
  }
  $url = Add-CacheBustIfMutable $ReleaseRef (Release-AssetUrl $ReleaseRef "checksums.txt")
  $response = Invoke-WebRequest -UseBasicParsing -Uri $url
  return [Text.Encoding]::UTF8.GetString($response.RawContentStream.ToArray())
}

function Get-ExpectedChecksum([string]$Checksums, [string]$Asset) {
  $line = ($Checksums -split "`r?`n" |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ -match ("^[0-9a-fA-F]{64}\s+\*?" + [regex]::Escape($Asset) + "$") } |
    Select-Object -First 1)
  if (-not $line) { throw "Release checksum is missing for $Asset" }
  return ($line -split "\s+")[0].ToLowerInvariant()
}

function Download-VerifiedAsset(
  [string]$ReleaseRef,
  [string]$Asset,
  [string]$Destination,
  [string]$Checksums
) {
  $url = Add-CacheBustIfMutable $ReleaseRef (Release-AssetUrl $ReleaseRef $Asset)
  Write-Info "Downloading $Asset"
  if ($AssetDirectory) {
    Copy-Item -LiteralPath (Join-Path $AssetDirectory $Asset) -Destination $Destination
  } else {
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $Destination | Out-Null
  }
  $expected = Get-ExpectedChecksum $Checksums $Asset
  $actual = (Get-FileHash -Algorithm SHA256 $Destination).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "Checksum verification failed for $Asset" }
}

function Ensure-ConfigFile {
  $configFile = Join-Path $ConfigDir "config.toml"
  New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
  if (Test-Path $configFile) {
    Write-Info "Found existing config at $configFile; leaving it unchanged"
    return
  }
  $channelLine = if (-not $Version) {
    "channel = `"$Channel`""
  } elseif ($Version -eq $DevReleaseTag) {
    'channel = "dev"'
  } else {
    '# channel = "stable"'
  }
  $configContent = @"
# GSV host application configuration
# gsv config --local set gateway.url wss://<your-gateway>.workers.dev/ws

[release]
$channelLine
"@
  [IO.File]::WriteAllText($configFile, $configContent, [Text.UTF8Encoding]::new($false))
  Write-Success "Created config at $configFile"
}

function Set-ReleaseChannelInConfig([string]$Channel) {
  # Set release.channel in an existing config without touching anything else.
  $configFile = Join-Path $ConfigDir "config.toml"
  if (-not (Test-Path $configFile)) { return }
  $lines = [System.Collections.Generic.List[string]](Get-Content -Path $configFile)
  $channelLine = "channel = `"$Channel`""
  $inRelease = $false
  $releaseIndex = -1
  for ($index = 0; $index -lt $lines.Count; $index++) {
    $line = $lines[$index]
    if ($line -match '^\s*\[release\]\s*$') { $inRelease = $true; $releaseIndex = $index; continue }
    if ($line -match '^\s*\[') { $inRelease = $false; continue }
    if ($inRelease -and $line -match '^\s*#?\s*channel\s*=') {
      $lines[$index] = $channelLine
      [IO.File]::WriteAllLines($configFile, $lines, [Text.UTF8Encoding]::new($false))
      return
    }
  }
  if ($releaseIndex -ge 0) {
    $lines.Insert($releaseIndex + 1, $channelLine)
  } else {
    $lines.Add("")
    $lines.Add("[release]")
    $lines.Add($channelLine)
  }
  [IO.File]::WriteAllLines($configFile, $lines, [Text.UTF8Encoding]::new($false))
}

function Add-InstallDirToPath {
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $entries = if ([string]::IsNullOrWhiteSpace($userPath)) { @() } else { $userPath -split ";" }
  if ($entries -notcontains $InstallDir) {
    $nextPath = if ([string]::IsNullOrWhiteSpace($userPath)) { $InstallDir } else { $userPath.TrimEnd(";") + ";" + $InstallDir }
    [Environment]::SetEnvironmentVariable("Path", $nextPath, "User")
    Write-Success "Added $InstallDir to the user PATH"
  }
  if (($env:Path -split ";") -notcontains $InstallDir) { $env:Path = $InstallDir + ";" + $env:Path }
}

function Restore-Binaries([array]$Installed) {
  for ($index = $Installed.Count - 1; $index -ge 0; $index--) {
    $record = $Installed[$index]
    if ($record.Backup) {
      if (Test-Path $record.Backup) {
        Remove-Item -Recurse -Force $record.Target -ErrorAction SilentlyContinue
        Move-Item -Force $record.Backup $record.Target
      }
    } else {
      Remove-Item -Recurse -Force $record.Target -ErrorAction SilentlyContinue
    }
  }
}

# This bootstrap is passed by value to Windows PowerShell. Only its two pinned
# byte snapshots cross UAC; the child never rereads a script or checksum manifest.
function Get-ServiceUpdateCommand([string]$Source, [string]$CliHash, [string]$DaemonHash) {
  $quote = { param($value) "'" + $value.Replace("'", "''") + "'" }
  $prefix = '$source = ' + (& $quote $Source) + '; $cliHash = ' + (& $quote $CliHash) + '; $daemonHash = ' + (& $quote $DaemonHash) + ";`n"
  return $prefix + @'
$ErrorActionPreference = 'Stop'
$env:PSModulePath = [IO.Path]::Combine([Environment]::SystemDirectory, 'WindowsPowerShell\v1.0\Modules')
$stage = $null
try {
  $root = [IO.Path]::Combine([Environment]::GetFolderPath('ProgramFiles'), 'GSV')
  $bin = [IO.Path]::Combine($root, 'service')
  foreach ($path in @($root, $bin)) {
    $directory = [IO.DirectoryInfo]::new($path)
    if (-not $directory.Exists -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Untrusted service directory' }
    $acl = $directory.GetAccessControl()
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-18', 'S-1-5-32-544')) { throw 'Untrusted service directory owner' }
    $rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
    if (-not $rules.Count) { throw 'Service directory has no protective ACL' }
    foreach ($rule in $rules) {
      if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @('S-1-5-18', 'S-1-5-32-544') -and ([int]$rule.FileSystemRights -band 0x500D0156)) { throw 'Service directory is writable by an unprivileged identity' }
    }
  }
  $directoryAcl = [Security.AccessControl.DirectorySecurity]::new()
  $directoryAcl.SetSecurityDescriptorSddlForm('O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;GRGX;;;BU)')
  $stage = [IO.Path]::Combine($bin, '.update-' + [Guid]::NewGuid().ToString('N'))
  [IO.Directory]::CreateDirectory($stage, $directoryAcl) > $null
  $fileAcl = [Security.AccessControl.FileSecurity]::new()
  $fileAcl.SetSecurityDescriptorSddlForm('O:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;BU)')
  foreach ($entry in @(@('gsv-windows-x64.exe', 'gsv.exe', $cliHash), @('gsvd-windows-x64.exe', 'gsvd.exe', $daemonHash))) {
    $bytes = [IO.File]::ReadAllBytes([IO.Path]::Combine($source, $entry[0]))
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $actual = [BitConverter]::ToString($hasher.ComputeHash($bytes)).Replace('-', '') } finally { $hasher.Dispose() }
    if ($actual -ne $entry[2]) { throw 'Service update bytes changed after approval was requested' }
    $file = [IO.FileStream]::new([IO.Path]::Combine($stage, $entry[1]), [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::Write, [IO.FileShare]::Read, 65536, [IO.FileOptions]::WriteThrough, $fileAcl)
    try { $file.Write($bytes, 0, $bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
  }
  & ([IO.Path]::Combine($stage, 'gsv.exe')) daemon windows-update --daemon-sha256 $daemonHash
  if ($LASTEXITCODE -ne 0) { throw 'Protected service update failed' }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
} finally {
  if ($stage -and [IO.Directory]::Exists($stage)) { [IO.Directory]::Delete($stage, $true) }
}
'@
}

function Update-GsvService([string]$Source, [string]$Checksums) {
  $command = Get-ServiceUpdateCommand $Source (Get-ExpectedChecksum $Checksums 'gsv-windows-x64.exe') (Get-ExpectedChecksum $Checksums 'gsvd-windows-x64.exe')
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  $powershell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
  $process = Start-Process -FilePath $powershell -Verb RunAs -ArgumentList ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + $encoded) -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw 'Administrator service update failed; the previous daemon was retained or restored' }
}

function Install-MicrosoftRuntime([string]$Url, [string]$Name, [string[]]$Arguments) {
  $path = Join-Path ([IO.Path]::GetTempPath()) (([Guid]::NewGuid().ToString('N')) + '.exe')
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $path | Out-Null
    $signature = Get-AuthenticodeSignature -FilePath $path
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
      throw "$Name installer does not have a valid Microsoft signature"
    }
    $process = Start-Process -FilePath $path -ArgumentList $Arguments -Wait -PassThru
    if ($process.ExitCode -notin @(0, 1638, 3010)) { throw "$Name installation failed: $($process.ExitCode)" }
  } finally { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
}

function Ensure-HostRuntimes {
  if ($SkipRuntimeSetup) { return }
  if (-not $Headless) {
  $webview = @(
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
  ) | Where-Object { (Get-ItemProperty -Path $_ -Name pv -ErrorAction SilentlyContinue).pv -match '^[1-9]' }
  if (-not $webview) {
    Install-MicrosoftRuntime 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' 'WebView2' @('/silent', '/install')
  }
  }
  $vc = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64' -ErrorAction SilentlyContinue
  $vcVersion = if ($vc.Version) { [version]($vc.Version.TrimStart('v')) } else { [version]'0.0' }
  if (-not $vc -or $vc.Installed -ne 1 -or $vcVersion -lt [version]'14.44') {
    Install-MicrosoftRuntime 'https://aka.ms/vs/17/release/vc_redist.x64.exe' 'Visual C++ runtime' @('/install', '/quiet', '/norestart')
  }
}

function Install-GsvHost {
  if (-not [Environment]::Is64BitOperatingSystem) { throw "GSV requires 64-bit Windows" }
  if (-not [System.IO.Path]::IsPathRooted($InstallDir)) { throw "GSV_INSTALL_DIR must be an absolute path" }
  $resolvedInstallDir = ([System.IO.Path]::GetFullPath($InstallDir)).TrimEnd("\")
  $volumeRoot = ([System.IO.Path]::GetPathRoot($resolvedInstallDir)).TrimEnd("\")
  $userProfile = ([System.IO.Path]::GetFullPath($env:USERPROFILE)).TrimEnd("\")
  if ($resolvedInstallDir -eq $volumeRoot -or $resolvedInstallDir -eq $userProfile) {
    throw "GSV_INSTALL_DIR must name a dedicated binary directory"
  }
  if ([Environment]::OSVersion.Version.Major -lt 10) { throw 'GSV requires Windows 10 or newer' }
  if ($env:PROCESSOR_ARCHITECTURE -match 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -match 'ARM64') {
    throw 'This release supports Windows x64 only'
  }
  $releaseRef = Resolve-ReleaseRef
  $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString("N"))
  $assets = [ordered]@{
    "gsv-$Platform.exe" = "gsv.exe"
    "gsvd-$Platform.exe" = "gsvd.exe"
    "gsv-desktop-$Platform.exe" = "gsv-desktop.exe"
    "gsv-transcribe-$Platform.exe" = "gsv-transcribe.exe"
    "gsv-vision-$Platform.exe" = "gsv-vision.exe"
    "gsv-transcribe-THIRD_PARTY.md" = "gsv-transcribe-THIRD_PARTY.md"
    "gsv-vision-LICENSE.apache-2.0" = "gsv-vision-LICENSE.apache-2.0"
    "gsv-vision-PROVENANCE.md" = "gsv-vision-PROVENANCE.md"
    "gsv-vision-THIRD_PARTY.md" = "gsv-vision-THIRD_PARTY.md"
    "gsv-transcribe-runtime-$Platform.zip" = "gsv-transcribe-runtime"
  }
  if ($Headless) {
    $assets = [ordered]@{ "gsv-$Platform.exe" = "gsv.exe"; "gsvd-$Platform.exe" = "gsvd.exe" }
  }
  $serviceExisted = $false
  $installed = @()
  $rollbackNeeded = $false
  New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

  try {
    Write-Info "Downloading release manifest ($releaseRef)"
    $checksums = Get-ReleaseChecksums $releaseRef
    foreach ($asset in $assets.Keys) {
      Download-VerifiedAsset $releaseRef $asset (Join-Path $tempDir $asset) $checksums
    }
    Write-Success "Verified $($assets.Count) release artifacts"
    if (-not $Headless) {
      Expand-Archive -LiteralPath (Join-Path $tempDir "gsv-transcribe-runtime-$Platform.zip") -DestinationPath $tempDir
      if (-not (Test-Path (Join-Path $tempDir 'gsv-transcribe-runtime/transcribe.dll'))) {
        throw 'Transcription runtime is missing'
      }
    }

    $service = Get-CimInstance Win32_Service -Filter "Name='gsvd'" -ErrorAction Stop
    $serviceExisted = $null -ne $service
    $busy = Get-Process -Name gsv-desktop,gsv-transcribe,gsv-vision -ErrorAction SilentlyContinue
    if ($busy) { throw 'Close GSV Desktop and its input helpers, then run the installer again.' }
    Ensure-HostRuntimes

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $rollbackNeeded = $true
    try {
      foreach ($entry in $assets.GetEnumerator()) {
        $target = Join-Path $InstallDir $entry.Value
        $staged = "$target.new.$PID"
        $backup = if (Test-Path $target) { "$target.backup.$PID" } else { "" }
        $record = [PSCustomObject]@{ Target = $target; Backup = $backup }
        $installed += $record
        try {
          $source = if ($entry.Value -eq 'gsv-transcribe-runtime') {
            Join-Path $tempDir $entry.Value
          } else { Join-Path $tempDir $entry.Key }
          Copy-Item -Recurse -Force $source $staged
          if ($backup) {
            Move-Item -Force $target $backup
          }
          Move-Item -Force $staged $target
        } finally {
          Remove-Item -Recurse -Force $staged -ErrorAction SilentlyContinue
        }
      }

      # The config must be complete before the replacement daemon starts.
      Ensure-ConfigFile
      if ($Version -eq $DevReleaseTag) { Set-ReleaseChannelInConfig "dev" }

      if ($serviceExisted) {
        Update-GsvService $tempDir $checksums
        Write-Success 'Updated and verified the gsvd Windows service'
      }
    } catch {
      Restore-Binaries $installed
      $rollbackNeeded = $false
      throw "Installation failed; previous binaries were restored: $($_.Exception.Message)"
    }

    $rollbackNeeded = $false
    foreach ($record in $installed) {
      if ($record.Backup) { Remove-Item -Recurse -Force $record.Backup -ErrorAction SilentlyContinue }
    }
  } finally {
    if ($rollbackNeeded) {
      Restore-Binaries $installed
    }
    Remove-Item -Recurse -Force $tempDir -ErrorAction SilentlyContinue
  }
}

Write-Host ""
Write-Host "GSV host installer · Windows x64" -ForegroundColor Cyan
Write-Host ""
Install-GsvHost
if ($SkipUserSetup) { return }
if ($env:GSV_NO_MODIFY_PATH -eq "1") {
  Write-Info "Left the user PATH alone (GSV_NO_MODIFY_PATH=1); add $InstallDir yourself"
} else {
  Add-InstallDirToPath
}
if (-not $Version) {
  try {
    & (Join-Path $InstallDir "gsv.exe") config --local set release.channel $Channel *> $null
    if ($LASTEXITCODE -ne 0) { throw "gsv config exited with status $LASTEXITCODE" }
  } catch {
    Write-Warn "Could not persist release.channel"
  }
}
if (-not $Headless) {
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Programs')) 'GSV.lnk'))
$shortcut.TargetPath = Join-Path $InstallDir 'gsv-desktop.exe'
$shortcut.WorkingDirectory = $InstallDir
$shortcut.Save()
}
if ($Headless) {
  Write-Success "Installed GSV CLI and daemon to $InstallDir"
} else {
  Write-Success "Installed GSV Desktop, CLI, daemon and local input helpers to $InstallDir"
}
Write-Host ""
Write-Host "  Next: finish setting up your space in your browser."
Write-Host "  CLI login: gsv --url wss://your-space.example/ws auth login"
Write-Host "  Connect this computer: create an invitation in Fleet, then run gsv pair CODE"
Write-Host ""
