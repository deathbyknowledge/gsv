import { MemberRecoveryScreen } from "./features/session/MemberRecoveryScreen";
import { AppProviders, type AppProviderDependencies } from "./providers/AppProviders";
import { Instrument } from "./features/instrument/Instrument";
import { AccountRecoveryScreen } from "./features/session/AccountRecoveryScreen";
import { AuthScene } from "./features/session/AuthLayout";
import { navigateApp, useAppLocation } from "./services/navigation/appNavigation";
import { useSession } from "./services/session/SessionProvider";
import { ContactInvitationScreen } from "./features/session/ContactInvitationScreen";
import { pendingContactInvitation } from "./services/session/contactInvitationIntent";
import { useLayoutEffect, useState } from "preact/hooks";
import { SiteAuthorizationScreen } from "./features/session/SiteAuthorizationScreen";

function AppRoutes() {
  const { pathname, revision } = useAppLocation();
  const { snapshot } = useSession();
  const [contactInvitation, setContactInvitation] = useState(pendingContactInvitation);
  useLayoutEffect(() => {
    if (snapshot.phase !== "ready" || !contactInvitation || pathname === "/recover" || pathname === "/recover-member" || pathname === "/authorize-site") return;
    setContactInvitation(null);
    const destination = new URL(window.location.href);
    destination.pathname = "/people";
    navigateApp(destination.href, { replace: true });
  }, [snapshot.phase, contactInvitation, pathname]);
  const recovery = pathname === "/recover-member" ? <MemberRecoveryScreen key={revision} />
    : pathname === "/recover" ? <AccountRecoveryScreen key={revision} /> : null;
  if (pathname === "/authorize-site" && snapshot.phase === "ready") {
    return <AuthScene layout="welcome"><SiteAuthorizationScreen /></AuthScene>;
  }
  if (recovery || snapshot.phase !== "ready") {
    return <AuthScene setup={!recovery && (snapshot.phase === "setup" || pathname === "/onboarding")}>
      {recovery ?? <Instrument initialPath={pathname} />}
    </AuthScene>;
  }
  return <Instrument initialPath={pathname} />;
}

export function App(dependencies: AppProviderDependencies = {}) {
  const { pathname } = useAppLocation();
  if (pathname === "/connect") return <AuthScene layout="welcome"><ContactInvitationScreen /></AuthScene>;
  return <AppProviders {...dependencies}><AppRoutes /></AppProviders>;
}
