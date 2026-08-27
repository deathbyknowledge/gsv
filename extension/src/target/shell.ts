import { Bash, defineCommand, type BashExecResult } from "just-bash/browser";
import { DEFAULT_SHELL_EXEC_TIMEOUT_MS } from "@humansandmachines/gsv/protocol";
import { abortable, throwIfAborted } from "./abort";
import { JustBashFileSystemAdapter } from "./fs-adapter";
import { decodeJustBashStdin } from "./just-bash-stdin";
import type {
  BrowserCommand,
  CommandContext,
  ShellResult,
  TargetCopyEndpoint,
  TargetFileSystem,
} from "./types";
import { commandError } from "./types";
import { commandCatalog, helpText } from "./commands";

type BrowserBash = InstanceType<typeof Bash>;

export const DEFAULT_BROWSER_SHELL_TIMEOUT_MS = DEFAULT_SHELL_EXEC_TIMEOUT_MS;
const JUST_BASH_EXTENSION_CLEANUP_TIME_MS = 100;

export type BrowserShellExecContext = {
  currentTargetId?: string;
  abortSignal?: AbortSignal;
  copyTargetFile?: (
    source: TargetCopyEndpoint,
    destination: TargetCopyEndpoint,
    signal: AbortSignal | undefined,
  ) => Promise<unknown>;
};

export class BrowserTargetShell {
  private bash: BrowserBash | null = null;
  private ready: Promise<void> | null = null;
  private activeExecContext: BrowserShellExecContext = {};
  private readonly activeCommandCompletions = new Set<Promise<void>>();
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
    let acquired = false;
    try {
      await abortable(previous, context.abortSignal);
      acquired = true;
      return await this.execLocked(args, context);
    } catch (error) {
      return failedResult(error);
    } finally {
      if (acquired) {
        // Cancellation can settle Bash before a custom command's owned work; do not let
        // the next command overlap that work while it reaches its terminal boundary.
        const completions = [...this.activeCommandCompletions];
        if (completions.length > 0) {
          void Promise.all(completions).then(() => release());
        } else {
          release();
        }
      } else {
        void previous.then(release);
      }
    }
  }

  private async execLocked(args: unknown, context: BrowserShellExecContext): Promise<ShellResult> {
    const record = asRecord(args);
    const input = typeof record.input === "string" ? record.input : "";
    const cwd = typeof record.cwd === "string" && record.cwd.trim() ? this.fs.resolvePath("/", record.cwd) : "/";
    const sessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";
    const timeoutMs = resolveShellTimeout(record.timeout);

    if (sessionId) {
      return { status: "failed", output: "", error: "Browser shell sessions are not supported yet" };
    }
    if (!input.trim()) {
      return { status: "failed", output: "", error: "shell.exec requires input" };
    }
    if (timeoutMs === null) {
      return { status: "failed", output: "", error: "shell.exec timeout must be a positive number" };
    }
    if (input.trim() === "help") {
      return { status: "completed", output: helpText(this.commands), exitCode: 0 };
    }

    await this.ensureReady();
    try {
      if (!(await this.fs.exists(cwd))) {
        await this.fs.mkdir(cwd);
      }
      throwIfAborted(context.abortSignal);
      const deadline = new AbortController();
      const timer = setTimeout(() => {
        deadline.abort(new Error(`Command timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const signal = context.abortSignal
        ? AbortSignal.any([context.abortSignal, deadline.signal])
        : deadline.signal;
      this.activeExecContext = { ...context, abortSignal: signal };
      try {
        const result = await this.requireBash().exec(input, { cwd, signal });
        throwIfAborted(signal);
        return toShellResult(result);
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      return failedResult(error);
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
      defineCommand("commands", async (args) => {
        if (args.length === 0) {
          return { stdout: helpText(this.commands), stderr: "", exitCode: 0 };
        }
        if (args.length === 1 && args[0] === "--json") {
          return { stdout: commandCatalog(this.commands), stderr: "", exitCode: 0 };
        }
        if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
          return {
            stdout: "Usage: commands [--json]\n",
            stderr: "",
            exitCode: 0,
          };
        }
        return {
          stdout: "",
          stderr: "Usage: commands [--json]\n",
          exitCode: 1,
        };
      }),
      ...this.commands.map((command) =>
        defineCommand(command.name, async (args, ctx) => {
          const commandContext: CommandContext = {
            cwd: ctx.cwd,
            stdin: decodeJustBashStdin(ctx.stdin),
            fs: this.fs,
            now: () => Date.now(),
            currentTargetId: this.activeExecContext.currentTargetId,
            abortSignal: ctx.signal ?? this.activeExecContext.abortSignal,
            copyTargetFile: this.activeExecContext.copyTargetFile,
          };
          try {
            const execution = Promise.resolve(command.run(args, commandContext));
            const completion = execution.then(
              () => undefined,
              () => undefined,
            );
            this.activeCommandCompletions.add(completion);
            void completion.then(() => this.activeCommandCompletions.delete(completion));
            return await abortable(
              execution,
              commandContext.abortSignal,
            );
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
        maxExtensionCleanupTimeMs: JUST_BASH_EXTENSION_CLEANUP_TIME_MS,
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

function failedResult(error: unknown): ShellResult {
  return {
    status: "failed",
    output: "",
    error: error instanceof Error ? error.message : String(error),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function resolveShellTimeout(value: unknown): number | null {
  if (value === undefined) return DEFAULT_BROWSER_SHELL_TIMEOUT_MS;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}
