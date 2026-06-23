import type { OnboardingDraft } from "@humansandmachines/gsv/protocol";
import { currentDetailStep } from "../sessionDomain";
import { AccountDetails } from "./AccountDetails";
import { SystemDetails } from "./SystemDetails";

export function DetailsStage({
  draft,
  timezoneOptions,
  updateDraft,
}: {
  draft: OnboardingDraft;
  timezoneOptions: string[];
  updateDraft: (updater: (draft: OnboardingDraft) => OnboardingDraft) => void;
}) {
  const activeStep = currentDetailStep(draft);
  const isSystem = activeStep === "system";
  const title = isSystem ? "Preferences" : "Desktop account";
  const description = isSystem
    ? draft.lane === "quick"
      ? "Confirm timezone and decide whether admin actions need a separate password."
      : "Confirm timezone, admin security, and any custom AI, system files, or device settings."
    : "Create the first desktop account and secure it with a password.";

  return (
    <section class="onboarding-stage onboarding-stage-details" data-setup-stage="details" hidden={draft.stage !== "details"}>
      <div class="onboarding-lane-banner">
        <span data-setup-lane-kicker>{isSystem ? "Preferences" : "Login credentials"}</span>
      </div>
      <div class="setup-step-copy" data-setup-detail-copy>
        <h2 data-setup-lane-title>{title}</h2>
        <p class="session-copy" data-setup-lane-description>{description}</p>
      </div>
      <AccountDetails draft={draft} activeStep={activeStep} updateDraft={updateDraft} />
      <SystemDetails draft={draft} activeStep={activeStep} timezoneOptions={timezoneOptions} updateDraft={updateDraft} />
    </section>
  );
}
