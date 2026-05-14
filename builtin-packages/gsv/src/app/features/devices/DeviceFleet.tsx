import { ActionButton } from "../../components/ui/ActionButton";
import { formatRelativeTime } from "../../utils/format";
import { formatOwner } from "./devices-domain";
import type { DeviceScope, DeviceSummary, DevicesState } from "./types";

export function DeviceFleetPane({
  state,
  visibleDevices,
  selectedDeviceId,
  query,
  scope,
  errorText,
  onAdd,
  onQuery,
  onScope,
  onSelect,
}: {
  state: DevicesState | null;
  visibleDevices: DeviceSummary[];
  selectedDeviceId: string | null;
  query: string;
  scope: DeviceScope;
  errorText: string | null;
  onAdd: () => void;
  onQuery: (value: string) => void;
  onScope: (value: DeviceScope) => void;
  onSelect: (deviceId: string) => void;
}) {
  const viewer = state?.viewer ?? null;
  return (
    <section class="gsv-devices-list-pane" aria-label="Device fleet">
      <header class="gsv-devices-list-head">
        <div>
          <span class="gsv-kicker">Fleet</span>
          <h3>Devices</h3>
        </div>
        <ActionButton
          icon="key"
          label="Add"
          disabled={!viewer?.canManageTokens}
          title={viewer?.canManageTokens ? "Issue a node token and enroll a device." : "Token permissions are required to add devices."}
          onClick={onAdd}
        />
      </header>

      <DeviceFilters query={query} scope={scope} onQuery={onQuery} onScope={onScope} />

      <p class="gsv-runtime-meta">
        {state ? `${state.devices.length} known / ${state.devices.filter((device) => device.online).length} online` : "Loading fleet..."}
      </p>
      {errorText ? <p class="gsv-inline-error">{errorText}</p> : null}

      <div class="gsv-devices-list" aria-busy={!state ? "true" : "false"}>
        {!state ? (
          <section class="gsv-empty-state"><h3>Loading devices</h3><p>Fetching fleet state...</p></section>
        ) : visibleDevices.length === 0 ? (
          <section class="gsv-empty-state"><h3>No devices</h3><p>No devices matched the current filter.</p></section>
        ) : visibleDevices.map((device) => (
          <DeviceRow
            key={device.deviceId}
            device={device}
            selected={device.deviceId === selectedDeviceId}
            onSelect={() => onSelect(device.deviceId)}
          />
        ))}
      </div>
    </section>
  );
}

function DeviceFilters({
  query,
  scope,
  onQuery,
  onScope,
}: {
  query: string;
  scope: DeviceScope;
  onQuery: (value: string) => void;
  onScope: (value: DeviceScope) => void;
}) {
  return (
    <div class="gsv-devices-filters">
      <label class="gsv-runtime-search">
        <span>Search</span>
        <input
          type="search"
          value={query}
          placeholder="id, platform, owner"
          onInput={(event) => onQuery(event.currentTarget.value)}
        />
      </label>
      <label class="gsv-runtime-search">
        <span>Scope</span>
        <select value={scope} onChange={(event) => onScope(event.currentTarget.value as DeviceScope)}>
          <option value="all">All</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
        </select>
      </label>
    </div>
  );
}

function DeviceRow({ device, selected, onSelect }: { device: DeviceSummary; selected: boolean; onSelect: () => void }) {
  return (
    <button class={`gsv-device-row${selected ? " is-selected" : ""}`} type="button" onClick={onSelect}>
      <span class={`gsv-mark is-${device.online ? "good" : "warning"}`} aria-hidden="true"></span>
      <span class="gsv-row-copy">
        <strong>{device.deviceId}</strong>
        <span>{device.platform || "unknown"} / {formatOwner(device)}</span>
        {device.description ? <span>{device.description}</span> : null}
      </span>
      <span class="gsv-row-meta">{formatRelativeTime(device.lastSeenAt)}</span>
    </button>
  );
}
