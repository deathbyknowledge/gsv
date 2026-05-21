import type {
  BufferEncoding,
  CpOptions,
  FileContent,
  FsStat,
  IFileSystem,
  MkdirOptions,
  RmOptions,
} from "just-bash/browser";

type ZenCore = typeof import("@zenfs/core");
type ZenPromisedFs = ZenCore["fs"]["promises"];
type ZenStats = Awaited<ReturnType<ZenPromisedFs["stat"]>>;
type BrowserWriteFileOptions = { encoding?: BufferEncoding };
type BrowserDirentEntry = {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
};

let zenReady: Promise<ZenCore> | null = null;

export type BrowserTargetFileSystemInfo = {
  backend: "indexeddb" | "memory";
};

export class BrowserTargetFileSystem implements IFileSystem {
  private constructor(
    private readonly zen: ZenCore,
    readonly info: BrowserTargetFileSystemInfo,
  ) {
  }

  static async create(): Promise<BrowserTargetFileSystem> {
    const { zen, info } = await configureZenFs();
    return new BrowserTargetFileSystem(zen, info);
  }

  async readFile(path: string, options?: { encoding?: BufferEncoding | null } | BufferEncoding): Promise<string> {
    const encoding = typeof options === "string" ? options : options?.encoding;
    const data = await this.zen.fs.promises.readFile(path);
    return decodeContent(toUint8Array(data), encoding ?? "utf8");
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const data = await this.zen.fs.promises.readFile(path);
    return toUint8Array(data);
  }

  async writeFile(path: string, content: FileContent, options?: BrowserWriteFileOptions | BufferEncoding): Promise<void> {
    await this.ensureParentDirectory(path);
    await this.zen.fs.promises.writeFile(path, content, normalizeWriteOptions(options));
  }

  async appendFile(path: string, content: FileContent, options?: BrowserWriteFileOptions | BufferEncoding): Promise<void> {
    await this.ensureParentDirectory(path);
    await this.zen.fs.promises.appendFile(path, content, normalizeWriteOptions(options));
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.zen.fs.promises.access(path);
      return true;
    } catch {
      return false;
    }
  }

  async stat(path: string): Promise<FsStat> {
    return toFsStat(await this.zen.fs.promises.stat(path));
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    await this.zen.fs.promises.mkdir(path, { recursive: options?.recursive === true });
  }

  async readdir(path: string): Promise<string[]> {
    const entries = await this.zen.fs.promises.readdir(path);
    return entries.map((entry) => String(entry));
  }

  async readdirWithFileTypes(path: string): Promise<BrowserDirentEntry[]> {
    const entries = await this.zen.fs.promises.readdir(path, { withFileTypes: true });
    return entries.map((entry) => ({
      name: String(entry.name),
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
      isSymbolicLink: entry.isSymbolicLink(),
    }));
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    await this.zen.fs.promises.rm(path, {
      recursive: options?.recursive === true,
      force: options?.force === true,
    });
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    await this.ensureParentDirectory(dest);
    await this.zen.fs.promises.cp(src, dest, { recursive: options?.recursive === true });
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.ensureParentDirectory(dest);
    await this.zen.fs.promises.rename(src, dest);
  }

  resolvePath(base: string, path: string): string {
    if (!path || path === ".") {
      return normalizeAbsolutePath(base);
    }
    if (path.startsWith("/")) {
      return normalizeAbsolutePath(path);
    }
    return normalizeAbsolutePath(`${base.replace(/\/+$/, "")}/${path}`);
  }

  getAllPaths(): string[] {
    try {
      return Array.from(walkSync(this.zen, "/")).sort();
    } catch {
      return [];
    }
  }

  async chmod(path: string, mode: number): Promise<void> {
    await this.zen.fs.promises.chmod(path, mode);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    await this.ensureParentDirectory(linkPath);
    await this.zen.fs.promises.symlink(target, linkPath);
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    await this.ensureParentDirectory(newPath);
    await this.zen.fs.promises.link(existingPath, newPath);
  }

  async readlink(path: string): Promise<string> {
    return String(await this.zen.fs.promises.readlink(path));
  }

  async lstat(path: string): Promise<FsStat> {
    return toFsStat(await this.zen.fs.promises.lstat(path));
  }

  async realpath(path: string): Promise<string> {
    return String(await this.zen.fs.promises.realpath(path, "utf8"));
  }

  async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    await this.zen.fs.promises.utimes(path, atime, mtime);
  }

  private async ensureParentDirectory(path: string): Promise<void> {
    const parent = dirname(path);
    if (parent && parent !== path && !(await this.exists(parent))) {
      await this.mkdir(parent, { recursive: true });
    }
  }
}

async function configureZenFs(): Promise<{ zen: ZenCore; info: BrowserTargetFileSystemInfo }> {
  if (!zenReady) {
    zenReady = initializeZenFs();
  }
  return zenReady.then((zen) => ({ zen, info: currentBackend }));
}

let currentBackend: BrowserTargetFileSystemInfo = { backend: "memory" };

async function initializeZenFs(): Promise<ZenCore> {
  const [zen, dom] = await Promise.all([
    import("@zenfs/core"),
    import("@zenfs/dom"),
  ]);

  try {
    const available = await dom.IndexedDB.isAvailable({});
    if (!available) {
      throw new Error("IndexedDB unavailable");
    }
    await zen.configureSingle({
      backend: dom.IndexedDB,
      storeName: "gsv-browser-target-v1",
    });
    currentBackend = { backend: "indexeddb" };
  } catch (error) {
    console.warn("Browser target IndexedDB filesystem unavailable, using memory", error);
    await zen.configureSingle({ backend: zen.InMemory, label: "gsv-browser-target-memory" });
    currentBackend = { backend: "memory" };
  }

  return zen;
}

function toFsStat(stat: ZenStats): FsStat {
  return {
    isFile: stat.isFile(),
    isDirectory: stat.isDirectory(),
    isSymbolicLink: stat.isSymbolicLink(),
    mode: Number(stat.mode),
    size: Number(stat.size),
    mtime: stat.mtime,
  };
}

function toUint8Array(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new TextEncoder().encode(String(data ?? ""));
}

function decodeContent(data: Uint8Array, encoding: BufferEncoding | null): string {
  switch (encoding) {
    case "base64":
      return btoa(String.fromCharCode(...data));
    case "hex":
      return Array.from(data).map((byte) => byte.toString(16).padStart(2, "0")).join("");
    case "binary":
    case "latin1":
      return String.fromCharCode(...data);
    case "ascii":
      return String.fromCharCode(...data.map((byte) => byte & 0x7f));
    case null:
    case "utf8":
    case "utf-8":
    default:
      return new TextDecoder().decode(data);
  }
}

function normalizeWriteOptions(options: BrowserWriteFileOptions | BufferEncoding | undefined): BufferEncoding | undefined {
  if (typeof options === "string") {
    return options;
  }
  return isBufferEncoding(options?.encoding) ? options.encoding : undefined;
}

function isBufferEncoding(value: unknown): value is BufferEncoding {
  return value === "utf8"
    || value === "utf-8"
    || value === "ascii"
    || value === "binary"
    || value === "base64"
    || value === "hex"
    || value === "latin1";
}

function normalizeAbsolutePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return `/${parts.join("/")}`;
}

function dirname(path: string): string {
  const normalized = normalizeAbsolutePath(path);
  if (normalized === "/") {
    return "/";
  }
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}

function walkSync(zen: ZenCore, root: string): Set<string> {
  const paths = new Set<string>();
  const visit = (path: string): void => {
    paths.add(path);
    const stat = zen.fs.statSync(path);
    if (!stat.isDirectory()) {
      return;
    }
    for (const name of zen.fs.readdirSync(path)) {
      const child = path === "/" ? `/${String(name)}` : `${path}/${String(name)}`;
      visit(child);
    }
  };
  visit(root);
  return paths;
}
