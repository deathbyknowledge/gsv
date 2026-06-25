import { AppProviders } from "./providers/AppProviders";
import { DesktopShell } from "./features/desktop/DesktopShell";
import { Catalog } from "../design-system/catalog";

const DESIGN_SYSTEM_PATHS = new Set(["/design", "/design.html", "/design-system"]);

export function App() {
  if (DESIGN_SYSTEM_PATHS.has(window.location.pathname)) {
    return <Catalog />;
  }

  return (
    <AppProviders>
      <DesktopShell />
    </AppProviders>
  );
}
