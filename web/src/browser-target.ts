import type {
  BashExecResult,
  CustomCommand,
} from "just-bash/browser";
import type { SysTargetRegisterResult } from "@gsv/protocol/syscalls/system";
import type { AppManifest } from "./apps";
import type { GatewayClientLike, GatewayRequestFrame } from "./gateway-client";
import type { WindowManager, WindowSummary } from "./window-manager";

type BrowserTargetOptions = {
  gatewayClient: GatewayClientLike;
  windowManager: WindowManager;
};

type FsReadArgs = {
  path?: unknown;
  offset?: unknown;
  limit?: unknown;
};

type ShellExecArgs = {
  input?: unknown;
  cwd?: unknown;
  sessionId?: unknown;
  timeout?: unknown;
};

const TARGET_IMPLEMENTS = ["fs.read", "shell.exec"];
const TARGET_VERSION = "0.1.0";
const DEFAULT_TIMEOUT_MS = 30_000;

type JustBashModule = typeof import("just-bash/browser");
type BrowserInMemoryFs = InstanceType<JustBashModule["InMemoryFs"]>;
type BrowserBash = InstanceType<JustBashModule["Bash"]>;

export function createBrowserTargetProvider({
  gatewayClient,
  windowManager,
}: BrowserTargetOptions): () => void {
  let registeredConnectionId: string | null = null;
  const shell = new BrowserTargetShell(windowManager);

  const unregisterRead = gatewayClient.onRequest("fs.read", (frame) => {
    return shell.read(frame);
  });
  const unregisterShell = gatewayClient.onRequest("shell.exec", (frame) => {
    return shell.exec(frame);
  });
  const unregisterStatus = gatewayClient.onStatus((status) => {
    if (status.state !== "connected" || !status.connectionId) {
      registeredConnectionId = null;
      return;
    }
    if (registeredConnectionId === status.connectionId) {
      return;
    }
    registeredConnectionId = status.connectionId;
    void registerBrowserTarget(gatewayClient).catch((error) => {
      registeredConnectionId = null;
      console.warn("Failed to register browser target", error);
    });
  });

  return () => {
    unregisterRead();
    unregisterShell();
    unregisterStatus();
  };
}

class BrowserTargetShell {
  private fs: BrowserInMemoryFs | null = null;
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
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
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
    const fs = new justBash.InMemoryFs({
      "/README.txt": [
        "GSV browser target",
        "",
        "This is the active web shell desktop.",
        "Use standard shell commands such as ls, cat, grep, jq, head, and tail.",
        "Browser commands: windows, window, apps, app.",
        "",
      ].join("\n"),
    });
    this.fs = fs;
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
    await this.ensureDirectory("/desktop");
    await this.ensureDirectory("/home/browser");
    await this.ensureDirectory("/tmp");
    await this.refreshDynamicFiles();
  }

  private async refreshDynamicFiles(): Promise<void> {
    await this.ensureDirectory("/desktop");
    await this.writeText("/desktop/windows.json", JSON.stringify({
      windows: this.windowManager.listWindows(),
      updatedAt: new Date().toISOString(),
    }, null, 2));

    const active = this.windowManager.listWindows().find((window) => window.active) ?? null;
    await this.writeText("/desktop/active-window", active ? JSON.stringify(active, null, 2) : "");

    await this.writeText("/apps.json", JSON.stringify({
      apps: this.windowManager.listApps().map(toAppSummary),
      updatedAt: new Date().toISOString(),
    }, null, 2));
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
    let stat: Awaited<ReturnType<BrowserInMemoryFs["stat"]>> | null = null;
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

  private getFs(): BrowserInMemoryFs {
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

async function registerBrowserTarget(gatewayClient: GatewayClientLike): Promise<void> {
  await gatewayClient.call<SysTargetRegisterResult>("sys.target.register", {
    label: "Browser Shell",
    description: "The active GSV web shell desktop, windows, apps, and browser-side automation.",
    platform: "browser-shell",
    version: TARGET_VERSION,
    implements: TARGET_IMPLEMENTS,
  });
}

function buildBrowserCommands(
  windowManager: WindowManager,
  defineBrowserCommand: JustBashModule["defineCommand"],
): CustomCommand[] {
  return [
    defineBrowserCommand("windows", async (args) => {
      const subcommand = args[0] ?? "list";
      if (subcommand !== "list") {
        return commandError(`Usage: windows list`);
      }
      return commandOk(formatWindows(windowManager.listWindows()));
    }),
    defineBrowserCommand("window", async (args) => {
      return handleWindowCommand(args, windowManager);
    }),
    defineBrowserCommand("apps", async (args) => {
      const subcommand = args[0] ?? "list";
      if (subcommand !== "list") {
        return commandError(`Usage: apps list`);
      }
      return commandOk(formatApps(windowManager.listApps()));
    }),
    defineBrowserCommand("app", async (args) => {
      const subcommand = args[0] ?? "";
      if (subcommand !== "open") {
        return commandError("Usage: app open <appId> [route]");
      }
      const appId = args[1] ?? "";
      const route = args[2];
      if (!appId) {
        return commandError("Usage: app open <appId> [route]");
      }
      const windowId = windowManager.openAppById(appId, route);
      if (!windowId) {
        return commandError(`Unknown app: ${appId}`);
      }
      return commandOk(`opened ${appId} as ${windowId}\n`);
    }),
  ];
}

function handleWindowCommand(args: string[], windowManager: WindowManager): { stdout: string; stderr: string; exitCode: number } {
  const subcommand = args[0] ?? "";
  const windowId = args[1] ?? "";
  if (!subcommand || !windowId) {
    return commandError("Usage: window <focus|restore|minimize|maximize|close> <windowId>");
  }

  const exists = windowManager.listWindows().some((window) => window.windowId === windowId);
  if (!exists) {
    return commandError(`Unknown window: ${windowId}`);
  }

  switch (subcommand) {
    case "focus":
      windowManager.restoreWindow(windowId);
      windowManager.focusWindow(windowId);
      return commandOk(`focused ${windowId}\n`);
    case "restore":
      windowManager.restoreWindow(windowId);
      return commandOk(`restored ${windowId}\n`);
    case "minimize":
      windowManager.minimizeWindow(windowId);
      return commandOk(`minimized ${windowId}\n`);
    case "maximize":
      windowManager.maximizeWindow(windowId);
      return commandOk(`maximized ${windowId}\n`);
    case "close":
      windowManager.closeWindow(windowId);
      return commandOk(`closed ${windowId}\n`);
    default:
      return commandError(`Unknown window command: ${subcommand}`);
  }
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

function commandOk(stdout: string): { stdout: string; stderr: string; exitCode: number } {
  return { stdout, stderr: "", exitCode: 0 };
}

function commandError(message: string): { stdout: string; stderr: string; exitCode: number } {
  return { stdout: "", stderr: `${message}\n`, exitCode: 1 };
}

function normalizePath(path: string): string {
  const trimmed = path.trim() || "/";
  const withRoot = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withRoot.length > 1 ? withRoot.replace(/\/+$/, "") : withRoot;
}

function toAppSummary(app: AppManifest): Record<string, unknown> {
  return {
    id: app.id,
    name: app.name,
    description: app.description,
    entrypoint: app.entrypoint,
    permissions: app.permissions,
    syscalls: app.syscalls,
    windowDefaults: app.windowDefaults,
  };
}

function formatWindows(windows: WindowSummary[]): string {
  if (windows.length === 0) {
    return "no windows\n";
  }
  return [
    "WINDOW\tAPP\tMODE\tACTIVE\tTITLE\tROUTE",
    ...windows.map((window) => [
      window.windowId,
      window.appId,
      window.mode,
      window.active ? "yes" : "no",
      window.title,
      window.route,
    ].join("\t")),
  ].join("\n") + "\n";
}

function formatApps(apps: AppManifest[]): string {
  if (apps.length === 0) {
    return "no apps\n";
  }
  return [
    "APP\tNAME\tROUTE",
    ...apps.map((app) => [
      app.id,
      app.name,
      app.entrypoint.route,
    ].join("\t")),
  ].join("\n") + "\n";
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
