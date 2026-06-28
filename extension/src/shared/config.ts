export type ExtensionConfig = {
  gatewayUrl: string;
  username: string;
  token: string;
  deviceId: string;
  autoConnect: boolean;
};

const DEFAULT_CONFIG: ExtensionConfig = {
  gatewayUrl: "ws://localhost:8787/ws",
  username: "",
  token: "",
  deviceId: "chrome",
  autoConnect: true,
};

const CONFIG_KEY = "gsvExtensionConfig";

export async function loadConfig(): Promise<ExtensionConfig> {
  const raw = await chrome.storage.local.get(CONFIG_KEY);
  return normalizeConfig(raw[CONFIG_KEY]);
}

export async function saveConfig(config: ExtensionConfig): Promise<ExtensionConfig> {
  const normalized = normalizeConfig(config);
  await chrome.storage.local.set({ [CONFIG_KEY]: normalized });
  return normalized;
}

export function normalizeConfig(value: unknown): ExtensionConfig {
  const record = isRecord(value) ? value : {};
  return {
    gatewayUrl: normalizeGatewayUrl(record.gatewayUrl, DEFAULT_CONFIG.gatewayUrl),
    username: normalizeString(record.username, DEFAULT_CONFIG.username),
    token: normalizeString(record.token, DEFAULT_CONFIG.token),
    deviceId: normalizeDeviceId(record.deviceId),
    autoConnect: typeof record.autoConnect === "boolean" ? record.autoConnect : DEFAULT_CONFIG.autoConnect,
  };
}

export function configReady(config: ExtensionConfig): boolean {
  return Boolean(config.gatewayUrl && config.username && config.token && config.deviceId);
}

export function normalizeGatewayUrl(value: unknown, fallback = ""): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return fallback;
  }

  const candidate = raw.replace(/\/+$/, "");
  const explicitScheme = candidate.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1]?.toLowerCase() ?? null;
  const urlText = explicitScheme
    ? candidate
    : `${inferGatewayProtocol(candidate)}://${candidate.replace(/^\/+/, "")}`;

  try {
    const url = new URL(urlText);
    if (url.protocol === "http:") {
      url.protocol = "ws:";
    } else if (url.protocol === "https:") {
      url.protocol = "wss:";
    } else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      return fallback;
    }
    url.pathname = "/ws";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return fallback;
  }
}

function normalizeString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function normalizeDeviceId(value: unknown): string {
  const normalized = normalizeString(value, DEFAULT_CONFIG.deviceId);
  return normalized || DEFAULT_CONFIG.deviceId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function inferGatewayProtocol(value: string): "ws" | "wss" {
  const authority = value.split("/")[0]?.split("@").pop()?.toLowerCase() ?? "";
  const host = authority.split(":")[0]?.replace(/^\[|\]$/g, "").toLowerCase() ?? "";
  if (
    host === "localhost"
    || host === "0.0.0.0"
    || host === "::1"
    || host.endsWith(".local")
    || host.startsWith("127.")
    || host.startsWith("10.")
    || host.startsWith("192.168.")
    || isPrivate172Host(host)
    || authority.endsWith(":8787")
  ) {
    return "ws";
  }
  return "wss";
}

function isPrivate172Host(host: string): boolean {
  const match = host.match(/^172\.(\d{1,3})\./);
  if (!match) {
    return false;
  }
  const second = Number.parseInt(match[1], 10);
  return second >= 16 && second <= 31;
}
