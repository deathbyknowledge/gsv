import { Bash, defineCommand, type BashExecResult } from "just-bash/browser";
import { JustBashFileSystemAdapter } from "./fs-adapter";
import type {
  BrowserCommand,
  CommandContext,
  ShellResult,
  TargetCopyEndpoint,
  TargetFileSystem,
} from "./types";
import { commandError } from "./types";
import { helpText } from "./commands";

type BrowserBash = InstanceType<typeof Bash>;

export type BrowserShellExecContext = {
  currentTargetId?: string;
  abortSignal?: AbortSignal;
  copyTargetFile?: (source: TargetCopyEndpoint, destination: TargetCopyEndpoint) => Promise<unknown>;
};

export class BrowserTargetShell {
  private bash: BrowserBash | null = null;
  private ready: Promise<void> | null = null;
  private activeExecContext: BrowserShellExecContext = {};
  private execQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly fs: TargetFileSystem,
    private readonly commands: BrowserCommand[],
  ) {}

  async exec(args: unknown, context: BrowserShellExecContext = {}): Promise<ShellResult> {
    const previous = this.execQueue;
    let release!: () => void;
    this.execQueue = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.execLocked(args, context);
    } finally {
      release();
    }
  }

  private async execLocked(args: unknown, context: BrowserShellExecContext): Promise<ShellResult> {
    const record = asRecord(args);
    const input = typeof record.input === "string" ? record.input : "";
    const cwd = typeof record.cwd === "string" && record.cwd.trim() ? this.fs.resolvePath("/", record.cwd) : "/";
    const sessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";

    if (sessionId) {
      return { status: "failed", output: "", error: "Browser shell sessions are not supported yet" };
    }
    if (!input.trim()) {
      return { status: "failed", output: "", error: "shell.exec requires input" };
    }

    await this.ensureReady();
    try {
      if (!(await this.fs.exists(cwd))) {
        await this.fs.mkdir(cwd);
      }
      this.activeExecContext = context;
      const result = await this.requireBash().exec(input, { cwd, signal: context.abortSignal });
      return toShellResult(result);
    } catch (error) {
      return {
        status: "failed",
        output: "",
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.activeExecContext = {};
    }
  }

  private async ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = this.initialize();
    }
    await this.ready;
  }

  private async initialize(): Promise<void> {
    const adapter = new JustBashFileSystemAdapter(this.fs);
    const customCommands = [
      defineCommand("help", async () => ({
        stdout: helpText(this.commands),
        stderr: "",
        exitCode: 0,
      })),
      ...this.commands.map((command) =>
        defineCommand(command.name, async (args, ctx) => {
          const commandContext: CommandContext = {
            cwd: ctx.cwd,
            stdin: ctx.stdin,
            fs: this.fs,
            now: () => Date.now(),
            currentTargetId: this.activeExecContext.currentTargetId,
            abortSignal: this.activeExecContext.abortSignal,
            copyTargetFile: this.activeExecContext.copyTargetFile,
          };
          try {
            return await command.run(args, commandContext);
          } catch (error) {
            return commandError(error instanceof Error ? error.message : String(error));
          }
        })
      ),
    ];

    this.bash = new Bash({
      fs: adapter,
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
      customCommands,
      network: {
        dangerouslyAllowFullInternetAccess: true,
        timeoutMs: 60_000,
        maxResponseSize: 50 * 1024 * 1024,
      },
      executionLimits: {
        maxCommandCount: 10_000,
        maxLoopIterations: 10_000,
        maxCallDepth: 50,
      },
    });
  }

  private requireBash(): BrowserBash {
    if (!this.bash) {
      throw new Error("Browser shell is not initialized");
    }
    return this.bash;
  }
}

function toShellResult(result: BashExecResult): ShellResult {
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.exitCode === 0) {
    return { status: "completed", output, exitCode: result.exitCode };
  }
  return {
    status: "failed",
    output,
    error: result.stderr || `Command exited ${result.exitCode}`,
    exitCode: result.exitCode,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
