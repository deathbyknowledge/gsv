import { useEffect } from "preact/hooks";
import { encodeDevicePairingCode } from "@humansandmachines/gsv/protocol";
import { LoadingState } from "../../../components/ui/Spinner";
import { browserExtensionDownloadUrl } from "../../../domain/cliInstall";
import { parseDeviceId } from "../../../domain/deviceId";
import type { ConsoleTarget } from "../../../domain/system/consoleModels";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useSession } from "../../../services/session/SessionProvider";
import { useDevicePairing } from "../../../services/machines/DevicePairingProvider";
import { buildMachineInstallCommand, type MachineProvisionPlatform } from "../../../services/machines/machineProvision";
import { SetupCommand } from "./SetupCommand";

export function DevicePairingPanel({ targets, allowed = true, ready = true, initialPlatform, onClose, onConnected }: {
  targets: readonly Pick<ConsoleTarget, "deviceId" | "online">[];
  allowed?: boolean;
  ready?: boolean;
  initialPlatform?: MachineProvisionPlatform;
  onClose?: () => void;
  onConnected?: (targetId: string) => void;
}) {
  const { connected } = useGateway();
  const { snapshot } = useSession();
  const { pairing: owner, state } = useDevicePairing();
  const { draft, invitation, pending, error } = state;
  const pairing = invitation?.pairing;
  const known = pairing && targets.find((target) => target.deviceId === pairing.targetId);
  const online = Boolean(known?.online);
  const expired = pairing?.state === "expired" || pairing?.state === "pending" && pairing.expiresAt <= Date.now();
  const active = pairing?.state === "pending" && !expired;
  const code = active ? encodeDevicePairingCode(snapshot.url, pairing, invitation!.request.secret) : "";
  const release = snapshot.server?.release ?? "dev";
  const disabled = !connected || !allowed || !ready || pending;

  useEffect(() => {
    if (initialPlatform && !owner.snapshot().invitation && !owner.snapshot().draft.label) owner.setPlatform(initialPlatform);
  }, [initialPlatform, owner]);
  useEffect(() => { if (connected) void owner.refresh(); }, [connected, online, owner]);
  useEffect(() => {
    if (!active || !pairing) return;
    const timer = window.setTimeout(() => void owner.refresh(), Math.max(1, pairing.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [active, pairing?.expiresAt, owner]);

  return <div class="device-pairing fleet-connection">
    {!allowed && <p class="note">Your account cannot create device invitations.</p>}
    {!invitation ? <form class="fleet-place-form" onSubmit={(event) => { event.preventDefault(); void owner.create(); }}>
      <fieldset disabled={disabled}>
        {draft.replace ? <p class="note">Pair {draft.label} again as <code>{draft.targetId}</code>.</p> : <>
          <label>Name<input name="pairing-label" value={draft.label} placeholder="My macbook" autoComplete="off" maxLength={100} onInput={(event) => owner.setLabel(event.currentTarget.value, targets.map((target) => target.deviceId))} /></label>
          <label>Target ID<input name="pairing-target" value={draft.targetId} placeholder="my-macbook" autoComplete="off" spellcheck={false} maxLength={48} onInput={(event) => owner.setTargetId(event.currentTarget.value)} /></label>
          <p class="note">The ID follows the name until you edit it.</p>
        </>}
        <PlatformChoice platform={draft.platform} onChange={(value) => owner.setPlatform(value)} />
        <div class="fleet-actions"><button class="ibtn is-primary" type="submit" disabled={!draft.label.trim() || !parseDeviceId(draft.targetId)}>{pending ? <LoadingState>creating…</LoadingState> : "create invitation"}</button></div>
      </fieldset>
    </form> : !pairing ? <>
      <p class="note">{pending ? "Preparing the invitation…" : "Invitation creation needs a retry. Its identity is saved in this browser."}</p>
      <button type="button" class="fleet-text-action" disabled={disabled} onClick={() => void owner.create()}>retry</button>
    </> : pairing.state === "paired" ? <>
      <p class="note is-on" role="status">{pairing.label} is paired{online ? " and connected." : ". Waiting for its connection."}</p>
      <div class="fleet-actions">
        {online && onConnected && <button type="button" class="fleet-text-action is-primary" onClick={() => onConnected(pairing.targetId)}>view place</button>}
        <button type="button" class="fleet-text-action" onClick={owner.startAnother}>pair another place</button>
      </div>
    </> : !active ? <>
      <p class="note" role="status">This invitation {expired ? "expired" : "was cancelled"}.</p>
      <button type="button" class="fleet-text-action" onClick={owner.startAnother}>new invitation</button>
    </> : <>
      <p class="note" role="status">Invitation for {pairing.label} · <code>{pairing.targetId}</code>. Expires at {new Date(pairing.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.</p>
      <PlatformChoice platform={draft.platform} onChange={(value) => owner.setPlatform(value)} />
      {draft.platform === "browser" ? <>
        <p class="note">Download and unzip the extension. In <code>chrome://extensions</code>, enable developer mode and load its folder. Paste this invitation in the extension’s connection settings.</p>
        <div class="fleet-actions"><a class="fleet-text-action" href={browserExtensionDownloadUrl(release)} target="_blank" rel="noreferrer">download extension</a></div>
        <SetupCommand text={code} label="copy invitation" />
      </> : <>
        <p class="note">1 · Install GSV on that computer.</p>
        <SetupCommand text={buildMachineInstallCommand(draft.platform, release)} label="copy install command" />
        <p class="note">2 · Connect it to your Ship.</p>
        <SetupCommand text={`${draft.platform === "windows" ? "gsv.exe" : "gsv"} pair ${code}`} label="copy connect command" />
      </>}
      <p class="note">You can close this panel and come back. Cancelling an invitation leaves an already-paired device connected.</p>
    </>}
    <div class="fleet-actions">
      {onClose && <button class="fleet-text-action" type="button" onClick={onClose}>{invitation ? "done" : "cancel"}</button>}
      {invitation && (!pairing || active) && <button type="button" class="fleet-text-action is-danger" disabled={!connected || pending} onClick={() => void owner.cancel()}>{pending ? "please wait…" : "cancel invitation"}</button>}
    </div>
    {error && <p class="error" role="alert">{error}</p>}
  </div>;
}

function PlatformChoice({ platform, onChange }: { platform: MachineProvisionPlatform; onChange: (platform: MachineProvisionPlatform) => void }) {
  return <label class="pairing-platform">Place <select class="fleet-select" value={platform} onChange={(event) => {
    const value = event.currentTarget.value;
    if (value === "mac" || value === "linux" || value === "windows" || value === "browser") onChange(value);
  }}><option value="mac">Mac</option><option value="linux">Linux</option><option value="windows">Windows</option><option value="browser">Browser</option></select></label>;
}
