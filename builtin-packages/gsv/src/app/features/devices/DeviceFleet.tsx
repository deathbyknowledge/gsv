import { ActionButton } from "../../components/ui/ActionButton";
import { formatRelativeTime } from "../../utils/format";
import {
  formatOwner,
  summarizeFleet,
  targetDisplayName,
  targetKind,
  targetKindLabel,
  targetSubtitle,
} from "./devices-domain";
import type { DeviceScope, DeviceSummary, DevicesState } from "./types";

export function DeviceFleetPane({
  state,
  visibleDevices,
  selectedDeviceId,
  query,
  scope,
  includeServiceConnections,
  errorText,
  onAdd,
  onQuery,
  onScope,
  onIncludeServiceConnections,
  onSelect,
}: {
  state: DevicesState | null;
  visibleDevices: DeviceSummary[];
  selectedDeviceId: string | null;
  query: string;
  scope: DeviceScope;
  includeServiceConnections: boolean;
  errorText: string | null;
  onAdd: () => void;
  onQuery: (value: string) => void;
  onScope: (value: DeviceScope) => void;
  onIncludeServiceConnections: (value: boolean) => void;
  onSelect: (deviceId: string) => void;
}) {
  const viewer = state?.viewer ?? null;
  const summary = state ? summarizeFleet(state.devices) : null;
  return (
    <section class="gsv-devices-list-pane" aria-label="Fleet machines">
      <header class="gsv-devices-list-head">
        <div>
          <span class="gsv-kicker">Fleet</span>
          <h3>Machines</h3>
        </div>
        <ActionButton
          icon="device"
          label="New machine"
          size="compact"
          disabled={!viewer?.canManageTokens}
          title={viewer?.canManageTokens ? "Connect a machine to this fleet." : "Machine connection permissions are required."}
          onClick={onAdd}
        />
      </header>

      <DeviceFilters
        query={query}
        scope={scope}
        includeServiceConnections={includeServiceConnections}
        onQuery={onQuery}
        onScope={onScope}
        onIncludeServiceConnections={onIncludeServiceConnections}
      />

      {summary ? (
        <FleetSummaryStrip summary={summary} includeServiceConnections={includeServiceConnections} />
      ) : (
        <p class="gsv-runtime-meta">Loading machines...</p>
      )}
      {errorText ? <p class="gsv-inline-error">{errorText}</p> : null}

      <div class="gsv-devices-list" aria-busy={!state ? "true" : "false"}>
        {!state ? (
          <section class="gsv-empty-state"><h3>Loading machines</h3><p>Fetching fleet state...</p></section>
        ) : visibleDevices.length === 0 ? (
          <section class="gsv-empty-state"><h3>No machines</h3><p>No machines matched the current filter.</p></section>
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
  includeServiceConnections,
  onQuery,
  onScope,
  onIncludeServiceConnections,
}: {
  query: string;
  scope: DeviceScope;
  includeServiceConnections: boolean;
  onQuery: (value: string) => void;
  onScope: (value: DeviceScope) => void;
  onIncludeServiceConnections: (value: boolean) => void;
}) {
  return (
    <div class="gsv-devices-filters">
      <label class="gsv-runtime-search">
        <span>Search</span>
        <input
          type="search"
          value={query}
          placeholder="machine id, platform, owner"
          onInput={(event) => onQuery(event.currentTarget.value)}
        />
      </label>
      <label class="gsv-runtime-search">
        <span>Status</span>
        <select value={scope} onChange={(event) => onScope(event.currentTarget.value as DeviceScope)}>
          <option value="all">All</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
        </select>
      </label>
      <label class="gsv-service-toggle">
        <input
          type="checkbox"
          checked={includeServiceConnections}
          onChange={(event) => onIncludeServiceConnections(event.currentTarget.checked)}
        />
        <span>Service connections</span>
      </label>
    </div>
  );
}

function FleetSummaryStrip({
  summary,
  includeServiceConnections,
}: {
  summary: ReturnType<typeof summarizeFleet>;
  includeServiceConnections: boolean;
}) {
  return (
    <div class="gsv-target-summary" aria-label="Fleet summary">
      <span><strong>{summary.onlineMachines}/{summary.machines}</strong> machines online</span>
      {includeServiceConnections ? (
        <span><strong>{summary.onlineServiceConnections}/{summary.serviceConnections}</strong> service connections online</span>
      ) : summary.serviceConnections > 0 ? (
        <span><strong>{summary.serviceConnections}</strong> service connections hidden</span>
      ) : null}
    </div>
  );
}

function DeviceRow({ device, selected, onSelect }: { device: DeviceSummary; selected: boolean; onSelect: () => void }) {
  const kind = targetKind(device);
  const subtitle = targetSubtitle(device);
  return (
    <button class={`gsv-device-row${selected ? " is-selected" : ""}`} type="button" onClick={onSelect}>
      <span class={`gsv-mark is-${device.online ? "good" : "warning"}`} aria-hidden="true"></span>
      <span class="gsv-row-copy">
        <strong>{targetDisplayName(device)}</strong>
        {subtitle ? <span>{subtitle}</span> : null}
        <span>{device.platform || "unknown"} / {formatOwner(device)}</span>
        {device.description ? <span>{device.description}</span> : null}
      </span>
      <span class="gsv-target-row-meta">
        <span class={`gsv-target-kind is-${kind}`}>{targetKindLabel(kind)}</span>
        <span class="gsv-row-meta">{formatRelativeTime(device.lastSeenAt)}</span>
      </span>
    </button>
  );
}
