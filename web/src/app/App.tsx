import { MemberRecoveryScreen } from "./features/session/MemberRecoveryScreen";
import { AppProviders, type AppProviderDependencies } from "./providers/AppProviders";
import { Instrument } from "./features/instrument/Instrument";
import { AccountRecoveryScreen } from "./features/session/AccountRecoveryScreen";
import { AuthScene } from "./features/session/AuthLayout";
import { useSessionLocation } from "./features/session/sessionNavigation";
import { useSession } from "./services/session/SessionProvider";
import { ContactInvitationScreen } from "./features/session/ContactInvitationScreen";
import { pendingContactInvitation } from "./services/session/contactInvitationIntent";
import { useState } from "preact/hooks";

function AppRoutes() {
  const { pathname, revision } = useSessionLocation();
  const { snapshot } = useSession();
  const [contactInvitation] = useState(pendingContactInvitation);
  const recovery = pathname === "/recover-member" ? <MemberRecoveryScreen key={revision} />
    : pathname === "/recover" ? <AccountRecoveryScreen key={revision} /> : null;
  if (recovery || snapshot.phase !== "ready") {
    return <AuthScene setup={!recovery && (snapshot.phase === "setup" || pathname === "/onboarding")}>
      {recovery ?? <Instrument initialPath={pathname} />}
    </AuthScene>;
  }
  return <Instrument initialPath={contactInvitation ? "/people" : pathname} />;
}

export function App(dependencies: AppProviderDependencies = {}) {
  const { pathname } = useSessionLocation();
  if (pathname === "/connect") return <AuthScene layout="welcome"><ContactInvitationScreen /></AuthScene>;
  return <AppProviders {...dependencies}><AppRoutes /></AppProviders>;
}
