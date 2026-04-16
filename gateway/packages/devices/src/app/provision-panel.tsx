import type { IssuedNodeToken } from "./types";

type ProvisionFormState = {
  deviceId: string;
  label: string;
  expiresDays: string;
};

type ProvisionPanelProps = {
  initialDeviceId: string;
  pendingAction: string | null;
  issuedToken: IssuedNodeToken | null;
  onBack: () => void;
  onSubmit: (form: ProvisionFormState) => void;
};

export function ProvisionPanel({
  initialDeviceId,
  pendingAction,
  issuedToken,
  onBack,
  onSubmit,
}: ProvisionPanelProps) {
  const install = `curl -fsSL ${window.location.origin}/downloads/cli/install.sh | bash`;
  const gatewayWs = buildGatewayWsUrl(window.location.origin);
  const bootstrap = issuedToken
    ? [
        install,
        `gsv local-config set gateway.url "${gatewayWs}"`,
        `gsv local-config set node.id "${issuedToken.allowedDeviceId ?? initialDeviceId}"`,
        `gsv local-config set node.token "${issuedToken.token}"`,
        `gsv node install --id "${issuedToken.allowedDeviceId ?? initialDeviceId}" --workspace ~/projects`,
      ].join("\n")
    : "";

  return (
    <section class="devices-provision-stage">
      <header class="devices-detail-head">
        <div>
          <h2>Add device</h2>
          <p>Issue a node token and show the exact bootstrap sequence for the next machine.</p>
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
          <section class="devices-command-block">
            <header>
              <h3>Install CLI</h3>
              <p>Run this on the target machine first.</p>
            </header>
            <textarea class="devices-output" readOnly value={install} />
          </section>
          <section class="devices-command-block">
            <header>
              <h3>Bootstrap node</h3>
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
