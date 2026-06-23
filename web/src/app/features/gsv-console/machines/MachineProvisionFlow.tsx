import { useEffect, useMemo, useState } from "preact/hooks";
import { Button } from "../../../components/ui/Button";
import { Icon } from "../../../components/ui/Icon";
import { IconButton } from "../../../components/ui/IconButton";
import { ListRow } from "../../../components/ui/ListRow";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { Spinner } from "../../../components/ui/Spinner";
import { StatusDot } from "../../../components/ui/StatusDot";
import { Stepper } from "../../../components/ui/Stepper";
import { Surface } from "../../../components/ui/Surface";
import { Tag } from "../../../components/ui/Tag";
import { TextInput } from "../../../components/ui/TextInput";
import { Tile } from "../../../components/ui/Tile";
import { useSession } from "../../../services/session/SessionProvider";
import type { IssuedMachineNodeToken } from "../backend/consoleService";
import type { ConsoleTarget } from "../domain/consoleModels";
import { useConsoleTargets, useCreateMachineNodeToken } from "../hooks/useConsoleData";
import {
  MACHINE_PLATFORM_OPTIONS,
  MACHINE_PROVISION_STEP_LABELS,
  buildMachineBootstrapCommand,
  buildMachineInstallCommand,
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

type CopyTarget = "install" | "connect";

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
    <section class="machine-command">
      <header>
        <div>
          <span>{title}</span>
          <small>{meta}</small>
        </div>
        <button type="button" class="machine-copy-button" onClick={onCopy}>
          <Icon name="bookmark" size={13} />
          <span>{copied ? "COPIED" : "COPY"}</span>
        </button>
      </header>
      <pre>{value}</pre>
    </section>
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
  const origin = window.location.origin;
  const selectedPlatform = platformOption(platform);
  const knownTarget = targets.targets.find((target) => target.deviceId === deviceId.trim()) ?? null;
  const currentStep = stepIndex(step);
  const expires = normalizeExpiresDays(expiresDays);
  const detailsReady = machineName.trim().length > 0 && deviceId.trim().length > 0;
  const installCommand = useMemo(
    () => buildMachineInstallCommand(origin, platform),
    [origin, platform],
  );
  const bootstrapCommand = issuedToken
    ? buildMachineBootstrapCommand({
        origin,
        platform,
        username: snapshot.username || "root",
        deviceId,
        token: issuedToken.token,
      })
    : "";
  const createError = errorText(createToken.error);

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
    if (!detailsReady || createToken.isPending) {
      return;
    }
    setCheckMessage("");
    const token = await createToken.mutateAsync({
      deviceId: deviceId.trim(),
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
      setCheckMessage("Machine registered. Waiting for it to come online.");
      return;
    }
    setCheckMessage("Machine not detected yet. Run the connect command on the target.");
  };

  const renderStep = () => {
    if (step === "platform") {
      return (
        <>
          <SectionHeader title="SELECT PLATFORM" meta="STEP 1 / 5" divider />
          <div class="machine-card-body">
            <p class="machine-card-copy">Choose the operating system for the machine you are adding to the fleet.</p>
            <div class="machine-platform-grid">
              {MACHINE_PLATFORM_OPTIONS.map((option) => (
                <button
                  type="button"
                  class={`machine-platform-tile-button${platform === option.id ? " is-selected" : ""}`}
                  key={option.id}
                  aria-pressed={platform === option.id ? "true" : "false"}
                  title={`${option.label}: ${option.meta}`}
                  onClick={() => selectPlatform(option.id)}
                >
                  <Tile
                    label={option.label}
                    glyph="machines"
                    iconSrc={`/icons/doticons/${option.dotIcon}.svg`}
                    iconTitle={option.label}
                    iconSize={36}
                    status={platform === option.id ? "update" : "idle"}
                    selected={platform === option.id}
                  />
                  <span class="machine-platform-meta">{option.meta}</span>
                  <Tag tone={platform === option.id ? "accent" : "idle"} label={option.commandLabel.toUpperCase()} boxed />
                </button>
              ))}
            </div>
          </div>
          <footer class="machine-card-actions">
            <Button variant="secondary" label="BACK TO MACHINES" onClick={onBack} />
            <Button variant="primary" label="CONTINUE" onClick={() => setStep("details")} />
          </footer>
        </>
      );
    }

    if (step === "details") {
      return (
        <>
          <SectionHeader title="DEVICE DETAILS" meta="STEP 2 / 5" divider />
          <div class="machine-card-body">
            <div class="machine-detail-grid">
              <TextInput
                label="MACHINE NAME"
                value={machineName}
                placeholder="Studio MacBook"
                clearable
                status={machineName.trim() ? "success" : "warning"}
                message={machineName.trim() ? "Display label ready" : "Machine name required"}
                onChange={updateMachineName}
              />
              <TextInput
                key={`device-${deviceId}`}
                label="DEVICE ID"
                value={deviceId}
                placeholder="studio-macbook"
                clearable
                status={deviceId.trim() ? "success" : "warning"}
                message={deviceId.trim() ? "Used by CLI and routing" : "Device id required"}
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
            <div class="machine-detail-summary">
              <ListRow
                icon="computer"
                label={machineName || "New machine"}
                sub={`${deviceId || "device-id"} / ${selectedPlatform.commandLabel}`}
                status={detailsReady ? "online" : "warn"}
                statusLabel={detailsReady ? "READY" : "INCOMPLETE"}
                statusDotPlacement="trailing"
              />
            </div>
          </div>
          <footer class="machine-card-actions">
            <Button variant="secondary" label="BACK" onClick={() => setStep("platform")} />
            <Button
              variant="primary"
              label="CONTINUE"
              disabled={!detailsReady}
              onClick={() => setStep("install")}
            />
          </footer>
        </>
      );
    }

    if (step === "install") {
      return (
        <>
          <SectionHeader title="INSTALL CLI" meta="STEP 3 / 5" divider />
          <div class="machine-card-body">
            <p class="machine-card-copy">Run this installer on the machine you want GSV to control.</p>
            <CommandBlock
              title="INSTALL COMMAND"
              meta={selectedPlatform.commandLabel}
              value={installCommand}
              copied={copied === "install"}
              onCopy={() => void copyCommand("install", installCommand)}
            />
          </div>
          <footer class="machine-card-actions">
            <Button variant="secondary" label="BACK" onClick={() => setStep("details")} />
            <Button variant="primary" label="CLI INSTALLED" onClick={() => setStep("connect")} />
          </footer>
        </>
      );
    }

    if (step === "connect") {
      return (
        <>
          <SectionHeader title="CONNECT MACHINE" meta="STEP 4 / 5" divider />
          <div class="machine-card-body">
            {!issuedToken ? (
              <div class="machine-issue-token">
                <StatusDot tone={createToken.isPending ? "live" : "update"} size={9} />
                <div>
                  <strong>{createToken.isPending ? "ISSUING NODE TOKEN" : "ISSUE NODE TOKEN"}</strong>
                  <span>
                    The token is scoped to {deviceId || "this device"} and expires in {expires} days.
                  </span>
                </div>
              </div>
            ) : (
              <>
                <p class="machine-card-copy">Run this command on the machine after the CLI installer completes.</p>
                <CommandBlock
                  title="CONNECT COMMAND"
                  meta={`${deviceId} / token ${issuedToken.tokenPrefix}`}
                  value={bootstrapCommand}
                  copied={copied === "connect"}
                  onCopy={() => void copyCommand("connect", bootstrapCommand)}
                />
              </>
            )}
            {createError ? (
              <div class="machine-inline-error" role="alert">{createError}</div>
            ) : null}
            {checkMessage ? (
              <div class="machine-inline-info" role="status">{checkMessage}</div>
            ) : null}
            {issuedToken && !knownTarget?.online ? (
              <div class="machine-waiting">
                <Spinner size={15} />
                <span>{knownTarget ? "Registered. Waiting for online status." : "Waiting for device registration."}</span>
              </div>
            ) : null}
          </div>
          <footer class="machine-card-actions">
            <Button variant="secondary" label="BACK" disabled={createToken.isPending} onClick={() => setStep("install")} />
            {!issuedToken ? (
              <Button
                variant="primary"
                label={createToken.isPending ? "ISSUING" : "ISSUE TOKEN"}
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
          </footer>
        </>
      );
    }

    return (
      <>
        <SectionHeader title="SUCCESS" meta="STEP 5 / 5" divider />
        <div class="machine-card-body">
          <div class="machine-success-mark">
            <Icon name="computer" size={30} />
          </div>
          <h3>{machineName || deviceId} is connected</h3>
          <p class="machine-card-copy">The machine is now part of the GSV fleet and can be used by Files, Terminal, and agent tools.</p>
          <div class="machine-detail-summary">
            {knownTarget ? (
              <ListRow
                icon="computer"
                label={knownTarget.label}
                sub={targetSub(knownTarget)}
                status={knownTarget.online ? "online" : "idle"}
                statusLabel={targetStatus(knownTarget)}
                statusDotPlacement="trailing"
              />
            ) : (
              <ListRow
                icon="computer"
                label={machineName || deviceId}
                sub={deviceId}
                status="online"
                statusLabel="CONNECTED"
                statusDotPlacement="trailing"
              />
            )}
          </div>
        </div>
        <footer class="machine-card-actions">
          <Button variant="secondary" label="BACK TO MACHINES" onClick={onBack} />
          <Button
            variant="primary"
            label="OPEN MACHINE"
            disabled={!knownTarget || !onOpenMachine}
            onClick={() => {
              if (knownTarget) {
                onOpenMachine?.(knownTarget);
              }
            }}
          />
        </footer>
      </>
    );
  };

  return (
    <section class="machine-provision">
      <div class="machine-provision-shell">
        <header class="machine-provision-head">
          <IconButton glyph="arrowBack" size="medium" title="Back to machines" onClick={onBack} />
          <div>
            <span class="machine-provision-kicker">FLEET / NEW MACHINE</span>
            <h2>Connect new machine</h2>
            <p>Provision a native device token, install the CLI, and attach the machine to GSV.</p>
          </div>
          <Tag tone={knownTarget?.online ? "online" : issuedToken ? "update" : "idle"} label={targetStatus(knownTarget)} boxed dot />
        </header>

        <div class="machine-provision-stepper" aria-label="Machine connection progress">
          <Stepper
            count={5}
            current={currentStep}
            l0={MACHINE_PROVISION_STEP_LABELS[0]}
            l1={MACHINE_PROVISION_STEP_LABELS[1]}
            l2={MACHINE_PROVISION_STEP_LABELS[2]}
            l3={MACHINE_PROVISION_STEP_LABELS[3]}
            l4={MACHINE_PROVISION_STEP_LABELS[4]}
            width={620}
            size="small"
          />
        </div>

        <Surface class="machine-provision-card" level={2}>
          {renderStep()}
        </Surface>
      </div>
    </section>
  );
}
