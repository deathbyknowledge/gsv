import type {
  BashExecResult,
  IFileSystem,
} from "just-bash/browser";
import type {
  NotificationCreateResult,
  NotificationLevel,
} from "@gsv/protocol/syscalls/notification";
import {
  BINARY_FRAME_DATA,
  BINARY_FRAME_END,
} from "@gsv/protocol/binary-frame";
import { buildBrowserCommands } from "./browser-target-commands";
import { BrowserRuntimeFileSystem } from "./browser-runtime-fs";
import { BrowserTargetFileSystem } from "./browser-target-fs";
import type { GatewayClientLike, GatewayRequestFrame } from "./gateway-client";
import type { PreviewDirectoryEntry, PreviewWindowContent } from "./preview-window";
import type { WindowManager } from "./window-manager";

type FsReadArgs = {
  path?: unknown;
  offset?: unknown;
  limit?: unknown;
};

type FsWriteArgs = {
  path?: unknown;
  content?: unknown;
};

type FsEditArgs = {
  path?: unknown;
  oldString?: unknown;
  newString?: unknown;
  replaceAll?: unknown;
};

type FsDeleteArgs = {
  path?: unknown;
};

type FsSearchArgs = {
  query?: unknown;
  path?: unknown;
  include?: unknown;
};

type FsCopyEndpoint = {
  target?: string;
  path?: string;
};

type FsCopyArgs = {
  source?: FsCopyEndpoint;
  destination?: FsCopyEndpoint;
};

type TransferStatArgs = {
  path?: unknown;
};

type TransferReadArgs = {
  path?: unknown;
  offset?: unknown;
  length?: unknown;
  streamId?: unknown;
};

type TransferWriteArgs = {
  path?: unknown;
  offset?: unknown;
  streamId?: unknown;
  expectedSize?: unknown;
  contentType?: unknown;
  done?: unknown;
};

type TransferStatResult =
  | {
      ok: true;
      path: string;
      size: number;
      isFile: boolean;
      isDirectory: boolean;
      contentType?: string;
    }
  | { ok: false; error?: string };

type TransferReadResult =
  | {
      ok: true;
      path: string;
      offset: number;
      bytesRead: number;
      eof: boolean;
    }
  | { ok: false; error?: string };

type FsReadDirectoryResult =
  | {
      ok: true;
      path?: string;
      files: string[];
      directories: string[];
    }
  | { ok: false; error?: string };

type ShellExecArgs = {
  input?: unknown;
  cwd?: unknown;
  sessionId?: unknown;
  timeout?: unknown;
};

type ParsedOpenCommandArgs =
  | { ok: true; path: string; type?: string; title?: string }
  | { ok: false; error: string };

type JustBashModule = typeof import("just-bash/browser");
type BrowserBash = InstanceType<JustBashModule["Bash"]>;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_SEARCH_MATCHES = 200;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_TRANSFER_READ_BYTES = 1024 * 1024;
const MAX_PREVIEW_BYTES = 64 * 1024 * 1024;

export class BrowserTargetShell {
  private fs: IFileSystem | null = null;
  private bash: BrowserBash | null = null;
  private ready: Promise<void> | null = null;
  private targetId: string | null = null;
  private storageInfo: { backend: "indexeddb" | "memory" } = { backend: "memory" };

  constructor(
    private readonly windowManager: WindowManager,
    private readonly gatewayClient: GatewayClientLike,
  ) {
  }

  setTargetId(targetId: string | null): void {
    this.targetId = targetId;
  }

  dispose(): void {
    // Reserved for future browser-target resources.
  }

  warmup(): void {
    void this.ensureReady().catch((error) => {
      console.warn("Browser shell warmup failed", error);
    });
  }

  async read(frame: GatewayRequestFrame): Promise<unknown> {
    await this.ensureReady();

    const fs = this.getFs();
    const args = (frame.args ?? {}) as FsReadArgs;
    const path = normalizePath(typeof args.path === "string" ? args.path : "/");
    const offset = parseNonNegativeInteger(args.offset);
    const limit = parseNonNegativeInteger(args.limit);

    try {
      const stat = await fs.stat(path);
      if (stat.isDirectory) {
        const entries = await this.readDirectory(path);
        return {
          ok: true,
          path,
          files: entries.files,
          directories: entries.directories,
        };
      }

      const contentType = inferContentType(path);
      if (contentType.startsWith("image/")) {
        if (stat.size > MAX_IMAGE_BYTES) {
          return {
            ok: false,
            error: `Image too large (${formatSize(stat.size)}, max ${formatSize(MAX_IMAGE_BYTES)})`,
          };
        }
        const bytes = await fs.readFileBuffer(path);
        return readImage(path, bytes, contentType, stat.size);
      }
      if (!isTextContentType(contentType)) {
        return {
          ok: false,
          error: `Binary file (${contentType}, ${formatSize(stat.size)}) - not readable as text`,
        };
      }

      const content = await fs.readFile(path);
      return readText(path, content, stat.size, offset, limit);
    } catch (error) {
      return failedFs(error);
    }
  }

  async write(frame: GatewayRequestFrame): Promise<unknown> {
    await this.ensureReady();

    const args = (frame.args ?? {}) as FsWriteArgs;
    const path = parsePathArg(args.path, "fs.write");
    if (!path.ok) {
      return path;
    }
    if (typeof args.content !== "string") {
      return { ok: false, error: "fs.write requires string content" };
    }

    try {
      await this.getFs().writeFile(path.path, args.content);
      return {
        ok: true,
        path: path.path,
        size: new TextEncoder().encode(args.content).byteLength,
      };
    } catch (error) {
      return failedFs(error);
    }
  }

  async edit(frame: GatewayRequestFrame): Promise<unknown> {
    await this.ensureReady();

    const args = (frame.args ?? {}) as FsEditArgs;
    const path = parsePathArg(args.path, "fs.edit");
    if (!path.ok) {
      return path;
    }
    if (typeof args.oldString !== "string") {
      return { ok: false, error: "fs.edit requires oldString" };
    }
    if (typeof args.newString !== "string") {
      return { ok: false, error: "fs.edit requires newString" };
    }

    try {
      const content = await this.getFs().readFile(path.path);
      const count = content.split(args.oldString).length - 1;
      if (count === 0) {
        return { ok: false, error: `oldString not found in ${path.path}` };
      }
      if (args.replaceAll !== true && count > 1) {
        return {
          ok: false,
          error: `oldString found ${count} times in ${path.path}. Use replaceAll or provide more context.`,
        };
      }

      const updated = args.replaceAll === true
        ? content.replaceAll(args.oldString, args.newString)
        : content.replace(args.oldString, args.newString);
      await this.getFs().writeFile(path.path, updated);
      return {
        ok: true,
        path: path.path,
        replacements: args.replaceAll === true ? count : 1,
      };
    } catch (error) {
      return failedFs(error);
    }
  }

  async delete(frame: GatewayRequestFrame): Promise<unknown> {
    await this.ensureReady();

    const args = (frame.args ?? {}) as FsDeleteArgs;
    const path = parsePathArg(args.path, "fs.delete");
    if (!path.ok) {
      return path;
    }
    if (path.path === "/") {
      return { ok: false, error: "Refusing to delete /" };
    }

    try {
      const fs = this.getFs();
      if (!(await fs.exists(path.path))) {
        return { ok: false, error: `File not found: ${path.path}` };
      }
      await fs.rm(path.path, { force: true, recursive: true });
      return { ok: true, path: path.path };
    } catch (error) {
      return failedFs(error);
    }
  }

  async search(frame: GatewayRequestFrame): Promise<unknown> {
    await this.ensureReady();

    const args = (frame.args ?? {}) as FsSearchArgs;
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) {
      return { ok: false, error: "Search query is required." };
    }
    const root = normalizePath(typeof args.path === "string" && args.path.trim() ? args.path : "/");
    const include = typeof args.include === "string" && args.include.trim() ? args.include.trim() : null;

    try {
      const matches = [];
      const files = await this.collectFiles(root);
      for (const path of files) {
        if (!matchesInclude(path, root, include)) {
          continue;
        }
        const content = await this.getFs().readFile(path);
        if (looksBinary(content)) {
          continue;
        }
        const lines = content.split("\n");
        for (const [index, line] of lines.entries()) {
          if (!line.includes(query)) {
            continue;
          }
          matches.push({ path, line: index + 1, content: line });
          if (matches.length >= MAX_SEARCH_MATCHES) {
            return { ok: true, matches, count: matches.length, truncated: true };
          }
        }
      }
      return { ok: true, matches, count: matches.length };
    } catch (error) {
      return failedFs(error);
    }
  }

  async copy(frame: GatewayRequestFrame): Promise<unknown> {
    await this.ensureReady();

    const args = (frame.args ?? {}) as FsCopyArgs;
    const source = parseCopyEndpoint(args.source, "source");
    if (!source.ok) {
      return source;
    }
    const destination = parseCopyEndpoint(args.destination, "destination");
    if (!destination.ok) {
      return destination;
    }
    if (!this.isLocalTarget(source.target) || !this.isLocalTarget(destination.target)) {
      return {
        ok: false,
        error: `Browser fs.copy only accepts local browser endpoints`,
      };
    }

    try {
      const result = await this.copyLocalFile(source.path, destination.path);
      return {
        ok: true,
        source: { target: this.localTargetId(), path: source.path },
        destination: { target: this.localTargetId(), path: result.destination },
        size: result.size,
        contentType: inferContentType(result.destination),
      };
    } catch (error) {
      return failedFs(error);
    }
  }

  async transferStat(frame: GatewayRequestFrame): Promise<unknown> {
    await this.ensureReady();

    const args = (frame.args ?? {}) as TransferStatArgs;
    const path = parsePathArg(args.path, "fs.transfer.stat");
    if (!path.ok) {
      return path;
    }

    try {
      const stat = await this.getFs().stat(path.path);
      return {
        ok: true,
        path: path.path,
        size: stat.size,
        isFile: stat.isFile,
        isDirectory: stat.isDirectory,
        contentType: stat.isFile ? inferContentType(path.path) : undefined,
      };
    } catch (error) {
      return failedFs(error);
    }
  }

  async transferRead(frame: GatewayRequestFrame): Promise<unknown> {
    await this.ensureReady();

    const args = (frame.args ?? {}) as TransferReadArgs;
    const path = parsePathArg(args.path, "fs.transfer.read");
    if (!path.ok) {
      return path;
    }
    const offset = parseNonNegativeInteger(args.offset) ?? 0;
    const length = Math.min(parseNonNegativeInteger(args.length) ?? MAX_TRANSFER_READ_BYTES, MAX_TRANSFER_READ_BYTES);
    const streamId = parseStreamId(args.streamId);
    if (streamId === null) {
      return { ok: false, error: "fs.transfer.read requires streamId" };
    }

    try {
      const stat = await this.getFs().stat(path.path);
      if (!stat.isFile) {
        return { ok: false, error: `Not a file: ${path.path}` };
      }
      const chunk = offset >= stat.size
        ? new Uint8Array()
        : await this.readLocalChunk(path.path, offset, Math.min(length, stat.size - offset));
      this.gatewayClient.sendBinaryFrame(streamId, BINARY_FRAME_DATA | BINARY_FRAME_END, chunk);
      return {
        ok: true,
        path: path.path,
        offset,
        bytesRead: chunk.byteLength,
        eof: offset + chunk.byteLength >= stat.size,
      };
    } catch (error) {
      return failedFs(error);
    }
  }

  async transferWrite(frame: GatewayRequestFrame): Promise<unknown> {
    const args = (frame.args ?? {}) as TransferWriteArgs;
    const path = parsePathArg(args.path, "fs.transfer.write");
    if (!path.ok) {
      return path;
    }
    const offset = parseNonNegativeInteger(args.offset) ?? 0;
    const expectedSize = parseNonNegativeInteger(args.expectedSize);
    if (expectedSize === null) {
      return { ok: false, error: "fs.transfer.write requires expectedSize" };
    }
    const streamId = parseStreamId(args.streamId);
    if (streamId === null) {
      return { ok: false, error: "fs.transfer.write requires streamId" };
    }

    const binary = this.gatewayClient.waitForBinaryFrame(streamId);
    let binaryConsumed = false;
    try {
      await this.ensureReady();
      const frame = await binary;
      binaryConsumed = true;
      if ((frame.flags & BINARY_FRAME_DATA) === 0) {
        return { ok: false, error: "fs.transfer.write binary frame did not include data" };
      }
      const bytes = frame.payload;
      await this.writeLocalChunk(path.path, offset, bytes);

      if (args.done === true) {
        const stat = await this.getFs().stat(path.path);
        if (stat.size !== expectedSize) {
          return {
            ok: false,
            error: `Transfer size mismatch for ${path.path}: expected ${expectedSize}, got ${stat.size}`,
          };
        }
      }

      return {
        ok: true,
        path: path.path,
        offset,
        bytesWritten: bytes.byteLength,
        done: args.done === true,
        contentType: typeof args.contentType === "string" ? args.contentType : inferContentType(path.path),
      };
    } catch (error) {
      if (!binaryConsumed) {
        this.gatewayClient.cancelBinaryFrame(
          streamId,
          error instanceof Error ? error.message : "Binary transfer write failed",
        );
        binary.catch(() => undefined);
      }
      return failedFs(error);
    }
  }

  async exec(frame: GatewayRequestFrame): Promise<unknown> {
    const args = (frame.args ?? {}) as ShellExecArgs;
    const input = typeof args.input === "string" ? args.input : "";

    await this.ensureReady();

    const bash = this.getBash();
    if (typeof args.sessionId === "string" && args.sessionId.trim()) {
      return failedShell("Browser shell sessions are not supported yet");
    }

    if (input.trim().length === 0) {
      return failedShell("input must not be empty");
    }

    const timeoutMs = parsePositiveInteger(args.timeout) ?? DEFAULT_TIMEOUT_MS;
    const cwd = typeof args.cwd === "string" && args.cwd.trim()
      ? normalizePath(args.cwd)
      : "/";
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      await this.ensureDirectory(cwd);

      const result = await bash.exec(input, {
        cwd,
        signal: controller.signal,
      });

      return shellResult(result);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return failedShell(`Command timed out after ${timeoutMs}ms`);
      }
      return failedShell(error instanceof Error ? error.message : String(error));
    } finally {
      window.clearTimeout(timer);
    }
  }

  private async ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = this.initialize();
    }
    await this.ready;
  }

  private async initialize(): Promise<void> {
    const justBash = await import("just-bash/browser");
    const persistentFs = await BrowserTargetFileSystem.create();
    this.storageInfo = persistentFs.info;
    await cleanupLegacyRuntimePaths(persistentFs);
    const fs = new justBash.MountableFs({ base: persistentFs });
    fs.mount("/tmp", new justBash.InMemoryFs());
    fs.mount("/run/gsv", new BrowserRuntimeFileSystem(this.windowManager));
    this.fs = fs;
    await this.ensureBaseFiles();
    this.bash = new justBash.Bash({
      fs,
      cwd: "/",
      env: {
        HOME: "/home/browser",
        USER: "browser",
        LOGNAME: "browser",
        SHELL: "/bin/bash",
        PATH: "/usr/local/bin:/usr/bin:/bin",
        PWD: "/",
        TERM: "xterm-256color",
        LANG: "en_US.UTF-8",
        HOSTNAME: "browser",
      },
      processInfo: {
        pid: 1,
        ppid: 0,
        uid: 1000,
        gid: 1000,
      },
      customCommands: buildBrowserCommands(
        this.windowManager,
        justBash.defineCommand,
        (args, cwd) => this.runCopyCommand(args, cwd),
        (args, cwd, stdin) => this.runOpenCommand(args, cwd, stdin),
        (args) => this.runNotifyCommand(args),
      ),
      executionLimits: {
        maxCommandCount: 10_000,
        maxLoopIterations: 10_000,
        maxCallDepth: 50,
      },
    });
    await this.ensureDirectory("/home/browser");
    await this.ensureDirectory("/tmp");
  }

  private async ensureBaseFiles(): Promise<void> {
    await this.ensureDirectory("/home/browser");
    await this.ensureDirectory("/tmp");
    await this.writeText("/README.txt", [
      "GSV browser target",
      "",
      "This target is the active GSV web shell desktop.",
      `Local filesystem backend: ${this.storageInfo.backend}`,
      "",
      "Writable paths:",
      "- /home/browser (persistent when IndexedDB is available)",
      "- /tmp (in-memory scratch, cleared when the browser target restarts)",
      "",
      "Generated read-only runtime mount:",
      "- /run/gsv/desktop/windows.json",
      "- /run/gsv/desktop/active-window",
      "- /run/gsv/apps.json",
      "- /run/gsv/apps/<appId>/manifest.json",
      "- /run/gsv/apps/<appId>/windows.json",
      "- /run/gsv/windows/<windowId>/meta.json",
      "- /run/gsv/windows/<windowId>/{app,mode,route,title}.txt",
      "",
      "Shell commands: windows, window, apps, app, open, cp, dom, js, clipboard, notify, plus standard just-bash commands.",
      "",
    ].join("\n"));
  }

  private async readDirectory(path: string): Promise<{ files: string[]; directories: string[] }> {
    const fs = this.getFs();
    if (typeof fs.readdirWithFileTypes === "function") {
      const entries = await fs.readdirWithFileTypes(path);
      return {
        files: entries.filter((entry) => entry.isFile || entry.isSymbolicLink).map((entry) => entry.name).sort(),
        directories: entries.filter((entry) => entry.isDirectory).map((entry) => entry.name).sort(),
      };
    }

    const names = await fs.readdir(path);
    const files: string[] = [];
    const directories: string[] = [];
    for (const name of names) {
      const child = path === "/" ? `/${name}` : `${path}/${name}`;
      const stat = await fs.stat(child);
      if (stat.isDirectory) {
        directories.push(name);
      } else {
        files.push(name);
      }
    }
    return {
      files: files.sort(),
      directories: directories.sort(),
    };
  }

  private async ensureDirectory(path: string): Promise<void> {
    const fs = this.getFs();
    let stat: Awaited<ReturnType<IFileSystem["stat"]>> | null = null;
    try {
      stat = await fs.stat(path);
    } catch {
      await fs.mkdir(path, { recursive: true });
      return;
    }
    if (!stat.isDirectory) {
      throw new Error(`${path} exists and is not a directory`);
    }
  }

  private async writeText(path: string, content: string): Promise<void> {
    await this.getFs().writeFile(path, content);
  }

  private async copyLocalFile(sourcePath: string, destinationPath: string): Promise<{ destination: string; size: number }> {
    const fs = this.getFs();
    const sourceStat = await fs.stat(sourcePath);
    if (!sourceStat.isFile) {
      throw new Error(`Source is not a file: ${sourcePath}`);
    }

    let finalDestination = destinationPath;
    try {
      const destinationStat = await fs.stat(destinationPath);
      if (destinationStat.isDirectory) {
        finalDestination = joinPath(destinationPath, basename(sourcePath));
      }
    } catch {
      // Destination does not exist; copy to the requested path.
    }

    await fs.cp(sourcePath, finalDestination);
    return {
      destination: finalDestination,
      size: sourceStat.size,
    };
  }

  private async writeLocalChunk(path: string, offset: number, bytes: Uint8Array): Promise<void> {
    const fs = this.getFs();
    if (offset === 0) {
      if (fs instanceof BrowserTargetFileSystem) {
        await fs.writeFileChunk(path, offset, bytes);
      } else {
        await fs.writeFile(path, bytes);
      }
      return;
    }

    const stat = await fs.stat(path);
    if (!stat.isFile) {
      throw new Error(`Not a file: ${path}`);
    }
    if (stat.size !== offset) {
      throw new Error(`Unexpected write offset for ${path}: expected ${stat.size}, got ${offset}`);
    }
    if (fs instanceof BrowserTargetFileSystem) {
      await fs.writeFileChunk(path, offset, bytes);
      return;
    }

    const current = await fs.readFileBuffer(path);
    const next = new Uint8Array(stat.size + bytes.byteLength);
    next.set(current, 0);
    next.set(bytes, stat.size);
    await fs.writeFile(path, next);
  }

  private async readLocalChunk(path: string, offset: number, length: number): Promise<Uint8Array> {
    const fs = this.getFs();
    if (fs instanceof BrowserTargetFileSystem) {
      return fs.readFileChunk(path, offset, length);
    }
    const bytes = await fs.readFileBuffer(path);
    const end = Math.min(offset + length, bytes.byteLength);
    return offset >= bytes.byteLength ? new Uint8Array() : bytes.subarray(offset, end);
  }

  private async runOpenCommand(args: string[], cwd: string, stdin: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (hasHelpFlag(args)) {
      return {
        stdout: [
          "open [--as TYPE] [--title TITLE] [PATH]",
          "",
          "Open a file in a GSV desktop preview window.",
          "PATH may be local, gsv:/path, target:/path, or [target-with-colons]:/path.",
          "PATH may be omitted when stdin is provided.",
          "",
          "Examples:",
          "  open /tmp/report.pdf",
          "  echo '<h1>Hello</h1>' | open --as html --title Test",
          "  open rearden:/home/hank/image.png",
          "  open [browser:abc123]:/tmp/page.html",
          "",
        ].join("\n"),
        stderr: "",
        exitCode: 0,
      };
    }

    const parsed = parseOpenCommandArgs(args, { allowMissingPath: true });
    if (!parsed.ok) {
      return { stdout: "", stderr: `open: ${parsed.error}\n`, exitCode: 1 };
    }

    try {
      let path = parsed.path;
      if (!path) {
        if (!stdin) {
          return { stdout: "", stderr: "open: missing file operand\n", exitCode: 1 };
        }
        path = `/tmp/open-${Date.now()}${extensionForTypeHint(parsed.type)}`;
        await this.writeText(path, stdin);
      }

      const endpoint = this.parseShellEndpoint(path, cwd);
      const windowId = await this.openPreview(endpoint, {
        type: parsed.type,
        title: parsed.title,
      });
      return {
        stdout: `opened ${formatEndpointLabel(endpoint.target, endpoint.path)} as ${windowId}\n`,
        stderr: "",
        exitCode: 0,
      };
    } catch (error) {
      return {
        stdout: "",
        stderr: `open: ${error instanceof Error ? error.message : String(error)}\n`,
        exitCode: 1,
      };
    }
  }

  private async openPreview(endpoint: { target: string; path: string }, options: { type?: string; title?: string }): Promise<string> {
    const preview = await this.loadPreview(endpoint, options);
    return this.windowManager.openPreview(preview);
  }

  private async runNotifyCommand(args: { title: string; body?: string; level?: NotificationLevel; ttlMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    try {
      const result = await this.gatewayClient.call<NotificationCreateResult>("notification.create", {
        title: args.title,
        body: args.body,
        level: args.level,
        ttlMs: args.ttlMs,
      });
      return {
        stdout: `notified ${result.notification.notificationId}\n`,
        stderr: "",
        exitCode: 0,
      };
    } catch (error) {
      return {
        stdout: "",
        stderr: `notify: ${error instanceof Error ? error.message : String(error)}\n`,
        exitCode: 1,
      };
    }
  }

  private async loadPreview(endpoint: { target: string; path: string }, options: { type?: string; title?: string }): Promise<PreviewWindowContent> {
    if (this.isLocalTarget(endpoint.target)) {
      return this.loadLocalPreview(endpoint.path, {
        ...options,
        target: this.localTargetId(),
      });
    }
    return this.loadRemotePreview(endpoint, options);
  }

  private async loadLocalPreview(path: string, options: { target: string; type?: string; title?: string }): Promise<PreviewWindowContent> {
    const fs = this.getFs();
    const stat = await fs.stat(path);
    const sourceLabel = formatEndpointLabel(options.target, path);
    const title = normalizePreviewTitle(options.title, path, sourceLabel);

    if (stat.isDirectory) {
      const entries = await this.readDirectory(path);
      return {
        kind: "directory",
        title,
        sourceLabel,
        target: options.target,
        path,
        entries: directoryEntries(entries),
      };
    }

    if (!stat.isFile) {
      throw new Error(`Not a regular file: ${path}`);
    }
    if (stat.size > MAX_PREVIEW_BYTES) {
      throw new Error(`File too large to preview (${formatSize(stat.size)}, max ${formatSize(MAX_PREVIEW_BYTES)})`);
    }

    const bytes = await fs.readFileBuffer(path);
    return previewFromBytes({
      bytes,
      contentType: normalizePreviewContentType(options.type, inferContentType(path)),
      path,
      size: stat.size,
      sourceLabel,
      target: options.target,
      title,
      typeHint: options.type,
    });
  }

  private async loadRemotePreview(endpoint: { target: string; path: string }, options: { type?: string; title?: string }): Promise<PreviewWindowContent> {
    const stat = await this.gatewayClient.call<TransferStatResult>("fs.transfer.stat", this.withEndpointTarget(endpoint, { path: endpoint.path }));
    if (!stat.ok) {
      throw new Error(stat.error ?? `Unable to stat ${endpoint.target}:${endpoint.path}`);
    }

    const path = stat.path || endpoint.path;
    const sourceLabel = formatEndpointLabel(endpoint.target, path);
    const title = normalizePreviewTitle(options.title, path, sourceLabel);

    if (stat.isDirectory) {
      return this.loadRemoteDirectory({ target: endpoint.target, path }, title, sourceLabel);
    }
    if (!stat.isFile) {
      throw new Error(`Not a regular file: ${sourceLabel}`);
    }
    if (stat.size > MAX_PREVIEW_BYTES) {
      throw new Error(`File too large to preview (${formatSize(stat.size)}, max ${formatSize(MAX_PREVIEW_BYTES)})`);
    }

    const bytes = await this.readRemoteBytes({ target: endpoint.target, path }, stat.size);
    return previewFromBytes({
      bytes,
      contentType: normalizePreviewContentType(options.type, stat.contentType || inferContentType(path)),
      path,
      size: stat.size,
      sourceLabel,
      target: endpoint.target,
      title,
      typeHint: options.type,
    });
  }

  private async loadRemoteDirectory(endpoint: { target: string; path: string }, title: string, sourceLabel: string): Promise<PreviewWindowContent> {
    const result = await this.gatewayClient.call<FsReadDirectoryResult>("fs.read", this.withEndpointTarget(endpoint, { path: endpoint.path }));
    if (!result.ok) {
      throw new Error(result.error ?? `Unable to read directory ${sourceLabel}`);
    }
    if (!Array.isArray(result.files) || !Array.isArray(result.directories)) {
      throw new Error(`${sourceLabel} is not a directory`);
    }
    return {
      kind: "directory",
      title,
      sourceLabel,
      target: endpoint.target,
      path: result.path || endpoint.path,
      entries: directoryEntries({
        files: result.files,
        directories: result.directories,
      }),
    };
  }

  private async readRemoteBytes(endpoint: { target: string; path: string }, size: number): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let offset = 0;

    while (offset < size) {
      const streamId = this.gatewayClient.allocateBinaryStreamId();
      const binary = this.gatewayClient.waitForBinaryFrame(streamId);
      let result: TransferReadResult;
      try {
        result = await this.gatewayClient.call<TransferReadResult>("fs.transfer.read", this.withEndpointTarget(endpoint, {
          path: endpoint.path,
          offset,
          length: Math.min(MAX_TRANSFER_READ_BYTES, size - offset),
          streamId,
        }));
      } catch (error) {
        this.gatewayClient.cancelBinaryFrame(streamId, error instanceof Error ? error.message : "Remote transfer read failed");
        binary.catch(() => undefined);
        throw error;
      }
      if (!result.ok) {
        this.gatewayClient.cancelBinaryFrame(streamId, result.error ?? "Remote transfer read failed");
        binary.catch(() => undefined);
        throw new Error(result.error ?? `Unable to read ${endpoint.target}:${endpoint.path}`);
      }
      if (result.bytesRead <= 0 && !result.eof) {
        throw new Error(`Read zero bytes before EOF from ${endpoint.target}:${endpoint.path}`);
      }
      const frame = await binary;
      if ((frame.flags & BINARY_FRAME_DATA) === 0) {
        throw new Error(`fs.transfer.read from ${endpoint.target}:${endpoint.path} did not include data`);
      }
      if (result.bytesRead > 0) {
        const chunk = frame.payload;
        chunks.push(chunk);
        total += chunk.byteLength;
        offset += result.bytesRead;
      }
      if (result.eof) {
        break;
      }
    }

    const bytes = new Uint8Array(total);
    let cursor = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, cursor);
      cursor += chunk.byteLength;
    }
    return bytes;
  }

  private withEndpointTarget(endpoint: { target: string; path: string }, args: Record<string, unknown>): Record<string, unknown> {
    return endpoint.target === "gsv" ? args : { ...args, target: endpoint.target };
  }

  private async runCopyCommand(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (hasHelpFlag(args)) {
      return {
        stdout: [
          "cp SOURCE DEST",
          "",
          "Copy one file locally or across targets.",
          "Paths may be local, gsv:/path, target:/path, or [target-with-colons]:/path.",
          "",
          "Examples:",
          "  cp rearden:/home/hank/report.pdf /tmp/",
          "  cp /tmp/report.pdf gsv:/home/hank/report.pdf",
          "  cp rearden:/home/hank/report.pdf [browser:abc123]:/tmp/report.pdf",
          "",
        ].join("\n"),
        stderr: "",
        exitCode: 0,
      };
    }

    const operands = args.filter((arg) => arg !== "--");
    const unsupported = operands.find((arg) => arg.startsWith("-"));
    if (unsupported) {
      return { stdout: "", stderr: `cp: unsupported option '${unsupported}'\n`, exitCode: 1 };
    }
    if (operands.length < 2) {
      return { stdout: "", stderr: "cp: missing destination file operand\n", exitCode: 1 };
    }
    if (operands.length > 2) {
      return { stdout: "", stderr: "cp: multiple source files are not supported yet\n", exitCode: 1 };
    }

    try {
      const source = this.parseShellEndpoint(operands[0], cwd);
      const destination = this.parseShellEndpoint(operands[1], cwd);
      if (this.isLocalTarget(source.target) && this.isLocalTarget(destination.target)) {
        await this.copyLocalFile(source.path, destination.path);
        return { stdout: "", stderr: "", exitCode: 0 };
      }

      const result = await this.gatewayClient.call<{ ok: boolean; error?: string }>("fs.copy", {
        source,
        destination,
      });
      if (!result.ok) {
        return { stdout: "", stderr: `cp: ${result.error ?? "copy failed"}\n`, exitCode: 1 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (error) {
      return {
        stdout: "",
        stderr: `cp: ${error instanceof Error ? error.message : String(error)}\n`,
        exitCode: 1,
      };
    }
  }

  private parseShellEndpoint(spec: string, cwd: string): { target: string; path: string } {
    const bracket = spec.match(/^\[([^\]]+)]:(.*)$/);
    if (bracket) {
      const target = bracket[1] || this.localTargetId();
      const path = bracket[2] || ".";
      return {
        target,
        path: this.isLocalTarget(target) ? this.getFs().resolvePath(cwd, path) : path,
      };
    }

    const localTarget = this.localTargetId();
    const localPrefix = `${localTarget}:`;
    if (spec.startsWith(localPrefix)) {
      const path = spec.slice(localPrefix.length) || ".";
      return {
        target: localTarget,
        path: this.getFs().resolvePath(cwd, path),
      };
    }

    const pathSeparator = spec.lastIndexOf(":/");
    if (pathSeparator > 0) {
      const target = spec.slice(0, pathSeparator);
      const path = spec.slice(pathSeparator + 1) || ".";
      return {
        target,
        path: this.isLocalTarget(target) ? this.getFs().resolvePath(cwd, path) : path,
      };
    }

    const match = spec.match(/^([A-Za-z0-9_.-]+):(.*)$/);
    if (match) {
      const target = match[1] || "gsv";
      const path = match[2] || ".";
      return {
        target,
        path: target === "gsv" ? path : path,
      };
    }

    return {
      target: localTarget,
      path: this.getFs().resolvePath(cwd, spec),
    };
  }

  private isLocalTarget(target: string | null | undefined): boolean {
    return !target || target === "local" || target === this.localTargetId();
  }

  private localTargetId(): string {
    return this.targetId ?? "local";
  }

  private async collectFiles(path: string): Promise<string[]> {
    const fs = this.getFs();
    const stat = await fs.stat(path);
    if (!stat.isDirectory) {
      return [path];
    }
    const out: string[] = [];
    const entries = await this.readDirectory(path);
    for (const name of entries.directories) {
      const child = path === "/" ? `/${name}` : `${path}/${name}`;
      out.push(...await this.collectFiles(child));
    }
    for (const name of entries.files) {
      const child = path === "/" ? `/${name}` : `${path}/${name}`;
      const childStat = await fs.stat(child);
      if (!childStat.isDirectory) {
        out.push(child);
      }
    }
    return out.sort();
  }

  private getFs(): IFileSystem {
    if (!this.fs) {
      throw new Error("Browser shell filesystem is not ready");
    }
    return this.fs;
  }

  private getBash(): BrowserBash {
    if (!this.bash) {
      throw new Error("Browser shell is not ready");
    }
    return this.bash;
  }
}

function directoryEntries(entries: { files: string[]; directories: string[] }): PreviewDirectoryEntry[] {
  return [
    ...entries.directories.map((name) => ({ name, kind: "directory" as const })),
    ...entries.files.map((name) => ({ name, kind: "file" as const })),
  ];
}

function formatEndpointLabel(target: string, path: string): string {
  return target.includes(":") ? `[${target}]:${path}` : `${target}:${path}`;
}

async function cleanupLegacyRuntimePaths(fs: IFileSystem): Promise<void> {
  for (const path of ["/apps", "/apps.json", "/desktop", "/windows"]) {
    await fs.rm(path, { recursive: true, force: true }).catch(() => undefined);
  }
}

function normalizePreviewTitle(title: string | undefined, path: string, sourceLabel: string): string {
  const normalized = title?.trim();
  if (normalized) {
    return normalized;
  }
  return basename(path) || sourceLabel || "Preview";
}

function normalizePreviewContentType(typeHint: string | undefined, detected: string): string {
  const hint = typeHint?.trim().toLowerCase() ?? "";
  if (hint === "html") {
    return "text/html";
  }
  if (hint === "text") {
    return "text/plain";
  }
  if (hint.includes("/")) {
    return hint;
  }
  return detected;
}

function extensionForTypeHint(typeHint: string | undefined): string {
  const hint = typeHint?.trim().toLowerCase() ?? "";
  if (hint === "html" || hint === "text/html") {
    return ".html";
  }
  if (hint === "json" || hint === "application/json") {
    return ".json";
  }
  if (hint === "markdown" || hint === "md" || hint === "text/markdown") {
    return ".md";
  }
  return ".txt";
}

function previewFromBytes(input: {
  bytes: Uint8Array;
  contentType: string;
  path: string;
  size: number;
  sourceLabel: string;
  target: string;
  title: string;
  typeHint?: string;
}): PreviewWindowContent {
  const forcedKind = input.typeHint?.trim().toLowerCase() ?? "";
  const base = {
    title: input.title,
    sourceLabel: input.sourceLabel,
    target: input.target,
    path: input.path,
    contentType: input.contentType,
    size: input.size,
  };

  if (forcedKind === "html" || input.contentType === "text/html") {
    return {
      ...base,
      kind: "html",
      text: new TextDecoder().decode(input.bytes),
    };
  }

  if (
    input.contentType === "application/pdf"
    || input.contentType.startsWith("image/")
    || input.contentType.startsWith("video/")
    || input.contentType.startsWith("audio/")
  ) {
    return {
      ...base,
      kind: "blob",
      bytes: input.bytes,
      contentType: input.contentType,
    };
  }

  if ((forcedKind === "text" || isTextContentType(input.contentType)) && !looksBinaryBytes(input.bytes)) {
    return {
      ...base,
      kind: "text",
      text: new TextDecoder().decode(input.bytes),
    };
  }

  return {
    ...base,
    kind: "binary",
    contentType: input.contentType || "application/octet-stream",
  };
}

function looksBinaryBytes(bytes: Uint8Array): boolean {
  const length = Math.min(bytes.byteLength, 8192);
  for (let index = 0; index < length; index += 1) {
    if (bytes[index] === 0) {
      return true;
    }
  }
  return false;
}

function parsePathArg(value: unknown, syscall: string): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, error: `${syscall} requires path` };
  }
  return { ok: true, path: normalizePath(value) };
}

function parseStreamId(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 0xffffffff) {
    return null;
  }
  return value;
}

function parseCopyEndpoint(
  value: FsCopyEndpoint | undefined,
  name: "source" | "destination",
): { ok: true; target: string | undefined; path: string } | { ok: false; error: string } {
  if (!value || typeof value !== "object") {
    return { ok: false, error: `fs.copy requires ${name}` };
  }
  if (typeof value.path !== "string" || !value.path.trim()) {
    return { ok: false, error: `fs.copy requires ${name}.path` };
  }
  return {
    ok: true,
    target: typeof value.target === "string" && value.target.trim() ? value.target.trim() : undefined,
    path: normalizePath(value.path),
  };
}

function parseOpenCommandArgs(args: string[], options: { allowMissingPath: boolean }): ParsedOpenCommandArgs {
  let type: string | undefined;
  let title: string | undefined;
  const operands: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--") {
      operands.push(...args.slice(index + 1));
      break;
    }
    if (arg === "--as" || arg === "--type") {
      const value = args[index + 1] ?? "";
      if (!value) {
        return { ok: false, error: `${arg} requires a value` };
      }
      type = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--as=")) {
      type = arg.slice("--as=".length);
      continue;
    }
    if (arg.startsWith("--type=")) {
      type = arg.slice("--type=".length);
      continue;
    }
    if (arg === "--title") {
      const value = args[index + 1] ?? "";
      if (!value) {
        return { ok: false, error: "--title requires a value" };
      }
      title = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--title=")) {
      title = arg.slice("--title=".length);
      continue;
    }
    if (arg.startsWith("-")) {
      return { ok: false, error: `unsupported option '${arg}'` };
    }
    operands.push(arg);
  }

  if (operands.length === 0 && !options.allowMissingPath) {
    return { ok: false, error: "missing file operand" };
  }
  if (operands.length > 1) {
    return { ok: false, error: "multiple files are not supported yet" };
  }
  return {
    ok: true,
    path: operands[0] ?? "",
    type,
    title,
  };
}

function hasHelpFlag(args: readonly string[]): boolean {
  return args.some((arg) => arg === "-h" || arg === "--help");
}

function readText(path: string, content: string, size: number, offset: number | null, limit: number | null): unknown {
  const allLines = content.split("\n");
  const start = offset ?? 0;
  const count = limit ?? allLines.length;
  const selected = allLines.slice(start, start + count);
  const numbered = selected
    .map((line, index) => `${String(start + index + 1).padStart(6)}\t${line}`)
    .join("\n");

  return {
    ok: true,
    content: numbered,
    path,
    lines: selected.length,
    size,
  };
}

function readImage(path: string, bytes: Uint8Array, mimeType: string, size: number): unknown {
  return {
    ok: true,
    content: [
      {
        type: "text",
        text: `Read image ${path} [${mimeType}, ${formatSize(size)}]`,
      },
      { type: "image", data: encodeBase64Bytes(bytes), mimeType },
    ],
    path,
    size,
  };
}

function isTextContentType(contentType: string): boolean {
  const base = contentType.split(";")[0].trim().toLowerCase();
  return base.startsWith("text/")
    || base === "application/json"
    || base === "application/yaml"
    || base === "application/xml"
    || base === "application/javascript"
    || base === "application/typescript"
    || base === "application/toml";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function encodeBase64Bytes(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function failedFs(error: unknown): unknown {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

function shellResult(result: BashExecResult): unknown {
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const output = stdout + stderr;
  if (result.exitCode === 0) {
    return {
      status: "completed",
      output,
      exitCode: result.exitCode,
      ok: true,
      pid: 0,
      stdout,
      stderr,
    };
  }
  return {
    status: "failed",
    output,
    error: `Command exited with code ${result.exitCode}`,
    exitCode: result.exitCode,
    ok: true,
    pid: 0,
    stdout,
    stderr,
  };
}

function failedShell(error: string): unknown {
  return {
    status: "failed",
    output: "",
    error,
    exitCode: 1,
    ok: true,
    pid: 0,
    stdout: "",
    stderr: `${error}\n`,
  };
}

function normalizePath(path: string): string {
  const trimmed = path.trim() || "/";
  const withRoot = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const parts: string[] = [];
  for (const part of withRoot.split("/")) {
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

function parseNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.floor(value));
}

function parsePositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.floor(value);
}

function matchesInclude(path: string, root: string, include: string | null): boolean {
  if (!include) {
    return true;
  }
  const relative = path.startsWith(root === "/" ? "/" : `${root}/`)
    ? path.slice(root === "/" ? 1 : root.length + 1)
    : path.replace(/^\/+/, "");
  const regex = globToRegExp(include);
  return regex.test(relative) || regex.test(path) || regex.test(basename(path));
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (const char of pattern) {
    if (char === "*") {
      source += ".*";
    } else if (char === "?") {
      source += ".";
    } else {
      source += escapeRegExp(char);
    }
  }
  source += "$";
  return new RegExp(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
}

function basename(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function joinPath(parent: string, child: string): string {
  return parent.endsWith("/") ? `${parent}${child}` : `${parent}/${child}`;
}

function inferContentType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".txt") || lower.endsWith(".log")) return "text/plain";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  if (lower.endsWith(".css")) return "text/css";
  if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "text/javascript";
  if (lower.endsWith(".wasm")) return "application/wasm";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  return "text/plain";
}

function looksBinary(content: string): boolean {
  return content.includes("\0");
}
