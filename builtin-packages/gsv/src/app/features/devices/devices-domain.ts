import type { DeviceDetail, DeviceScope, DeviceSummary, TargetKind, TargetKindFilter } from "./types";

export type TargetFleetSummary = {
  total: number;
  online: number;
  native: number;
  browser: number;
  adapter: number;
};

export function filterDevices(
  devices: DeviceSummary[],
  scope: DeviceScope,
  kind: TargetKindFilter,
  query: string,
): DeviceSummary[] {
  const normalizedQuery = query.trim().toLowerCase();
  return devices.filter((device) => {
    if (scope === "online" && !device.online) return false;
    if (scope === "offline" && device.online) return false;
    if (kind !== "all" && targetKind(device) !== kind) return false;
    if (!normalizedQuery) return true;
    return [
      device.deviceId,
      device.label,
      device.description,
      device.platform,
      device.version,
      targetKindLabel(targetKind(device)),
      device.ownerUsername ?? "",
      String(device.ownerUid),
    ].some((part) => part.toLowerCase().includes(normalizedQuery));
  });
}

export function summarizeTargets(devices: DeviceSummary[]): TargetFleetSummary {
  return devices.reduce<TargetFleetSummary>((summary, device) => {
    const kind = targetKind(device);
    summary.total += 1;
    if (device.online) summary.online += 1;
    if (kind === "native-device") summary.native += 1;
    if (kind === "browser") summary.browser += 1;
    if (kind === "adapter") summary.adapter += 1;
    return summary;
  }, { total: 0, online: 0, native: 0, browser: 0, adapter: 0 });
}

export function targetKind(device: Pick<DeviceSummary, "deviceId" | "platform">): TargetKind {
  const platform = device.platform.toLowerCase();
  if (
    device.deviceId.startsWith("browser:")
    || platform === "browser"
    || platform === "browser-extension"
  ) {
    return "browser";
  }
  if (device.deviceId.startsWith("adapter:") || platform === "adapter") return "adapter";
  return "native-device";
}

export function targetKindLabel(kind: TargetKind): string {
  if (kind === "browser") return "Browser";
  if (kind === "adapter") return "Adapter";
  return "Native";
}

export function targetDisplayName(device: Pick<DeviceSummary, "deviceId" | "label">): string {
  const label = device.label.trim();
  return label && label !== device.deviceId ? label : device.deviceId;
}

export function targetSubtitle(device: Pick<DeviceSummary, "deviceId" | "label">): string | null {
  return targetDisplayName(device) === device.deviceId ? null : device.deviceId;
}

export function canManageNodeAccess(device: DeviceSummary): boolean {
  return targetKind(device) === "native-device";
}

export function canEditTargetMetadata(device: DeviceSummary): boolean {
  return targetKind(device) !== "adapter";
}

export function deviceHealthSummary(device: DeviceDetail): string {
  const lastSeenAge = Date.now() - device.lastSeenAt;
  if (device.online) {
    return "Connected and available for routing.";
  }
  if (lastSeenAge < 10 * 60_000) {
    return "Recently disconnected. Reconnect may still be in progress.";
  }
  return "Offline. Reconnect or access intervention may be needed before routing work here.";
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
