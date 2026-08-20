import { AppProviders } from "./providers/AppProviders";
import { DesktopShell } from "./features/desktop/DesktopShell";
import { Catalog } from "../design-system/catalog";
import { TemplatePreview } from "../design-system/previews";
import { WelcomeSite } from "./features/website/WelcomeSite";

const DESIGN_SYSTEM_PATHS = new Set(["/design", "/design.html", "/design-system"]);
const TEMPLATE_PREVIEW_PREFIX = "/design/preview/";
const WELCOME_PATHS = new Set(["/welcome", "/welcome.html"]);

export function App() {
  const { pathname } = window.location;
  if (pathname.startsWith(TEMPLATE_PREVIEW_PREFIX)) {
    return <TemplatePreview id={pathname.slice(TEMPLATE_PREVIEW_PREFIX.length)} />;
  }
  if (DESIGN_SYSTEM_PATHS.has(pathname)) {
    return <Catalog />;
  }
  // The public site is pre-auth by nature: like /design, it returns before
  // AppProviders so it mounts with no gateway, session, or query client.
  if (WELCOME_PATHS.has(pathname)) {
    return <WelcomeSite />;
  }

  return (
    <AppProviders>
      <DesktopShell />
    </AppProviders>
  );
}
