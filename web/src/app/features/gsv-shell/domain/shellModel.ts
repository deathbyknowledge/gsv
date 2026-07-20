export type ShellSurfaceId =
  | "desktop"
  | "app"
  | "settings"
  | "crew"
  | "agent"
  | "machines"
  | "messengers"
  | "integrations"
  | "applications"
  | "runtime"
  | "models"
  | "files"
  | "repositories"
  | "library"
  | "terminal"
  | "list-template"
  | "card-template"
  | "connect-flows";

export type DesktopObjectId = "machines" | "messengers" | "integrations" | "applications";
export type ShellStatus = "online" | "error" | "idle" | "warn" | "live" | "update";
export type DesktopGlyph = "machines" | "messengers" | "integrations" | "applications";
export type ShellPageSurfaceId = Exclude<ShellSurfaceId, "desktop">;
export type ShellPageTabKind = "settings" | "system" | "inventory" | "object" | "app";
export type ShellSettingsListKind = DesktopObjectId | "library" | "tasks";

export type ShellSettingsRoute =
  | { view: "overview" }
  | { view: "list"; kind: ShellSettingsListKind; detailId?: string; detailLabel?: string; createNew?: boolean }
  | { view: "config"; kind: "models" | "overrides"; select?: string }
  | { view: "crew" }
  | { view: "agent"; accountUid: number | null; createNew?: boolean };

export type ShellPageTab = {
  key: string;
  surface: ShellPageSurfaceId;
  title: string;
  kind: ShellPageTabKind;
  icon: string;
  type: string;
  appRoute?: ShellAppRoute;
  libraryRoute?: ShellLibraryRoute;
  settingsRoute?: ShellSettingsRoute;
};

export type ShellAppRoute = {
  appId: string;
  suffix: string;
  search: string;
  hash: string;
};

export type ShellLibraryRoute =
  | { view: "index"; db?: string; q?: string }
  | { view: "reader"; db: string; path: string }
  | { view: "editor"; db: string; path?: string }
  | { view: "capture"; db: string }
  | { view: "build"; db?: string };

export type ShellRoute =
  | { surface: "desktop" }
  | { surface: "app"; appRoute: ShellAppRoute }
  | { surface: "library"; libraryRoute?: ShellLibraryRoute }
  | { surface: Exclude<ShellPageSurfaceId, "app" | "library">; settingsRoute?: ShellSettingsRoute };

export type DesktopChildRoute = {
  kind: DesktopObjectId;
  detailId: string;
};

export type DesktopChildObject = {
  id: string;
  label: string;
  type: string;
  blurb: string;
  status: ShellStatus;
  statusLabel: string;
  glyph: DesktopGlyph;
  appRoute?: ShellAppRoute;
  /** Object-detail route. Absent on native (surface-backed) children. */
  route?: DesktopChildRoute;
  /** Set on native children: the system surface this child opens. */
  surface?: NativeAppSurfaceId;
  /** Explicit card/row icon for native children (e.g. folder, terminal). */
  iconName?: string;
  /** Native children are fixed system apps — excluded from status/count aggregation. */
  native?: boolean;
  /** Provenance for external (imported) applications: source repo + visibility. */
  sourceRepo?: string;
  sourcePublic?: boolean;
};

export type DesktopObject = {
  id: DesktopObjectId;
  label: string;
  glyph: DesktopGlyph;
  status: ShellStatus;
  statusLabel: string;
  meta: string;
  x: number;
  y: number;
  children: DesktopChildObject[];
};

export type NativeAppSurfaceId = "files" | "library" | "terminal" | "repositories";

export type NativeAppEntry = {
  surface: NativeAppSurfaceId;
  label: string;
  icon: string;
  blurb: string;
};

/** The built-in GSV apps, listed under APPLICATIONS ahead of imported packages
 *  (rail subitems, desktop object strip, and the applications list page). */
export const NATIVE_APP_ENTRIES: NativeAppEntry[] = [
  {
    surface: "files",
    label: "FILES",
    icon: "folder",
    blurb: "Ship filesystem, datasets, logs, and build artifacts.",
  },
  {
    surface: "library",
    label: "LIBRARY",
    icon: "pencil",
    blurb: "Repo-backed markdown knowledge, source notes, and durable memory.",
  },
  {
    surface: "terminal",
    label: "TERMINAL",
    icon: "terminal",
    blurb: "Direct shell access to GSV and connected machines.",
  },
  {
    surface: "repositories",
    label: "REPOS",
    icon: "doticons/branch",
    blurb: "Browse ripgit repositories, source history, search, and diffs.",
  },
];

export function getDesktopObject(objects: readonly DesktopObject[], id: DesktopObjectId | null): DesktopObject | null {
  if (!id) {
    return null;
  }
  return objects.find((object) => object.id === id) ?? null;
}

export function shellSurfaceLabel(surface: ShellSurfaceId): string {
  switch (surface) {
    case "settings":
      return "SHIP OVERVIEW";
    case "app":
      return "APP";
    case "crew":
      return "CREW";
    case "agent":
      return "AGENT";
    case "machines":
      return "MACHINES";
    case "messengers":
      return "MESSENGERS";
    case "integrations":
      return "INTEGRATIONS";
    case "applications":
      return "APPLICATIONS";
    case "runtime":
      return "TASKS";
    case "models":
      return "MODELS";
    case "files":
      return "FILES";
    case "repositories":
      return "REPOSITORIES";
    case "library":
      return "LIBRARY";
    case "terminal":
      return "TERMINAL";
    case "list-template":
      return "LIST TEMPLATE";
    case "card-template":
      return "CARD TEMPLATE";
    case "connect-flows":
      return "CONNECT FLOWS";
    case "desktop":
    default:
      return "DESKTOP";
  }
}

export function shellTabForSurface(surface: ShellPageSurfaceId): ShellPageTab {
  const title = shellSurfaceLabel(surface);
  if (surface === "settings") {
    return {
      key: "settings",
      surface,
      title,
      kind: "settings",
      icon: "cog",
      type: "GSV · OVERVIEW",
      settingsRoute: { view: "overview" },
    };
  }
  if (surface === "files") {
    return {
      key: "sys:files",
      surface,
      title,
      kind: "system",
      icon: "folder",
      type: "GSV · STORAGE",
    };
  }
  if (surface === "repositories") {
    return {
      key: "sys:repositories",
      surface,
      title,
      kind: "system",
      icon: "doticons/branch",
      type: "GSV · REPOSITORIES",
    };
  }
  if (surface === "library") {
    return {
      key: "sys:library",
      surface,
      title,
      kind: "system",
      icon: "pencil",
      type: "GSV · LIBRARY",
      libraryRoute: { view: "index" },
    };
  }
  if (surface === "terminal") {
    return {
      key: "sys:terminal",
      surface,
      title,
      kind: "system",
      icon: "terminal",
      type: "GSV · CONSOLE",
    };
  }
  if (surface === "app") {
    return {
      key: "app:unknown",
      surface,
      title: "APP",
      kind: "app",
      icon: "stars",
      type: "GSV · APP",
      appRoute: {
        appId: "unknown",
        suffix: "/",
        search: "",
        hash: "",
      },
    };
  }
  if (surface === "models") {
    return {
      key: "surface:models",
      surface,
      title,
      kind: "inventory",
      icon: "stars",
      type: "GSV · MODELS",
    };
  }
  return {
    key: `surface:${surface}`,
    surface,
    title,
    kind: "inventory",
    icon: surface === "machines"
      ? "computer"
      : surface === "messengers" || surface === "crew" || surface === "agent"
        ? "chat"
        : surface === "integrations"
          ? "weblink"
          : surface === "applications"
            ? "stars"
            : "list",
    type: "GSV · CONTROL",
  };
}

function iconForDesktopGlyph(glyph: DesktopGlyph): string {
  if (glyph === "machines") return "computer";
  if (glyph === "messengers") return "chat";
  if (glyph === "integrations") return "weblink";
  return "stars";
}

export function shellTabForSettingsRoute(route: ShellSettingsRoute): ShellPageTab {
  return {
    ...shellTabForSurface("settings"),
    settingsRoute: route,
  };
}

export function shellTabForLibraryRoute(route: ShellLibraryRoute): ShellPageTab {
  return {
    ...shellTabForSurface("library"),
    libraryRoute: route,
  };
}

export function shellTabForAppRoute(route: ShellAppRoute, title?: string): ShellPageTab {
  const normalizedRoute = normalizeShellAppRoute(route);
  return {
    key: shellAppRouteKey(normalizedRoute),
    surface: "app",
    title: title ?? normalizedRoute.appId,
    kind: "app",
    icon: "stars",
    type: "GSV · APP",
    appRoute: normalizedRoute,
  };
}

export function shellTabForRoute(route: ShellRoute, title?: string): ShellPageTab | null {
  if (route.surface === "desktop") {
    return null;
  }
  if (route.surface === "app") {
    return shellTabForAppRoute(route.appRoute, title);
  }
  if (route.surface === "settings" && route.settingsRoute) {
    return shellTabForSettingsRoute(route.settingsRoute);
  }
  if (route.surface === "library" && route.libraryRoute) {
    return shellTabForLibraryRoute(route.libraryRoute);
  }
  return shellTabForSurface(route.surface);
}

export function shellRouteForTab(tab: ShellPageTab): ShellRoute {
  if (tab.surface === "app") {
    return {
      surface: "app",
      appRoute: normalizeShellAppRoute(tab.appRoute ?? {
        appId: "unknown",
        suffix: "/",
        search: "",
        hash: "",
      }),
    };
  }
  if (tab.surface === "settings") {
    return {
      surface: "settings",
      settingsRoute: tab.settingsRoute ?? { view: "overview" },
    };
  }
  if (tab.surface === "library") {
    return {
      surface: "library",
      libraryRoute: tab.libraryRoute ?? { view: "index" },
    };
  }
  return { surface: tab.surface };
}

export function shellAppRouteKey(route: ShellAppRoute): string {
  const normalizedRoute = normalizeShellAppRoute(route);
  return `app:${normalizedRoute.appId}:${normalizedRoute.suffix}:${normalizedRoute.search}:${normalizedRoute.hash}`;
}

export function normalizeShellAppRoute(route: ShellAppRoute): ShellAppRoute {
  const suffix = route.suffix.trim();
  const search = route.search.trim();
  const hash = route.hash.trim();
  return {
    appId: route.appId.trim(),
    suffix: suffix.length === 0 ? "/" : suffix.startsWith("/") ? suffix : `/${suffix}`,
    search: search.length > 0 && !search.startsWith("?") ? `?${search}` : search,
    hash: hash.length > 0 && !hash.startsWith("#") ? `#${hash}` : hash,
  };
}

export function shellTabForDesktopChild(child: DesktopChildObject): ShellPageTab {
  const route = child.route;
  if (!route) {
    // Native children carry a `surface` instead of an object route and are
    // opened via openSurface before this factory is ever consulted.
    throw new Error(`shellTabForDesktopChild: child ${child.id} has no object route`);
  }
  return {
    key: `obj:${route.kind}:${route.detailId}`,
    surface: "settings",
    title: child.label,
    kind: "object",
    icon: iconForDesktopGlyph(child.glyph),
    type: child.type,
    settingsRoute: {
      view: "list",
      kind: route.kind,
      detailId: route.detailId,
      detailLabel: child.label,
    },
  };
}
