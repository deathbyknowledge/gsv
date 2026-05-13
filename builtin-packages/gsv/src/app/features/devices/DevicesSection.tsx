import { openApp } from "@gsv/package/host";
import { useEffect, useState } from "preact/hooks";
import type { GsvBackend } from "../../backend-contract";
import { formatNullableTimestamp, formatRelativeTime, groupCapabilities, hasFiles, hasShell, deviceHealthSummary } from "./devices-domain";
import { buildBootstrapCommand, buildInstallCommand, type ProvisionInstallPlatform } from "./provision";
import { useDevices } from "./useDevices";
import type { DeviceDetail, DeviceScope, DeviceSummary, DeviceToken, DevicesTabId, DevicesViewer, IssuedNodeToken } from "./types";

export function DevicesSection({ backend }: { backend: GsvBackend }) {
  const devices = useDevices(backend);
  const selected = devices.selectedDevice;
  const viewer = devices.state?.viewer ?? null;
  const [compactFleetOpen, setCompactFleetOpen] = useState(shouldStartInFleetView);
  const showFleetOnCompact = devices.mode === "detail" && (compactFleetOpen || (!devices.selectedDeviceId && !selected));

  useEffect(() => {
    const onPopState = () => setCompactFleetOpen(shouldStartInFleetView());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  return (
    <section class={`gsv-devices${showFleetOnCompact ? " is-fleet-view" : " is-detail-view"}`}>
      <section class="gsv-devices-list-pane" aria-label="Device fleet">
        <header class="gsv-devices-list-head">
          <div>
            <span class="gsv-kicker">Fleet</span>
            <h3>Devices</h3>
          </div>
          <button
            class="gsv-mini-button"
            type="button"
            disabled={!viewer?.canManageTokens}
            title={viewer?.canManageTokens ? "Issue a node token and enroll a device." : "Token permissions are required to add devices."}
            onClick={() => {
              devices.setIssuedToken(null);
              setCompactFleetOpen(false);
              devices.writeRoute({ mode: "provision" });
            }}
          >
            Add
          </button>
        </header>

        <DeviceFilters
          query={devices.query}
          scope={devices.scope}
          onQuery={devices.setQuery}
          onScope={devices.setScope}
        />

        <p class="gsv-runtime-meta">
          {devices.state ? `${devices.state.devices.length} known / ${devices.state.devices.filter((device) => device.online).length} online` : "Loading fleet..."}
        </p>
        {devices.errorText ? <p class="gsv-inline-error">{devices.errorText}</p> : null}

        <div class="gsv-devices-list" aria-busy={!devices.state ? "true" : "false"}>
          {!devices.state ? (
            <section class="gsv-empty-state"><h3>Loading devices</h3><p>Fetching fleet state...</p></section>
          ) : devices.visibleDevices.length === 0 ? (
            <section class="gsv-empty-state"><h3>No devices</h3><p>No devices matched the current filter.</p></section>
          ) : devices.visibleDevices.map((device) => (
            <DeviceRow
              key={device.deviceId}
              device={device}
              selected={device.deviceId === devices.selectedDeviceId}
              onSelect={() => {
                devices.setIssuedToken(null);
                setCompactFleetOpen(false);
                devices.writeRoute({ mode: "detail", deviceId: device.deviceId });
              }}
            />
          ))}
        </div>
      </section>

      {devices.mode === "provision" ? (
        <ProvisionPanel
          initialDeviceId={devices.selectedDeviceId ?? ""}
          viewer={viewer}
          pendingAction={devices.pendingAction}
          issuedToken={devices.issuedToken}
          onBack={() => {
            setCompactFleetOpen(true);
            devices.writeRoute({ mode: "detail" });
          }}
          onSubmit={(form) => void devices.createToken(form)}
        />
      ) : (
        <DeviceDetailPanel
          device={selected}
          viewer={viewer}
          activeTab={devices.activeTab}
          tokens={devices.state?.deviceTokens ?? []}
          pendingAction={devices.pendingAction}
          onTab={(tab) => devices.writeRoute({ tab })}
          onBackToFleet={() => setCompactFleetOpen(true)}
          onProvision={(deviceId) => {
            devices.setIssuedToken(null);
            setCompactFleetOpen(false);
            devices.writeRoute({ mode: "provision", deviceId });
          }}
          onRevoke={(tokenId) => void devices.revokeToken(tokenId)}
          onUpdateDescription={(deviceId, description) => void devices.updateDescription(deviceId, description)}
        />
      )}
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
        <span>{device.platform || "unknown"} / uid {device.ownerUid}</span>
        {device.description ? <span>{device.description}</span> : null}
      </span>
      <span class="gsv-row-meta">{formatRelativeTime(device.lastSeenAt)}</span>
    </button>
  );
}

function DeviceDetailPanel({
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
      <section class="gsv-device-detail">
        <div class="gsv-empty-state">
          <h3>No device selected</h3>
          <p>Choose a device from the fleet list or add a new execution target.</p>
        </div>
      </section>
    );
  }

  return (
    <section class="gsv-device-detail" aria-label="Device detail">
      <header class="gsv-device-detail-head">
        <div>
          <span class="gsv-kicker">Fleet detail</span>
          <h3>{device.deviceId}</h3>
          <p>{device.online ? "Online and ready for routing." : "Offline. Review health and access before routing work here."}</p>
        </div>
        <div class="gsv-device-actions">
          <button class="gsv-mini-button gsv-device-compact-back" type="button" onClick={onBackToFleet}>
            Back to fleet
          </button>
          <button class="gsv-mini-button" type="button" disabled={!hasFiles(device)} onClick={() => openApp({ target: "files", payload: { device: device.deviceId, path: "." } })}>
            Files
          </button>
          <button class="gsv-mini-button" type="button" disabled={!hasShell(device)} onClick={() => openApp({ target: "shell", payload: { device: device.deviceId, cwd: "." } })}>
            Shell
          </button>
          {viewer?.canManageTokens ? (
            <button class="gsv-mini-button" type="button" onClick={() => onProvision(device.deviceId)}>Add access</button>
          ) : null}
        </div>
      </header>

      <nav class="gsv-local-tabs" aria-label="Device tabs">
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
          canEdit={Boolean(viewer && (viewer.uid === 0 || viewer.uid === device.ownerUid))}
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
          <span>Device note</span>
          <textarea
            value={description}
            maxLength={500}
            readOnly={!canEdit}
            disabled={pending}
            placeholder="Personal MacBook used for local work"
            onInput={(event) => setDescription(event.currentTarget.value)}
          />
        </label>
        <div class="gsv-device-note-actions">
          <span>{description.length}/500</span>
          <button class="gsv-mini-button" type="button" disabled={!canEdit || pending || !changed} onClick={() => onUpdateDescription(description)}>
            {pending ? "Saving" : "Save note"}
          </button>
        </div>
      </div>

      <div class="gsv-summary-grid">
        <Info label="Status" value={device.online ? "Ready" : "Offline"} />
        <Info label="Platform" value={device.platform || "Unknown"} />
        <Info label="Version" value={device.version || "Unknown"} />
        <Info label="Owner" value={`uid ${device.ownerUid}`} />
        <Info label="First seen" value={formatNullableTimestamp(device.firstSeenAt)} />
        <Info label="Last seen" value={formatNullableTimestamp(device.lastSeenAt)} />
        <Info label="Shell" value={hasShell(device) ? "Available" : "Unavailable"} />
        <Info label="Files" value={hasFiles(device) ? "Available" : "Unavailable"} />
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
  return (
    <section class="gsv-device-tab">
      <div class="gsv-device-access-head">
        <span>{tokens.length} node token{tokens.length === 1 ? "" : "s"}</span>
        {viewer?.canManageTokens ? <button class="gsv-mini-button" type="button" onClick={() => onProvision(device.deviceId)}>Issue token</button> : null}
      </div>
      <div class="gsv-token-list">
        {tokens.length === 0 ? (
          <section class="gsv-empty-state"><h3>No node tokens</h3><p>No node tokens are issued for this device.</p></section>
        ) : tokens.map((token) => {
          const revoked = typeof token.revokedAt === "number";
          return (
            <article class="gsv-token-row" key={token.tokenId}>
              <span class={`gsv-mark is-${revoked ? "warning" : "good"}`} aria-hidden="true"></span>
              <span class="gsv-row-copy">
                <strong>{token.tokenPrefix}</strong>
                <span>{token.label || device.deviceId} / {revoked ? "revoked" : "active"}</span>
                <span>created {formatNullableTimestamp(token.createdAt)}</span>
                <span>last used {formatNullableTimestamp(token.lastUsedAt)}</span>
                <span>expires {formatNullableTimestamp(token.expiresAt)}</span>
              </span>
              {viewer?.canManageTokens && !revoked ? (
                <button class="gsv-mini-button" type="button" disabled={pendingAction === `revoke:${token.tokenId}`} onClick={() => onRevoke(token.tokenId)}>
                  Revoke
                </button>
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
        <div><dt>Last heartbeat</dt><dd>{new Date(device.lastSeenAt).toLocaleString()}</dd></div>
        <div><dt>Connected</dt><dd>{formatNullableTimestamp(device.connectedAt)}</dd></div>
        <div><dt>Disconnected</dt><dd>{formatNullableTimestamp(device.disconnectedAt)}</dd></div>
        <div><dt>Capabilities</dt><dd>{device.implements.length}</dd></div>
      </dl>
    </section>
  );
}

function ProvisionPanel({
  initialDeviceId,
  viewer,
  pendingAction,
  issuedToken,
  onBack,
  onSubmit,
}: {
  initialDeviceId: string;
  viewer: DevicesViewer | null;
  pendingAction: string | null;
  issuedToken: IssuedNodeToken | null;
  onBack: () => void;
  onSubmit: (form: { deviceId: string; label: string; expiresDays: string }) => void;
}) {
  const [platform, setPlatform] = useState<ProvisionInstallPlatform>("unix");
  const [copied, setCopied] = useState<string | null>(null);
  const canCopy = typeof navigator.clipboard?.writeText === "function";
  const origin = window.location.origin;
  const install = buildInstallCommand(origin, platform);
  const bootstrap = issuedToken
    ? buildBootstrapCommand(origin, platform, viewer?.username ?? "root", issuedToken.allowedDeviceId ?? initialDeviceId, issuedToken.token)
    : "";

  async function copy(value: string, target: string): Promise<void> {
    if (!canCopy) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(target);
      window.setTimeout(() => setCopied((current) => current === target ? null : current), 1400);
    } catch {
      setCopied(null);
    }
  }

  if (!viewer?.canManageTokens) {
    return (
      <section class="gsv-device-detail">
        <div class="gsv-empty-state">
          <h3>Provisioning unavailable</h3>
          <p>Your current session cannot issue node tokens.</p>
        </div>
      </section>
    );
  }

  return (
    <section class="gsv-device-detail">
      <header class="gsv-device-detail-head">
        <div>
          <span class="gsv-kicker">Provisioning</span>
          <h3>Add device</h3>
          <p>Issue a node token and bootstrap the next execution target.</p>
        </div>
        <button class="gsv-mini-button" type="button" onClick={onBack}>Back to fleet</button>
      </header>

      <form
        class="gsv-provision-form"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget as HTMLFormElement;
          const data = new FormData(form);
          onSubmit({
            deviceId: String(data.get("deviceId") ?? "").trim(),
            label: String(data.get("label") ?? "").trim(),
            expiresDays: String(data.get("expiresDays") ?? "30").trim(),
          });
        }}
      >
        <label><span>Device id</span><input name="deviceId" defaultValue={initialDeviceId} required /></label>
        <label><span>Label</span><input name="label" placeholder="MacBook Pro" /></label>
        <label><span>Expires in days</span><input name="expiresDays" type="number" min="1" defaultValue="30" /></label>
        <button class="gsv-action-button" type="submit" disabled={pendingAction === "create-token"}>{pendingAction === "create-token" ? "Issuing" : "Issue token"}</button>
      </form>

      {issuedToken ? (
        <section class="gsv-provision-output">
          <label class="gsv-runtime-search">
            <span>Target platform</span>
            <select value={platform} onChange={(event) => setPlatform(event.currentTarget.value as ProvisionInstallPlatform)}>
              <option value="unix">macOS / Linux</option>
              <option value="windows">Windows</option>
            </select>
          </label>
          <CommandBlock title="Install CLI" value={install} copied={copied === "install"} onCopy={() => void copy(install, "install")} />
          <CommandBlock title="Bootstrap device" value={bootstrap} copied={copied === "bootstrap"} onCopy={() => void copy(bootstrap, "bootstrap")} />
        </section>
      ) : null}
    </section>
  );
}

function CommandBlock({ title, value, copied, onCopy }: { title: string; value: string; copied: boolean; onCopy: () => void }) {
  return (
    <section class="gsv-command-block">
      <header>
        <h4>{title}</h4>
        <button class="gsv-mini-button" type="button" onClick={onCopy}>{copied ? "Copied" : "Copy"}</button>
      </header>
      <textarea readOnly value={value} onFocus={(event) => event.currentTarget.select()} />
    </section>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div class="gsv-info-box">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function shouldStartInFleetView(): boolean {
  const url = new URL(window.location.href);
  return url.searchParams.get("mode") !== "provision" && !url.searchParams.get("device");
}
