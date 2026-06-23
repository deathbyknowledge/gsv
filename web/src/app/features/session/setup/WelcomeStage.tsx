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
    <section class="onboarding-stage onboarding-stage-welcome" data-setup-stage="welcome" hidden={draft.stage !== "welcome"}>
      <div class="onboarding-mode-grid">
        <Surface
          as="button"
          interactive
          selected={draft.lane === "quick"}
          class="onboarding-mode-card"
          dataAttrs={{ "data-setup-lane": "quick" }}
          onClick={() => onLane("quick")}
        >
          <span class="onboarding-mode-kicker">Recommended</span>
          <strong>Quick start</strong>
          <p>Create the first account, keep the default AI path, and use the official system files.</p>
        </Surface>
        <Surface
          as="button"
          interactive
          selected={draft.lane === "customize" || draft.lane === "advanced"}
          class="onboarding-mode-card"
          dataAttrs={{ "data-setup-lane": "customize" }}
          onClick={() => onLane("customize")}
        >
          <span class="onboarding-mode-kicker">More control</span>
          <strong>Custom</strong>
          <p>Choose AI defaults, system files, and optional device setup before first start.</p>
        </Surface>
      </div>
    </section>
  );
}
