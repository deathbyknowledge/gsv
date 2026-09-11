import { AppProviders } from "./providers/AppProviders";
import { Instrument } from "./features/instrument/Instrument";
import { AccountRecoveryScreen } from "./features/session/AccountRecoveryScreen";

export function App() {
  const { pathname } = window.location;
  return (
    <AppProviders>
      {pathname === "/recover" ? <AccountRecoveryScreen /> : <Instrument initialPath={pathname} />}
    </AppProviders>
  );
}
