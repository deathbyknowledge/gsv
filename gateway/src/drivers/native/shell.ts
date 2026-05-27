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
import type { BashExecResult } from "just-bash";
import { GsvFs } from "../../fs/gsv-fs";
import {
  createHomeKnowledgeBackend,
  createPackageBackend,
  createProcessSourceBackend,
  RipgitClient,
  resolveUserPath,
} from "../../fs";
import type { KernelContext } from "../../kernel/context";
import { visiblePackageScopesForActor } from "../../kernel/packages";
import type { ShellExecArgs, ShellExecResult } from "../../syscalls/shell";
import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";
import {
  buildCustomCommands,
  type NativeShellCommandOptions,
} from "./shell/commands";

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
  const bash = createBash(ctx, identity, cwd, options);

  const timeoutMs = parseInt(
    ctx.config.get("config/shell/timeout_ms") ?? "30000",
    10,
  );
  const maxOutput = parseInt(
    ctx.config.get("config/shell/max_output_bytes") ?? "524288",
    10,
  );
  const timeout = args.timeout ?? timeoutMs;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    let result: BashExecResult;
    try {
      result = await bash.exec(command, {
        cwd,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
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
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "failed", output: "", error: `Command timed out after ${timeout}ms` };
    }
    return { status: "failed", output: "", error: err instanceof Error ? err.message : String(err) };
  }
}

function createBash(
  ctx: KernelContext,
  identity: ProcessIdentity,
  cwd: string,
  options?: NativeShellCommandOptions,
): Bash {
  const sourceBackend = createProcessSourceBackend({
    identity,
    storage: ctx.env.STORAGE,
    ripgit: ctx.env.RIPGIT ? new RipgitClient(ctx.env.RIPGIT) : null,
    packages: ctx.packages.list({ scopes: visiblePackageScopesForActor(identity) }),
    mounts: ctx.processId ? ctx.procs.getMounts(ctx.processId) : null,
    processId: ctx.processId ?? null,
    config: ctx.config,
  });
  const fs = new GsvFs(
    ctx.env.STORAGE,
    identity,
    {
      auth: ctx.auth,
      procs: ctx.procs,
      devices: ctx.devices,
      caps: ctx.caps,
      config: ctx.config,
    },
    undefined,
    sourceBackend,
    createHomeKnowledgeBackend(ctx.env.STORAGE, ctx.env.RIPGIT, identity),
    createPackageBackend(identity, ctx.packages),
  );

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
      ? { dangerouslyAllowFullInternetAccess: true }
      : undefined,
    executionLimits: {
      maxCommandCount: 1000,
      maxCallDepth: 64,
      maxLoopIterations: 10_000,
      maxOutputSize: maxOutput,
    },
    customCommands: buildCustomCommands(fs, identity, ctx, options),
  });
}


function truncate(str: string, maxBytes: number): string {
  if (new TextEncoder().encode(str).length <= maxBytes) return str;
  const truncated = str.slice(0, maxBytes);
  return truncated + "\n...[truncated]";
}
