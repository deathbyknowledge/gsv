import type { OnboardingDraft } from "@humansandmachines/gsv/protocol";
import { Stepper } from "../../../components/ui/Stepper";
import { SETUP_LANE_META, currentDetailStep } from "../sessionDomain";
import "./SetupSidebar.css";

export function SetupSidebar({ draft }: { draft: OnboardingDraft }) {
  const meta = SETUP_LANE_META[draft.lane];
  const detailStep = currentDetailStep(draft);
  const copy = draft.stage === "welcome" ? "Choose a setup path." : meta.estimate;

  // Mirror SetupStageRail's active/complete derivation into a single Stepper index:
  //   welcome / details(account)        → step 0 (Login credentials)
  //   details(detailStep !== "account") → step 1 (Preferences)
  //   review                            → step 2 (Review and start)
  const current =
    draft.stage === "review" ? 2 : draft.stage === "details" && detailStep !== "account" ? 1 : 0;

  return (
    <aside class="gsv-setup-sidebar">
      <div class="gsv-setup-head">
        <p class="gsv-setup-kicker gsv-sublabel">First-time setup</p>
        <h1 class="gsv-setup-title gsv-title" data-setup-heading>
          Create account
        </h1>
        <p class="gsv-setup-copy gsv-listitem" data-setup-copy>
          {copy}
        </p>
      </div>
      <Stepper
        current={current}
        l0="Login credentials"
        l1="Preferences"
        l2="Review and start"
        size="small"
        width={320}
      />
    </aside>
  );
}
