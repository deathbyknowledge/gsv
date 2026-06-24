import type {
  ShellAppRoute,
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
  library: "library",
  machines: "machines",
  messengers: "messengers",
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
    return { view: "config", kind: section };
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
    return `/settings/${route.kind}`;
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

