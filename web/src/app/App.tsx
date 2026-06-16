import { AppProviders } from "./providers/AppProviders";
import { LegacyDesktopShell } from "./features/desktop/LegacyDesktopShell";

export function App() {
  return (
    <AppProviders>
      <LegacyDesktopShell />
    </AppProviders>
  );
}
