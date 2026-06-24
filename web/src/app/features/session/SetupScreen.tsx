import type { RefObject } from "preact";
import { useEffect, useRef } from "preact/hooks";
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
  onStep: (index: number) => void;
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
  onStep,
  onSubmit,
  onGuideToggle,
  onGuideMessage,
  onGuideSend,
  onGuideKeyDown,
  updateDraft,
}: SetupScreenProps) {
  const { draft } = onboardingSnapshot;
  const busy = snapshot.phase === "authenticating";
  const showNext = draft.stage === "details";
  const showSubmit = draft.stage === "review";
  const showBack = draft.stage !== "welcome";
  // The guide opens as a floating corner window; its launcher sits at that same
  // corner and only shows while the guide is available but not already open.
  const showGuideLaunch = draft.stage !== "welcome" && draft.mode !== "guided";
  const formRef = useRef<HTMLFormElement>(null);

  // Three stepper steps: Login credentials (account) · Preferences (system) ·
  // Review and deploy. Welcome is the path chooser — before step 1 — so it has
  // no stepper and no step count.
  const detailStep = currentDetailStep(draft);
  const onWelcome = draft.stage === "welcome";
  const current =
    draft.stage === "review" ? 2 : detailStep !== "account" ? 1 : 0;

  // Each step is a fresh page: when the step changes, scroll the panel back to
  // the top so a step doesn't open mid-scroll from the previous one.
  const panelRef = useRef<HTMLDivElement>(null);
  const stepKey = `${draft.stage}:${detailStep}`;
  useEffect(() => {
    panelRef.current?.scrollTo({ top: 0 });
  }, [stepKey]);

  return (
    <AuthLayout background="galaxy" visible={snapshot.phase === "setup"} surfaceClass="gsv-auth-surface-setup">
      <div class="gsv-setup-panel" data-session-setup-view ref={panelRef}>
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
                onChange={onStep}
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
              <div class="gsv-setup-nav-primary">
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
              </div>
            </div>
          ) : null}
        </form>
      </div>

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

      {showGuideLaunch ? (
        <button type="button" class="gsv-guide-launch" onClick={onGuideToggle}>
          <svg class="gsv-guide-launch-icon" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round">
            <path d="M2 3.5 H14 V11 H6.5 L3.5 13.5 V11 H2 Z" />
          </svg>
          Ask the guide
        </button>
      ) : null}
    </AuthLayout>
  );
}
