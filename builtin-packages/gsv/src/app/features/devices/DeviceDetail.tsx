import { openApp } from "@gsv/package/host";
import { useEffect, useState } from "preact/hooks";
import { ActionButton } from "../../components/ui/ActionButton";
import { Icon, type IconName } from "../../components/ui/Icon";
import {
  absoluteTimestamp,
  canEditTargetMetadata,
  canManageNodeAccess,
  formatNullableTimestamp,
  formatOwner,
  groupCapabilities,
  hasFiles,
  hasShell,
  deviceHealthSummary,
  targetDisplayName,
  targetKind,
  targetKindLabel,
  targetSubtitle,
} from "./devices-domain";
import type { DeviceDetail, DeviceToken, DevicesTabId, DevicesViewer } from "./types";

export function DeviceDetailPanel({
  device,
  viewer,
  activeTab,
  tokens,
  pendingAction,
  onTab,
  onBackToFleet,
  onProvision,
  onRevoke,
  onUpdateDescription,
}: {
  device: DeviceDetail | null;
  viewer: DevicesViewer | null;
  activeTab: DevicesTabId;
  tokens: DeviceToken[];
  pendingAction: string | null;
  onTab: (tab: DevicesTabId) => void;
  onBackToFleet: () => void;
  onProvision: (deviceId: string) => void;
  onRevoke: (tokenId: string) => void;
  onUpdateDescription: (deviceId: string, description: string) => void;
}) {
  if (!device) {
    return (
      <section class="gsv-device-detail" aria-label="Target detail">
        <header class="gsv-device-detail-head">
          <ActionButton icon="arrow-left" label="Targets" onClick={onBackToFleet} />
          <div>
            <span class="gsv-kicker">Target detail</span>
            <h3>No target selected</h3>
          </div>
        </header>
        <div class="gsv-empty-state">
          <p>Choose a target from the list or add a native execution node.</p>
        </div>
      </section>
    );
  }

  const kind = targetKind(device);
  const subtitle = targetSubtitle(device);
  const canManageAccess = Boolean(viewer?.canManageTokens && canManageNodeAccess(device));

  return (
    <section class="gsv-device-detail" aria-label="Target detail">
      <header class="gsv-device-detail-head">
        <ActionButton icon="arrow-left" label="Targets" onClick={onBackToFleet} />
        <div>
          <span class="gsv-kicker">{targetKindLabel(kind)} target</span>
          <h3>{targetDisplayName(device)}</h3>
          <p>{subtitle ? `${subtitle} / ` : ""}{device.online ? "Online and ready for routing." : "Offline. Review health before routing work here."}</p>
        </div>
        <div class="gsv-device-actions">
          <ActionButton
            icon="folder"
            label="Files"
            disabled={!hasFiles(device)}
            title={hasFiles(device) ? "Open this target in Files." : "Files capability is unavailable on this target."}
            onClick={() => openApp({ target: "files", payload: { device: device.deviceId, path: "." } })}
          />
          <ActionButton
            icon="terminal"
            label="Shell"
            disabled={!hasShell(device)}
            title={hasShell(device) ? "Open this target in Shell." : "Shell capability is unavailable on this target."}
            onClick={() => openApp({ target: "shell", payload: { device: device.deviceId, cwd: "." } })}
          />
          {canManageAccess ? (
            <ActionButton icon="key" label="Add access" onClick={() => onProvision(device.deviceId)} />
          ) : null}
        </div>
      </header>

      <nav class="gsv-local-tabs" aria-label="Target tabs">
        {([
          ["overview", "Overview"],
          ["capabilities", "Capabilities"],
          ["access", "Access"],
          ["health", "Health"],
        ] as Array<[DevicesTabId, string]>).map(([tab, label]) => (
          <button key={tab} type="button" class={activeTab === tab ? "is-active" : ""} onClick={() => onTab(tab)}>
            {label}
          </button>
        ))}
      </nav>

      {activeTab === "overview" ? (
        <DeviceOverview
          device={device}
          canEdit={Boolean(viewer && canEditTargetMetadata(device) && (viewer.uid === 0 || viewer.uid === device.ownerUid))}
          pending={pendingAction === "update-description"}
          onUpdateDescription={(description) => onUpdateDescription(device.deviceId, description)}
        />
      ) : null}
      {activeTab === "capabilities" ? <DeviceCapabilities device={device} /> : null}
      {activeTab === "access" ? <DeviceAccess viewer={viewer} device={device} tokens={tokens} pendingAction={pendingAction} onProvision={onProvision} onRevoke={onRevoke} /> : null}
      {activeTab === "health" ? <DeviceHealth device={device} /> : null}
    </section>
  );
}

function DeviceOverview({
  device,
  canEdit,
  pending,
  onUpdateDescription,
}: {
  device: DeviceDetail;
  canEdit: boolean;
  pending: boolean;
  onUpdateDescription: (description: string) => void;
}) {
  const [description, setDescription] = useState(device.description);
  const changed = description.trim() !== device.description.trim();

  useEffect(() => {
    setDescription(device.description);
  }, [device.deviceId, device.description]);

  return (
    <section class="gsv-device-tab">
      <div class="gsv-device-note">
        <label>
          <span>Target note</span>
          <textarea
            value={description}
            maxLength={500}
            readOnly={!canEdit}
            disabled={pending}
            placeholder="Local workstation, browser session, or adapter account purpose"
            onInput={(event) => setDescription(event.currentTarget.value)}
          />
        </label>
        <div class="gsv-device-note-actions">
          <span>{description.length}/500</span>
          <ActionButton
            icon="check"
            label="Save note"
            busyLabel="Saving"
            busy={pending}
            disabled={!canEdit || !changed}
            onClick={() => onUpdateDescription(description)}
          />
        </div>
      </div>

      <div class="gsv-device-facts" aria-label="Target overview">
        <FactChip icon="activity" label="Status" value={device.online ? "Ready" : "Offline"} tone={device.online ? "good" : "warning"} />
        <FactChip icon="device" label="Kind" value={targetKindLabel(targetKind(device))} />
        <FactChip icon="server" label="Platform" value={device.platform || "Unknown"} />
        <FactChip icon="code" label="Version" value={device.version || "Unknown"} />
        <FactChip icon="user" label="Owner" value={formatOwner(device)} />
        <FactChip icon="clock" label="First seen" value={formatNullableTimestamp(device.firstSeenAt)} title={absoluteTimestamp(device.firstSeenAt)} />
        <FactChip icon="clock" label="Last seen" value={formatNullableTimestamp(device.lastSeenAt)} title={absoluteTimestamp(device.lastSeenAt)} />
        <CapabilityIndicator icon="terminal" label="Shell" available={hasShell(device)} />
        <CapabilityIndicator icon="folder" label="Files" available={hasFiles(device)} />
      </div>
    </section>
  );
}

function DeviceCapabilities({ device }: { device: DeviceDetail }) {
  const groups = groupCapabilities(device.implements);
  return (
    <section class="gsv-device-tab">
      <div class="gsv-capability-groups">
        {groups.map((group) => (
          <section key={group.name} class="gsv-capability-group">
            <header>
              <h4>{group.name}</h4>
              <span>{group.items.length} capability{group.items.length === 1 ? "" : "ies"}</span>
            </header>
            <div>{group.items.map((item) => <code key={item}>{item}</code>)}</div>
          </section>
        ))}
      </div>
    </section>
  );
}

function DeviceAccess({
  viewer,
  device,
  tokens,
  pendingAction,
  onProvision,
  onRevoke,
}: {
  viewer: DevicesViewer | null;
  device: DeviceDetail;
  tokens: DeviceToken[];
  pendingAction: string | null;
  onProvision: (deviceId: string) => void;
  onRevoke: (tokenId: string) => void;
}) {
  if (!canManageNodeAccess(device)) {
    const kind = targetKindLabel(targetKind(device)).toLowerCase();
    return (
      <section class="gsv-device-tab">
        <div class="gsv-info-box">
          <span>Access model</span>
          <strong>{targetDisplayName(device)}</strong>
          <p>{kind} targets are provided by their owning connection or integration account, so node tokens are not issued here.</p>
        </div>
      </section>
    );
  }

  return (
    <section class="gsv-device-tab">
      <div class="gsv-device-access-head">
        <span>{tokens.length} node token{tokens.length === 1 ? "" : "s"}</span>
        {viewer?.canManageTokens ? <ActionButton icon="key" label="Issue token" onClick={() => onProvision(device.deviceId)} /> : null}
      </div>
      <div class="gsv-token-list">
        {tokens.length === 0 ? (
          <section class="gsv-empty-state"><h3>No node tokens</h3><p>No node tokens are issued for this target.</p></section>
        ) : tokens.map((token) => {
          const revoked = typeof token.revokedAt === "number";
          return (
            <article class="gsv-token-row" key={token.tokenId}>
              <span class={`gsv-mark is-${revoked ? "warning" : "good"}`} aria-hidden="true"></span>
              <span class="gsv-row-copy">
                <strong>{token.tokenPrefix}</strong>
                <span>{token.label || device.deviceId} / {revoked ? "revoked" : "active"}</span>
                <span title={absoluteTimestamp(token.createdAt)}>created {formatNullableTimestamp(token.createdAt)}</span>
                <span title={absoluteTimestamp(token.lastUsedAt)}>last used {formatNullableTimestamp(token.lastUsedAt)}</span>
                <span title={absoluteTimestamp(token.expiresAt)}>expires {formatNullableTimestamp(token.expiresAt)}</span>
              </span>
              {viewer?.canManageTokens && !revoked ? (
                <ActionButton
                  icon="trash"
                  label="Revoke"
                  variant="danger"
                  disabled={pendingAction === `revoke:${token.tokenId}`}
                  onClick={() => onRevoke(token.tokenId)}
                />
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function DeviceHealth({ device }: { device: DeviceDetail }) {
  return (
    <section class="gsv-device-tab">
      <div class={`gsv-health-banner${device.online ? " is-ready" : " is-warning"}`}>
        <strong>{device.online ? "Ready" : "Needs attention"}</strong>
        <span>{deviceHealthSummary(device)}</span>
      </div>
      <dl class="gsv-detail-list">
        <div><dt>Last heartbeat</dt><dd title={absoluteTimestamp(device.lastSeenAt)}>{formatNullableTimestamp(device.lastSeenAt)}</dd></div>
        <div><dt>Connected</dt><dd title={absoluteTimestamp(device.connectedAt)}>{formatNullableTimestamp(device.connectedAt)}</dd></div>
        <div><dt>Disconnected</dt><dd title={absoluteTimestamp(device.disconnectedAt)}>{formatNullableTimestamp(device.disconnectedAt)}</dd></div>
        <div><dt>Capabilities</dt><dd>{device.implements.length}</dd></div>
      </dl>
    </section>
  );
}

function FactChip({
  icon,
  label,
  value,
  tone,
  title,
}: {
  icon: IconName;
  label: string;
  value: string;
  tone?: "good" | "warning";
  title?: string;
}) {
  return (
    <span class={`gsv-device-fact${tone ? ` is-${tone}` : ""}`} title={title}>
      <Icon name={icon} />
      <span>{label}</span>
      <strong>{value}</strong>
    </span>
  );
}

function CapabilityIndicator({
  icon,
  label,
  available,
}: {
  icon: IconName;
  label: string;
  available: boolean;
}) {
  return (
    <span
      class={`gsv-device-capability-indicator is-${available ? "available" : "unavailable"}`}
      title={`${label} capability is ${available ? "available" : "unavailable"} on this target.`}
    >
      <Icon name={icon} />
      <span>{label}</span>
      <strong>{available ? "Yes" : "No"}</strong>
    </span>
  );
}
