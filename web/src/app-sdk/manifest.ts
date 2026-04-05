export type DesktopIconId = "chat" | "shell" | "devices" | "files" | "control" | "processes" | "packages";

export type AppIcon =
  | { kind: "builtin"; id: DesktopIconId }
  | { kind: "svg"; svg: string };

export type AppCapability =
  | "chat.use"
  | "shell.exec"
  | "fs.*"
  | "fs.read"
  | "proc.inspect"
  | "device.inspect"
  | "system.manage";

export type AppWindowDefaults = {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
};

export type LegacyEntrypoint = {
  kind: "legacy";
  route: string;
};

export type ComponentEntrypoint = {
  kind: "component";
  route: string;
  tagName: `${string}-${string}`;
};

export type WebEntrypoint = {
  kind: "web";
  route: string;
};

export type AppEntrypoint = LegacyEntrypoint | ComponentEntrypoint | WebEntrypoint;

export type AppManifest = {
  id: string;
  name: string;
  description: string;
  icon: AppIcon;
  entrypoint: AppEntrypoint;
  permissions: readonly AppCapability[];
  syscalls: readonly string[];
  windowDefaults: AppWindowDefaults;
};

function isValidCustomElementTag(tagName: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(tagName);
}

function assertManifest(manifest: AppManifest): void {
  if (!manifest.id.trim()) {
    throw new Error("App manifest id is required");
  }
  if (!manifest.name.trim()) {
    throw new Error(`App manifest "${manifest.id}" is missing name`);
  }
  if (manifest.icon.kind === "svg" && manifest.icon.svg.trim().length === 0) {
    throw new Error(`App manifest "${manifest.id}" has empty svg icon`);
  }

  if (manifest.entrypoint.kind === "component") {
    if (!isValidCustomElementTag(manifest.entrypoint.tagName)) {
      throw new Error(
        `App manifest "${manifest.id}" has invalid custom element tag: ${manifest.entrypoint.tagName}`,
      );
    }
  }
}

export function defineAppManifest(manifest: AppManifest): AppManifest {
  assertManifest(manifest);
  return manifest;
}
