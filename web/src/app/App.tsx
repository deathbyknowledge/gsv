import { MemberRecoveryScreen } from "./features/session/MemberRecoveryScreen";
import { AppProviders } from "./providers/AppProviders";
import { Instrument } from "./features/instrument/Instrument";
import { AccountRecoveryScreen } from "./features/session/AccountRecoveryScreen";
import { HumanInvitationScreen } from "./features/session/HumanInvitationScreen";
import { AuthScene } from "./features/session/AuthLayout";
import { useSessionLocation } from "./features/session/sessionNavigation";
import { useSession } from "./services/session/SessionProvider";

function AppRoutes() {
  const { pathname, revision } = useSessionLocation();
  const { snapshot } = useSession();
  const recovery = pathname === "/recover-member" ? <MemberRecoveryScreen key={revision} />
    : pathname === "/recover" ? <AccountRecoveryScreen key={revision} />
    : pathname === "/join" ? <HumanInvitationScreen key={revision} /> : null;
  if (recovery || snapshot.phase !== "ready") {
    return <AuthScene setup={!recovery && (snapshot.phase === "setup" || snapshot.phase === "setup-complete")}>
      {recovery ?? <Instrument initialPath={pathname} />}
    </AuthScene>;
  }
  return <Instrument initialPath={pathname} />;
}

export function App() {
  return <AppProviders><AppRoutes /></AppProviders>;
}
