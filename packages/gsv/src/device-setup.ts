const INSTALL_URL = "https://install.gsv.space";
const BROWSER_DOWNLOAD_URL = "https://gsv.space/browser";
/** The GitHub release page listing every host download, including the beta Desktop app. */
export const LATEST_RELEASE_PAGE_URL = "https://github.com/deathbyknowledge/gsv/releases/latest";

export type CliInstallPlatform = "unix" | "windows";

export function buildCliInstallCommand(
  platform: CliInstallPlatform,
  release: string,
): string {
  const selector = cliReleaseSelector(release);
  if (platform === "windows") {
    return `$env:${selector.name}='${selector.value}'; irm ${INSTALL_URL}/install.ps1 | iex`;
  }
  return `curl -fsSL ${INSTALL_URL} | ${selector.name}=${selector.value} bash`;
}

export function cliReleaseLabel(release: string): string {
  const selector = cliReleaseSelector(release);
  return selector.name === "GSV_VERSION"
    ? `release ${selector.value}`
    : `${selector.value} release channel`;
}

export function browserExtensionDownloadUrl(release: string): string {
  return `${BROWSER_DOWNLOAD_URL}?release=${releaseRef(release)}`;
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
