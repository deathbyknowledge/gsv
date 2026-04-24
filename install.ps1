$ErrorActionPreference = "Stop"

$Repo = "deathbyknowledge/gsv"
$InstallDir = if ($env:GSV_INSTALL_DIR) {
  $env:GSV_INSTALL_DIR
} else {
  Join-Path $env:LOCALAPPDATA "Programs\gsv\bin"
}
$Channel = if ($env:GSV_CHANNEL) { $env:GSV_CHANNEL } else { "stable" }
$Version = if ($env:GSV_VERSION) { $env:GSV_VERSION } else { "" }
$ConfigRoot = if ($env:APPDATA) {
  $env:APPDATA
} else {
  Join-Path $env:USERPROFILE "AppData\Roaming"
}
$ConfigDir = Join-Path $ConfigRoot "gsv"
$BinaryName = "gsv-windows-x64.exe"
$DevReleaseTag = "dev"

function Write-Info([string]$Message) {
  Write-Host "  -> $Message" -ForegroundColor Cyan
}

function Write-Success([string]$Message) {
  Write-Host "  OK $Message" -ForegroundColor Green
}

function Write-Warn([string]$Message) {
  Write-Host "  !! $Message" -ForegroundColor Yellow
}

function Get-GithubJson([string]$Url) {
  Invoke-RestMethod -Headers @{
    Accept = "application/vnd.github+json"
    "User-Agent" = "gsv-installer"
  } -Uri $Url
}

function Add-CacheBustIfDev([string]$ReleaseRef, [string]$Url) {
  if ($ReleaseRef -ne $DevReleaseTag) {
    return $Url
  }

  $separator = if ($Url.Contains("?")) { "&" } else { "?" }
  return "$Url${separator}ts=$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
}

function Resolve-ReleaseTag {
  if ($Version) {
    return $Version
  }

  if ($Channel -eq "stable") {
    $release = Get-GithubJson "https://api.github.com/repos/$Repo/releases/latest"
    if (-not $release.tag_name) {
      throw "Could not resolve latest stable release tag"
    }
    return [string]$release.tag_name
  }

  if ($Channel -ne "dev") {
    throw "Invalid GSV_CHANNEL '$Channel' (must be 'stable' or 'dev')"
  }

  try {
    $release = Get-GithubJson "https://api.github.com/repos/$Repo/releases/tags/$DevReleaseTag"
    if ($release.tag_name) {
      return [string]$release.tag_name
    }
  } catch {
  }

  $releases = Get-GithubJson "https://api.github.com/repos/$Repo/releases?per_page=20"
  foreach ($release in $releases) {
    $tag = [string]$release.tag_name
    if (-not $release.draft -and ($tag -eq $DevReleaseTag -or ($release.prerelease -and $tag -match "^v\d+\.\d+\.\d+-[0-9A-Za-z.-]+$"))) {
      return $tag
    }
  }

  throw "Could not resolve latest dev prerelease tag"
}

function Ensure-ConfigFile {
  $configFile = Join-Path $ConfigDir "config.toml"
  New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null

  if (Test-Path $configFile) {
    Write-Info "Found existing config at $configFile, leaving unchanged"
    return
  }

  $configContent = if ($Version) {
@"
# GSV CLI configuration
# Set values explicitly when ready, e.g.:
#   gsv config --local set gateway.url wss://<your-gateway>.workers.dev/ws
#   gsv config --local set gateway.token <your-auth-token>

[release]
# Preferred default upgrade/setup channel (`stable` or `dev`)
# channel = "stable"
"@
  } else {
@"
# GSV CLI configuration
# Set values explicitly when ready, e.g.:
#   gsv config --local set gateway.url wss://<your-gateway>.workers.dev/ws
#   gsv config --local set gateway.token <your-auth-token>

[release]
channel = "$Channel"
"@
  }

  Set-Content -Path $configFile -Value $configContent -Encoding UTF8
  Write-Success "Created config file at $configFile"
}

function Persist-ReleaseChannel {
  if ($Version) {
    return
  }

  $gsvBin = Join-Path $InstallDir "gsv.exe"
  if (-not (Test-Path $gsvBin)) {
    return
  }

  try {
    & $gsvBin config --local set release.channel $Channel *> $null
    Write-Success "Saved default release channel ($Channel)"
  } catch {
    Write-Warn "Could not persist release.channel in local config"
  }
}

function Install-GsvCli {
  $releaseRef = Resolve-ReleaseTag
  $downloadUrl = Add-CacheBustIfDev $releaseRef "https://github.com/$Repo/releases/download/$releaseRef/$BinaryName"
  $checksumUrl = Add-CacheBustIfDev $releaseRef "https://github.com/$Repo/releases/download/$releaseRef/checksums.txt"
  $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString("N"))
  $tempFile = Join-Path $tempDir "gsv.exe"
  $targetPath = Join-Path $InstallDir "gsv.exe"

  if ($env:PROCESSOR_ARCHITECTURE -match "ARM64") {
    Write-Warn "Using the Windows x64 CLI build on ARM64."
  }

  New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
  try {
    Write-Info "Downloading CLI ($releaseRef) for windows-x64..."
    Invoke-WebRequest -Uri $downloadUrl -OutFile $tempFile | Out-Null

    $checksums = (Invoke-WebRequest -Uri $checksumUrl).Content
    $expectedLine = ($checksums -split "`r?`n" |
      ForEach-Object { $_.Trim() } |
      Where-Object { $_ -match ([regex]::Escape($BinaryName) + "$") } |
      Select-Object -First 1)
    if (-not $expectedLine) {
      throw "Could not locate checksum for $BinaryName"
    }

    $expectedSum = ($expectedLine -split "\s+")[0].ToLowerInvariant()
    $actualSum = (Get-FileHash -Algorithm SHA256 $tempFile).Hash.ToLowerInvariant()
    if ($expectedSum -ne $actualSum) {
      throw "Checksum verification failed for $BinaryName"
    }

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    Move-Item -Force $tempFile $targetPath
    Write-Success "Installed to $targetPath"

    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $pathEntries = if ([string]::IsNullOrWhiteSpace($userPath)) {
      @()
    } else {
      $userPath -split ";" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    }

    if ($pathEntries -notcontains $InstallDir) {
      $newUserPath = if ([string]::IsNullOrWhiteSpace($userPath)) {
        $InstallDir
      } else {
        $userPath.TrimEnd(";") + ";" + $InstallDir
      }
      [Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")
      Write-Success "Added $InstallDir to the user PATH"
      Write-Info "Restart PowerShell if gsv is not found immediately"
    }
  } finally {
    Remove-Item -Recurse -Force $tempDir -ErrorAction SilentlyContinue
  }
}

Write-Host ""
Write-Host "GSV Installer (Windows)" -ForegroundColor Cyan
if ($Version) {
  Write-Host "  Platform: windows-x64  Version: $Version"
} else {
  Write-Host "  Platform: windows-x64  Channel: $Channel"
}
Write-Host ""

Install-GsvCli
Write-Host ""
Ensure-ConfigFile
Persist-ReleaseChannel
Write-Host ""
Write-Host "Setup complete." -ForegroundColor Green
Write-Host "  CLI installed."
Write-Host "  Config:  $(Join-Path $ConfigDir 'config.toml')"
Write-Host ""
Write-Host "  Next steps:"
Write-Host "    gsv setup"
Write-Host "    gsv config --local set gateway.url wss://<your-gateway>.workers.dev/ws"
Write-Host "    gsv config --local set gateway.token <your-auth-token>"
Write-Host "    gsv chat `"Hello!`""
Write-Host ""
Write-Host "  Docs: https://github.com/$Repo"
Write-Host ""
