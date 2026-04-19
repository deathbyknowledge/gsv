import { useState } from "preact/hooks";
import type { IssuedNodeToken } from "./types";

type ProvisionInstallPlatform = "unix" | "windows";

type ProvisionFormState = {
  deviceId: string;
  label: string;
  expiresDays: string;
};

type ProvisionPanelProps = {
  initialDeviceId: string;
  viewerUsername: string;
  pendingAction: string | null;
  issuedToken: IssuedNodeToken | null;
  onBack: () => void;
  onSubmit: (form: ProvisionFormState) => void;
};

export function ProvisionPanel({
  initialDeviceId,
  viewerUsername,
  pendingAction,
  issuedToken,
  onBack,
  onSubmit,
}: ProvisionPanelProps) {
  const [platform, setPlatform] = useState<ProvisionInstallPlatform>("unix");
  const install = buildInstallCommand(window.location.origin, platform);
  const bootstrap = issuedToken
    ? buildBootstrapCommand(
        window.location.origin,
        platform,
        viewerUsername,
        issuedToken.allowedDeviceId ?? initialDeviceId,
        issuedToken.token,
      )
    : "";

  return (
    <section class="devices-provision-stage">
      <header class="devices-detail-head">
        <div>
          <h2>Add device</h2>
          <p>Issue a node token and show the current bootstrap sequence for the next machine.</p>
        </div>
        <button class="devices-button devices-button--quiet" onClick={onBack}>Back to fleet</button>
      </header>

      <ProvisionForm
        initialDeviceId={initialDeviceId}
        pendingAction={pendingAction}
        onSubmit={onSubmit}
      />

      {issuedToken ? (
        <div class="devices-provision-output">
          <label class="devices-field-block devices-field-block--narrow">
            <span>Target platform</span>
            <select
              class="devices-input"
              value={platform}
              onChange={(event) => {
                setPlatform((event.currentTarget as HTMLSelectElement).value as ProvisionInstallPlatform);
              }}
            >
              <option value="unix">macOS / Linux</option>
              <option value="windows">Windows</option>
            </select>
          </label>
          <section class="devices-command-block">
            <header>
              <h3>Install CLI</h3>
              <p>Run this on the target machine first.</p>
            </header>
            <textarea class="devices-output" readOnly value={install} />
          </section>
          <section class="devices-command-block">
            <header>
              <h3>Bootstrap device</h3>
              <p>{issuedToken.allowedDeviceId ?? initialDeviceId} · {issuedToken.expiresAt ? new Date(issuedToken.expiresAt).toLocaleString() : "no expiry"}</p>
            </header>
            <textarea class="devices-output" readOnly value={bootstrap} />
          </section>
        </div>
      ) : null}
    </section>
  );
}

function ProvisionForm({
  initialDeviceId,
  pendingAction,
  onSubmit,
}: {
  initialDeviceId: string;
  pendingAction: string | null;
  onSubmit: (form: ProvisionFormState) => void;
}) {
  return (
    <form
      class="devices-provision-form"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget as HTMLFormElement;
        const formData = new FormData(form);
        onSubmit({
          deviceId: String(formData.get("deviceId") ?? "").trim(),
          label: String(formData.get("label") ?? "").trim(),
          expiresDays: String(formData.get("expiresDays") ?? "30").trim(),
        });
      }}
    >
      <label class="devices-field-block">
        <span>Device id</span>
        <input class="devices-input" name="deviceId" defaultValue={initialDeviceId} required />
      </label>
      <label class="devices-field-block">
        <span>Label</span>
        <input class="devices-input" name="label" placeholder="MacBook Pro" />
      </label>
      <label class="devices-field-block devices-field-block--narrow">
        <span>Expires in days</span>
        <input class="devices-input" name="expiresDays" type="number" min="1" defaultValue="30" />
      </label>
      <div class="devices-inline-actions">
        <button class="devices-button devices-button--primary" type="submit" disabled={pendingAction === "create-token"}>
          {pendingAction === "create-token" ? "Issuing…" : "Issue token"}
        </button>
      </div>
    </form>
  );
}

function buildGatewayWsUrl(origin: string): string {
  if (origin.startsWith("https://")) {
    return `wss://${origin.slice("https://".length)}/ws`;
  }
  if (origin.startsWith("http://")) {
    return `ws://${origin.slice("http://".length)}/ws`;
  }
  return `${origin.replace(/\/+$/g, "")}/ws`;
}

function buildInstallCommand(origin: string, platform: ProvisionInstallPlatform): string {
  return platform === "windows"
    ? `irm ${origin}/downloads/cli/install.ps1 | iex`
    : `curl -fsSL ${origin}/downloads/cli/install.sh | bash`;
}

function buildBootstrapCommand(
  origin: string,
  platform: ProvisionInstallPlatform,
  viewerUsername: string,
  deviceId: string,
  token: string,
): string {
  const gatewayWs = escapeCliValue(buildGatewayWsUrl(origin));
  const escapedViewerUsername = escapeCliValue(viewerUsername);
  const escapedDeviceId = escapeCliValue(deviceId);
  const escapedToken = escapeCliValue(token);
  const workspace = platform === "windows" ? "\"$HOME\\projects\"" : "~/projects";

  return [
    `gsv config --local set gateway.url "${gatewayWs}"`,
    `gsv config --local set gateway.username "${escapedViewerUsername}"`,
    `gsv config --local set node.token "${escapedToken}"`,
    `gsv device install --id "${escapedDeviceId}" --workspace ${workspace}`,
  ].join("\n");
}

function escapeCliValue(value: string): string {
  return value.replaceAll("\"", "\\\"");
}
