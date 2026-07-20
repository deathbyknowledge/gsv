import { AppProviders } from "./providers/AppProviders";
import { DesktopShell } from "./features/desktop/DesktopShell";
import { Catalog } from "../design-system/catalog";
import { TemplatePreview } from "../design-system/previews";

const DESIGN_SYSTEM_PATHS = new Set(["/design", "/design.html", "/design-system"]);
const TEMPLATE_PREVIEW_PREFIX = "/design/preview/";

export function App() {
  const { pathname } = window.location;
  if (pathname.startsWith(TEMPLATE_PREVIEW_PREFIX)) {
    return <TemplatePreview id={pathname.slice(TEMPLATE_PREVIEW_PREFIX.length)} />;
  }
  if (DESIGN_SYSTEM_PATHS.has(pathname)) {
    return <Catalog />;
  }

  return (
    <AppProviders>
      <DesktopShell />
    </AppProviders>
  );
}
