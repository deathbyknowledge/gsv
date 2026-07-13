const INSTALL_URL = "https://install.gsv.space";
const RELEASE_DOWNLOAD_URL = "https://github.com/deathbyknowledge/gsv/releases/download";

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
  return `${RELEASE_DOWNLOAD_URL}/${releaseRef(release)}/gsv-browser-extension.zip`;
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
