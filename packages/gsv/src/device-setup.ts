export const DEFAULT_INSTALL_URL = "https://raw.githubusercontent.com/deathbyknowledge/gsv/main/install.sh";
/** The GitHub release page listing every host download, including the beta Desktop app. */
export const LATEST_RELEASE_PAGE_URL = "https://github.com/deathbyknowledge/gsv/releases/latest";

export type CliInstallPlatform = "unix" | "windows";

export function buildCliInstallCommand(
  platform: CliInstallPlatform,
  release: string,
  installUrl = DEFAULT_INSTALL_URL,
): string {
  const selector = cliReleaseSelector(release);
  if (platform === "windows") {
    const windowsUrl = new URL("install.ps1", installUrl.endsWith("/") || installUrl.endsWith(".sh") ? installUrl : `${installUrl}/`).href;
    return `$env:${selector.name}='${selector.value}'; irm '${windowsUrl.replace(/'/g, "''")}' | iex`;
  }
  return `curl -fsSL '${installUrl.replace(/'/g, "'\\''")}' | ${selector.name}=${selector.value} bash`;
}

export function cliReleaseLabel(release: string): string {
  const selector = cliReleaseSelector(release);
  return selector.name === "GSV_VERSION"
    ? `release ${selector.value}`
    : `${selector.value} release channel`;
}

export function browserExtensionDownloadUrl(release: string): string {
  return `https://github.com/deathbyknowledge/gsv/releases/download/${releaseRef(release)}/gsv-browser-extension.zip`;
}

function cliReleaseSelector(release: string): { name: "GSV_CHANNEL" | "GSV_VERSION"; value: string } {
  const ref = releaseRef(release);
  return ref === "dev"
    ? { name: "GSV_CHANNEL", value: ref }
    : { name: "GSV_VERSION", value: ref };
}

function releaseRef(release: string): string {
  return /^v\d+\.\d+\.\d+$/.test(release) ? release : "dev";
}

export function machineDeviceIdFromName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "").slice(0, 48) || "machine";
}
