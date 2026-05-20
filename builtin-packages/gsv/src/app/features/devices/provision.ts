export type ProvisionInstallPlatform = "unix" | "windows";

export function buildInstallCommand(origin: string, platform: ProvisionInstallPlatform): string {
  return platform === "windows"
    ? `$env:GSV_BASE_URL='${origin}'; irm ${origin}/public/gsv/downloads/cli/install.ps1 | iex`
    : `curl -fsSL ${origin}/public/gsv/downloads/cli/install.sh | bash -s -- ${origin}`;
}

export function buildBootstrapCommand(
  origin: string,
  platform: ProvisionInstallPlatform,
  viewerUsername: string,
  deviceId: string,
  token: string,
): string {
  const gatewayWs = escapeCliValue(buildGatewayWsUrl(origin));
  const escapedViewerUsername = escapeCliValue(viewerUsername);
  const escapedDeviceId = escapeCliValue(deviceId);
  const escapedToken = escapeCliValue(token);
  const workspace = platform === "windows" ? "\"$HOME\"" : "~/";

  return [
    `gsv config --local set gateway.url "${gatewayWs}"`,
    `gsv config --local set gateway.username "${escapedViewerUsername}"`,
    `gsv config --local set node.token "${escapedToken}"`,
    `gsv device install --id "${escapedDeviceId}" --workspace ${workspace}`,
  ].join("\n");
}

function buildGatewayWsUrl(origin: string): string {
  if (origin.startsWith("https://")) {
    return `wss://${origin.slice("https://".length)}/ws`;
  }
  if (origin.startsWith("http://")) {
    return `ws://${origin.slice("http://".length)}/ws`;
  }
  return `${origin.replace(/\/+$/g, "")}/ws`;
}

function escapeCliValue(value: string): string {
  return value.replaceAll("\"", "\\\"");
}
