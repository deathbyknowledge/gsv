import type { JSX } from "preact";
import type { OnboardingDetailStep, OnboardingStage } from "@humansandmachines/gsv/protocol";

type SetupStageRailProps = {
  stage: OnboardingStage;
  detailStep: OnboardingDetailStep;
};

export function SessionError({
  className = "session-error",
  message,
}: {
  className?: string;
  message: string | null;
}) {
  return (
    <p class={className} role="alert" hidden={!message}>
      {message ?? ""}
    </p>
  );
}

export function SetupStageRail({ stage, detailStep }: SetupStageRailProps) {
  const railItems = [
    { stage: "details", railStep: "account", label: "Login credentials", number: "1" },
    { stage: "details", railStep: "preferences", label: "Preferences", number: "2" },
    { stage: "review", railStep: "review", label: "Review and start", number: "3" },
  ] as const;

  return (
    <ol class="onboarding-step-list">
      {railItems.map((item) => {
        const active = stage === "review"
          ? item.railStep === "review"
          : stage === "details" && (
            (item.railStep === "account" && detailStep === "account") ||
            (item.railStep === "preferences" && detailStep !== "account")
          );
        const complete = stage === "review"
          ? item.railStep === "account" || item.railStep === "preferences"
          : stage === "details" && item.railStep === "account" && detailStep !== "account";
        const isWelcomeActive = stage === "welcome" && item.railStep === "account";
        const muted = item.stage !== stage && !active && !complete;

        return (
          <li
            class={[
              "onboarding-stage-pill",
              active || isWelcomeActive ? "is-active" : "",
              complete ? "is-complete" : "",
              muted ? "is-muted" : "",
            ].filter(Boolean).join(" ")}
            data-setup-stage-pill={item.stage}
            data-setup-rail-step={item.railStep}
            key={item.railStep}
          >
            <span>{item.number}</span>
            <strong>{item.label}</strong>
          </li>
        );
      })}
    </ol>
  );
}

export function CompleteStageRail() {
  return (
    <ol class="onboarding-step-list">
      {["Login credentials", "Preferences", "Review and start"].map((label, index) => (
        <li class="onboarding-stage-pill is-complete" key={label}>
          <span>{index + 1}</span>
          <strong>{label}</strong>
        </li>
      ))}
    </ol>
  );
}

export function DeployStageRail() {
  return (
    <ol class="onboarding-step-list">
      <li class="onboarding-stage-pill is-complete">
        <span>1</span>
        <strong>Login credentials</strong>
      </li>
      <li class="onboarding-stage-pill is-complete">
        <span>2</span>
        <strong>Preferences</strong>
      </li>
      <li class="onboarding-stage-pill is-active">
        <span>3</span>
        <strong>Review and start</strong>
      </li>
    </ol>
  );
}

export function OnboardingHelp({
  label,
  tooltipId,
  title,
  children,
}: {
  label: string;
  tooltipId: string;
  title: string;
  children: JSX.Element | string;
}) {
  return (
    <div class="onboarding-help" tabIndex={0} aria-label={label} aria-describedby={tooltipId}>
      <span class="onboarding-help-trigger" aria-hidden="true">?</span>
      <div id={tooltipId} class="onboarding-help-popover" role="tooltip">
        <strong>{title}</strong>
        <p>{children}</p>
      </div>
    </div>
  );
}
