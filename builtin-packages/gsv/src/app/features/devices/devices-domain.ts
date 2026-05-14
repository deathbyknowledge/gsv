import type { DeviceDetail, DeviceScope, DeviceSummary } from "./types";

export function filterDevices(devices: DeviceSummary[], scope: DeviceScope, query: string): DeviceSummary[] {
  const normalizedQuery = query.trim().toLowerCase();
  return devices.filter((device) => {
    if (scope === "online" && !device.online) return false;
    if (scope === "offline" && device.online) return false;
    if (!normalizedQuery) return true;
    return [
      device.deviceId,
      device.description,
      device.platform,
      device.version,
      device.ownerUsername ?? "",
      String(device.ownerUid),
    ].some((part) => part.toLowerCase().includes(normalizedQuery));
  });
}

export function deviceHealthSummary(device: DeviceDetail): string {
  const lastSeenAge = Date.now() - device.lastSeenAt;
  if (device.online) {
    return "Connected and available for routing.";
  }
  if (lastSeenAge < 10 * 60_000) {
    return "Recently disconnected. Reconnect may still be in progress.";
  }
  return "Offline. Token or agent intervention may be needed before routing work here.";
}

export function hasShell(device: DeviceDetail): boolean {
  return device.implements.some((capability) => capability.startsWith("shell."));
}

export function hasFiles(device: DeviceDetail): boolean {
  return device.implements.some((capability) => capability.startsWith("fs."));
}

export function groupCapabilities(implementsList: string[]): Array<{ name: string; items: string[] }> {
  const buckets = new Map<string, string[]>();
  for (const capability of implementsList) {
    const prefix = capability.split(".")[0] || "other";
    const name = prefix.toUpperCase();
    const bucket = buckets.get(name) ?? [];
    bucket.push(capability);
    buckets.set(name, bucket);
  }
  return [...buckets.entries()]
    .map(([name, items]) => ({ name, items: items.sort() }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function formatRelativeTime(timestamp: number): string {
  const deltaMs = Date.now() - timestamp;
  if (!Number.isFinite(deltaMs)) return "unknown";
  if (deltaMs < 60_000) return "just now";
  if (deltaMs < 3_600_000) return `${Math.round(deltaMs / 60_000)}m ago`;
  if (deltaMs < 86_400_000) return `${Math.round(deltaMs / 3_600_000)}h ago`;
  return `${Math.round(deltaMs / 86_400_000)}d ago`;
}

export function formatNullableTimestamp(timestamp: number | null): string {
  return typeof timestamp === "number" ? formatRelativeTime(timestamp) : "never";
}

export function formatOwner(device: Pick<DeviceDetail, "ownerUid" | "ownerUsername">): string {
  return device.ownerUsername || `uid ${device.ownerUid}`;
}

export function absoluteTimestamp(timestamp: number | null): string | undefined {
  return typeof timestamp === "number" ? new Date(timestamp).toLocaleString() : undefined;
}
