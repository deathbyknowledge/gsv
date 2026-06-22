export type ShellSurfaceId =
  | "desktop"
  | "settings"
  | "crew"
  | "agent"
  | "machines"
  | "object"
  | "runtime"
  | "files"
  | "library"
  | "terminal";

export type DesktopObjectId = "machines" | "messengers" | "integrations" | "applications";
export type ShellStatus = "online" | "error" | "idle" | "warn" | "live" | "update";
export type DesktopGlyph = "machines" | "messengers" | "integrations" | "applications";
export type ShellRailMode = "objects" | "gsv" | "tabs";

export type ShellTab = {
  key: string;
  surface: Exclude<ShellSurfaceId, "desktop">;
  title: string;
};

export type DesktopChildObject = {
  id: string;
  label: string;
  type: string;
  blurb: string;
  status: ShellStatus;
  statusLabel: string;
  glyph: DesktopGlyph;
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
  id: Exclude<ShellSurfaceId, "desktop" | "agent" | "machines" | "object">;
  label: string;
  icon: string;
  description: string;
};

export type GsvControlItem = {
  id: "runtime" | "files" | "library" | "terminal" | "settings";
  label: string;
  icon: string;
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

export const GSV_CONTROL_ITEMS: GsvControlItem[] = [
  {
    id: "runtime",
    label: "RUNTIME",
    icon: "list",
  },
  {
    id: "files",
    label: "FILES",
    icon: "folder",
  },
  {
    id: "library",
    label: "LIBRARY",
    icon: "pencil",
  },
  {
    id: "terminal",
    label: "TERMINAL",
    icon: "terminal",
  },
  {
    id: "settings",
    label: "SETTINGS",
    icon: "cog",
  },
];

export function shellTabForSurface(surface: Exclude<ShellSurfaceId, "desktop">): ShellTab {
  return {
    key: surface,
    surface,
    title: shellSurfaceLabel(surface),
  };
}

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
    case "object":
      return "OBJECT";
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
