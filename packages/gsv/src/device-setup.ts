export const DEFAULT_INSTALL_URL = "https://install.ship.space";
/** The GitHub release page listing every host download, including the beta Desktop app. */
export const LATEST_RELEASE_PAGE_URL = "https://github.com/deathbyknowledge/gsv/releases/latest";

export type CliInstallPlatform = "unix" | "windows";

/** Older Windows daemons append /install.ps1 to the protocol-error installer URL. */
export function machineUpdateInstallerUrl(platform: string | undefined, installUrl = DEFAULT_INSTALL_URL): string {
  if (!platform?.toLowerCase().startsWith("win")) return installUrl;
  const url = new URL(installUrl);
  if (url.search || url.hash) {
    const script = windowsInstallerUrl(installUrl);
    // Absorb the old daemon's literal filename suffix in a fragment. HTTP never
    // sends that fragment, so the selected script and query reach the server intact.
    script.hash = "";
    return `${script.href}#`;
  }
  if (!/\.(?:sh|ps1)$/.test(url.pathname)) return installUrl;
  url.pathname = url.pathname.slice(0, url.pathname.lastIndexOf("/"));
  return url.href;
}

export function buildCliInstallCommand(
  platform: CliInstallPlatform,
  release: string,
  installUrl = DEFAULT_INSTALL_URL,
): string {
  const selector = cliReleaseSelector(release);
  if (platform === "windows") {
    const url = windowsInstallerUrl(installUrl);
    return `$env:${selector.name}='${selector.value}'; irm '${url.href.replace(/'/g, "''")}' | iex`;
  }
  return `curl -fsSL '${installUrl.replace(/'/g, "'\\''")}' | ${selector.name}=${selector.value} bash`;
}

function windowsInstallerUrl(installUrl: string): URL {
  const url = new URL(installUrl);
  const path = url.pathname.replace(/\/+$/, "");
  const directory = /\.(?:sh|ps1)$/.test(path) ? path.slice(0, path.lastIndexOf("/")) : path;
  url.pathname = `${directory}/install.ps1`;
  return url;
}

export function cliReleaseLabel(release: string): string {
  const selector = cliReleaseSelector(release);
  return selector.name === "GSV_VERSION"
    ? `release ${selector.value}`
    : `${selector.value} release channel`;
}

export function browserExtensionDownloadUrl(release: string): string {
  return `https://ship.space/browser?release=${releaseRef(release)}`;
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
