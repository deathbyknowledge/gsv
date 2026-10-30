import { useEffect } from "preact/hooks";
import { useViewActive } from "../../../services/navigation/ViewActivity";
import { encodeDevicePairingCode } from "@humansandmachines/gsv/protocol";
import { Select } from "../../../components/ui/Select";
import { LoadingState } from "../../../components/ui/Spinner";
import { Select } from "../../../components/ui/Select";
import { TextInput } from "../../../components/ui/TextInput";
import { browserExtensionDownloadUrl } from "../../../domain/cliInstall";
import { parseDeviceId } from "../../../domain/deviceId";
import type { ConsoleTarget } from "../../../domain/system/consoleModels";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useSession } from "../../../services/session/SessionProvider";
import { useDevicePairing } from "../../../services/machines/DevicePairingProvider";
import { buildMachineInstallCommand, type MachineProvisionPlatform } from "../../../services/machines/machineProvision";
import { SetupCommand } from "./SetupCommand";
import { rich, useT } from "../../../i18n/locale";

export function DevicePairingPanel({ targets, allowed = true, ready = true, initialPlatform, onClose, onConnected }: {
  targets: readonly Pick<ConsoleTarget, "deviceId" | "online">[];
  allowed?: boolean;
  ready?: boolean;
  initialPlatform?: MachineProvisionPlatform;
  onClose?: () => void;
  onConnected?: (targetId: string) => void;
}) {
  const t = useT();
  const visible = useViewActive();
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
  useEffect(() => { if (visible && connected) void owner.refresh(); }, [visible, connected, online, owner]);
  useEffect(() => {
    if (!visible || !active || !pairing) return;
    const timer = window.setTimeout(() => void owner.refresh(), Math.max(1, pairing.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [visible, active, pairing?.expiresAt, owner]);

  return <div class="device-pairing fleet-connection">
    {!allowed && <p class="note">{t("shell.pairing.notAllowed")}</p>}
    {!invitation ? <form class="fleet-place-form" onSubmit={(event) => { event.preventDefault(); void owner.create(); }}>
      <fieldset disabled={disabled}>
        {draft.replace ? <p class="note">{rich(t("shell.pairing.replace", { name: draft.label }), { id: <code>{draft.targetId}</code> })}</p> : <>
          <TextInput label={t("shell.pairing.name")} value={draft.label} placeholder={t("shell.pairing.namePlaceholder")} disabled={disabled}
            inputProps={{ name: "pairing-label", autoComplete: "off", maxLength: 100 }}
            onChange={(value) => owner.setLabel(value, targets.map((target) => target.deviceId))} />
          <TextInput label={t("shell.pairing.targetId")} value={draft.targetId} placeholder={t("shell.pairing.targetIdPlaceholder")} description={t("shell.pairing.targetIdHint")} disabled={disabled}
            inputProps={{ name: "pairing-target", autoComplete: "off", spellcheck: false, maxLength: 48 }}
            onChange={(value) => owner.setTargetId(value)} />
        </>}
        <PlatformChoice platform={draft.platform} disabled={disabled} onChange={(value) => owner.setPlatform(value)} />
        <div class="fleet-actions"><button class="ibtn is-primary" type="submit" disabled={!draft.label.trim() || !parseDeviceId(draft.targetId)}>{pending ? <LoadingState>{t("shell.pairing.creating")}</LoadingState> : t("shell.pairing.create")}</button></div>
      </fieldset>
    </form> : !pairing ? <>
      <p class="note">{pending ? t("shell.pairing.preparing") : t("shell.pairing.createFailed")}</p>
      <button type="button" class="fleet-text-action" disabled={disabled} onClick={() => void owner.create()}>{t("shell.retry")}</button>
    </> : pairing.state === "paired" ? <>
      <p class="note is-on" role="status">{t(online ? "shell.pairing.pairedOnline" : "shell.pairing.pairedWaiting", { name: pairing.label })}</p>
      <div class="fleet-actions">
        {online && onConnected && <button type="button" class="fleet-text-action is-primary" onClick={() => onConnected(pairing.targetId)}>{t("shell.pairing.viewPlace")}</button>}
        <button type="button" class="fleet-text-action" onClick={owner.startAnother}>{t("shell.pairing.pairAnother")}</button>
      </div>
    </> : !active ? <>
      <p class="note" role="status">{t(expired ? "shell.pairing.expired" : "shell.pairing.cancelled")}</p>
      <button type="button" class="fleet-text-action" onClick={owner.startAnother}>{t("shell.pairing.newInvitation")}</button>
    </> : <>
      <p class="note" role="status">{rich(t("shell.pairing.invitation", {
        name: pairing.label, time: new Date(pairing.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      }), { id: <code>{pairing.targetId}</code> })}</p>
      <PlatformChoice platform={draft.platform} onChange={(value) => owner.setPlatform(value)} />
      {draft.platform === "browser" ? <>
        <p class="note">{rich(t("shell.pairing.extensionSteps"), { extensions: <code>chrome://extensions</code> })}</p>
        <div class="fleet-actions"><a class="fleet-text-action" href={browserExtensionDownloadUrl(release)} target="_blank" rel="noreferrer">{t("shell.pairing.downloadExtension")}</a></div>
        <SetupCommand text={code} label={t("shell.pairing.copyInvitation")} />
      </> : <>
        <p class="note">{t("shell.pairing.openTerminal", { app: draft.platform === "windows" ? "PowerShell" : "Terminal" })}</p>
        <p class="note">{t("shell.pairing.installStep")}</p>
        <SetupCommand text={buildMachineInstallCommand(draft.platform, release)} label={t("shell.pairing.copyInstall")} language={draft.platform === "windows" ? "powershell" : "sh"} />
        <p class="note">{t("shell.pairing.connectStep")}</p>
        <SetupCommand text={`${draft.platform === "windows" ? "gsv.exe" : "gsv"} pair ${code}`} label={t("shell.pairing.copyConnect")} language={draft.platform === "windows" ? "powershell" : "sh"} />
      </>}
      <p class="note">{t("shell.pairing.closeHint")}</p>
    </>}
    <div class="fleet-actions">
      {onClose && <button class="fleet-text-action" type="button" onClick={onClose}>{t(invitation ? "shell.pairing.done" : "common.cancel")}</button>}
      {invitation && (!pairing || active) && <button type="button" class="fleet-text-action is-danger" disabled={!connected || pending} onClick={() => void owner.cancel()}>{pending ? t("shell.pairing.wait") : t("shell.pairing.cancelInvitation")}</button>}
    </div>
    {error && <p class="error" role="alert">{error}</p>}
  </div>;
}

const PLATFORMS: readonly MachineProvisionPlatform[] = ["mac", "linux", "windows", "browser"];

function PlatformChoice({ platform, disabled = false, onChange }: { platform: MachineProvisionPlatform; disabled?: boolean; onChange: (platform: MachineProvisionPlatform) => void }) {
  const t = useT();
  const labels = { mac: "Mac", linux: "Linux", windows: "Windows", browser: t("shell.pairing.browser") } satisfies Record<MachineProvisionPlatform, string>;
  return <Select block label={t("shell.pairing.place")} disabled={disabled}
    options={PLATFORMS.map((value) => ({ label: labels[value], value }))}
    value={PLATFORMS.indexOf(platform)}
    onChange={(index) => onChange(PLATFORMS[index])} />;
}
