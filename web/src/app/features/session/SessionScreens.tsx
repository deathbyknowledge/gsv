import type { RefObject } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { OnboardingDraft, OnboardingLane } from "@gsv/protocol/syscalls/system";
import { createOnboardingService, type OnboardingSnapshot } from "../../../onboarding-service";
import type { SessionService, SessionSnapshot } from "../../../session-service";
import { BootScreen } from "./BootScreen";
import { LoginScreen } from "./LoginScreen";
import { ProvisioningScreen } from "./ProvisioningScreen";
import { SetupCompleteScreen } from "./SetupCompleteScreen";
import { SetupScreen } from "./SetupScreen";
import {
  buildSetupPayload,
  currentDetailStep,
  detailStepsForLane,
  guideShortcutReady,
  resolveVisibleView,
  setupResultViewModel,
  timeZoneOptions,
  validateSetupDetails,
  type AdminMode,
  type PendingAction,
} from "./sessionDomain";
import { useSessionFocus } from "./useSessionFocus";

type SessionScreensProps = {
  session: SessionService;
  snapshot: SessionSnapshot;
};

function copyText(
  value: string,
  fallbackRef: RefObject<HTMLTextAreaElement>,
): void {
  if (!value) {
    return;
  }

  void navigator.clipboard.writeText(value).catch(() => {
    fallbackRef.current?.select();
  });
}

export function SessionScreens({ session, snapshot }: SessionScreensProps) {
  const [onboarding] = useState(() => createOnboardingService(session.client, snapshot.username));
  const [onboardingSnapshot, setOnboardingSnapshot] = useState<OnboardingSnapshot>(() => onboarding.snapshot());
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [lastAdminMode, setLastAdminMode] = useState<AdminMode>(onboardingSnapshot.draft.admin.mode);
  const [loginValidationError, setLoginValidationError] = useState<string | null>(null);
  const [setupValidationError, setSetupValidationError] = useState<string | null>(null);
  const [loginUsername, setLoginUsername] = useState(snapshot.username);
  const [loginPassword, setLoginPassword] = useState("");
  const [loginToken, setLoginToken] = useState("");
  const [guideMessage, setGuideMessage] = useState("");
  const screenRef = useRef<HTMLElement>(null);
  const guideInputRef = useRef<HTMLTextAreaElement>(null);
  const guideLogRef = useRef<HTMLDivElement>(null);
  const continueButtonRef = useRef<HTMLButtonElement>(null);
  const cliCommandRef = useRef<HTMLTextAreaElement>(null);
  const nodeCommandRef = useRef<HTMLTextAreaElement>(null);
  const zones = useMemo(timeZoneOptions, []);
  const visibleView = resolveVisibleView(snapshot, pendingAction);
  const busy = snapshot.phase === "authenticating";
  const { draft } = onboardingSnapshot;
  const setupError = snapshot.phase === "setup" && snapshot.message ? snapshot.message : setupValidationError;
  const loginError = snapshot.phase === "locked" && snapshot.message ? snapshot.message : loginValidationError;
  const completeError = snapshot.phase === "setup-complete" && snapshot.message ? snapshot.message : null;
  const setupResult = setupResultViewModel(snapshot, lastAdminMode);

  useSessionFocus(screenRef, visibleView, draft, continueButtonRef);

  useEffect(() => onboarding.subscribe(setOnboardingSnapshot), [onboarding]);

  useEffect(() => {
    if (!snapshot.username || onboardingSnapshot.draft.account.username.trim()) {
      return;
    }
    onboarding.updateDraft((current) => ({
      ...current,
      account: {
        ...current.account,
        username: snapshot.username,
      },
    }));
  }, [onboarding, onboardingSnapshot.draft.account.username, snapshot.username]);

  useEffect(() => {
    if (snapshot.username && !loginUsername.trim()) {
      setLoginUsername(snapshot.username);
    }
  }, [loginUsername, snapshot.username]);

  useEffect(() => {
    if (snapshot.phase === "setup-complete" || snapshot.phase === "ready") {
      setPendingAction(null);
    }
    if (snapshot.phase === "ready") {
      setLoginPassword("");
      setLoginToken("");
    }
  }, [snapshot.phase]);

  useEffect(() => {
    if (!guideLogRef.current) {
      return;
    }
    guideLogRef.current.scrollTop = guideLogRef.current.scrollHeight;
  }, [onboardingSnapshot.busy, onboardingSnapshot.messages]);

  const updateDraft = (updater: (current: OnboardingDraft) => OnboardingDraft): void => {
    setSetupValidationError(null);
    onboarding.updateDraft(updater);
  };

  const submitLogin = (event: Event): void => {
    event.preventDefault();

    const username = loginUsername.trim();
    const password = loginPassword.trim();
    const token = loginToken.trim();

    if (!username) {
      setLoginValidationError("Username is required.");
      return;
    }
    if (!password && !token) {
      setLoginValidationError("Provide password or token.");
      return;
    }
    if (password && token) {
      setLoginValidationError("Use either password or token.");
      return;
    }

    setLoginValidationError(null);
    setPendingAction("login");
    void session.login({
      username,
      ...(token ? { token } : { password }),
    }).catch(() => {
      // Error is reflected through session snapshot.
    });
  };

  const selectLane = (lane: OnboardingLane): void => {
    setSetupValidationError(null);
    onboarding.setLane(lane);
  };

  const back = (): void => {
    setSetupValidationError(null);
    if (draft.stage === "review") {
      onboarding.setStage("details");
      return;
    }

    const steps = detailStepsForLane(draft.lane);
    const currentIndex = steps.indexOf(currentDetailStep(draft));
    if (currentIndex > 0) {
      onboarding.setDetailStep(steps[currentIndex - 1] ?? "account");
    } else {
      onboarding.setStage("welcome");
    }
  };

  const next = (): void => {
    const jumpToReview = guideShortcutReady(draft, onboardingSnapshot.reviewReady);
    const validation = validateSetupDetails(draft, jumpToReview);
    if (validation.message) {
      setSetupValidationError(validation.message);
      if (validation.step && validation.step !== currentDetailStep(draft)) {
        onboarding.setDetailStep(validation.step);
      }
      return;
    }

    setSetupValidationError(null);
    const steps = detailStepsForLane(draft.lane);
    const currentIndex = steps.indexOf(currentDetailStep(draft));
    const lastIndex = steps.length - 1;
    if (jumpToReview || currentIndex >= lastIndex) {
      onboarding.setStage("review");
    } else {
      onboarding.setDetailStep(steps[currentIndex + 1] ?? steps[lastIndex] ?? "account");
    }
  };

  const submitSetup = (event: Event): void => {
    event.preventDefault();

    const validation = validateSetupDetails(draft, true);
    if (validation.message) {
      setSetupValidationError(validation.message);
      onboarding.setStage("details");
      if (validation.step) {
        onboarding.setDetailStep(validation.step);
      }
      return;
    }

    if (draft.stage !== "review") {
      setSetupValidationError(null);
      onboarding.setStage("review");
      return;
    }

    setPendingAction("setup");
    setLastAdminMode(draft.admin.mode);
    void session.setup(buildSetupPayload(draft)).catch(() => {
      setPendingAction(null);
      // Error is reflected through session snapshot.
    });
  };

  const continueFromSetup = (): void => {
    setPendingAction("continue");
    void session.continueFromSetup().catch(() => {
      setPendingAction(null);
      // Error is reflected through session snapshot.
    });
  };

  const toggleGuide = (): void => {
    setSetupValidationError(null);
    const nextMode = draft.mode === "guided" ? "manual" : "guided";
    onboarding.setMode(nextMode);
    if (nextMode === "guided") {
      window.setTimeout(() => guideInputRef.current?.focus(), 0);
    }
  };

  const sendGuideMessage = (): void => {
    const message = guideMessage.trim();
    if (!message || onboardingSnapshot.busy) {
      return;
    }
    setGuideMessage("");
    void onboarding.assist(message).finally(() => {
      guideInputRef.current?.focus();
    });
  };

  const onGuideKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }
    event.preventDefault();
    sendGuideMessage();
  };

  return (
    <section class="session-screen" data-session-screen data-session-view={visibleView} hidden={visibleView === "desktop"} ref={screenRef}>
      <div class={`session-stage${visibleView === "booting" ? " session-stage-booting" : ""}`}>
        <BootScreen
          visible={visibleView === "booting"}
          message={snapshot.message}
        />
        <LoginScreen
          visible={visibleView === "login"}
          busy={busy}
          error={loginError}
          username={loginUsername}
          password={loginPassword}
          token={loginToken}
          onUsername={(value) => {
            setLoginValidationError(null);
            setLoginUsername(value);
          }}
          onPassword={(value) => {
            setLoginValidationError(null);
            setLoginPassword(value);
          }}
          onToken={(value) => {
            setLoginValidationError(null);
            setLoginToken(value);
          }}
          onSubmit={submitLogin}
        />
        <SetupScreen
          snapshot={snapshot}
          onboardingSnapshot={onboardingSnapshot}
          setupError={setupError}
          guideMessage={guideMessage}
          guideInputRef={guideInputRef}
          guideLogRef={guideLogRef}
          timezoneOptions={zones}
          onLane={selectLane}
          onBack={back}
          onNext={next}
          onSubmit={submitSetup}
          onGuideToggle={toggleGuide}
          onGuideMessage={setGuideMessage}
          onGuideSend={sendGuideMessage}
          onGuideKeyDown={onGuideKeyDown}
          updateDraft={updateDraft}
        />
        <ProvisioningScreen visible={visibleView === "provisioning"} pendingAction={pendingAction} />
        <SetupCompleteScreen
          visible={visibleView === "complete"}
          snapshot={snapshot}
          adminMode={lastAdminMode}
          completeError={completeError}
          busy={busy}
          continueButtonRef={continueButtonRef}
          cliCommandRef={cliCommandRef}
          nodeCommandRef={nodeCommandRef}
          onContinue={continueFromSetup}
          onCopyCli={() => copyText(setupResult.cliCommand, cliCommandRef)}
          onCopyToken={() => copyText(setupResult.node.command, nodeCommandRef)}
        />
      </div>
    </section>
  );
}
