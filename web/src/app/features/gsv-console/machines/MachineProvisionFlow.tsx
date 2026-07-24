import { useEffect, useState } from "preact/hooks";
import { useUnsavedGuard } from "../../gsv-shell/unsaved/unsavedGuard";
import { Button } from "../../../components/ui/Button";
import { Icon } from "../../../components/ui/Icon";
import { CopyGlyph } from "../../../components/ui/lineGlyphs";
import { ListRow } from "../../../components/ui/ListRow";
import { Spinner } from "../../../components/ui/Spinner";
import { StatusDot } from "../../../components/ui/StatusDot";
import { Tag } from "../../../components/ui/Tag";
import { TextInput } from "../../../components/ui/TextInput";
import { Tile } from "../../../components/ui/Tile";
import { Toggle } from "../../../components/ui/Toggle";
import { useSession } from "../../../services/session/SessionProvider";
import { browserExtensionDownloadUrl } from "../../../domain/cliInstall";
import { DEVICE_ID_FORMAT_DESCRIPTION, parseDeviceId } from "../../../domain/deviceId";
import type { IssuedMachineNodeToken } from "../backend/consoleService";
import { ConnectFlowShell } from "../connect-flows/ConnectFlowShell";
import type { ConnectFlowDef } from "../connect-flows/connectFlowTypes";
import type { ConsoleTarget } from "../domain/consoleModels";
import { useConsoleTargets, useCreateMachineNodeToken } from "../hooks/useConsoleData";
import {
  MACHINE_PLATFORM_OPTIONS,
  MACHINE_PROVISION_STEP_LABELS,
  MACHINE_PROVISION_STEPS,
  buildBrowserExtensionConfig,
  buildMachineBootstrapCommand,
  buildMachineInstallCommand,
  buildMachineRunCommand,
  defaultMachineName,
  expiresAtFromDays,
  machineDeviceIdFromName,
  normalizeExpiresDays,
  platformOption,
  stepIndex,
  type MachineProvisionPlatform,
  type MachineProvisionStep,
} from "./machineProvision";
import "./MachineProvisionFlow.css";

type MachineProvisionFlowProps = {
  onBack: () => void;
  onOpenMachine?: (target: ConsoleTarget) => void;
};

type CopyTarget = "install" | "connect" | "gateway" | "username" | "token" | "deviceId";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : error ? String(error) : "";
}

function targetStatus(target: ConsoleTarget | null): string {
  if (!target) {
    return "NOT DETECTED";
  }
  return target.online ? "ONLINE" : "REGISTERED";
}

function targetSub(target: ConsoleTarget): string {
  return [
    target.platform,
    target.version,
    target.ownerUsername ? `owner ${target.ownerUsername}` : "",
    target.description,
  ].filter(Boolean).join(" / ") || target.deviceId;
}

async function copyText(value: string): Promise<boolean> {
  if (!value) {
    return false;
  }
  try {
    if (typeof navigator.clipboard?.writeText === "function") {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to textarea copy.
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

/** Copy-able command block — header (title + meta + COPY) over a <pre> body,
 *  styled with the shared `.gsv-cf-cmd*` classes from the shell. Keeps the real
 *  copy handler. */
function CommandBlock({
  title,
  meta,
  value,
  copied,
  onCopy,
}: {
  title: string;
  meta: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <section class="gsv-cf-cmd">
      <header class="gsv-cf-cmd-head">
        <span class="gsv-cf-cmd-title">{title}</span>
        <span class="gsv-cf-cmd-meta">{meta}</span>
        <button type="button" class="gsv-cf-cmd-copy" onClick={onCopy}>
          <CopyGlyph size={12} />
          <span>{copied ? "COPIED" : "COPY"}</span>
        </button>
      </header>
      <pre class="gsv-cf-cmd-body">{value}</pre>
    </section>
  );
}

/** A single labelled, copyable value for the browser-extension Options page. */
function ExtensionValueRow({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div class="machine-extension-value">
      <div>
        <span>{label}</span>
        <code>{value}</code>
      </div>
      <button type="button" class="gsv-cf-cmd-copy" onClick={onCopy}>
        <CopyGlyph size={12} />
        <span>{copied ? "COPIED" : "COPY"}</span>
      </button>
    </div>
  );
}

export function MachineProvisionFlow({
  onBack,
  onOpenMachine,
}: MachineProvisionFlowProps) {
  const { snapshot } = useSession();
  const targets = useConsoleTargets();
  const createToken = useCreateMachineNodeToken();
  const [step, setStep] = useState<MachineProvisionStep>("platform");
  const [platform, setPlatform] = useState<MachineProvisionPlatform>("mac");
  const [machineName, setMachineName] = useState(defaultMachineName("mac"));
  const [deviceId, setDeviceId] = useState(machineDeviceIdFromName(defaultMachineName("mac")));
  const [expiresDays, setExpiresDays] = useState("30");
  const [nameTouched, setNameTouched] = useState(false);
  const [deviceIdTouched, setDeviceIdTouched] = useState(false);
  const [issuedToken, setIssuedToken] = useState<IssuedMachineNodeToken | null>(null);
  const [copied, setCopied] = useState<CopyTarget | null>(null);
  const [checkMessage, setCheckMessage] = useState("");
  const [oneShotRun, setOneShotRun] = useState(false);
  const origin = window.location.origin;
  const selectedPlatform = platformOption(platform);
  const isBrowserTarget = platform === "browser";
  // Icon for the selected target across the flow's action bar, preview rows, and
  // success screen. Browser → the chrome doticon (matching the step-1 tile);
  // everything else → the computer glyph. `chrome` exists only as a doticon.
  const targetIcon = isBrowserTarget ? "doticons/chrome" : "computer";
  const stepLabels = isBrowserTarget
    ? ["TARGET", "DETAILS", "EXTENSION", "PAIR", "SUCCESS"]
    : MACHINE_PROVISION_STEP_LABELS;
  const knownTarget = targets.targets.find((target) => target.deviceId === deviceId.trim()) ?? null;
  const expires = normalizeExpiresDays(expiresDays);
  const validDeviceId = parseDeviceId(deviceId);
  const detailsReady = machineName.trim().length > 0 && validDeviceId !== null;
  const release = snapshot.server?.release ?? "dev";
  const installCommand = buildMachineInstallCommand(platform, release);
  const extensionDownloadUrl = browserExtensionDownloadUrl(release);
  const browserConfig = issuedToken
    ? buildBrowserExtensionConfig({
        origin,
        username: snapshot.username || "root",
        deviceId,
        token: issuedToken.token,
      })
    : null;
  const bootstrapCommand = issuedToken && !isBrowserTarget
    ? buildMachineBootstrapCommand({
        origin,
        platform,
        username: snapshot.username || "root",
        deviceId,
        token: issuedToken.token,
      })
    : "";
  const runCommand = issuedToken && !isBrowserTarget
    ? buildMachineRunCommand({
        origin,
        platform,
        username: snapshot.username || "root",
        deviceId,
        token: issuedToken.token,
      })
    : "";
  const connectCommand = oneShotRun ? runCommand : bootstrapCommand;
  const createError = errorText(createToken.error);

  useUnsavedGuard(() =>
    step !== "success" &&
    (step !== "platform" ||
      nameTouched ||
      deviceIdTouched ||
      expiresDays.trim() !== "30")
  );

  useEffect(() => {
    if (!issuedToken || step !== "connect") {
      return;
    }
    if (knownTarget?.online) {
      setStep("success");
      return;
    }

    const timer = window.setInterval(() => {
      void targets.refetch();
    }, 3500);
    return () => window.clearInterval(timer);
  }, [issuedToken, knownTarget?.online, step, targets.refetch]);

  const resetToken = () => {
    setIssuedToken(null);
    setCheckMessage("");
  };

  const selectPlatform = (nextPlatform: MachineProvisionPlatform) => {
    setPlatform(nextPlatform);
    if (!nameTouched) {
      const nextName = defaultMachineName(nextPlatform);
      setMachineName(nextName);
      if (!deviceIdTouched) {
        setDeviceId(machineDeviceIdFromName(nextName));
      }
    }
    resetToken();
  };

  const updateMachineName = (value: string) => {
    setNameTouched(true);
    setMachineName(value);
    if (!deviceIdTouched) {
      setDeviceId(machineDeviceIdFromName(value));
    }
    resetToken();
  };

  const updateDeviceId = (value: string) => {
    setDeviceIdTouched(true);
    setDeviceId(value.trim() ? machineDeviceIdFromName(value) : "");
    resetToken();
  };

  const copyCommand = async (target: CopyTarget, value: string) => {
    const ok = await copyText(value);
    setCopied(ok ? target : null);
    if (ok) {
      window.setTimeout(() => {
        setCopied((current) => current === target ? null : current);
      }, 1400);
    }
  };

  const issueToken = async () => {
    if (!detailsReady || !validDeviceId || createToken.isPending) {
      return;
    }
    setCheckMessage("");
    const token = await createToken.mutateAsync({
      deviceId: validDeviceId,
      label: machineName.trim(),
      expiresAt: expiresAtFromDays(expires),
    });
    setIssuedToken(token);
  };

  const checkConnection = async () => {
    const result = await targets.refetch();
    const nextTarget = result.data?.find((target) => target.deviceId === deviceId.trim()) ?? null;
    if (nextTarget?.online) {
      setStep("success");
      return;
    }
    if (nextTarget) {
      setCheckMessage(`${isBrowserTarget ? "Browser target" : "Machine"} registered. Waiting for it to come online.`);
      return;
    }
    setCheckMessage(isBrowserTarget
      ? "Browser target not detected yet. Save the extension options and connect."
      : "Machine not detected yet. Run the connect command on the target.");
  };

  // Header status string for the current step, computed from live state.
  const headerStatus =
    step === "success"
      ? knownTarget
        ? targetStatus(knownTarget)
        : "CONNECTED"
      : targetStatus(knownTarget);

  // Build the flow definition fresh each render so step bodies capture live
  // state and the header status stays live. Step bodies own only their content
  // + footer button row; the shell renders the title/status/stepper. The
  // browser-extension target swaps in its own copy, steps, and labels.
  const flow: ConnectFlowDef = {
    key: "machines",
    navLabel: "MACHINES",
    parentLabel: "MACHINES",
    icon: targetIcon,
    title: isBrowserTarget ? "Connect browser extension" : "Connect machine",
    blurb: isBrowserTarget
      ? "Provision a driver token and attach the GSV browser extension to the fleet · Chrome, Brave, Edge, or another Chromium browser."
      : "Provision a native device token, install the CLI, and attach the machine to the fleet · Mac, Windows, or Linux.",
    steps: [
      {
        key: "platform",
        label: stepLabels[0],
        title: "SELECT PLATFORM",
        meta: "STEP 1 / 5",
        status: headerStatus,
        render: () => (
          <>
            <p class="gsv-cf-desc" style={{ margin: 0 }}>
              Choose the target type you are adding to the fleet.
            </p>
            <div class="gsv-cf-tiles">
              {MACHINE_PLATFORM_OPTIONS.map((option) => (
                <button
                  type="button"
                  class={`machine-platform-tile-button${platform === option.id ? " is-selected" : ""}`}
                  key={option.id}
                  aria-pressed={platform === option.id ? "true" : "false"}
                  onClick={() => selectPlatform(option.id)}
                >
                  <Tile
                    label={option.label}
                    glyph="machines"
                    iconSrc={`/icons/doticons/${option.dotIcon}.svg`}
                    iconTitle={option.label}
                    iconSize={36}
                    status={platform === option.id ? "accent" : "idle"}
                    statusHint={`Select ${option.label}`}
                    selected={platform === option.id}
                  />
                  <span class="machine-platform-meta gsv-prose-sm">{option.meta}</span>
                  <Tag tone={platform === option.id ? "accent" : "idle"} label={option.commandLabel.toUpperCase()} boxed />
                </button>
              ))}
            </div>
            <div class="gsv-cf-footer">
              <span class="gsv-cf-footer-spacer" />
              <Button variant="primary" label="CONTINUE" onClick={() => setStep("details")} />
            </div>
          </>
        ),
      },
      {
        key: "details",
        label: stepLabels[1],
        title: "DEVICE DETAILS",
        meta: "STEP 2 / 5",
        status: headerStatus,
        render: () => (
          <>
            <div class="gsv-cf-fields">
              <TextInput
                label={isBrowserTarget ? "BROWSER NAME" : "MACHINE NAME"}
                value={machineName}
                placeholder={isBrowserTarget ? "Chrome" : "Studio MacBook"}
                clearable
                status={machineName.trim() ? "success" : "warning"}
                message={machineName.trim() ? "Display label ready" : `${isBrowserTarget ? "Browser" : "Machine"} name required`}
                onChange={updateMachineName}
              />
              <TextInput
                key={`device-${deviceId}`}
                label="DEVICE ID"
                value={deviceId}
                placeholder={isBrowserTarget ? "chrome" : "studio-macbook"}
                clearable
                status={validDeviceId ? "success" : "warning"}
                message={validDeviceId
                  ? (isBrowserTarget ? "Use this exact value in the extension" : "Used by CLI and routing")
                  : deviceId.trim() ? DEVICE_ID_FORMAT_DESCRIPTION : "Device id required"}
                onChange={updateDeviceId}
              />
              <TextInput
                key={`expires-${expiresDays}`}
                label="TOKEN EXPIRY"
                value={expiresDays}
                suffix="DAYS"
                status="info"
                message={`${expires} day node token`}
                onChange={(value) => {
                  setExpiresDays(value.replace(/[^0-9]/g, ""));
                  resetToken();
                }}
              />
            </div>
            <div class="gsv-cf-framed">
              <ListRow
                icon={targetIcon}
                label={machineName || "New machine"}
                sub={`${deviceId || "device-id"} / ${selectedPlatform.commandLabel}`}
                status={detailsReady ? "online" : "warn"}
                statusLabel={detailsReady ? "READY" : "INCOMPLETE"}
                statusDotPlacement="trailing"
              />
            </div>
            <div class="gsv-cf-footer">
              <Button variant="secondary" label="BACK" onClick={() => setStep("platform")} />
              <span class="gsv-cf-footer-spacer" />
              <Button
                variant="primary"
                label="CONTINUE"
                disabled={!detailsReady}
                onClick={() => setStep("install")}
              />
            </div>
          </>
        ),
      },
      {
        key: "install",
        label: stepLabels[2],
        title: isBrowserTarget ? "INSTALL EXTENSION" : "INSTALL CLI",
        meta: "STEP 3 / 5",
        status: headerStatus,
        render: () => (
          isBrowserTarget ? (
            <>
              <p class="gsv-cf-desc" style={{ margin: 0 }}>
                Install the GSV browser extension as an unpacked extension, then open its Options page.
              </p>
              <section class="machine-browser-install" aria-label="Browser extension install steps">
                <div class="machine-browser-install-head">
                  <div>
                    <span>GSV Browser Extension</span>
                    <small>ZIP package / unpacked install</small>
                  </div>
                  <a
                    class="machine-download-link"
                    href={extensionDownloadUrl}
                    target="_blank"
                    rel="noreferrer"
                    download
                  >
                    DOWNLOAD ZIP
                  </a>
                </div>
                <ol class="machine-install-steps">
                  <li>
                    <span>1</span>
                    <p>Download and unzip <code>gsv-browser-extension.zip</code>.</p>
                  </li>
                  <li>
                    <span>2</span>
                    <p>Open <code>chrome://extensions</code> in Chrome, Brave, Edge, or another Chromium browser.</p>
                  </li>
                  <li>
                    <span>3</span>
                    <p>Enable <strong>Developer mode</strong>, choose <strong>Load unpacked</strong>, and select the unzipped extension folder.</p>
                  </li>
                  <li>
                    <span>4</span>
                    <p>Open the extension Options page. The next step gives you the exact connection values.</p>
                  </li>
                </ol>
              </section>
              <div class="gsv-cf-footer">
                <Button variant="secondary" label="BACK" onClick={() => setStep("details")} />
                <span class="gsv-cf-footer-spacer" />
                <Button variant="primary" label="EXTENSION READY" onClick={() => setStep("connect")} />
              </div>
            </>
          ) : (
            <>
              <p class="gsv-cf-desc" style={{ margin: 0 }}>
                Run this installer on the machine you want GSV to control.
              </p>
              <CommandBlock
                title="INSTALL COMMAND"
                meta={selectedPlatform.commandLabel}
                value={installCommand}
                copied={copied === "install"}
                onCopy={() => void copyCommand("install", installCommand)}
              />
              <div class="gsv-cf-footer">
                <Button variant="secondary" label="BACK" onClick={() => setStep("details")} />
                <span class="gsv-cf-footer-spacer" />
                <Button variant="primary" label="CLI INSTALLED" onClick={() => setStep("connect")} />
              </div>
            </>
          )
        ),
      },
      {
        key: "connect",
        label: stepLabels[3],
        title: isBrowserTarget ? "PAIR EXTENSION" : "CONNECT MACHINE",
        meta: "STEP 4 / 5",
        status: headerStatus,
        render: () => (
          <>
            {!issuedToken ? (
              <div class="machine-issue-token">
                <StatusDot tone={createToken.isPending ? "live" : "update"} size={9} />
                <div>
                  <strong>
                    {createToken.isPending
                      ? `ISSUING ${isBrowserTarget ? "DRIVER" : "NODE"} TOKEN`
                      : `ISSUE ${isBrowserTarget ? "DRIVER" : "NODE"} TOKEN`}
                  </strong>
                  <span>
                    The token is scoped to {deviceId || "this device"} and expires in {expires} days.
                    {isBrowserTarget ? " The extension device id must match this target." : ""}
                  </span>
                </div>
              </div>
            ) : isBrowserTarget && browserConfig ? (
              <>
                <p class="gsv-cf-desc" style={{ margin: 0 }}>
                  Paste these values into the GSV browser extension Options page, then save and connect.
                </p>
                <section class="machine-extension-values" aria-label="Browser extension connection values">
                  <ExtensionValueRow
                    label="Gateway WebSocket URL"
                    value={browserConfig.gatewayUrl}
                    copied={copied === "gateway"}
                    onCopy={() => void copyCommand("gateway", browserConfig.gatewayUrl)}
                  />
                  <ExtensionValueRow
                    label="Username"
                    value={browserConfig.username}
                    copied={copied === "username"}
                    onCopy={() => void copyCommand("username", browserConfig.username)}
                  />
                  <ExtensionValueRow
                    label="Driver token"
                    value={browserConfig.token}
                    copied={copied === "token"}
                    onCopy={() => void copyCommand("token", browserConfig.token)}
                  />
                  <ExtensionValueRow
                    label="Device id"
                    value={browserConfig.deviceId}
                    copied={copied === "deviceId"}
                    onCopy={() => void copyCommand("deviceId", browserConfig.deviceId)}
                  />
                </section>
              </>
            ) : (
              <>
                <p class="gsv-cf-desc" style={{ margin: 0 }}>
                  Run this command on the machine after the CLI installer completes.
                </p>
                <div class="machine-run-mode">
                  <Toggle
                    label="ONE-SHOT RUN"
                    size="small"
                    on={oneShotRun}
                    status={oneShotRun ? "info" : "none"}
                    message={oneShotRun ? "FOREGROUND / NO DAEMON" : ""}
                    onChange={setOneShotRun}
                  />
                </div>
                <CommandBlock
                  title="CONNECT COMMAND"
                  meta={`${deviceId} / token ${issuedToken.tokenPrefix}${oneShotRun ? " / one-shot" : ""}`}
                  value={connectCommand}
                  copied={copied === "connect"}
                  onCopy={() => void copyCommand("connect", connectCommand)}
                />
              </>
            )}
            {createError ? (
              <div class="machine-inline-error gsv-sublabel" role="alert">{createError}</div>
            ) : null}
            {checkMessage ? (
              <div class="machine-inline-info gsv-prose-sm" role="status">{checkMessage}</div>
            ) : null}
            {issuedToken && !knownTarget?.online ? (
              <div class="machine-waiting gsv-prose-sm">
                <Spinner size={15} />
                <span>{knownTarget ? "Registered. Waiting for online status." : `Waiting for ${isBrowserTarget ? "browser target" : "device"} registration.`}</span>
              </div>
            ) : null}
            <div class="gsv-cf-footer">
              <Button variant="secondary" label="BACK" disabled={createToken.isPending} onClick={() => setStep("install")} />
              <span class="gsv-cf-footer-spacer" />
              {!issuedToken ? (
                <Button
                  variant="primary"
                  label={createToken.isPending ? "ISSUING" : `ISSUE ${isBrowserTarget ? "DRIVER" : "NODE"} TOKEN`}
                  disabled={!detailsReady || createToken.isPending}
                  onClick={() => void issueToken()}
                />
              ) : (
                <Button
                  variant="primary"
                  label={targets.isFetching ? "CHECKING" : "CHECK CONNECTION"}
                  disabled={targets.isFetching}
                  onClick={() => void checkConnection()}
                />
              )}
            </div>
          </>
        ),
      },
      {
        key: "success",
        label: stepLabels[4],
        title: "SUCCESS",
        meta: "STEP 5 / 5",
        status: headerStatus,
        render: () => (
          <>
            <div class="gsv-cf-cap">
              <span class="gsv-cf-cap-mark">
                <Icon name={targetIcon} size={26} />
              </span>
              <div class="gsv-cf-cap-text">
                <span class="gsv-cf-cap-title">{machineName || deviceId} is connected</span>
                <span class="gsv-cf-cap-sub">
                  {isBrowserTarget
                    ? "The browser target is now available to GSV agents for browser-local tools."
                    : "The machine is now part of the GSV fleet and can be used by Files, Terminal, and agent tools."}
                </span>
              </div>
            </div>
            <div class="gsv-cf-framed">
              {knownTarget ? (
                <ListRow
                  icon={targetIcon}
                  label={knownTarget.label}
                  sub={targetSub(knownTarget)}
                  status={knownTarget.online ? "online" : "idle"}
                  statusLabel={targetStatus(knownTarget)}
                  statusDotPlacement="trailing"
                />
              ) : (
                <ListRow
                  icon={targetIcon}
                  label={machineName || deviceId}
                  sub={deviceId}
                  status="online"
                  statusLabel="CONNECTED"
                  statusDotPlacement="trailing"
                />
              )}
            </div>
            <div class="gsv-cf-footer">
              <span class="gsv-cf-footer-spacer" />
              <Button
                variant="primary"
                label={isBrowserTarget ? "OPEN TARGET" : "OPEN MACHINE"}
                disabled={!knownTarget || !onOpenMachine}
                onClick={() => {
                  if (knownTarget) {
                    onOpenMachine?.(knownTarget);
                  }
                }}
              />
            </div>
          </>
        ),
      },
    ],
  };

  const current = stepIndex(step);

  // Allow only backward navigation to already-visited steps; forward jumps are
  // gated by the per-step CONTINUE handlers above.
  const onStep = (target: number) => {
    if (target < current) {
      setStep(MACHINE_PROVISION_STEPS[target]);
    }
  };

  return <ConnectFlowShell flow={flow} current={current} onStep={onStep} />;
}
