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
  deviceId: "browser:chrome",
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
    gatewayUrl: normalizeString(record.gatewayUrl, DEFAULT_CONFIG.gatewayUrl),
    username: normalizeString(record.username, DEFAULT_CONFIG.username),
    token: normalizeString(record.token, DEFAULT_CONFIG.token),
    deviceId: normalizeDeviceId(record.deviceId),
    autoConnect: typeof record.autoConnect === "boolean" ? record.autoConnect : DEFAULT_CONFIG.autoConnect,
  };
}

export function configReady(config: ExtensionConfig): boolean {
  return Boolean(config.gatewayUrl && config.username && config.token && config.deviceId);
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
