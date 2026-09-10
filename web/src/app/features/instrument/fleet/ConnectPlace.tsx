import { useEffect, useRef, useState } from "preact/hooks";
import { LoadingState } from "../../../components/ui/Spinner";
import { browserExtensionDownloadUrl } from "../../../domain/cliInstall";
import { parseDeviceId } from "../../../domain/deviceId";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useSession } from "../../../services/session/SessionProvider";
import { createMachineNodeToken, type IssuedMachineNodeToken } from "../../../services/system/consoleService";
import type { ConsoleAccount, ConsoleTarget } from "../../../domain/system/consoleModels";
import {
  buildBrowserExtensionConfig,
  buildMachineBootstrapCommand,
  buildMachineInstallCommand,
  defaultMachineName,
  expiresAtFromDays,
  machineDeviceIdFromName,
  type MachineProvisionPlatform,
} from "../../../services/machines/machineProvision";
import { uniqueDeviceId } from "../firstday/firstdayModel";
import { canConfigure } from "../settings/settingsModel";

export function ConnectPlace({ account, targets, ready, onClose, onConnected }: {
  account: ConsoleAccount | undefined;
  targets: readonly ConsoleTarget[];
  ready: boolean;
  onClose: () => void;
  onConnected: (id: string) => void;
}) {
  const { client, connected } = useGateway();
  const { snapshot } = useSession();
  const [platform, setPlatform] = useState<MachineProvisionPlatform>("mac");
  const [name, setName] = useState("");
  const [issued, setIssued] = useState<IssuedMachineNodeToken | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const nameInput = useRef<HTMLInputElement>(null);
  const allowed = !!account && canConfigure(account, "sys.token.create");
  const label = name.trim() || defaultMachineName(platform);
  const deviceId = uniqueDeviceId(machineDeviceIdFromName(label), targets.map((target) => target.deviceId));
  const known = issued ? targets.find((target) => target.deviceId === issued.peerId) : undefined;
  const release = snapshot.server?.release ?? "dev";
  const gateway = new URL(snapshot.url);
  gateway.protocol = gateway.protocol === "wss:" ? "https:" : gateway.protocol === "ws:" ? "http:" : gateway.protocol;
  const setup = issued ? platform === "browser"
    ? JSON.stringify(buildBrowserExtensionConfig({ origin: gateway.origin, username: snapshot.username, deviceId: issued.peerId!, token: issued.token }), null, 2)
    : buildMachineBootstrapCommand({ origin: gateway.origin, platform, username: snapshot.username, deviceId: issued.peerId!, token: issued.token }) : "";

  useEffect(() => {
    nameInput.current?.focus();
    return () => { mounted.current = false; };
  }, []);
  const create = async () => {
    if (!connected || !allowed || !ready || pending || !parseDeviceId(deviceId)) return;
    setPending(true);
    setError("");
    try {
      const token = await createMachineNodeToken(client, { deviceId, label, expiresAt: expiresAtFromDays(30) });
      if (mounted.current) setIssued(token);
      else await client.sys.token.revoke({ tokenId: token.tokenId, reason: "Connection closed before the pairing key was displayed" });
    } catch {
      if (mounted.current) setError("Could not create the pairing key. Try again.");
    } finally {
      if (mounted.current) setPending(false);
    }
  };
  const revoke = async () => {
    if (!issued || pending) return;
    setPending(true);
    setError("");
    try {
      await client.sys.token.revoke({ tokenId: issued.tokenId, reason: "Connection cancelled" });
      if (mounted.current) onClose();
    } catch {
      if (mounted.current) setError("Could not revoke this key. Keep this panel open and try again.");
    } finally {
      if (mounted.current) setPending(false);
    }
  };

  return <section class="fleet-connection" aria-label="Connect a place">
    <h3>Connect a place</h3>
    <p class="note">Give your Ship access to another computer or browser.</p>
    {!allowed && account && <p class="note">Your account cannot create pairing keys.</p>}
    {!issued ? <form class="fleet-place-form" onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <fieldset disabled={!connected || !allowed || !ready || pending}>
        <label>Place<select class="fleet-select" value={platform} onChange={(event) => {
          const value = event.currentTarget.value;
          if (value === "mac" || value === "linux" || value === "windows" || value === "browser") setPlatform(value);
        }}><option value="mac">Mac</option><option value="linux">Linux</option><option value="windows">Windows</option><option value="browser">Browser</option></select></label>
        <label>Name<input ref={nameInput} value={name} placeholder={defaultMachineName(platform)} autoComplete="off" onInput={(event) => setName(event.currentTarget.value)} /></label>
        <p class="note">{label} will appear in Places when it connects.</p>
        <div class="fleet-actions"><button class="ibtn is-primary" type="submit" disabled={!parseDeviceId(deviceId)}>{pending ? <LoadingState>creating…</LoadingState> : "create pairing key"}</button></div>
      </fieldset>
      <div class="fleet-actions"><button class="fleet-text-action" type="button" onClick={onClose}>cancel</button></div>
    </form> : <>
      {known?.online ? <p class="note is-on" role="status">{known.label || label} is connected.</p> : <p class="note" role="status">Waiting for {issued.label || label} to connect. This key is shown once and expires in 30 days.</p>}
      {platform === "browser" ? <>
        <p class="note">Download and unzip the extension. In <code>chrome://extensions</code>, enable developer mode and load its folder. Apply this configuration in the extension’s connection settings.</p>
        <div class="fleet-actions"><a class="fleet-text-action" href={browserExtensionDownloadUrl(release)} target="_blank" rel="noreferrer">download extension</a></div>
      </> : <>
        <p class="note">1 · Install GSV on that computer.</p>
        <SetupCommand text={buildMachineInstallCommand(platform, release)} label="copy install command" />
        <p class="note">2 · Connect it to your Ship.</p>
      </>}
      <SetupCommand text={setup} label={platform === "browser" ? "copy configuration" : "copy connect command"} />
      <div class="fleet-actions">
        <button class="fleet-text-action is-primary" type="button" disabled={pending} onClick={() => known?.online ? onConnected(known.deviceId) : onClose()}>{known?.online ? "view place" : "done"}</button>
        {!known?.online && <button class="fleet-text-action is-danger" type="button" disabled={!connected || pending} onClick={() => void revoke()}>{pending ? <LoadingState>cancelling…</LoadingState> : "cancel and revoke key"}</button>}
      </div>
    </>}
    {error && <p class="error" role="alert">{error}</p>}
  </section>;
}

export function SetupCommand({ text, label }: { text: string; label: string }) {
  const [status, setStatus] = useState("");
  useEffect(() => { setStatus(""); }, [text]);
  return <div class="fleet-setup-command">
    <pre class="fleet-setup">{text}</pre>
    <div class="fleet-actions"><button class="fleet-text-action" type="button" onClick={() => {
      void navigator.clipboard.writeText(text).then(() => setStatus("copied"), () => setStatus("Select and copy the text above."));
    }}>{label}</button><span role="status">{status}</span></div>
  </div>;
}
