import type { SessionService, SessionSnapshot } from "../../services/session/sessionService";
import { LoginScreen } from "./LoginScreen";
import { SetupScreen } from "./SetupScreen";
import { useSessionScreensState } from "./useSessionScreensState";
import { AuthLayout } from "./AuthLayout";
import { SectionHeader } from "../../components/ui/SectionHeader";
import { Button } from "../../components/ui/Button";

type SessionScreensProps = {
  session: SessionService;
  snapshot: SessionSnapshot;
};

export function SessionScreens({ session, snapshot }: SessionScreensProps) {
  const state = useSessionScreensState({ session, snapshot });
  const { visibleView } = state;
  return <section class="session-screen" data-session-screen data-session-view={visibleView} hidden={visibleView === "ready"} ref={state.screenRef}>
    <div class={`session-stage${visibleView === "booting" ? " session-stage-booting" : ""}`}>
      <LoginScreen visible={visibleView === "login" || visibleView === "booting"} loading={visibleView === "booting"}
        busy={state.busy} space={new URL(snapshot.url).host} {...state.login} />
      <SetupScreen visible={visibleView === "setup"} busy={state.busy} space={new URL(snapshot.url).host} {...state.setup} />
      {visibleView === "setup-recovery" && <AuthLayout background="galaxy" visible surfaceClass="gsv-auth-surface-login">
        <div class="gsv-login-panel">
          <SectionHeader title="Finish setting up your space" titleSize="title" divider />
          <div class="gsv-login-body">
            <p>{snapshot.setupRecoveryUrl ? "Sign in with the email you used to claim it." : "Ask the person who invited you for a new setup link."}</p>
            {snapshot.setupRecoveryUrl && (session.resumeSetup
              ? <Button label="Continue setup" variant="primary" block onClick={() => session.resumeSetup!(snapshot.setupRecoveryUrl!)} />
              : <a class="gsv-btn gsv-btn-primary gsv-btn-block" href={snapshot.setupRecoveryUrl}>Continue setup</a>)}
          </div>
        </div>
      </AuthLayout>}
    </div>
  </section>;
}
