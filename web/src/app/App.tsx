import { MemberRecoveryScreen } from "./features/session/MemberRecoveryScreen";
import { AppProviders } from "./providers/AppProviders";
import { Instrument } from "./features/instrument/Instrument";
import { AccountRecoveryScreen } from "./features/session/AccountRecoveryScreen";
import { HumanInvitationScreen } from "./features/session/HumanInvitationScreen";

export function App() {
  const { pathname } = window.location;
  return (
    <AppProviders>
      {pathname === "/recover-member" ? <MemberRecoveryScreen /> : pathname === "/recover" ? <AccountRecoveryScreen /> : pathname === "/join" ? <HumanInvitationScreen /> : <Instrument initialPath={pathname} />}
    </AppProviders>
  );
}
