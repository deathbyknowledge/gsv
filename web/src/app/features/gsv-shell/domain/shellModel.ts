export type ShellSurfaceId =
  | "desktop"
  | "settings"
  | "crew"
  | "agent"
  | "machines"
  | "messengers"
  | "integrations"
  | "applications"
  | "runtime"
  | "files"
  | "library"
  | "terminal";

export type DesktopObjectId = "machines" | "messengers" | "integrations" | "applications";
export type ShellStatus = "online" | "error" | "idle" | "warn" | "live" | "update";
export type DesktopGlyph = "machines" | "messengers" | "integrations" | "applications";
export type ShellPageSurfaceId = Exclude<ShellSurfaceId, "desktop">;
export type ShellPageTabKind = "settings" | "system" | "inventory" | "object";
export type ShellSettingsListKind = DesktopObjectId | "library" | "tasks";

export type ShellSettingsRoute =
  | { view: "overview" }
  | { view: "list"; kind: ShellSettingsListKind; detailId?: string; detailLabel?: string; createNew?: boolean }
  | { view: "config"; kind: "models" | "overrides" }
  | { view: "crew" }
  | { view: "agent"; accountUid: number | null; createNew?: boolean };

export type ShellPageTab = {
  key: string;
  surface: ShellPageSurfaceId;
  title: string;
  kind: ShellPageTabKind;
  icon: string;
  type: string;
  settingsRoute?: ShellSettingsRoute;
};

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
    description: "Packages, models, and reusable skills available to agents.",
  },
  {
    id: "terminal",
    label: "TERMINAL",
    icon: "terminal",
    description: "Direct shell access to GSV and connected machines.",
  },
  {
    id: "settings",
    label: "SETTINGS",
    icon: "cog",
    description: "Crew, machines, integrations, access, and system configuration.",
  },
  {
    id: "crew",
    label: "CREW",
    icon: "chat",
    description: "Agents, models, task ownership, and permissions.",
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
      return "SETTINGS";
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
      return "RUNTIME";
    case "files":
      return "FILES";
    case "library":
      return "LIBRARY";
    case "terminal":
      return "TERMINAL";
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
      type: "GSV · SETTINGS",
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
  if (surface === "library") {
    return {
      key: "sys:library",
      surface,
      title,
      kind: "system",
      icon: "pencil",
      type: "GSV · PACKAGES",
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
