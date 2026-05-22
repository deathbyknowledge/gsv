import { ActionButton } from "../../components/ui/ActionButton";
import { formatRelativeTime } from "../../utils/format";
import {
  formatOwner,
  summarizeTargets,
  targetDisplayName,
  targetKind,
  targetKindLabel,
  targetSubtitle,
} from "./devices-domain";
import type { DeviceScope, DeviceSummary, DevicesState, TargetKindFilter } from "./types";

export function DeviceFleetPane({
  state,
  visibleDevices,
  selectedDeviceId,
  query,
  scope,
  kind,
  errorText,
  onAdd,
  onQuery,
  onScope,
  onKind,
  onSelect,
}: {
  state: DevicesState | null;
  visibleDevices: DeviceSummary[];
  selectedDeviceId: string | null;
  query: string;
  scope: DeviceScope;
  kind: TargetKindFilter;
  errorText: string | null;
  onAdd: () => void;
  onQuery: (value: string) => void;
  onScope: (value: DeviceScope) => void;
  onKind: (value: TargetKindFilter) => void;
  onSelect: (deviceId: string) => void;
}) {
  const viewer = state?.viewer ?? null;
  const summary = state ? summarizeTargets(state.devices) : null;
  return (
    <section class="gsv-devices-list-pane" aria-label="Target list">
      <header class="gsv-devices-list-head">
        <div>
          <span class="gsv-kicker">Targets</span>
          <h3>Available surfaces</h3>
        </div>
        <ActionButton
          icon="key"
          label="Add node"
          disabled={!viewer?.canManageTokens}
          title={viewer?.canManageTokens ? "Issue a node token and enroll a native device." : "Token permissions are required to add native devices."}
          onClick={onAdd}
        />
      </header>

      <DeviceFilters query={query} scope={scope} kind={kind} onQuery={onQuery} onScope={onScope} onKind={onKind} />

      {summary ? <TargetSummaryStrip summary={summary} /> : <p class="gsv-runtime-meta">Loading targets...</p>}
      {errorText ? <p class="gsv-inline-error">{errorText}</p> : null}

      <div class="gsv-devices-list" aria-busy={!state ? "true" : "false"}>
        {!state ? (
          <section class="gsv-empty-state"><h3>Loading targets</h3><p>Fetching target state...</p></section>
        ) : visibleDevices.length === 0 ? (
          <section class="gsv-empty-state"><h3>No targets</h3><p>No targets matched the current filter.</p></section>
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
  kind,
  onQuery,
  onScope,
  onKind,
}: {
  query: string;
  scope: DeviceScope;
  kind: TargetKindFilter;
  onQuery: (value: string) => void;
  onScope: (value: DeviceScope) => void;
  onKind: (value: TargetKindFilter) => void;
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
        <span>Kind</span>
        <select value={kind} onChange={(event) => onKind(event.currentTarget.value as TargetKindFilter)}>
          <option value="all">All</option>
          <option value="native-device">Native</option>
          <option value="browser">Browser</option>
          <option value="adapter">Adapter</option>
        </select>
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

function TargetSummaryStrip({ summary }: { summary: ReturnType<typeof summarizeTargets> }) {
  return (
    <div class="gsv-target-summary" aria-label="Target summary">
      <span><strong>{summary.online}/{summary.total}</strong> online</span>
      <span><strong>{summary.native}</strong> native</span>
      <span><strong>{summary.browser}</strong> browser</span>
      <span><strong>{summary.adapter}</strong> adapter</span>
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
