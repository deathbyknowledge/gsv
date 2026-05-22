import type {
  BufferEncoding,
  CpOptions,
  FileContent,
  FsStat,
  IFileSystem,
  MkdirOptions,
  RmOptions,
} from "just-bash/browser";
import { toAppSummary } from "./browser-target-commands";
import type { WindowManager } from "./window-manager";

type RuntimeDirentEntry = {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
};

type RuntimeEntry =
  | { kind: "directory"; path: string; children: string[] }
  | { kind: "file"; path: string; content: string };

type RuntimeReadFileOptions = { encoding?: BufferEncoding | null };
type RuntimeWriteFileOptions = { encoding?: BufferEncoding };

const READONLY_MESSAGE = "Browser runtime filesystem is read-only";
const RUNTIME_MTIME = new Date(0);

export class BrowserRuntimeFileSystem implements IFileSystem {
  constructor(private readonly windowManager: WindowManager) {
  }

  async readFile(path: string, options?: RuntimeReadFileOptions | BufferEncoding): Promise<string> {
    const entry = this.getEntry(path);
    if (entry.kind !== "file") {
      throw new Error(`Is a directory: ${normalizeRuntimePath(path)}`);
    }
    const encoding = typeof options === "string" ? options : options?.encoding;
    return encodeText(entry.content, encoding ?? "utf8");
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const entry = this.getEntry(path);
    if (entry.kind !== "file") {
      throw new Error(`Is a directory: ${normalizeRuntimePath(path)}`);
    }
    return new TextEncoder().encode(entry.content);
  }

  async writeFile(_path: string, _content: FileContent, _options?: RuntimeWriteFileOptions | BufferEncoding): Promise<void> {
    throw new Error(READONLY_MESSAGE);
  }

  async appendFile(_path: string, _content: FileContent, _options?: RuntimeWriteFileOptions | BufferEncoding): Promise<void> {
    throw new Error(READONLY_MESSAGE);
  }

  async exists(path: string): Promise<boolean> {
    return this.findEntry(path) !== null;
  }

  async stat(path: string): Promise<FsStat> {
    return this.statEntry(this.getEntry(path));
  }

  async lstat(path: string): Promise<FsStat> {
    return this.stat(path);
  }

  async mkdir(_path: string, _options?: MkdirOptions): Promise<void> {
    throw new Error(READONLY_MESSAGE);
  }

  async readdir(path: string): Promise<string[]> {
    const entry = this.getEntry(path);
    if (entry.kind !== "directory") {
      throw new Error(`Not a directory: ${normalizeRuntimePath(path)}`);
    }
    return [...entry.children].sort();
  }

  async readdirWithFileTypes(path: string): Promise<RuntimeDirentEntry[]> {
    const names = await this.readdir(path);
    return names.map((name) => {
      const child = this.getEntry(joinRuntimePath(path, name));
      return {
        name,
        isFile: child.kind === "file",
        isDirectory: child.kind === "directory",
        isSymbolicLink: false,
      };
    });
  }

  async rm(_path: string, _options?: RmOptions): Promise<void> {
    throw new Error(READONLY_MESSAGE);
  }

  async cp(_src: string, _dest: string, _options?: CpOptions): Promise<void> {
    throw new Error(READONLY_MESSAGE);
  }

  async mv(_src: string, _dest: string): Promise<void> {
    throw new Error(READONLY_MESSAGE);
  }

  resolvePath(base: string, path: string): string {
    if (!path || path === ".") {
      return normalizeRuntimePath(base);
    }
    if (path.startsWith("/")) {
      return normalizeRuntimePath(path);
    }
    return normalizeRuntimePath(`${base.replace(/\/+$/, "")}/${path}`);
  }

  getAllPaths(): string[] {
    return Array.from(this.buildEntries().keys()).sort();
  }

  async chmod(_path: string, _mode: number): Promise<void> {
    throw new Error(READONLY_MESSAGE);
  }

  async symlink(_target: string, _linkPath: string): Promise<void> {
    throw new Error(READONLY_MESSAGE);
  }

  async link(_existingPath: string, _newPath: string): Promise<void> {
    throw new Error(READONLY_MESSAGE);
  }

  async readlink(path: string): Promise<string> {
    throw new Error(`Not a symlink: ${normalizeRuntimePath(path)}`);
  }

  async realpath(path: string): Promise<string> {
    this.getEntry(path);
    return normalizeRuntimePath(path);
  }

  async utimes(_path: string, _atime: Date, _mtime: Date): Promise<void> {
    throw new Error(READONLY_MESSAGE);
  }

  private findEntry(path: string): RuntimeEntry | null {
    return this.buildEntries().get(normalizeRuntimePath(path)) ?? null;
  }

  private getEntry(path: string): RuntimeEntry {
    const normalized = normalizeRuntimePath(path);
    const entry = this.findEntry(normalized);
    if (!entry) {
      throw new Error(`No such file or directory: ${normalized}`);
    }
    return entry;
  }

  private statEntry(entry: RuntimeEntry): FsStat {
    if (entry.kind === "directory") {
      return {
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
        mode: 0o555,
        size: 0,
        mtime: RUNTIME_MTIME,
      };
    }
    return {
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
      mode: 0o444,
      size: new TextEncoder().encode(entry.content).byteLength,
      mtime: RUNTIME_MTIME,
    };
  }

  private buildEntries(): Map<string, RuntimeEntry> {
    const windows = this.windowManager.listWindows();
    const apps = this.windowManager.listApps();
    const active = windows.find((window) => window.active) ?? null;
    const entries = new Map<string, RuntimeEntry>();

    const addDirectory = (path: string, children: string[]) => {
      entries.set(normalizeRuntimePath(path), {
        kind: "directory",
        path: normalizeRuntimePath(path),
        children,
      });
    };
    const addFile = (path: string, content: unknown) => {
      entries.set(normalizeRuntimePath(path), {
        kind: "file",
        path: normalizeRuntimePath(path),
        content: `${JSON.stringify(content, null, 2)}\n`,
      });
    };
    const addTextFile = (path: string, content: string) => {
      entries.set(normalizeRuntimePath(path), {
        kind: "file",
        path: normalizeRuntimePath(path),
        content,
      });
    };

    addDirectory("/", ["apps.json", "apps", "desktop", "windows"]);
    addFile("/apps.json", {
      apps: apps.map(toAppSummary),
      generatedAt: new Date().toISOString(),
    });

    addDirectory("/desktop", ["active-window", "active-window.json", "windows.json"]);
    entries.set("/desktop/active-window", {
      kind: "file",
      path: "/desktop/active-window",
      content: active ? JSON.stringify(active, null, 2) : "",
    });
    addFile("/desktop/active-window.json", active);
    addFile("/desktop/windows.json", {
      windows,
      generatedAt: new Date().toISOString(),
    });

    addDirectory("/apps", apps.map((app) => app.id));
    for (const app of apps) {
      addDirectory(`/apps/${app.id}`, ["manifest.json", "windows.json"]);
      addFile(`/apps/${app.id}/manifest.json`, toAppSummary(app));
      addFile(`/apps/${app.id}/windows.json`, {
        windows: windows.filter((window) => window.appId === app.id),
        generatedAt: new Date().toISOString(),
      });
    }

    addDirectory("/windows", windows.map((window) => window.windowId));
    for (const window of windows) {
      addDirectory(`/windows/${window.windowId}`, ["app.txt", "meta.json", "mode.txt", "route.txt", "title.txt"]);
      addFile(`/windows/${window.windowId}/meta.json`, window);
      addTextFile(`/windows/${window.windowId}/app.txt`, `${window.appId}\n`);
      addTextFile(`/windows/${window.windowId}/mode.txt`, `${window.mode}\n`);
      addTextFile(`/windows/${window.windowId}/route.txt`, `${window.route}\n`);
      addTextFile(`/windows/${window.windowId}/title.txt`, `${window.title}\n`);
    }

    return entries;
  }
}

function joinRuntimePath(base: string, name: string): string {
  const normalizedBase = normalizeRuntimePath(base);
  return normalizedBase === "/" ? `/${name}` : `${normalizedBase}/${name}`;
}

function normalizeRuntimePath(path: string): string {
  const absolute = path.startsWith("/") ? path : `/${path}`;
  const parts: string[] = [];
  for (const part of absolute.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

function encodeText(content: string, encoding: BufferEncoding | null): string {
  const bytes = new TextEncoder().encode(content);
  switch (encoding) {
    case "base64":
      return btoa(String.fromCharCode(...bytes));
    case "hex":
      return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
    case "binary":
    case "latin1":
      return String.fromCharCode(...bytes);
    case "ascii":
      return String.fromCharCode(...bytes.map((byte) => byte & 0x7f));
    case null:
    case "utf8":
    case "utf-8":
    default:
      return content;
  }
}
