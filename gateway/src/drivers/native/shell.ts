/**
 * Native shell driver — executes bash commands inside the worker using just-bash.
 *
 * Wires up:
 * - GsvFs as the unified filesystem (R2 + virtual /proc, /dev, /sys)
 * - Network access (curl/wget) — enabled by default since Workers are sandboxed
 * - Custom OS commands (chown, id, whoami, ps, ls, stat) that use real permissions
 * - Per-identity Bash instances with proper uid/gid/env and process info
 */

import { Bash } from "just-bash";
import type { BashExecResult, NetworkConfig } from "just-bash";
import { resolveUserPath } from "../../fs";
import type { KernelContext } from "../../kernel/context";
import type { ShellExecArgs, ShellExecResult } from "../../syscalls/shell";
import {
  DEFAULT_SHELL_EXEC_TIMEOUT_MS,
  type ProcessIdentity,
} from "@humansandmachines/gsv/protocol";
import { createNativeFileSystem } from "./filesystem";
import {
  buildCustomCommands,
  type NativeShellCommandOptions,
} from "./shell/commands";

export const NATIVE_SHELL_NETWORK_CONFIG = {
  dangerouslyAllowFullInternetAccess: true,
  // just-bash enables this production guard through node:dns.lookup, which
  // Cloudflare Workers does not implement. Native gsv requests use global
  // fetch rather than a private-network binding, so let the runtime resolve
  // public hostnames instead of failing before fetch.
  denyPrivateRanges: false,
} satisfies NetworkConfig;

export const DEFAULT_NATIVE_SHELL_TIMEOUT_MS = DEFAULT_SHELL_EXEC_TIMEOUT_MS;
const JUST_BASH_EXTENSION_CLEANUP_TIME_MS = 100;
const JUST_BASH_EXECUTION_BACKSTOP_GRACE_MS = 1_000;

export async function handleShellExec(
  args: ShellExecArgs,
  ctx: KernelContext,
  options?: NativeShellCommandOptions,
): Promise<ShellExecResult> {
  const identity = ctx.identity!.process;
  if (args.sessionId) {
    return {
      status: "failed",
      output: "",
      error: "Native shell session continuation is not supported yet",
      sessionId: args.sessionId,
    };
  }

  const command = args.input;
  if (command.trim().length === 0) {
    return { status: "failed", output: "", error: "input must not be empty" };
  }

  const cwd = args.cwd
    ? resolveUserPath(args.cwd, identity.home, identity.cwd)
    : identity.cwd;
  const timeoutMs = parseInt(
    ctx.config.get("config/shell/timeout_ms") ?? String(DEFAULT_NATIVE_SHELL_TIMEOUT_MS),
    10,
  );
  const maxOutput = parseInt(
    ctx.config.get("config/shell/max_output_bytes") ?? "524288",
    10,
  );
  const timeout = args.timeout ?? timeoutMs;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return { status: "failed", output: "", error: "timeout must be a positive number" };
  }
  const bash = createBash(ctx, identity, cwd, timeout, options);
  const controller = new AbortController();

  try {
    const timer = setTimeout(() => {
      controller.abort(new Error(`Command timed out after ${timeout}ms`));
    }, timeout);
    const signal = ctx.requestSignal
      ? AbortSignal.any([controller.signal, ctx.requestSignal])
      : controller.signal;

    let result: BashExecResult;
    try {
      result = await bash.exec(command, {
        cwd,
        signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (ctx.requestSignal?.aborted) {
      return requestCancelledResult(ctx.requestSignal);
    }
    if (controller.signal.aborted) {
      return commandTimedOutResult(timeout);
    }

    const stdout = truncate(result.stdout, maxOutput);
    const stderr = truncate(result.stderr, maxOutput);
    const output = stdout + stderr;

    const truncated = stdout.length < result.stdout.length || stderr.length < result.stderr.length;
    if (result.exitCode === 0) {
      return {
        status: "completed",
        output,
        exitCode: result.exitCode,
        truncated,
        ok: true,
        pid: 0,
        stdout,
        stderr,
      };
    }

    return {
      status: "failed",
      output,
      exitCode: result.exitCode,
      error: stderr.trim().length > 0
        ? stderr.trim()
        : `Command exited with code ${result.exitCode}`,
      truncated,
      ok: true,
      pid: 0,
      stdout,
      stderr,
    };
  } catch (err) {
    if (ctx.requestSignal?.aborted) {
      return requestCancelledResult(ctx.requestSignal);
    }
    if (controller.signal.aborted) {
      return commandTimedOutResult(timeout);
    }
    if (err instanceof Error && err.name === "AbortError") {
      return commandTimedOutResult(timeout);
    }
    return { status: "failed", output: "", error: err instanceof Error ? err.message : String(err) };
  }
}

function createBash(
  ctx: KernelContext,
  identity: ProcessIdentity,
  cwd: string,
  timeoutMs: number,
  options?: NativeShellCommandOptions,
): Bash {
  const fs = createNativeFileSystem(ctx);

  const serverName = ctx.config.get("config/server/name") ?? "gsv";
  const serverVersion = ctx.config.get("config/server/version") ?? ctx.serverVersion;
  const networkEnabled = ctx.config.get("config/shell/network_enabled") !== "false";
  const maxOutput = parseInt(
    ctx.config.get("config/shell/max_output_bytes") ?? "524288",
    10,
  );

  return new Bash({
    fs,
    cwd,
    env: {
      HOME: identity.home,
      USER: identity.username,
      LOGNAME: identity.username,
      SHELL: "/bin/bash",
      PATH: "/usr/local/bin:/usr/bin:/bin",
      PWD: cwd,
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
      UID: String(identity.uid),
      GSV_PID: ctx.processId ?? "",
      GSV_INSTALLATION_ID: ctx.installationId ?? "",
      GSV_URL: ctx.installationIdentity?.canonicalOrigin ?? "",
      HOSTNAME: serverName,
      GSV_VERSION: serverVersion,
    },
    processInfo: {
      pid: identity.uid === 0 ? 1 : identity.uid,
      ppid: 0,
      uid: identity.uid,
      gid: identity.gid,
    },
    network: networkEnabled
      ? NATIVE_SHELL_NETWORK_CONFIG
      : undefined,
    executionLimits: {
      maxCommandCount: 1000,
      maxCallDepth: 64,
      maxLoopIterations: 10_000,
      maxOutputSize: maxOutput,
      maxExecutionTimeMs: timeoutMs + JUST_BASH_EXECUTION_BACKSTOP_GRACE_MS,
      maxExtensionCleanupTimeMs: JUST_BASH_EXTENSION_CLEANUP_TIME_MS,
    },
    customCommands: buildCustomCommands(fs, identity, ctx, options),
  });
}

function requestCancelledResult(signal: AbortSignal): ShellExecResult {
  return {
    status: "failed",
    output: "",
    error: signal.reason instanceof Error
      ? signal.reason.message
      : "Request cancelled",
  };
}

function commandTimedOutResult(timeoutMs: number): ShellExecResult {
  return {
    status: "failed",
    output: "",
    error: `Command timed out after ${timeoutMs}ms`,
  };
}

function truncate(str: string, maxBytes: number): string {
  if (new TextEncoder().encode(str).length <= maxBytes) return str;
  const truncated = str.slice(0, maxBytes);
  return truncated + "\n...[truncated]";
}
