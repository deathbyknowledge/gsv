export type CliReleaseChannel = "stable" | "dev";

export const CLI_RELEASE_REPO = "deathbyknowledge/gsv";
export const CLI_DEFAULT_CHANNEL_KEY = "downloads/cli/default-channel.txt";
export const CLI_RELEASE_CHANNELS: readonly CliReleaseChannel[] = ["stable", "dev"];
export const CLI_BINARY_ASSETS = [
  "gsv-darwin-arm64",
  "gsv-darwin-x64",
  "gsv-linux-arm64",
  "gsv-linux-x64",
] as const;

export type CliBinaryAsset = typeof CLI_BINARY_ASSETS[number];

export function inferDefaultCliChannel(ref: string): CliReleaseChannel {
  const normalized = ref.trim().toLowerCase();
  if (
    normalized === "main" ||
    normalized === "stable" ||
    normalized === "release" ||
    normalized.startsWith("release/")
  ) {
    return "stable";
  }
  return "dev";
}

export async function mirrorCliChannel(
  bucket: R2Bucket,
  channel: CliReleaseChannel,
): Promise<{ channel: CliReleaseChannel; assets: CliBinaryAsset[] }> {
  for (const asset of CLI_BINARY_ASSETS) {
    const response = await fetch(cliGithubReleaseUrl(channel, asset));
    if (!response.ok) {
      throw new Error(`Failed to mirror ${asset} from ${channel}: ${response.status}`);
    }
    const bytes = await response.arrayBuffer();
    const checksum = await sha256Hex(bytes);
    await bucket.put(cliAssetKey(channel, asset), bytes, {
      httpMetadata: { contentType: "application/octet-stream" },
    });
    await bucket.put(cliChecksumKey(channel, asset), `${checksum}  ${asset}\n`, {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
    });
  }
  return { channel, assets: [...CLI_BINARY_ASSETS] };
}

export async function storeDefaultCliChannel(
  bucket: R2Bucket,
  channel: CliReleaseChannel,
): Promise<void> {
  await bucket.put(CLI_DEFAULT_CHANNEL_KEY, channel, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
  });
}

export async function loadDefaultCliChannel(bucket: R2Bucket): Promise<CliReleaseChannel> {
  const record = await bucket.get(CLI_DEFAULT_CHANNEL_KEY);
  const value = (await record?.text())?.trim();
  return value === "dev" ? "dev" : "stable";
}

export function cliAssetKey(channel: CliReleaseChannel, asset: string): string {
  return `downloads/cli/${channel}/${asset}`;
}

export function cliChecksumKey(channel: CliReleaseChannel, asset: string): string {
  return `downloads/cli/${channel}/${asset}.sha256`;
}

export function isSupportedCliChannel(value: string): value is CliReleaseChannel {
  return value === "stable" || value === "dev";
}

export function isSupportedCliAsset(value: string): value is CliBinaryAsset {
  return (CLI_BINARY_ASSETS as readonly string[]).includes(value);
}

export function buildCliInstallScript(origin: string): string {
  const baseUrl = `${origin.replace(/\/+$/g, "")}/downloads/cli`;
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    `BASE_URL=${shellQuote(baseUrl)}`,
    "CHANNEL=\"${GSV_CHANNEL:-latest}\"",
    "INSTALL_DIR=\"${INSTALL_DIR:-/usr/local/bin}\"",
    "",
    "if ! command -v curl >/dev/null 2>&1; then",
    "  echo \"curl is required to install gsv\" >&2",
    "  exit 1",
    "fi",
    "",
    "OS=$(uname -s)",
    "ARCH=$(uname -m)",
    "",
    "case \"$OS\" in",
    "  Darwin) PLATFORM=darwin ;;",
    "  Linux) PLATFORM=linux ;;",
    "  *)",
    "    echo \"Unsupported operating system: $OS\" >&2",
    "    exit 1",
    "    ;;",
    "esac",
    "",
    "case \"$ARCH\" in",
    "  arm64|aarch64) TARGET_ARCH=arm64 ;;",
    "  x86_64|amd64) TARGET_ARCH=x64 ;;",
    "  *)",
    "    echo \"Unsupported architecture: $ARCH\" >&2",
    "    exit 1",
    "    ;;",
    "esac",
    "",
    "BINARY_NAME=\"gsv-${PLATFORM}-${TARGET_ARCH}\"",
    "DOWNLOAD_URL=\"${BASE_URL}/${CHANNEL}/${BINARY_NAME}\"",
    "CHECKSUM_URL=\"${DOWNLOAD_URL}.sha256\"",
    "",
    "TMP_DIR=$(mktemp -d)",
    "trap 'rm -rf \"$TMP_DIR\"' EXIT",
    "",
    "curl -fsSL \"$DOWNLOAD_URL\" -o \"$TMP_DIR/gsv\"",
    "curl -fsSL \"$CHECKSUM_URL\" -o \"$TMP_DIR/gsv.sha256\"",
    "",
    "if command -v shasum >/dev/null 2>&1; then",
    "  ACTUAL_SUM=$(shasum -a 256 \"$TMP_DIR/gsv\" | awk '{print $1}')",
    "elif command -v sha256sum >/dev/null 2>&1; then",
    "  ACTUAL_SUM=$(sha256sum \"$TMP_DIR/gsv\" | awk '{print $1}')",
    "else",
    "  echo \"shasum or sha256sum is required to verify the gsv binary\" >&2",
    "  exit 1",
    "fi",
    "",
    "EXPECTED_SUM=$(awk '{print $1}' \"$TMP_DIR/gsv.sha256\")",
    "if [ \"$EXPECTED_SUM\" != \"$ACTUAL_SUM\" ]; then",
    "  echo \"Checksum verification failed for $BINARY_NAME\" >&2",
    "  exit 1",
    "fi",
    "",
    "chmod +x \"$TMP_DIR/gsv\"",
    "mkdir -p \"$INSTALL_DIR\"",
    "",
    "if [ -w \"$INSTALL_DIR\" ]; then",
    "  install -m 755 \"$TMP_DIR/gsv\" \"$INSTALL_DIR/gsv\"",
    "else",
    "  if ! command -v sudo >/dev/null 2>&1; then",
    "    echo \"Install directory is not writable and sudo is unavailable: $INSTALL_DIR\" >&2",
    "    exit 1",
    "  fi",
    "  sudo install -m 755 \"$TMP_DIR/gsv\" \"$INSTALL_DIR/gsv\"",
    "fi",
    "",
    "echo \"Installed gsv to $INSTALL_DIR/gsv\"",
    "echo \"If needed, add $INSTALL_DIR to your PATH.\"",
  ].join("\n");
}

export function buildCliInstallPowerShell(origin: string): string {
  const baseUrl = `${origin.replace(/\/+$/g, "")}/downloads/cli`;
  return [
    "$ErrorActionPreference = 'Stop'",
    `$BaseUrl = ${psQuote(baseUrl)}`,
    "$Channel = if ($env:GSV_CHANNEL) { $env:GSV_CHANNEL } else { 'latest' }",
    "$Arch = if ($env:PROCESSOR_ARCHITECTURE -match 'ARM64') { 'arm64' } else { 'x64' }",
    "$BinaryName = \"gsv-windows-$Arch.exe\"",
    "$DownloadUrl = \"$BaseUrl/$Channel/$BinaryName\"",
    "$ChecksumUrl = \"$DownloadUrl.sha256\"",
    "$InstallDir = if ($env:GSV_INSTALL_DIR) { $env:GSV_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\\gsv\\bin' }",
    "$TargetPath = Join-Path $InstallDir 'gsv.exe'",
    "$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString('N'))",
    "New-Item -ItemType Directory -Path $TempDir | Out-Null",
    "try {",
    "  $TempBinary = Join-Path $TempDir 'gsv.exe'",
    "  $TempChecksum = Join-Path $TempDir 'gsv.sha256'",
    "  try {",
    "    Invoke-WebRequest -Uri $DownloadUrl -OutFile $TempBinary | Out-Null",
    "    Invoke-WebRequest -Uri $ChecksumUrl -OutFile $TempChecksum | Out-Null",
    "  } catch {",
    "    throw 'Windows CLI binaries are not published for this deployment yet.'",
    "  }",
    "  $Expected = (Get-Content $TempChecksum | Select-Object -First 1).Split(' ')[0]",
    "  $Actual = (Get-FileHash -Algorithm SHA256 $TempBinary).Hash.ToLowerInvariant()",
    "  if ($Expected.ToLowerInvariant() -ne $Actual) {",
    "    throw \"Checksum verification failed for $BinaryName\"",
    "  }",
    "  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null",
    "  Move-Item -Force $TempBinary $TargetPath",
    "  if (($env:PATH -split ';') -notcontains $InstallDir) {",
    "    [Environment]::SetEnvironmentVariable('Path', ($env:PATH.TrimEnd(';') + ';' + $InstallDir), 'User')",
    "    Write-Host \"Added $InstallDir to the user PATH. Restart PowerShell if gsv is not found immediately.\"",
    "  }",
    "  Write-Host \"Installed gsv to $TargetPath\"",
    "} finally {",
    "  Remove-Item -Recurse -Force $TempDir -ErrorAction SilentlyContinue",
    "}",
  ].join("\r\n");
}

function cliGithubReleaseUrl(channel: CliReleaseChannel, asset: string): string {
  return `https://github.com/${CLI_RELEASE_REPO}/releases/download/${channel}/${asset}`;
}

async function sha256Hex(input: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", input);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
