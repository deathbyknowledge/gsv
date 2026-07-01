import type { OnboardingDraft } from "@humansandmachines/gsv/protocol";
import {
  browserTimeZone,
  buildAiSummary,
  buildDeviceSummary,
  buildSourceSummary,
} from "../sessionDomain";
import { Tooltip } from "../../../components/ui/Tooltip";
import { InfoTip } from "../../../components/ui/InfoTip";
import "./ReviewStage.css";

export function ReviewStage({ draft }: { draft: OnboardingDraft }) {
  const username = draft.account.username.trim();
  const agentName = draft.account.agentName.trim();
  const accountSummary = agentName
    ? `${username} · agent ${agentName}`
    : `${username} · default personal agent`;

  return (
    <section class="gsv-setup-stage gsv-setup-stage-review" data-setup-stage="review" hidden={draft.stage !== "review"}>
      <div class="gsv-setup-head">
        <span class="gsv-setup-head-kicker gsv-sublabel">Create account · Step 3 / 3</span>
        <h2 class="gsv-setup-head-title gsv-prose-display">Review and deploy</h2>
        <p class="gsv-setup-head-sub gsv-prose">This is the setup plan that will be applied before the desktop opens.</p>
      </div>
      <div class="review-table">
        <div class="review-row">
          <span class="review-row-k gsv-label">Account</span>
          <Tooltip text="First desktop user and personal agent account." position="left">
            <span class="review-row-v gsv-listitem" data-setup-summary-account>{accountSummary}</span>
          </Tooltip>
        </div>
        <div class="review-row">
          <span class="review-row-klabel">
            <span class="review-row-k gsv-label">Admin security</span>
            <InfoTip text="adding and removing users, other system wide configurations" position="right" />
          </span>
          <Tooltip text="How sensitive admin actions are protected." position="left">
            <span class="review-row-v gsv-listitem" data-setup-summary-admin>
              {draft.admin.mode === "custom" ? "Extra admin security layer configured" : "Account password protects admin tasks"}
            </span>
          </Tooltip>
        </div>
        <div class="review-row">
          <span class="review-row-k gsv-label">Timezone</span>
          <Tooltip text="Calendar basis for schedules and timestamps." position="left">
            <span class="review-row-v gsv-listitem" data-setup-summary-timezone>{draft.system.timezone.trim() || browserTimeZone()}</span>
          </Tooltip>
        </div>
        <div class="review-row">
          <span class="review-row-k gsv-label">AI</span>
          <Tooltip text="Initial AI service and model behavior." position="left">
            <span class="review-row-v gsv-listitem" data-setup-summary-ai>{buildAiSummary(draft)}</span>
          </Tooltip>
        </div>
        <div class="review-row">
          <span class="review-row-k gsv-label">System files</span>
          <Tooltip text="The system files loaded during setup." position="left">
            <span class="review-row-v gsv-listitem" data-setup-summary-source>{buildSourceSummary(draft)}</span>
          </Tooltip>
        </div>
        <div class="review-row">
          <span class="review-row-k gsv-label">Device setup</span>
          <Tooltip text="Optional setup key for connecting another machine." position="left">
            <span class="review-row-v gsv-listitem" data-setup-summary-device>{buildDeviceSummary(draft)}</span>
          </Tooltip>
        </div>
      </div>
      <aside class="gsv-setup-review-notes">
        <div>
          <strong class="gsv-sublabel">You can change this later</strong>
          <p class="gsv-prose-sm">AI defaults and system settings can be adjusted from the desktop after setup.</p>
        </div>
        <div>
          <strong class="gsv-sublabel">What are system files?</strong>
          <p class="gsv-prose-sm">They define the built-in apps and settings GSV starts with.</p>
        </div>
      </aside>
    </section>
  );
}
