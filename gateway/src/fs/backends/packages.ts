import type {
  FileContent,
  MkdirOptions,
  RmOptions,
} from "just-bash";
import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";
import {
  type PackageEntrypoint,
  type PackageStore,
  visiblePackageScopesForActor,
} from "../../kernel/packages";
import type { ExtendedMountStat, MountBackend } from "../mount";
import { normalizePath } from "../utils";

const TEXT_ENCODER = new TextEncoder();

type PackageCommandEntry = {
  command: string;
  packageName: string;
  packageId: string;
  description?: string;
};

export function createPackageBackend(
  identity: ProcessIdentity,
  packages: PackageStore | undefined,
): MountBackend | null {
  if (!packages) {
    return null;
  }

  return new PackageMountBackend(identity, packages);
}

export function isPackageMountPath(path: string): boolean {
  return (
    path === "/usr" ||
    path === "/usr/local" ||
    path === "/usr/local/bin" ||
    path.startsWith("/usr/local/bin/")
  );
}

class PackageMountBackend implements MountBackend {
  constructor(
    private readonly identity: ProcessIdentity,
    private readonly packages: PackageStore,
  ) {}

  handles(path: string): boolean {
    return isPackageMountPath(path);
  }

  async readFile(path: string): Promise<string> {
    const entry = this.requireCommandEntry(path);
    return renderPackageCommandShim(entry);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    return TEXT_ENCODER.encode(await this.readFile(path));
  }

  async writeFile(path: string, _content: FileContent): Promise<void> {
    throw new Error(`EPERM: package mount is read-only '${normalizePath(path)}'`);
  }

  async appendFile(path: string, _content: FileContent): Promise<void> {
    throw new Error(`EPERM: package mount is read-only '${normalizePath(path)}'`);
  }

  async exists(path: string): Promise<boolean> {
    const p = normalizePath(path);
    if (p === "/usr" || p === "/usr/local" || p === "/usr/local/bin") {
      return true;
    }
    if (!p.startsWith("/usr/local/bin/")) {
      return false;
    }
    return this.findCommandEntry(commandNameFromPath(p)) !== null;
  }

  async stat(path: string): Promise<ExtendedMountStat> {
    const p = normalizePath(path);
    if (p === "/usr" || p === "/usr/local" || p === "/usr/local/bin") {
      return makeDirectoryStat(this.identity.uid);
    }

    const entry = this.requireCommandEntry(p);
    const content = renderPackageCommandShim(entry);
    return {
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
      mode: 0o444,
      size: TEXT_ENCODER.encode(content).length,
      mtime: new Date(),
      uid: 0,
      gid: 0,
    };
  }

  async mkdir(path: string, _options?: MkdirOptions): Promise<void> {
    throw new Error(`EPERM: package mount is read-only '${normalizePath(path)}'`);
  }

  async readdir(path: string): Promise<string[]> {
    const p = normalizePath(path);
    if (p === "/usr") {
      return ["local"];
    }
    if (p === "/usr/local") {
      return ["bin"];
    }
    if (p === "/usr/local/bin") {
      return this.listCommands().map((entry) => entry.command);
    }
    throw new Error(`ENOENT: no such file or directory, scandir '${p}'`);
  }

  async rm(path: string, _options?: RmOptions): Promise<void> {
    throw new Error(`EPERM: package mount is read-only '${normalizePath(path)}'`);
  }

  async chmod(path: string): Promise<void> {
    throw new Error(`EPERM: package mount is read-only '${normalizePath(path)}'`);
  }

  async chown(path: string): Promise<void> {
    throw new Error(`EPERM: package mount is read-only '${normalizePath(path)}'`);
  }

  async utimes(path: string): Promise<void> {
    const p = normalizePath(path);
    if (await this.exists(p)) {
      return;
    }
    throw new Error(`ENOENT: no such file or directory, utimes '${p}'`);
  }

  private requireCommandEntry(path: string): PackageCommandEntry {
    const p = normalizePath(path);
    if (!p.startsWith("/usr/local/bin/")) {
      throw new Error(`EISDIR: illegal operation on a directory, read '${p}'`);
    }

    const command = commandNameFromPath(p);
    const entry = this.findCommandEntry(command);
    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, open '${p}'`);
    }
    return entry;
  }

  private findCommandEntry(command: string): PackageCommandEntry | null {
    for (const entry of this.listCommands()) {
      if (entry.command === command) {
        return entry;
      }
    }
    return null;
  }

  private listCommands(): PackageCommandEntry[] {
    const commands = new Map<string, PackageCommandEntry>();

    for (const record of this.packages.list({
      enabled: true,
      scopes: visiblePackageScopesForActor(this.identity),
    })) {
      for (const entrypoint of record.manifest.entrypoints) {
        if (!isCommandEntrypoint(entrypoint)) {
          continue;
        }
        const command = entrypoint.command.trim();
        if (commands.has(command)) {
          continue;
        }
        commands.set(command, {
          command,
          packageName: record.manifest.name,
          packageId: record.packageId,
          description: entrypoint.description,
        });
      }
    }

    return [...commands.values()].sort((left, right) => left.command.localeCompare(right.command));
  }
}

function isCommandEntrypoint(entrypoint: PackageEntrypoint): entrypoint is PackageEntrypoint & { command: string } {
  return entrypoint.kind === "command" && typeof entrypoint.command === "string" && entrypoint.command.trim().length > 0;
}

function commandNameFromPath(path: string): string {
  return normalizePath(path).slice("/usr/local/bin/".length);
}

function renderPackageCommandShim(entry: PackageCommandEntry): string {
  const description = entry.description?.trim() || "No description.";
  return [
    "#!/usr/bin/env gsv-package",
    "# virtual package command mount",
    `# package: ${entry.packageName}`,
    `# packageId: ${entry.packageId}`,
    `# command: ${entry.command}`,
    `# description: ${description}`,
    "",
  ].join("\n");
}

function makeDirectoryStat(uid: number): ExtendedMountStat {
  return {
    isFile: false,
    isDirectory: true,
    isSymbolicLink: false,
    mode: 0o755,
    size: 0,
    mtime: new Date(),
    uid,
    gid: uid,
  };
}
