$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Repo = "deathbyknowledge/gsv"
$InstallDir = if ($env:GSV_INSTALL_DIR) {
  $env:GSV_INSTALL_DIR
} else {
  Join-Path $env:LOCALAPPDATA "Programs\gsv\bin"
}
$Channel = if ($env:GSV_CHANNEL) { $env:GSV_CHANNEL } else { "stable" }
$Version = if ($env:GSV_VERSION) { $env:GSV_VERSION } else { "" }
$ConfigRoot = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $env:USERPROFILE "AppData\Roaming" }
$ConfigDir = Join-Path $ConfigRoot "gsv"
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
  Invoke-WebRequest -Uri $url -OutFile $Destination | Out-Null
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
  $channelLine = if ($Version) { '# channel = "stable"' } else { "channel = `"$Channel`"" }
  $configContent = @"
# GSV host application configuration
# gsv config --local set gateway.url wss://<your-gateway>.workers.dev/ws

[release]
$channelLine
"@
  Set-Content -Path $configFile -Value $configContent -Encoding UTF8
  Write-Success "Created config at $configFile"
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
        Remove-Item -Force $record.Target -ErrorAction SilentlyContinue
        Move-Item -Force $record.Backup $record.Target
      }
    } else {
      Remove-Item -Force $record.Target -ErrorAction SilentlyContinue
    }
  }
}

function Restore-ScheduledTask([bool]$Existed, [string]$Xml, [bool]$WasRunning) {
  Stop-ScheduledTask -TaskName "gsvd" -ErrorAction SilentlyContinue
  if (-not $Existed) {
    Unregister-ScheduledTask -TaskName "gsvd" -Confirm:$false -ErrorAction SilentlyContinue
    return
  }
  Register-ScheduledTask -TaskName "gsvd" -Xml $Xml -Force | Out-Null
  if ($WasRunning) { Start-ScheduledTask -TaskName "gsvd" }
}

function Wait-GsvdHealthy {
  for ($attempt = 0; $attempt -lt 10; $attempt++) {
    $task = Get-ScheduledTask -TaskName "gsvd" -ErrorAction SilentlyContinue
    & (Join-Path $InstallDir "gsv.exe") device doctor *> $null
    if ($LASTEXITCODE -eq 0 -and $task -and $task.State -eq "Running") { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
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
  if ($env:PROCESSOR_ARCHITECTURE -match "ARM64") {
    Write-Warn "Windows ARM64 is not a released target; installing the x64 CLI and daemon under emulation."
  }

  $releaseRef = Resolve-ReleaseRef
  $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString("N"))
  $assets = [ordered]@{
    "gsv-$Platform.exe" = "gsv.exe"
    "gsvd-$Platform.exe" = "gsvd.exe"
  }
  $taskExisted = $false
  $taskWasRunning = $false
  $taskXml = ""
  $installed = @()
  $rollbackNeeded = $false
  New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

  try {
    Write-Info "Downloading release manifest ($releaseRef)"
    $checksumUrl = Add-CacheBustIfMutable $releaseRef (Release-AssetUrl $releaseRef "checksums.txt")
    $checksums = (Invoke-WebRequest -Uri $checksumUrl).Content
    foreach ($asset in $assets.Keys) {
      Download-VerifiedAsset $releaseRef $asset (Join-Path $tempDir $asset) $checksums
    }
    Write-Success "Verified $($assets.Count) release artifacts"

    $oldTask = Get-ScheduledTask -TaskName "gsvd" -ErrorAction SilentlyContinue
    $taskExisted = $null -ne $oldTask
    $taskWasRunning = $taskExisted -and $oldTask.State -eq "Running"
    $taskXml = if ($taskExisted) { Export-ScheduledTask -TaskName "gsvd" } else { "" }

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $rollbackNeeded = $true
    try {
      if ($taskExisted) {
        Stop-ScheduledTask -TaskName "gsvd" -ErrorAction Stop
      }
      foreach ($entry in $assets.GetEnumerator()) {
        $target = Join-Path $InstallDir $entry.Value
        $staged = "$target.new.$PID"
        $backup = if (Test-Path $target) { "$target.backup.$PID" } else { "" }
        $record = [PSCustomObject]@{ Target = $target; Backup = $backup }
        $installed += $record
        try {
          Copy-Item -Force (Join-Path $tempDir $entry.Key) $staged
          if ($backup) {
            Move-Item -Force $target $backup
          }
          Move-Item -Force $staged $target
        } finally {
          Remove-Item -Force $staged -ErrorAction SilentlyContinue
        }
      }

      if ($taskExisted) {
        & (Join-Path $InstallDir "gsv.exe") device start *> $null
        if ($LASTEXITCODE -ne 0 -or -not (Wait-GsvdHealthy)) {
          throw "The updated gsvd service did not become healthy"
        }
        if (-not $taskWasRunning) { Stop-ScheduledTask -TaskName "gsvd" -ErrorAction SilentlyContinue }
        Write-Success "Migrated and verified the gsvd scheduled task"
      }
    } catch {
      if ($taskExisted) { Stop-ScheduledTask -TaskName "gsvd" -ErrorAction SilentlyContinue }
      Restore-Binaries $installed
      Restore-ScheduledTask $taskExisted $taskXml $taskWasRunning
      $rollbackNeeded = $false
      throw "Installation failed and the previous binaries and scheduled task were restored: $($_.Exception.Message)"
    }

    $rollbackNeeded = $false
    foreach ($record in $installed) {
      if ($record.Backup) { Remove-Item -Force $record.Backup -ErrorAction SilentlyContinue }
    }
  } finally {
    if ($rollbackNeeded) {
      if ($taskExisted) { Stop-ScheduledTask -TaskName "gsvd" -ErrorAction SilentlyContinue }
      Restore-Binaries $installed
      Restore-ScheduledTask $taskExisted $taskXml $taskWasRunning
    }
    Remove-Item -Recurse -Force $tempDir -ErrorAction SilentlyContinue
  }
}

Write-Host ""
Write-Host "GSV host installer · Windows x64" -ForegroundColor Cyan
Write-Host ""
Install-GsvHost
Ensure-ConfigFile
Add-InstallDirToPath
if (-not $Version) {
  try {
    & (Join-Path $InstallDir "gsv.exe") config --local set release.channel $Channel *> $null
    if ($LASTEXITCODE -ne 0) { throw "gsv config exited with status $LASTEXITCODE" }
  } catch {
    Write-Warn "Could not persist release.channel"
  }
}
Write-Success "Installed gsv and gsvd to $InstallDir"
Write-Warn "GSV Desktop is not yet released for Windows."
Write-Host ""
Write-Host "  Next: gsv auth setup"
Write-Host ""
