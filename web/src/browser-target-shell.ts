import type {
  BashExecResult,
} from "just-bash/browser";
import { buildBrowserCommands, toAppSummary } from "./browser-target-commands";
import { BrowserTargetFileSystem } from "./browser-target-fs";
import type { GatewayRequestFrame } from "./gateway-client";
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

type ShellExecArgs = {
  input?: unknown;
  cwd?: unknown;
  sessionId?: unknown;
  timeout?: unknown;
};

type JustBashModule = typeof import("just-bash/browser");
type BrowserBash = InstanceType<JustBashModule["Bash"]>;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_SEARCH_MATCHES = 200;

export class BrowserTargetShell {
  private fs: BrowserTargetFileSystem | null = null;
  private bash: BrowserBash | null = null;
  private ready: Promise<void> | null = null;

  constructor(private readonly windowManager: WindowManager) {
  }

  async read(frame: GatewayRequestFrame): Promise<unknown> {
    await this.ensureReady();
    await this.refreshDynamicFiles();

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

      const content = await fs.readFile(path);
      return readText(path, content, offset, limit);
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
      await this.refreshDynamicFiles();
      return { ok: true, path: path.path };
    } catch (error) {
      return failedFs(error);
    }
  }

  async search(frame: GatewayRequestFrame): Promise<unknown> {
    await this.ensureReady();
    await this.refreshDynamicFiles();

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

  async exec(frame: GatewayRequestFrame): Promise<unknown> {
    await this.ensureReady();
    await this.refreshDynamicFiles();

    const bash = this.getBash();
    const args = (frame.args ?? {}) as ShellExecArgs;
    if (typeof args.sessionId === "string" && args.sessionId.trim()) {
      return failedShell("Browser shell sessions are not supported yet");
    }

    const input = typeof args.input === "string" ? args.input : "";
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
      await this.refreshDynamicFiles();
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
    const fs = await BrowserTargetFileSystem.create();
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
      customCommands: buildBrowserCommands(this.windowManager, justBash.defineCommand),
      executionLimits: {
        maxCommandCount: 10_000,
        maxLoopIterations: 10_000,
        maxCallDepth: 50,
      },
    });
    await this.ensureDirectory("/apps");
    await this.ensureDirectory("/home/browser");
    await this.ensureDirectory("/tmp");
    await this.ensureDirectory("/windows");
    await this.refreshDynamicFiles();
  }

  private async ensureBaseFiles(): Promise<void> {
    const fs = this.getFs();
    await this.ensureDirectory("/home/browser");
    await this.ensureDirectory("/tmp");
    await this.ensureDirectory("/desktop");
    await this.ensureDirectory("/apps");
    await this.ensureDirectory("/windows");
    await this.writeText("/README.txt", [
      "GSV browser target",
      "",
      "This target is the active GSV web shell desktop.",
      `Local filesystem backend: ${fs.info.backend}`,
      "",
      "Writable paths:",
      "- /home/browser",
      "- /tmp",
      "",
      "Live synthetic paths:",
      "- /desktop/windows.json",
      "- /desktop/active-window",
      "- /apps.json",
      "- /apps/<appId>/manifest.json",
      "- /windows/<windowId>/meta.json",
      "",
      "Shell commands: windows, window, apps, app, dom, js, plus standard just-bash commands.",
      "",
    ].join("\n"));
  }

  private async refreshDynamicFiles(): Promise<void> {
    await this.ensureDirectory("/desktop");
    await this.ensureDirectory("/apps");
    await this.ensureDirectory("/windows");
    const windows = this.windowManager.listWindows();
    const apps = this.windowManager.listApps();
    await this.writeText("/desktop/windows.json", JSON.stringify({
      windows,
      updatedAt: new Date().toISOString(),
    }, null, 2));

    const active = windows.find((window) => window.active) ?? null;
    await this.writeText("/desktop/active-window", active ? JSON.stringify(active, null, 2) : "");
    await this.writeText("/desktop/active-window.json", active ? JSON.stringify(active, null, 2) : "null\n");

    await this.writeText("/apps.json", JSON.stringify({
      apps: apps.map(toAppSummary),
      updatedAt: new Date().toISOString(),
    }, null, 2));
    await this.syncChildJsonFiles("/apps", apps.map((app) => ({
      name: app.id,
      file: "manifest.json",
      content: toAppSummary(app),
    })));
    await this.syncChildJsonFiles("/windows", windows.map((window) => ({
      name: window.windowId,
      file: "meta.json",
      content: window,
    })));
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
    let stat: Awaited<ReturnType<BrowserTargetFileSystem["stat"]>> | null = null;
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

  private async syncChildJsonFiles(
    root: string,
    entries: Array<{ name: string; file: string; content: unknown }>,
  ): Promise<void> {
    const fs = this.getFs();
    const expected = new Set(entries.map((entry) => entry.name));
    for (const name of await fs.readdir(root)) {
      const child = root === "/" ? `/${name}` : `${root}/${name}`;
      const stat = await fs.stat(child);
      if (stat.isDirectory && !expected.has(name)) {
        await fs.rm(child, { recursive: true, force: true });
      }
    }
    for (const entry of entries) {
      const dir = `${root}/${entry.name}`;
      await this.ensureDirectory(dir);
      await this.writeText(`${dir}/${entry.file}`, `${JSON.stringify(entry.content, null, 2)}\n`);
    }
  }

  private getFs(): BrowserTargetFileSystem {
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

function parsePathArg(value: unknown, syscall: string): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, error: `${syscall} requires path` };
  }
  return { ok: true, path: normalizePath(value) };
}

function readText(path: string, content: string, offset: number | null, limit: number | null): unknown {
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
    size: new TextEncoder().encode(content).byteLength,
  };
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

function looksBinary(content: string): boolean {
  return content.includes("\0");
}
