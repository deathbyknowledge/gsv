import type {
  ShellAppRoute,
  ShellLibraryRoute,
  ShellRoute,
  ShellSettingsListKind,
  ShellSettingsRoute,
  ShellSurfaceId,
} from "../domain/shellModel";
import { normalizeShellAppRoute } from "../domain/shellModel";

const TOP_LEVEL_SURFACES: Record<string, Exclude<ShellSurfaceId, "desktop" | "app" | "settings">> = {
  agent: "agent",
  applications: "applications",
  crew: "crew",
  files: "files",
  integrations: "integrations",
  "card-template": "card-template",
  "connect-flows": "connect-flows",
  library: "library",
  "list-template": "list-template",
  machines: "machines",
  messengers: "messengers",
  repositories: "repositories",
  repos: "repositories",
  tasks: "runtime",
  terminal: "terminal",
};

const SETTINGS_LIST_KINDS = new Set<ShellSettingsListKind>([
  "applications",
  "integrations",
  "library",
  "machines",
  "messengers",
  "tasks",
]);

const WORKER_OWNED_PREFIXES = [
  "/apps",
  "/downloads",
  "/git",
  "/oauth",
  "/public",
  "/runtime",
  "/ws",
  "/.well-known",
];

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function encodeSegment(segment: string): string {
  return encodeURIComponent(segment);
}

function cleanPath(pathname: string): string {
  if (pathname === "/") {
    return pathname;
  }
  return pathname.replace(/\/+$/, "");
}

function pathParts(pathname: string): string[] {
  return cleanPath(pathname).split("/").filter(Boolean);
}

function isWorkerOwnedPath(pathname: string): boolean {
  const path = cleanPath(pathname);
  return WORKER_OWNED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function settingsRouteFromParts(parts: readonly string[]): ShellSettingsRoute {
  const section = parts[1];
  if (!section) {
    return { view: "overview" };
  }
  if (section === "crew") {
    return { view: "crew" };
  }
  if (section === "models" || section === "overrides") {
    const select = parts[2] ? decodeSegment(parts[2]) : undefined;
    return select ? { view: "config", kind: section, select } : { view: "config", kind: section };
  }
  if (section === "agent") {
    if (parts[2] === "new") {
      return { view: "agent", accountUid: null, createNew: true };
    }
    const rawUid = parts[2] ? decodeSegment(parts[2]) : null;
    const uid = rawUid ? Number(rawUid) : NaN;
    return { view: "agent", accountUid: Number.isSafeInteger(uid) ? uid : null };
  }

  const kind = section === "runtime" ? "tasks" : section;
  if (!SETTINGS_LIST_KINDS.has(kind as ShellSettingsListKind)) {
    return { view: "overview" };
  }

  if (parts[2] === "new") {
    return { view: "list", kind: kind as ShellSettingsListKind, createNew: true };
  }

  const detailId = parts[2] ? decodeSegment(parts[2]) : null;
  return detailId
    ? { view: "list", kind: kind as ShellSettingsListKind, detailId }
    : { view: "list", kind: kind as ShellSettingsListKind };
}

function appRouteFromParts(parts: readonly string[], search: string, hash: string): ShellAppRoute | null {
  const appId = parts[1] ? decodeSegment(parts[1]) : null;
  if (!appId?.trim()) {
    return null;
  }

  const suffixParts = parts.slice(2).map(decodeSegment);
  if (suffixParts.some((part) => part === null)) {
    return null;
  }

  return normalizeShellAppRoute({
    appId,
    suffix: suffixParts.length > 0 ? `/${suffixParts.join("/")}` : "/",
    search,
    hash,
  });
}

function decodedParts(parts: readonly string[]): string[] | null {
  const decoded = parts.map(decodeSegment);
  return decoded.some((part) => part === null) ? null : decoded as string[];
}

function libraryRouteFromParts(parts: readonly string[], search: string): ShellLibraryRoute {
  const decoded = decodedParts(parts.slice(1));
  if (!decoded) {
    return { view: "index" };
  }

  const query = new URLSearchParams(search);
  const q = query.get("q")?.trim() || undefined;
  const [db, actionOrPath, ...rest] = decoded;

  if (!db) {
    return { view: "index", ...(q ? { q } : {}) };
  }
  if (db === "build") {
    return { view: "build" };
  }
  if (!actionOrPath) {
    return { view: "index", db, ...(q ? { q } : {}) };
  }
  if (actionOrPath === "new") {
    return { view: "editor", db };
  }
  if (actionOrPath === "edit") {
    const path = rest.join("/");
    return path ? { view: "editor", db, path } : { view: "editor", db };
  }
  if (actionOrPath === "capture") {
    return { view: "capture", db };
  }
  if (actionOrPath === "build") {
    return { view: "build", db };
  }

  return { view: "reader", db, path: [actionOrPath, ...rest].join("/") };
}

export function shellRouteFromLocation(location: Pick<Location, "hash" | "pathname" | "search">): ShellRoute {
  if (isWorkerOwnedPath(location.pathname)) {
    return { surface: "desktop" };
  }

  const parts = pathParts(location.pathname);
  if (parts.length === 0) {
    return { surface: "desktop" };
  }

  if (parts[0] === "settings") {
    return { surface: "settings", settingsRoute: settingsRouteFromParts(parts) };
  }

  if (parts[0] === "library") {
    return { surface: "library", libraryRoute: libraryRouteFromParts(parts, location.search) };
  }

  if (parts[0] === "open") {
    const appRoute = appRouteFromParts(parts, location.search, location.hash);
    return appRoute ? { surface: "app", appRoute } : { surface: "desktop" };
  }

  const surface = TOP_LEVEL_SURFACES[parts[0]];
  return surface ? { surface } : { surface: "desktop" };
}

function formatSettingsRoute(route: ShellSettingsRoute | undefined): string {
  if (!route || route.view === "overview") {
    return "/settings";
  }
  if (route.view === "crew") {
    return "/settings/crew";
  }
  if (route.view === "config") {
    const base = `/settings/${route.kind}`;
    return route.select ? `${base}/${encodeSegment(route.select)}` : base;
  }
  if (route.view === "agent") {
    if (route.createNew) {
      return "/settings/agent/new";
    }
    return route.accountUid === null ? "/settings/agent" : `/settings/agent/${route.accountUid}`;
  }

  const base = `/settings/${route.kind}`;
  if (route.createNew) {
    return `${base}/new`;
  }
  return route.detailId ? `${base}/${encodeSegment(route.detailId)}` : base;
}

function formatAppRoute(route: ShellAppRoute): string {
  const appRoute = normalizeShellAppRoute(route);
  const suffix = appRoute.suffix === "/" ? "" : appRoute.suffix.split("/").filter(Boolean).map(encodeSegment).join("/");
  const path = suffix
    ? `/open/${encodeSegment(appRoute.appId)}/${suffix}`
    : `/open/${encodeSegment(appRoute.appId)}`;
  return `${path}${appRoute.search}${appRoute.hash}`;
}

function formatLibraryRoute(route: ShellLibraryRoute | undefined): string {
  if (!route || route.view === "index") {
    const base = route?.db ? `/library/${encodeSegment(route.db)}` : "/library";
    const q = route?.q?.trim();
    return q ? `${base}?q=${encodeURIComponent(q)}` : base;
  }
  if (route.view === "build") {
    return route.db ? `/library/${encodeSegment(route.db)}/build` : "/library/build";
  }
  if (route.view === "capture") {
    return `/library/${encodeSegment(route.db)}/capture`;
  }
  if (route.view === "editor") {
    if (!route.path) {
      return `/library/${encodeSegment(route.db)}/new`;
    }
    const path = route.path.split("/").filter(Boolean).map(encodeSegment).join("/");
    return `/library/${encodeSegment(route.db)}/edit/${path}`;
  }
  const path = route.path.split("/").filter(Boolean).map(encodeSegment).join("/");
  return `/library/${encodeSegment(route.db)}/${path}`;
}

export function shellRouteToPath(route: ShellRoute): string {
  if (route.surface === "desktop") {
    return "/";
  }
  if (route.surface === "settings") {
    return formatSettingsRoute(route.settingsRoute);
  }
  if (route.surface === "app") {
    return formatAppRoute(route.appRoute);
  }
  if (route.surface === "library") {
    return formatLibraryRoute(route.libraryRoute);
  }
  if (route.surface === "runtime") {
    return "/tasks";
  }
  return `/${route.surface}`;
}

export function replaceShellRoute(route: ShellRoute): void {
  const path = shellRouteToPath(route);
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` === path) {
    return;
  }
  window.history.replaceState(null, "", path);
}

export function pushShellRoute(route: ShellRoute): void {
  const path = shellRouteToPath(route);
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` === path) {
    return;
  }
  window.history.pushState(null, "", path);
}
