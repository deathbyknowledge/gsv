import type { SessionService, SessionSnapshot } from "../../services/session/sessionService";
import { LoginScreen } from "./LoginScreen";
import { SetupScreen } from "./SetupScreen";
import { useSessionScreensState } from "./useSessionScreensState";
import { AuthLayout } from "./AuthLayout";
import { SectionHeader } from "../../components/ui/SectionHeader";
import { Button } from "../../components/ui/Button";
import { useT } from "../../i18n/locale";

type SessionScreensProps = {
  session: SessionService;
  snapshot: SessionSnapshot;
};

export function SessionScreens({ session, snapshot }: SessionScreensProps) {
  const t = useT();
  const state = useSessionScreensState({ session, snapshot });
  const { visibleView } = state;
  return <section class="session-screen" data-session-screen data-session-view={visibleView} hidden={visibleView === "ready"} ref={state.screenRef}>
    <div class={`session-stage${visibleView === "booting" ? " session-stage-booting" : ""}`}>
      <LoginScreen visible={visibleView === "login" || visibleView === "booting"} loading={visibleView === "booting"}
        busy={state.busy} space={new URL(snapshot.url).host} {...state.login} />
      <SetupScreen visible={visibleView === "setup"} busy={state.busy} space={new URL(snapshot.url).host}
        arrivedFromSignup={snapshot.arrivedFromSignup === true} {...state.setup} />
      {visibleView === "setup-recovery" && <AuthLayout background="galaxy" visible surfaceClass="gsv-auth-surface-login">
        <div class="gsv-login-panel">
          <SectionHeader title={t("session.setupRecovery.title")} titleSize="title" divider />
          <div class="gsv-login-body">
            <p>{t(snapshot.setupRecoveryUrl ? "session.setupRecovery.signIn" : "session.setupRecovery.askInviter")}</p>
            {snapshot.setupRecoveryUrl && (session.resumeSetup
              ? <Button label={t("session.setupRecovery.continue")} variant="primary" block onClick={() => session.resumeSetup!(snapshot.setupRecoveryUrl!)} />
              : <a class="gsv-btn gsv-btn-primary gsv-btn-block" href={snapshot.setupRecoveryUrl}>{t("session.setupRecovery.continue")}</a>)}
          </div>
        </div>
      </AuthLayout>}
    </div>
  </section>;
}
