export type MachineProvisionPlatform = "mac" | "windows" | "linux" | "browser";

export type MachineProvisionStep = "platform" | "details" | "install" | "connect" | "success";

export type MachineProvisionPlatformOption = {
  id: MachineProvisionPlatform;
  label: string;
  meta: string;
  commandLabel: string;
  dotIcon: string;
};

export const MACHINE_PROVISION_STEPS: MachineProvisionStep[] = [
  "platform",
  "details",
  "install",
  "connect",
  "success",
];

export const MACHINE_PROVISION_STEP_LABELS = [
  "PLATFORM",
  "DETAILS",
  "INSTALL",
  "CONNECT",
  "SUCCESS",
] as const;

export const BROWSER_EXTENSION_DOWNLOAD_URL =
  "https://github.com/deathbyknowledge/gsv/releases/latest/download/gsv-browser-extension.zip";

export const MACHINE_PLATFORM_OPTIONS: MachineProvisionPlatformOption[] = [
  {
    id: "mac",
    label: "MAC",
    meta: "Apple desktop or laptop",
    commandLabel: "macOS / zsh",
    dotIcon: "apple",
  },
  {
    id: "windows",
    label: "WINDOWS",
    meta: "PowerShell target",
    commandLabel: "Windows / PowerShell",
    dotIcon: "windows",
  },
  {
    id: "linux",
    label: "LINUX",
    meta: "Server or workstation",
    commandLabel: "Linux / bash",
    dotIcon: "redhat",
  },
  {
    id: "browser",
    label: "BROWSER",
    meta: "Browser extension",
    commandLabel: "Extension options",
    dotIcon: "chrome",
  },
];

const DEFAULT_EXPIRES_DAYS = 30;

export function stepIndex(step: MachineProvisionStep): number {
  return MACHINE_PROVISION_STEPS.indexOf(step);
}

export function platformOption(platform: MachineProvisionPlatform): MachineProvisionPlatformOption {
  return MACHINE_PLATFORM_OPTIONS.find((option) => option.id === platform) ?? MACHINE_PLATFORM_OPTIONS[0];
}

export function defaultMachineName(platform: MachineProvisionPlatform): string {
  if (platform === "mac") {
    return "Mac workstation";
  }
  if (platform === "windows") {
    return "Windows workstation";
  }
  if (platform === "browser") {
    return "Chrome";
  }
  return "Linux machine";
}

export function machineDeviceIdFromName(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return base || "machine";
}

export function normalizeExpiresDays(value: string): number {
  const parsed = Number(value.trim() || String(DEFAULT_EXPIRES_DAYS));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_EXPIRES_DAYS;
  }
  return Math.max(1, Math.min(365, Math.floor(parsed)));
}

export function expiresAtFromDays(days: number, now = Date.now()): number {
  return now + normalizeExpiresDays(String(days)) * 24 * 60 * 60 * 1000;
}

export function buildMachineInstallCommand(origin: string, platform: MachineProvisionPlatform): string {
  if (platform === "browser") {
    return "";
  }
  const normalizedOrigin = trimTrailingSlash(origin);
  if (platform === "windows") {
    return `$env:GSV_BASE_URL='${normalizedOrigin}'; irm ${normalizedOrigin}/public/gsv/downloads/cli/install.ps1 | iex`;
  }
  return `curl -fsSL ${normalizedOrigin}/public/gsv/downloads/cli/install.sh | bash -s -- ${normalizedOrigin}`;
}

export function buildBrowserExtensionConfig(input: {
  origin: string;
  username: string;
  deviceId: string;
  token: string;
}): {
  gatewayUrl: string;
  username: string;
  token: string;
  deviceId: string;
} {
  return {
    gatewayUrl: buildGatewayWsUrl(input.origin),
    username: input.username.trim() || "root",
    token: input.token.trim(),
    deviceId: input.deviceId.trim(),
  };
}

export function buildMachineBootstrapCommand(input: {
  origin: string;
  platform: MachineProvisionPlatform;
  username: string;
  deviceId: string;
  token: string;
}): string {
  const gatewayWs = escapeCliValue(buildGatewayWsUrl(input.origin));
  const username = escapeCliValue(input.username.trim() || "root");
  const deviceId = escapeCliValue(input.deviceId.trim());
  const token = escapeCliValue(input.token.trim());
  const workspace = input.platform === "windows" ? "\"$HOME\"" : "~/";
  const cli = cliExecutableName(input.platform);

  return [
    `${cli} config --local set gateway.url "${gatewayWs}"`,
    `${cli} config --local set gateway.username "${username}"`,
    `${cli} config --local set node.token "${token}"`,
    `${cli} device install --id "${deviceId}" --workspace ${workspace}`,
  ].join("\n");
}

function cliExecutableName(platform: MachineProvisionPlatform): string {
  return platform === "windows" ? "gsv.exe" : "gsv";
}

function buildGatewayWsUrl(origin: string): string {
  const normalizedOrigin = trimTrailingSlash(origin);
  if (normalizedOrigin.startsWith("https://")) {
    return `wss://${normalizedOrigin.slice("https://".length)}/ws`;
  }
  if (normalizedOrigin.startsWith("http://")) {
    return `ws://${normalizedOrigin.slice("http://".length)}/ws`;
  }
  return `${normalizedOrigin}/ws`;
}

function trimTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/g, "");
}

function escapeCliValue(value: string): string {
  return value.replaceAll("\"", "\\\"");
}
