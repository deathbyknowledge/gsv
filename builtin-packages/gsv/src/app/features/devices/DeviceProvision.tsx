import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { ActionButton } from "../../components/ui/ActionButton";
import { Icon } from "../../components/ui/Icon";
import { buildBootstrapCommand, buildInstallCommand, type ProvisionInstallPlatform } from "./provision";
import type { DeviceSummary, DevicesViewer, IssuedNodeToken } from "./types";

type ProvisionStepId = "platform" | "details" | "install" | "connect" | "success";

const WIZARD_STEPS: Array<{ id: ProvisionStepId; label: string }> = [
  { id: "platform", label: "Platform" },
  { id: "details", label: "Details" },
  { id: "install", label: "Install" },
  { id: "connect", label: "Connect" },
  { id: "success", label: "Success" },
];

export function ProvisionPanel({
  initialDeviceId,
  viewer,
  devices,
  pendingAction,
  errorText,
  issuedToken,
  onBack,
  onRefresh,
  onOpenMachine,
  onSubmit,
}: {
  initialDeviceId: string;
  viewer: DevicesViewer | null;
  devices: DeviceSummary[];
  pendingAction: string | null;
  errorText: string | null;
  issuedToken: IssuedNodeToken | null;
  onBack: () => void;
  onRefresh: (deviceId: string) => void;
  onOpenMachine: (deviceId: string) => void;
  onSubmit: (form: { deviceId: string; label: string; expiresDays: string }) => void;
}) {
  const [step, setStep] = useState<ProvisionStepId>("platform");
  const [platform, setPlatform] = useState<ProvisionInstallPlatform>("mac");
  const [machineId, setMachineId] = useState(initialDeviceId);
  const [label, setLabel] = useState(() => deriveMachineDisplayName(initialDeviceId));
  const [labelEdited, setLabelEdited] = useState(false);
  const [expiresDays, setExpiresDays] = useState("30");
  const [copied, setCopied] = useState<string | null>(null);
  const canCopy = typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function";
  const origin = window.location.origin;
  const install = buildInstallCommand(origin, platform);
  const setupMachineId = issuedToken?.allowedDeviceId ?? machineId.trim();
  const bootstrap = issuedToken
    ? buildBootstrapCommand(origin, platform, viewer?.username ?? "root", setupMachineId, issuedToken.token)
    : "";
  const connectedMachine = setupMachineId
    ? devices.find((device) => device.deviceId === setupMachineId && device.online)
    : null;
  const setupReady = Boolean(issuedToken);
  const isConnected = Boolean(connectedMachine);
  const hasDetails = machineId.trim().length > 0;
  const currentIndex = WIZARD_STEPS.findIndex((candidate) => candidate.id === step);

  const unlockedSteps = useMemo(() => new Set<ProvisionStepId>([
    "platform",
    "details",
    ...(setupReady ? (["install", "connect"] as ProvisionStepId[]) : []),
    ...(isConnected ? (["success"] as ProvisionStepId[]) : []),
  ]), [isConnected, setupReady]);

  useEffect(() => {
    if (initialDeviceId && !machineId) {
      setMachineId(initialDeviceId);
      if (!labelEdited) {
        setLabel(deriveMachineDisplayName(initialDeviceId));
      }
    }
  }, [initialDeviceId, labelEdited, machineId]);

  useEffect(() => {
    if (issuedToken && step === "details") {
      setStep("install");
    }
  }, [issuedToken, step]);

  useEffect(() => {
    if (isConnected && step !== "success") {
      setStep("success");
    }
  }, [isConnected, step]);

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

  function goToStep(nextStep: ProvisionStepId): void {
    if (unlockedSteps.has(nextStep)) {
      setStep(nextStep);
    }
  }

  if (!viewer?.canManageTokens) {
    return (
      <section class="gsv-device-detail">
        <div class="gsv-empty-state">
          <h3>New machine unavailable</h3>
          <p>Your current session cannot connect machines.</p>
        </div>
      </section>
    );
  }

  return (
    <section class="gsv-device-detail">
      <header class="gsv-device-detail-head">
        <div>
          <span class="gsv-kicker">Fleet</span>
          <h3>New machine</h3>
          <p>Connect a workstation, server, or extension host to this GSV fleet.</p>
        </div>
        <ActionButton icon="arrow-left" label="Fleet" size="compact" onClick={onBack} />
      </header>

      <div class="gsv-provision-flow">
        <WizardProgress currentStep={step} unlockedSteps={unlockedSteps} onStep={goToStep} />

        {step === "platform" ? (
          <WizardStep index={1} title="Select platform">
            <div class="gsv-platform-grid" role="group" aria-label="Machine platform">
              <PlatformButton
                platform="windows"
                active={platform === "windows"}
                label="Windows"
                detail="PowerShell"
                onClick={() => setPlatform("windows")}
              />
              <PlatformButton
                platform="mac"
                active={platform === "mac"}
                label="Mac"
                detail="Terminal"
                onClick={() => setPlatform("mac")}
              />
              <PlatformButton
                platform="linux"
                active={platform === "linux"}
                label="Linux"
                detail="Terminal"
                onClick={() => setPlatform("linux")}
              />
            </div>
            <WizardActions>
              <ActionButton icon="arrow-left" label="Fleet" size="compact" onClick={onBack} />
              <ActionButton
                icon="arrow-right"
                label="Continue"
                size="compact"
                variant="primary"
                onClick={() => setStep("details")}
              />
            </WizardActions>
          </WizardStep>
        ) : null}

        {step === "details" ? (
          <WizardStep index={2} title="Machine details">
            <form
              class="gsv-provision-form"
              onSubmit={(event) => {
                event.preventDefault();
                onSubmit({
                  deviceId: machineId.trim(),
                  label: label.trim() || deriveMachineDisplayName(machineId),
                  expiresDays: expiresDays.trim() || "30",
                });
              }}
            >
              <label>
                <span>Machine id</span>
                <input
                  name="deviceId"
                  value={machineId}
                  placeholder="workstation-01"
                  required
                  onInput={(event) => {
                    const nextMachineId = event.currentTarget.value;
                    setMachineId(nextMachineId);
                    if (!labelEdited) {
                      setLabel(deriveMachineDisplayName(nextMachineId));
                    }
                  }}
                />
              </label>
              <label>
                <span>Display name</span>
                <input
                  name="label"
                  value={label}
                  placeholder="MacBook Pro"
                  onInput={(event) => {
                    const nextLabel = event.currentTarget.value;
                    setLabel(nextLabel);
                    setLabelEdited(nextLabel.trim().length > 0);
                  }}
                />
              </label>
              <label>
                <span>Setup window</span>
                <input
                  name="expiresDays"
                  type="number"
                  min="1"
                  value={expiresDays}
                  onInput={(event) => setExpiresDays(event.currentTarget.value)}
                />
              </label>
              <WizardActions>
                <ActionButton icon="arrow-left" label="Back" size="compact" onClick={() => setStep("platform")} />
                <ActionButton
                  icon="arrow-right"
                  label="Create setup instructions"
                  busyLabel="Creating"
                  busy={pendingAction === "create-token"}
                  disabled={!hasDetails}
                  size="compact"
                  variant="primary"
                  type="submit"
                />
              </WizardActions>
            </form>
            {errorText ? <p class="gsv-inline-error">{errorText}</p> : null}
          </WizardStep>
        ) : null}

        {step === "install" ? (
          <WizardStep index={3} title="Install CLI">
            <CommandBlock
              title="Install GSV CLI"
              value={install}
              copied={copied === "install"}
              canCopy={canCopy}
              onCopy={() => void copy(install, "install")}
            />
            <WizardActions>
              <ActionButton icon="arrow-left" label="Back" size="compact" onClick={() => setStep("details")} />
              <ActionButton
                icon="arrow-right"
                label="Continue"
                size="compact"
                variant="primary"
                onClick={() => setStep("connect")}
              />
            </WizardActions>
          </WizardStep>
        ) : null}

        {step === "connect" ? (
          <WizardStep index={4} title="Connect">
            <CopyValueBlock
              title="Connection token"
              value={issuedToken?.token ?? ""}
              copied={copied === "token"}
              canCopy={canCopy}
              onCopy={() => void copy(issuedToken?.token ?? "", "token")}
            />
            <CommandBlock
              title="Connect machine commands"
              value={bootstrap}
              copied={copied === "bootstrap"}
              canCopy={canCopy}
              onCopy={() => void copy(bootstrap, "bootstrap")}
            />
            <div class="gsv-provision-success is-waiting">
              <Icon name="clock" />
              <span>Waiting for the first connection.</span>
              <ActionButton
                icon="refresh"
                label="Refresh"
                size="compact"
                busy={pendingAction === "load-state"}
                onClick={() => onRefresh(setupMachineId)}
              />
            </div>
            <WizardActions>
              <ActionButton icon="arrow-left" label="Back" size="compact" onClick={() => setStep("install")} />
            </WizardActions>
          </WizardStep>
        ) : null}

        {step === "success" ? (
          <WizardStep index={5} title="Success">
            <div class="gsv-provision-success">
              <Icon name="check" />
              <span>Connected to Fleet.</span>
              <ActionButton
                icon="arrow-right"
                label="Open machine"
                size="compact"
                onClick={() => onOpenMachine(setupMachineId)}
              />
            </div>
          </WizardStep>
        ) : null}

        <span class="gsv-provision-count">{currentIndex + 1} / {WIZARD_STEPS.length}</span>
      </div>
    </section>
  );
}

function WizardProgress({
  currentStep,
  unlockedSteps,
  onStep,
}: {
  currentStep: ProvisionStepId;
  unlockedSteps: Set<ProvisionStepId>;
  onStep: (step: ProvisionStepId) => void;
}) {
  const currentIndex = WIZARD_STEPS.findIndex((step) => step.id === currentStep);
  return (
    <nav class="gsv-provision-progress" aria-label="New machine progress">
      {WIZARD_STEPS.map((step, index) => {
        const unlocked = unlockedSteps.has(step.id);
        const active = step.id === currentStep;
        const complete = index < currentIndex || (step.id === "success" && active);
        return (
          <button
            key={step.id}
            type="button"
            class={`${active ? "is-active" : ""}${complete ? " is-complete" : ""}`}
            disabled={!unlocked}
            onClick={() => onStep(step.id)}
          >
            <span>{index + 1}</span>
            <strong>{step.label}</strong>
          </button>
        );
      })}
    </nav>
  );
}

function WizardStep({
  index,
  title,
  children,
}: {
  index: number;
  title: string;
  children: ComponentChildren;
}) {
  return (
    <section class="gsv-provision-step">
      <header>
        <span class="gsv-provision-step-index">{index}</span>
        <h4>{title}</h4>
      </header>
      <div class="gsv-provision-step-body">{children}</div>
    </section>
  );
}

function WizardActions({ children }: { children: ComponentChildren }) {
  return <div class="gsv-provision-actions">{children}</div>;
}

function PlatformButton({
  platform,
  active,
  label,
  detail,
  onClick,
}: {
  platform: ProvisionInstallPlatform;
  active: boolean;
  label: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      class={`gsv-platform-option${active ? " is-active" : ""}`}
      aria-pressed={active ? "true" : "false"}
      onClick={onClick}
    >
      <OsGlyph platform={platform} />
      <span>
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
    </button>
  );
}

function OsGlyph({ platform }: { platform: ProvisionInstallPlatform }) {
  return (
    <span class={`gsv-platform-glyph is-${platform}`} aria-hidden="true">
      {platform === "windows" ? (
        <>
          <span></span>
          <span></span>
          <span></span>
          <span></span>
        </>
      ) : platform === "mac" ? (
        <svg viewBox="0 0 24 24">
          <path d="M15.5 4.5c-.9.6-1.7 1.6-1.5 2.8 1.1.1 2.1-.6 2.7-1.4.5-.7.8-1.5.7-2.4-.7.1-1.4.4-1.9 1z"></path>
          <path d="M18.8 16.8c-.4.9-.7 1.3-1.2 2.1-.8 1.2-1.9 2.7-3.3 2.7-1.2 0-1.5-.8-3.2-.8-1.6 0-2 .8-3.1.8-1.4 0-2.5-1.4-3.3-2.6-2.3-3.5-2.5-7.7-1.1-9.9 1-1.6 2.6-2.5 4.1-2.5 1.5 0 2.4.8 3.6.8 1.2 0 1.9-.8 3.7-.8 1.3 0 2.7.7 3.7 2-.1.1-2.4 1.4-2.4 4.2 0 3.4 3 4 3 4z"></path>
        </svg>
      ) : (
        <svg viewBox="0 0 24 24">
          <path d="M12 3.5c2.2 0 3.8 1.9 3.8 4.6 0 1.2.5 2.2 1.1 3.2.9 1.4 1.8 2.8 1.8 4.4 0 3-2.8 4.8-6.7 4.8s-6.7-1.8-6.7-4.8c0-1.6.9-3 1.8-4.4.6-1 1.1-2 1.1-3.2 0-2.7 1.6-4.6 3.8-4.6z"></path>
          <path d="M9.2 16.8c1.6 1 4 1 5.6 0"></path>
          <path d="M9.4 11.1c-.8.4-1.4 1.1-1.8 1.9"></path>
          <path d="M14.6 11.1c.8.4 1.4 1.1 1.8 1.9"></path>
          <path d="M10 7.8h.01"></path>
          <path d="M14 7.8h.01"></path>
        </svg>
      )}
    </span>
  );
}

function CopyValueBlock({
  title,
  value,
  copied,
  canCopy,
  onCopy,
}: {
  title: string;
  value: string;
  copied: boolean;
  canCopy: boolean;
  onCopy: () => void;
}) {
  return (
    <section class="gsv-copy-value-block">
      <header>
        <h4>{title}</h4>
        <ActionButton
          icon="copy"
          label={copied ? "Copied" : "Copy"}
          size="compact"
          disabled={!canCopy || !value}
          onClick={onCopy}
        />
      </header>
      <code>{value || "Token unavailable"}</code>
    </section>
  );
}

function CommandBlock({
  title,
  value,
  copied,
  canCopy,
  onCopy,
}: {
  title: string;
  value: string;
  copied: boolean;
  canCopy: boolean;
  onCopy: () => void;
}) {
  return (
    <section class="gsv-command-block">
      <header>
        <h4>{title}</h4>
        <ActionButton
          icon="copy"
          label={copied ? "Copied" : "Copy"}
          size="compact"
          disabled={!canCopy}
          onClick={onCopy}
        />
      </header>
      <textarea readOnly value={value} onFocus={(event) => event.currentTarget.select()} />
    </section>
  );
}

function deriveMachineDisplayName(machineId: string): string {
  const words = machineId
    .trim()
    .replace(/([A-Za-z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([A-Za-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/g)
    .filter(Boolean);
  return words.map(capitalizeWord).join(" ");
}

function capitalizeWord(word: string): string {
  const lower = word.toLowerCase();
  return lower ? `${lower[0].toUpperCase()}${lower.slice(1)}` : "";
}
