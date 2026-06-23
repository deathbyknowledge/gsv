import type { RefObject } from "preact";
import { useRef } from "preact/hooks";
import type {
  OnboardingDraft,
  OnboardingLane,
} from "@humansandmachines/gsv/protocol";
import type { OnboardingSnapshot } from "../../services/session/onboardingService";
import type { SessionSnapshot } from "../../services/session/sessionService";
import { Button } from "../../components/ui/Button";
import { Stepper } from "../../components/ui/Stepper";
import { AuthLayout } from "./AuthLayout";
import { SessionError } from "./SessionChrome";
import { currentDetailStep } from "./sessionDomain";
import { DetailsStage } from "./setup/DetailsStage";
import { GuidePanel } from "./setup/GuidePanel";
import { ReviewStage } from "./setup/ReviewStage";
import { WelcomeStage } from "./setup/WelcomeStage";
import "./SetupScreen.css";

type SetupScreenProps = {
  snapshot: SessionSnapshot;
  onboardingSnapshot: OnboardingSnapshot;
  setupError: string | null;
  guideMessage: string;
  guideInputRef: RefObject<HTMLTextAreaElement>;
  guideLogRef: RefObject<HTMLDivElement>;
  timezoneOptions: string[];
  onLane: (lane: OnboardingLane) => void;
  onBack: () => void;
  onNext: () => void;
  onSubmit: (event: Event) => void;
  onGuideToggle: () => void;
  onGuideMessage: (message: string) => void;
  onGuideSend: () => void;
  onGuideKeyDown: (event: KeyboardEvent) => void;
  updateDraft: (updater: (draft: OnboardingDraft) => OnboardingDraft) => void;
};

export function SetupScreen({
  snapshot,
  onboardingSnapshot,
  setupError,
  guideMessage,
  guideInputRef,
  guideLogRef,
  timezoneOptions,
  onLane,
  onBack,
  onNext,
  onSubmit,
  onGuideToggle,
  onGuideMessage,
  onGuideSend,
  onGuideKeyDown,
  updateDraft,
}: SetupScreenProps) {
  const { draft } = onboardingSnapshot;
  const busy = snapshot.phase === "authenticating";
  const showGuideToggle = draft.stage !== "welcome";
  const showNext = draft.stage === "details";
  const showSubmit = draft.stage === "review";
  const showBack = draft.stage !== "welcome";
  const guideButtonText = draft.mode === "guided" ? "Hide guide" : "Ask the guide";
  const formRef = useRef<HTMLFormElement>(null);

  // Three stepper steps: Login credentials (account) · Preferences (system) ·
  // Review and deploy. Welcome is the path chooser — before step 1 — so it has
  // no stepper and no step count.
  const detailStep = currentDetailStep(draft);
  const onWelcome = draft.stage === "welcome";
  const current =
    draft.stage === "review" ? 2 : detailStep !== "account" ? 1 : 0;

  return (
    <AuthLayout background="galaxy" visible={snapshot.phase === "setup"} surfaceClass="gsv-auth-surface-setup">
      <div class="gsv-setup-panel" data-session-setup-view>
        <form
          ref={formRef}
          class="gsv-setup-form"
          data-session-setup-form
          data-setup-stage={draft.stage}
          onSubmit={onSubmit}
        >
          {!onWelcome ? (
            <div class="gsv-setup-stepper">
              <Stepper
                current={current}
                l0="Login credentials"
                l1="Preferences"
                l2="Review and deploy"
                size="small"
                width={460}
              />
            </div>
          ) : null}

          <div class="gsv-setup-body">
            <WelcomeStage draft={draft} onLane={onLane} />
            <DetailsStage draft={draft} timezoneOptions={timezoneOptions} updateDraft={updateDraft} />
            <ReviewStage draft={draft} />
            <SessionError className="gsv-setup-alert" message={setupError} />
          </div>

          {!onWelcome ? (
            <div class="gsv-setup-nav">
              {showBack ? (
                <Button variant="secondary" label="Back" disabled={busy} onClick={onBack} />
              ) : null}
              <span class="gsv-setup-nav-spacer">
                <span class="gsv-setup-stepcount">
                  {current + 1} / 3
                </span>
              </span>
              {showNext ? (
                <Button variant="primary" label="Next" disabled={busy} onClick={onNext} />
              ) : null}
              {showSubmit ? (
                <Button
                  variant="primary"
                  label="Deploy"
                  disabled={busy}
                  dataAttrs={{ "data-setup-submit": true }}
                  onClick={() => formRef.current?.requestSubmit()}
                />
              ) : null}
              {showGuideToggle ? (
                <Button variant="secondary" label={guideButtonText} onClick={onGuideToggle} />
              ) : null}
            </div>
          ) : null}

          <GuidePanel
            snapshot={onboardingSnapshot}
            sessionSnapshot={snapshot}
            guideMessage={guideMessage}
            guideInputRef={guideInputRef}
            guideLogRef={guideLogRef}
            onGuideMessage={onGuideMessage}
            onGuideSend={onGuideSend}
            onGuideKeyDown={onGuideKeyDown}
            onClose={onGuideToggle}
          />
        </form>
      </div>
    </AuthLayout>
  );
}
