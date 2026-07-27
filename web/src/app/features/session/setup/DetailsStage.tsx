import type { OnboardingDraft } from "@humansandmachines/gsv/protocol";
import { currentDetailStep } from "../sessionDomain";
import { AccountDetails } from "./AccountDetails";
import { SystemDetails } from "./SystemDetails";
import "./DetailsStage.css";

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
    <section class="gsv-setup-stage gsv-setup-stage-details" data-setup-stage="details" hidden={draft.stage !== "details"}>
      <div class="gsv-setup-head" data-setup-detail-copy>
        <span class="gsv-setup-head-kicker gsv-sublabel" data-setup-lane-kicker>Create account · Step {isSystem ? 2 : 1} / 3</span>
        <h2 class="gsv-setup-head-title gsv-prose-display" data-setup-lane-title>{title}</h2>
        <p class="gsv-setup-head-sub gsv-prose" data-setup-lane-description>{description}</p>
      </div>
      <AccountDetails draft={draft} activeStep={activeStep} updateDraft={updateDraft} />
      <SystemDetails draft={draft} activeStep={activeStep} timezoneOptions={timezoneOptions} updateDraft={updateDraft} />
    </section>
  );
}
