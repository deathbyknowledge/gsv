import { lazy, Suspense } from "preact/compat";
import { AppProviders } from "./providers/AppProviders";
import { LoadingState } from "./components/ui/Spinner";
import { Instrument } from "./features/instrument/Instrument";

const Catalog = lazy(() => import("../design-system/catalog").then(({ Catalog }) => ({ default: Catalog })));
const TemplatePreview = lazy(() => import("../design-system/previews").then(({ TemplatePreview }) => ({ default: TemplatePreview })));
const DESIGN_SYSTEM_PATHS = new Set(["/design", "/design.html", "/design-system"]);
const TEMPLATE_PREVIEW_PREFIX = "/design/preview/";

export function App() {
  const { pathname } = window.location;
  if (pathname.startsWith(TEMPLATE_PREVIEW_PREFIX)) {
    return <Suspense fallback={<LoadingState>Loading preview…</LoadingState>}><TemplatePreview id={pathname.slice(TEMPLATE_PREVIEW_PREFIX.length)} /></Suspense>;
  }
  if (DESIGN_SYSTEM_PATHS.has(pathname)) {
    return <Suspense fallback={<LoadingState>Loading catalog…</LoadingState>}><Catalog /></Suspense>;
  }

  return (
    <AppProviders>
      <Instrument initialPath={pathname} />
    </AppProviders>
  );
}
