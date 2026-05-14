import { useState } from "preact/hooks";
import { ActionButton } from "../../components/ui/ActionButton";
import { buildBootstrapCommand, buildInstallCommand, type ProvisionInstallPlatform } from "./provision";
import type { DevicesViewer, IssuedNodeToken } from "./types";

export function ProvisionPanel({
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
        <ActionButton icon="arrow-left" label="Fleet" onClick={onBack} />
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
        <ActionButton
          icon="key"
          label="Issue token"
          busyLabel="Issuing"
          busy={pendingAction === "create-token"}
          type="submit"
        />
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
        <ActionButton icon="copy" label={copied ? "Copied" : "Copy"} onClick={onCopy} />
      </header>
      <textarea readOnly value={value} onFocus={(event) => event.currentTarget.select()} />
    </section>
  );
}
