import { AppProviders } from "./providers/AppProviders";
import { DesktopShell } from "./features/desktop/DesktopShell";
import { Catalog } from "../design-system/catalog";
import { TemplatePreview } from "../design-system/previews";
import { Instrument } from "./features/instrument/Instrument";

const DESIGN_SYSTEM_PATHS = new Set(["/design", "/design.html", "/design-system"]);
const TEMPLATE_PREVIEW_PREFIX = "/design/preview/";
const INSTRUMENT_PATHS = new Set(["/zen", "/fleet", "/first-day", "/memory", "/zen/settings"]);

export function App() {
  const { pathname } = window.location;
  if (pathname.startsWith(TEMPLATE_PREVIEW_PREFIX)) {
    return <TemplatePreview id={pathname.slice(TEMPLATE_PREVIEW_PREFIX.length)} />;
  }
  if (DESIGN_SYSTEM_PATHS.has(pathname)) {
    return <Catalog />;
  }
  if (INSTRUMENT_PATHS.has(pathname)) {
    return (
      <AppProviders>
        <Instrument initialPath={pathname} />
      </AppProviders>
    );
  }

  return (
    <AppProviders>
      <DesktopShell />
    </AppProviders>
  );
}
