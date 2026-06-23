import type { OnboardingDraft } from "@humansandmachines/gsv/protocol";
import {
  SETUP_LANE_META,
  browserTimeZone,
  buildAiSummary,
  buildDeviceSummary,
  buildSourceSummary,
} from "../sessionDomain";
import { Surface } from "../../../components/ui/Surface";
import "./ReviewStage.css";

export function ReviewStage({ draft }: { draft: OnboardingDraft }) {
  const meta = SETUP_LANE_META[draft.lane];
  const username = draft.account.username.trim();
  const agentName = draft.account.agentName.trim();
  const accountSummary = agentName
    ? `${username} · agent ${agentName}`
    : `${username} · default personal agent`;

  return (
    <section class="gsv-setup-stage gsv-setup-stage-review" data-setup-stage="review" hidden={draft.stage !== "review"}>
      <span class="gsv-setup-lane-kicker">Review and start</span>
      <div class="gsv-setup-step-copy">
        <h2>Setup plan</h2>
        <p class="gsv-setup-copy-text">This is the setup plan that will be applied before the desktop opens.</p>
      </div>
      <div class="review-summary-grid">
        <Surface level={1} class="review-card">
          <span class="review-card-label">Path</span>
          <strong class="review-card-value" data-setup-summary-lane>{meta.label}</strong>
          <p class="review-card-desc" data-setup-summary-lane-copy>{meta.reviewCopy}</p>
        </Surface>
        <Surface level={1} class="review-card">
          <span class="review-card-label">Account</span>
          <strong class="review-card-value" data-setup-summary-account>{accountSummary}</strong>
          <p class="review-card-desc">First desktop user and personal agent account.</p>
        </Surface>
        <Surface level={1} class="review-card">
          <span class="review-card-label">Admin security</span>
          <strong class="review-card-value" data-setup-summary-admin>
            {draft.admin.mode === "custom" ? "Extra admin security layer configured" : "Account password protects admin tasks"}
          </strong>
          <p class="review-card-desc">How sensitive admin actions are protected.</p>
        </Surface>
        <Surface level={1} class="review-card">
          <span class="review-card-label">Timezone</span>
          <strong class="review-card-value" data-setup-summary-timezone>{draft.system.timezone.trim() || browserTimeZone()}</strong>
          <p class="review-card-desc">Calendar basis for schedules and timestamps.</p>
        </Surface>
        <Surface level={1} class="review-card">
          <span class="review-card-label">AI</span>
          <strong class="review-card-value" data-setup-summary-ai>{buildAiSummary(draft)}</strong>
          <p class="review-card-desc">Initial AI service and model behavior.</p>
        </Surface>
        <Surface level={1} class="review-card">
          <span class="review-card-label">System files</span>
          <strong class="review-card-value" data-setup-summary-source>{buildSourceSummary(draft)}</strong>
          <p class="review-card-desc">The system files loaded during setup.</p>
        </Surface>
        <Surface level={1} class="review-card">
          <span class="review-card-label">Device setup</span>
          <strong class="review-card-value" data-setup-summary-device>{buildDeviceSummary(draft)}</strong>
          <p class="review-card-desc">Optional setup key for connecting another machine.</p>
        </Surface>
      </div>
      <aside class="gsv-setup-review-notes">
        <div>
          <strong>You can change this later</strong>
          <p>AI defaults and system settings can be adjusted from the desktop after setup.</p>
        </div>
        <div>
          <strong>What are system files?</strong>
          <p>They define the built-in apps and settings GSV starts with.</p>
        </div>
      </aside>
    </section>
  );
}
