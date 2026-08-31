export type ShellSurfaceId =
  | "desktop"
  | "settings"
  | "crew"
  | "agent"
  | "machines"
  | "messengers"
  | "integrations"
  | "runtime"
  | "responsibilities"
  | "contacts"
  | "architecture"
  | "files"
  | "repositories"
  | "library"
  | "terminal"
  | "list-template"
  | "card-template"
  | "connect-flows";

export type DesktopObjectId = "machines" | "messengers" | "integrations";
export type ShellStatus = "online" | "error" | "idle" | "warn" | "live" | "update";
export type DesktopGlyph = "machines" | "messengers" | "integrations";
export type ShellPageSurfaceId = Exclude<ShellSurfaceId, "desktop">;
export type ShellPageTabKind = "settings" | "system" | "inventory" | "object";
export type ShellSettingsListKind = DesktopObjectId | "library" | "tasks";

export type ShellSettingsRoute =
  | { view: "overview" }
  | { view: "list"; kind: ShellSettingsListKind; detailId?: string; detailLabel?: string; createNew?: boolean }
  | { view: "config"; kind: "models" | "overrides"; select?: string }
  | { view: "crew"; select?: string }
  | { view: "agent"; accountUid: number | null; createNew?: boolean };

export type ShellPageTab = {
  key: string;
  surface: ShellPageSurfaceId;
  title: string;
  kind: ShellPageTabKind;
  icon: string;
  type: string;
  libraryRoute?: ShellLibraryRoute;
  filesRoute?: ShellFilesRoute;
  settingsRoute?: ShellSettingsRoute;
};

export type ShellLibraryRoute =
  | { view: "index"; db?: string; q?: string }
  | { view: "reader"; db: string; path: string }
  | { view: "editor"; db: string; path?: string }
  | { view: "capture"; db: string }
  | { view: "build"; db?: string };

/** A FILES deep link: which target (machine) and which absolute directory to
 *  open on. Absent (bare /files) restores the default target + client-side tabs. */
export type ShellFilesRoute = { target: string; path: string };

export type ShellRoute =
  | { surface: "desktop" }
  | { surface: "library"; libraryRoute?: ShellLibraryRoute }
  | { surface: "files"; filesRoute?: ShellFilesRoute }
  | { surface: Exclude<ShellPageSurfaceId, "library" | "files">; settingsRoute?: ShellSettingsRoute };

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
  route: DesktopChildRoute;
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

export type SystemDockItem = {
  id: Exclude<ShellSurfaceId, "desktop" | "agent" | "machines">;
  label: string;
  icon: string;
  description: string;
};

export const SYSTEM_DOCK_ITEMS: SystemDockItem[] = [
  {
    id: "files",
    label: "FILES",
    icon: "folder",
    description: "Ship filesystem, datasets, logs, and build artifacts.",
  },
  {
    id: "library",
    label: "LIBRARY",
    icon: "pencil",
    description: "Repo-backed markdown knowledge, source notes, and durable memory.",
  },
  {
    id: "terminal",
    label: "TERMINAL",
    icon: "terminal",
    description: "Direct shell access to GSV and connected machines.",
  },
  {
    id: "repositories",
    label: "REPOS",
    icon: "doticons/branch",
    description: "Browse ripgit repositories, source history, search, and diffs.",
  },
  {
    id: "architecture",
    label: "SYSTEM MAP",
    icon: "stars",
    description: "Explore GSV subsystem ownership, source components, and end-to-end flows.",
  },
  {
    id: "settings",
    label: "OVERVIEW",
    icon: "cog",
    description: "Crew, machines, integrations, access, and system configuration.",
  },
  {
    id: "crew",
    label: "CREW",
    icon: "chat",
    description: "Agents, models, work ownership, and permissions.",
  },
  {
    id: "contacts",
    label: "CONTACTS",
    icon: "chat",
    description: "Trusted GSV Ships, pairing, requests, and access.",
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
      return "OVERVIEW";
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
    case "runtime":
      return "WORK";
    case "responsibilities":
      return "RESPONSIBILITIES";
    case "contacts":
      return "CONTACTS";
    case "architecture":
      return "SYSTEM MAP";
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
  if (surface === "architecture") {
    return {
      key: "sys:architecture",
      surface,
      title,
      kind: "system",
      icon: "stars",
      type: "GSV · SOURCE MAP",
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

export function shellTabForFilesRoute(route: ShellFilesRoute): ShellPageTab {
  return {
    ...shellTabForSurface("files"),
    filesRoute: route,
  };
}

export function shellTabForRoute(route: ShellRoute): ShellPageTab | null {
  if (route.surface === "desktop") {
    return null;
  }
  if (route.surface === "settings" && route.settingsRoute) {
    return shellTabForSettingsRoute(route.settingsRoute);
  }
  if (route.surface === "library" && route.libraryRoute) {
    return shellTabForLibraryRoute(route.libraryRoute);
  }
  if (route.surface === "files" && route.filesRoute) {
    return shellTabForFilesRoute(route.filesRoute);
  }
  return shellTabForSurface(route.surface);
}

export function shellRouteForTab(tab: ShellPageTab): ShellRoute {
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
  if (tab.surface === "files") {
    // Bare FILES carries no route (default target + client-side tabs); only a
    // deep-linked tab restores the target + directory.
    return tab.filesRoute
      ? { surface: "files", filesRoute: tab.filesRoute }
      : { surface: "files" };
  }
  return { surface: tab.surface };
}

export function shellTabForDesktopChild(child: DesktopChildObject): ShellPageTab {
  return {
    key: `obj:${child.route.kind}:${child.route.detailId}`,
    surface: "settings",
    title: child.label,
    kind: "object",
    icon: iconForDesktopGlyph(child.glyph),
    type: child.type,
    settingsRoute: {
      view: "list",
      kind: child.route.kind,
      detailId: child.route.detailId,
      detailLabel: child.label,
    },
  };
}
