import type { DeviceScope, DeviceSummary } from "./types";

type DeviceListProps = {
  devices: DeviceSummary[];
  canManageTokens: boolean;
  selectedDeviceId: string | null;
  query: string;
  scope: DeviceScope;
  onQueryChange: (value: string) => void;
  onScopeChange: (value: DeviceScope) => void;
  onSelectDevice: (deviceId: string) => void;
  onStartProvision: () => void;
};

export function DeviceList({
  devices,
  canManageTokens,
  selectedDeviceId,
  query,
  scope,
  onQueryChange,
  onScopeChange,
  onSelectDevice,
  onStartProvision,
}: DeviceListProps) {
  const filtered = devices.filter((device) => {
    if (scope === "online" && !device.online) return false;
    if (scope === "offline" && device.online) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [device.deviceId, device.platform, device.version, String(device.ownerUid)]
      .some((part) => part.toLowerCase().includes(q));
  });

  return (
    <aside class="devices-sidebar">
      <header class="devices-sidebar-head">
        <div>
          <h1>Devices</h1>
          <p>Execution targets known to the gateway.</p>
        </div>
        <button class="devices-button devices-button--primary" onClick={onStartProvision} disabled={!canManageTokens} title={canManageTokens ? "Issue a node token and bootstrap a new machine." : "Only root can add devices."}>Add device</button>
      </header>

      <div class="devices-sidebar-filters">
        <label class="devices-field-block">
          <span>Search</span>
          <input
            class="devices-input"
            type="text"
            value={query}
            placeholder="Find by id, platform, owner"
            onInput={(event) => onQueryChange((event.currentTarget as HTMLInputElement).value)}
          />
        </label>
        <label class="devices-field-block devices-field-block--narrow">
          <span>Scope</span>
          <select
            class="devices-input"
            value={scope}
            onChange={(event) => onScopeChange((event.currentTarget as HTMLSelectElement).value as DeviceScope)}
          >
            <option value="all">All</option>
            <option value="online">Online</option>
            <option value="offline">Offline</option>
          </select>
        </label>
      </div>

      <div class="devices-list-summary">
        <span>{devices.length} known</span>
        <span>{devices.filter((device) => device.online).length} online</span>
      </div>

      <div class="devices-list" role="list">
        {filtered.length === 0 ? (
          <div class="devices-empty-list">No matching devices.</div>
        ) : filtered.map((device) => (
          <button
            key={device.deviceId}
            class={`devices-list-item${device.deviceId === selectedDeviceId ? " is-active" : ""}`}
            onClick={() => onSelectDevice(device.deviceId)}
          >
            <div class="devices-list-item-head">
              <strong>{device.deviceId}</strong>
              <span class={`devices-status-pill${device.online ? " is-online" : " is-offline"}`}>
                {device.online ? "online" : "offline"}
              </span>
            </div>
            <div class="devices-list-item-meta">
              <span>{device.platform || "unknown platform"}</span>
              {device.version ? <span>{device.version}</span> : null}
              <span>uid {device.ownerUid}</span>
            </div>
            <div class="devices-list-item-foot">Last seen {formatRelativeTime(device.lastSeenAt)}</div>
          </button>
        ))}
      </div>
    </aside>
  );
}

function formatRelativeTime(timestamp: number): string {
  const deltaMs = Date.now() - timestamp;
  if (deltaMs < 60_000) return "just now";
  if (deltaMs < 3_600_000) return `${Math.round(deltaMs / 60_000)}m ago`;
  if (deltaMs < 86_400_000) return `${Math.round(deltaMs / 3_600_000)}h ago`;
  return `${Math.round(deltaMs / 86_400_000)}d ago`;
}
