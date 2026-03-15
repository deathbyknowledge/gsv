export type DesktopGlyphClass = "glyph-chat" | "glyph-shell" | "glyph-files" | "glyph-system";

export type AppCapability = "chat.use" | "shell.exec" | "fs.read" | "proc.inspect" | "system.manage";

export type AppEntrypoint = {
  kind: "internal";
  route: "/apps/chat" | "/apps/shell" | "/apps/files" | "/apps/control";
};

export type AppWindowDefaults = {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
};

export type AppManifest = {
  id: string;
  name: string;
  description: string;
  iconGlyphClass: DesktopGlyphClass;
  entrypoint: AppEntrypoint;
  permissions: readonly AppCapability[];
  windowDefaults: AppWindowDefaults;
};

export const APP_REGISTRY: readonly AppManifest[] = [
  {
    id: "chat",
    name: "Chat",
    description: "Conversational workspace with agents.",
    iconGlyphClass: "glyph-chat",
    entrypoint: { kind: "internal", route: "/apps/chat" },
    permissions: ["chat.use"],
    windowDefaults: {
      width: 880,
      height: 640,
      minWidth: 620,
      minHeight: 420,
    },
  },
  {
    id: "shell",
    name: "Shell",
    description: "Interactive command shell for nodes.",
    iconGlyphClass: "glyph-shell",
    entrypoint: { kind: "internal", route: "/apps/shell" },
    permissions: ["shell.exec", "proc.inspect"],
    windowDefaults: {
      width: 980,
      height: 640,
      minWidth: 700,
      minHeight: 420,
    },
  },
  {
    id: "files",
    name: "Files",
    description: "File browser and workspace management.",
    iconGlyphClass: "glyph-files",
    entrypoint: { kind: "internal", route: "/apps/files" },
    permissions: ["fs.read"],
    windowDefaults: {
      width: 980,
      height: 650,
      minWidth: 720,
      minHeight: 460,
    },
  },
  {
    id: "control",
    name: "Control",
    description: "System status, permissions, and settings.",
    iconGlyphClass: "glyph-system",
    entrypoint: { kind: "internal", route: "/apps/control" },
    permissions: ["system.manage", "proc.inspect"],
    windowDefaults: {
      width: 860,
      height: 580,
      minWidth: 640,
      minHeight: 420,
    },
  },
] as const;
