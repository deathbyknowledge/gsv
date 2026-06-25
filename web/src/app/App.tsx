import { AppProviders } from "./providers/AppProviders";
import { DesktopShell } from "./features/desktop/DesktopShell";

export function App() {
  return (
    <AppProviders>
      <DesktopShell />
    </AppProviders>
  );
}
