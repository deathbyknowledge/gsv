import { defineAppManifest } from "./app-sdk";
import type { AppCapability, AppManifest, AppWindowDefaults, DesktopGlyphClass } from "./app-sdk";

export type { AppCapability, AppManifest, AppWindowDefaults, DesktopGlyphClass };

export const APP_REGISTRY: readonly AppManifest[] = [
  defineAppManifest({
    id: "chat",
    name: "Chat",
    description: "Conversational workspace with agents.",
    iconGlyphClass: "glyph-chat",
    entrypoint: { kind: "component", route: "/apps/chat", tagName: "gsv-chat-app" },
    permissions: ["chat.use"],
    syscalls: ["proc.send", "proc.history"],
    windowDefaults: {
      width: 880,
      height: 640,
      minWidth: 620,
      minHeight: 420,
    },
  }),
  defineAppManifest({
    id: "shell",
    name: "Shell",
    description: "Interactive command shell for nodes.",
    iconGlyphClass: "glyph-shell",
    entrypoint: { kind: "component", route: "/apps/shell", tagName: "gsv-shell-app" },
    permissions: ["shell.exec", "proc.inspect"],
    syscalls: ["shell.exec", "shell.signal", "shell.list", "proc.list"],
    windowDefaults: {
      width: 980,
      height: 640,
      minWidth: 700,
      minHeight: 420,
    },
  }),
  defineAppManifest({
    id: "files",
    name: "Files",
    description: "File browser and workspace management.",
    iconGlyphClass: "glyph-files",
    entrypoint: { kind: "component", route: "/apps/files", tagName: "gsv-files-app" },
    permissions: ["fs.read"],
    syscalls: ["fs.read", "fs.search", "fs.write", "fs.edit", "fs.delete"],
    windowDefaults: {
      width: 980,
      height: 650,
      minWidth: 720,
      minHeight: 460,
    },
  }),
  defineAppManifest({
    id: "control",
    name: "Control",
    description: "System status, permissions, and settings.",
    iconGlyphClass: "glyph-system",
    entrypoint: { kind: "component", route: "/apps/control", tagName: "gsv-control-app" },
    permissions: ["system.manage", "proc.inspect"],
    syscalls: ["sys.config.get", "sys.config.set"],
    windowDefaults: {
      width: 860,
      height: 580,
      minWidth: 640,
      minHeight: 420,
    },
  }),
] as const;
