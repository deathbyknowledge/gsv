import type { SessionService, SessionSnapshot } from "../../services/session/sessionService";
import { LoginScreen } from "./LoginScreen";
import { SetupScreen } from "./SetupScreen";
import { useSessionScreensState } from "./useSessionScreensState";

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
        busy={state.busy} {...state.login} />
      <SetupScreen visible={visibleView === "setup"} busy={state.busy} space={new URL(snapshot.url).host} {...state.setup} />
    </div>
  </section>;
}
