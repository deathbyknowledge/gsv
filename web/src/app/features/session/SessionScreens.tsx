import type { SessionService, SessionSnapshot } from "../../../session-service";
import { BootScreen } from "./BootScreen";
import { LoginScreen } from "./LoginScreen";
import { ProvisioningScreen } from "./ProvisioningScreen";
import { SetupCompleteScreen } from "./SetupCompleteScreen";
import { SetupScreen } from "./SetupScreen";
import { useSessionScreensState } from "./useSessionScreensState";

type SessionScreensProps = {
  session: SessionService;
  snapshot: SessionSnapshot;
};

export function SessionScreens({ session, snapshot }: SessionScreensProps) {
  const state = useSessionScreensState({ session, snapshot });
  const { refs, visibleView } = state;

  return (
    <section class="session-screen" data-session-screen data-session-view={visibleView} hidden={visibleView === "desktop"} ref={refs.screenRef}>
      <div class={`session-stage${visibleView === "booting" ? " session-stage-booting" : ""}`}>
        <BootScreen
          visible={visibleView === "booting"}
          message={state.boot.message}
        />
        <LoginScreen
          visible={visibleView === "login"}
          busy={state.busy}
          error={state.login.error}
          username={state.login.username}
          password={state.login.password}
          token={state.login.token}
          onUsername={state.login.onUsername}
          onPassword={state.login.onPassword}
          onToken={state.login.onToken}
          onSubmit={state.login.onSubmit}
        />
        <SetupScreen
          snapshot={snapshot}
          onboardingSnapshot={state.onboardingSnapshot}
          setupError={state.setup.error}
          guideMessage={state.setup.guideMessage}
          guideInputRef={refs.guideInputRef}
          guideLogRef={refs.guideLogRef}
          timezoneOptions={state.setup.timezoneOptions}
          onLane={state.setup.onLane}
          onBack={state.setup.onBack}
          onNext={state.setup.onNext}
          onSubmit={state.setup.onSubmit}
          onGuideToggle={state.setup.onGuideToggle}
          onGuideMessage={state.setup.onGuideMessage}
          onGuideSend={state.setup.onGuideSend}
          onGuideKeyDown={state.setup.onGuideKeyDown}
          updateDraft={state.setup.updateDraft}
        />
        <ProvisioningScreen visible={visibleView === "provisioning"} pendingAction={state.provisioning.pendingAction} />
        <SetupCompleteScreen
          visible={visibleView === "complete"}
          snapshot={snapshot}
          adminMode={state.complete.adminMode}
          completeError={state.complete.error}
          busy={state.busy}
          continueButtonRef={refs.continueButtonRef}
          cliCommandRef={refs.cliCommandRef}
          nodeCommandRef={refs.nodeCommandRef}
          onContinue={state.complete.onContinue}
          onCopyCli={state.complete.onCopyCli}
          onCopyToken={state.complete.onCopyToken}
        />
      </div>
    </section>
  );
}
