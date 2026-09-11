import { AppProviders } from "./providers/AppProviders";
import { Instrument } from "./features/instrument/Instrument";

export function App() {
  const { pathname } = window.location;
  return (
    <AppProviders>
      <Instrument initialPath={pathname} />
    </AppProviders>
  );
}
