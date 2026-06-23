import type { OnboardingDraft, OnboardingLane } from "@humansandmachines/gsv/protocol";
import { Surface } from "../../../components/ui/Surface";
import "./WelcomeStage.css";

export function WelcomeStage({
  draft,
  onLane,
}: {
  draft: OnboardingDraft;
  onLane: (lane: OnboardingLane) => void;
}) {
  return (
    <section class="gsv-setup-stage gsv-setup-stage-welcome" data-setup-stage="welcome" hidden={draft.stage !== "welcome"}>
      <div class="gsv-setup-head">
        <span class="gsv-setup-head-kicker">Create account · Step 1 / 3</span>
        <h1 class="gsv-setup-head-title" data-setup-heading>Choose a setup path</h1>
        <p class="gsv-setup-head-sub">Pick how much you want to configure before first start.</p>
      </div>
      <div class="gsv-setup-mode-grid">
        <Surface
          as="button"
          interactive
          selected={draft.lane === "quick"}
          class="gsv-setup-mode-card"
          dataAttrs={{ "data-setup-lane": "quick" }}
          onClick={() => onLane("quick")}
        >
          <span class="gsv-setup-mode-kicker">Recommended</span>
          <strong>Quick start</strong>
          <p>Create the first account, keep the default AI path, and use the official system files.</p>
        </Surface>
        <Surface
          as="button"
          interactive
          selected={draft.lane === "customize" || draft.lane === "advanced"}
          class="gsv-setup-mode-card"
          dataAttrs={{ "data-setup-lane": "customize" }}
          onClick={() => onLane("customize")}
        >
          <span class="gsv-setup-mode-kicker">More control</span>
          <strong>Custom</strong>
          <p>Choose AI defaults, system files, and optional device setup before first start.</p>
        </Surface>
      </div>
    </section>
  );
}
