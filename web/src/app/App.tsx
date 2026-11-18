import { MemberRecoveryScreen } from "./features/session/MemberRecoveryScreen";
import { AppProviders, type AppProviderDependencies } from "./providers/AppProviders";
import { Instrument } from "./features/instrument/Instrument";
import { AccountRecoveryScreen } from "./features/session/AccountRecoveryScreen";
import { AuthScene } from "./features/session/AuthLayout";
import { navigateApp, useAppLocation } from "./services/navigation/appNavigation";
import { useSession } from "./services/session/SessionProvider";
import { takeFirstRunInvite } from "./services/session/installationOnboarding";
import { useLayoutEffect } from "preact/hooks";

function AppRoutes() {
  const { pathname, revision } = useAppLocation();
  const { snapshot } = useSession();
  useLayoutEffect(() => {
    if (snapshot.phase !== "ready" || pathname === "/recover" || pathname === "/recover-member") return;
    // A Ship made from someone's invitation link opens on a request to them, as their public profile would.
    const invite = takeFirstRunInvite();
    if (!invite) return;
    const destination = new URL("/people", window.location.origin);
    destination.searchParams.set("compose", invite);
    navigateApp(destination.href, { replace: true });
  }, [snapshot.phase, pathname]);
  const recovery = pathname === "/recover-member" ? <MemberRecoveryScreen key={revision} />
    : pathname === "/recover" ? <AccountRecoveryScreen key={revision} /> : null;
  if (recovery || snapshot.phase !== "ready") {
    return <AuthScene setup={!recovery && (snapshot.phase === "setup" || pathname === "/onboarding")}>
      {recovery ?? <Instrument initialPath={pathname} />}
    </AuthScene>;
  }
  return <Instrument initialPath={pathname} />;
}

export function App(dependencies: AppProviderDependencies = {}) {
  return <AppProviders {...dependencies}><AppRoutes /></AppProviders>;
}
