import path from "node:path";

import { Bash, defineCommand } from "just-bash";

const MAX_OUTPUT_CHARS = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

function bounded(value, max = MAX_OUTPUT_CHARS) {
  const text = typeof value === "string" ? value : "";
  return text.length <= max ? text : `${text.slice(0, max - 16)}\n...[truncated]`;
}

function parsePresentationArgs(rawArgs) {
  const args = [...rawArgs];
  let title = "GSV";
  for (let index = 0; index < args.length; ++index) {
    if (args[index] === "--title") {
      if (index + 1 >= args.length) {
        throw new Error("--title requires a value");
      }
      title = args[index + 1];
      args.splice(index, 2);
      index -= 1;
    }
  }
  return { args, title };
}

function commandResult(stdout = "", stderr = "", exitCode = 0) {
  return { stdout, stderr, exitCode };
}

function gsvShowHelp() {
  return [
    "Usage:",
    "  gsv-show text [--title TITLE] [TEXT ...]",
    "  gsv-show image [--title TITLE] PATH",
    "  gsv-show clear",
    "  gsv-show status",
    "",
    "Text may also be piped on stdin. Images currently support PNG and BMP.",
  ].join("\n");
}

export class WearableShell {
  constructor({ filesystem, onPresent, getPresentation = () => ({ kind: "none" }), onActivity = () => {} }) {
    this.filesystem = filesystem;
    this.onPresent = onPresent;
    this.getPresentation = getPresentation;
    this.onActivity = onActivity;
    const show = defineCommand("gsv-show", async (rawArgs, context) => {
      const [operation = "help", ...operationArgs] = rawArgs;
      try {
        if (operation === "help" || operation === "--help" || operation === "-h") {
          return commandResult(`${gsvShowHelp()}\n`);
        }
        if (operation === "status") {
          return commandResult(`${JSON.stringify(this.getPresentation(), null, 2)}\n`);
        }
        if (operation === "clear") {
          this.onPresent({ kind: "none", title: "", body: "", path: "" });
          return commandResult("Wearable presentation cleared.\n");
        }
        const { args, title } = parsePresentationArgs(operationArgs);
        if (operation === "text") {
          const body = args.length ? args.join(" ") : context.stdin;
          if (!body?.trim()) {
            return commandResult("", "gsv-show text requires text or stdin\n", 2);
          }
          this.onPresent({ kind: "text", title, body, path: "" });
          return commandResult("Text presented on the wearable.\n");
        }
        if (operation === "image") {
          if (args.length !== 1) {
            return commandResult("", "gsv-show image requires exactly one path\n", 2);
          }
          const virtualPath = context.fs.resolvePath(context.cwd, args[0]);
          const image = await this.filesystem.resolveDisplayPath(virtualPath);
          this.onPresent({
            kind: "image",
            title,
            body: image.virtualPath,
            path: image.hostPath,
          });
          return commandResult(`Image presented from ${image.virtualPath}.\n`);
        }
        if (operation === "website" || operation === "video") {
          return commandResult(
            "",
            `${operation} rendering is not implemented; render or capture it to a PNG first\n`,
            2,
          );
        }
        return commandResult("", `Unknown gsv-show operation: ${operation}\n${gsvShowHelp()}\n`, 2);
      } catch (error) {
        return commandResult("", `${error instanceof Error ? error.message : "Presentation failed"}\n`, 1);
      }
    });

    this.bash = new Bash({
      fs: filesystem.requireFs(),
      cwd: "/home/gsv",
      env: {
        HOME: "/home/gsv",
        USER: "gsv",
        LOGNAME: "gsv",
        SHELL: "/bin/bash",
        PATH: "/usr/local/bin:/usr/bin:/bin",
        PWD: "/home/gsv",
        TERM: "xterm-256color",
        LANG: "en_US.UTF-8",
        HOSTNAME: "hdzero-g2",
      },
      processInfo: { pid: 1000, ppid: 0, uid: 1000, gid: 1000 },
      executionLimits: {
        maxCommandCount: 500,
        maxCallDepth: 32,
        maxLoopIterations: 5_000,
        maxOutputSize: MAX_OUTPUT_CHARS,
      },
      customCommands: [show],
    });
  }

  async execute(args, requestSignal) {
    if (args?.sessionId) {
      return {
        status: "failed",
        output: "",
        error: "Wearable pseudo-shell session continuation is not supported",
        sessionId: args.sessionId,
      };
    }
    const input = typeof args?.input === "string" ? args.input : "";
    if (!input.trim()) {
      return { status: "failed", output: "", error: "input must not be empty" };
    }
    if (args?.background) {
      return { status: "failed", output: "", error: "Wearable pseudo-shell background jobs are not supported" };
    }
    const cwd = typeof args?.cwd === "string" && args.cwd.trim()
      ? path.posix.resolve("/home/gsv", args.cwd)
      : "/home/gsv";
    const timeout = Number.isSafeInteger(args?.timeout) && args.timeout > 0
      ? Math.min(args.timeout, DEFAULT_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(new Error(`Command timed out after ${timeout}ms`)), timeout);
    const signal = requestSignal
      ? AbortSignal.any([requestSignal, timeoutController.signal])
      : timeoutController.signal;
    this.onActivity("Wearable pseudo-shell command");
    try {
      await this.filesystem.syncRuntimeFiles();
      const result = await this.bash.exec(input, { cwd, signal });
      const stdout = bounded(result.stdout);
      const stderr = bounded(result.stderr);
      const output = bounded(stdout + stderr);
      if (result.exitCode === 0) {
        return {
          status: "completed",
          output,
          exitCode: 0,
          ok: true,
          pid: 0,
          stdout,
          stderr,
          truncated: output.length < result.stdout.length + result.stderr.length,
        };
      }
      return {
        status: "failed",
        output,
        error: stderr.trim() || `Command exited with code ${result.exitCode}`,
        exitCode: result.exitCode,
        ok: true,
        pid: 0,
        stdout,
        stderr,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Shell command failed";
      return { status: "failed", output: "", error: message };
    } finally {
      clearTimeout(timer);
    }
  }
}
