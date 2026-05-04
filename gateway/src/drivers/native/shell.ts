/**
 * Native shell driver — executes bash commands inside the worker using just-bash.
 *
 * Wires up:
 * - GsvFs as the unified filesystem (R2 + virtual /proc, /dev, /sys)
 * - Network access (curl/wget) — enabled by default since Workers are sandboxed
 * - Custom OS commands (chown, id, whoami, ps, ls, stat) that use real permissions
 * - Per-identity Bash instances with proper uid/gid/env and process info
 */

import { Bash, defineCommand } from "just-bash";
import type { BashExecResult, ExecResult } from "just-bash";
import { GsvFs } from "../../fs/gsv-fs";
import type { ExtendedStat } from "../../fs/gsv-fs";
import type { AppRunnerCommandInput } from "../../app-runner";
import {
  commitProcessSourceChanges,
  createHomeKnowledgeBackend,
  createPackageBackend,
  createProcessSourceBackend,
  createWorkspaceBackend,
  diffProcessSourceChanges,
  discardProcessSourceChanges,
  getProcessSourceStatus,
  RipgitClient,
  packageSourcePathNameMap,
  packageSourcePathName,
  normalizePath,
  resolveUserPath,
} from "../../fs";
import type { KernelContext } from "../../kernel/context";
import { hasCapability } from "../../kernel/capabilities";
import {
  handlePkgAdd,
  handlePkgCheckout,
  handlePkgCreate,
  handlePkgInstall,
  handlePkgList,
  handlePkgPublicList,
  handlePkgPublicSet,
  handlePkgRemoteAdd,
  handlePkgRemoteList,
  handlePkgRemoteRemove,
  handlePkgRemove,
  handlePkgReviewApprove,
  isRepoPublic,
  resolveInstalledPackage,
} from "../../kernel/pkg";
import {
  handleRepoLog,
  handleRepoRefs,
} from "../../kernel/repo";
import {
  handleProcIpcCall,
  handleProcIpcSend,
} from "../../kernel/proc-handlers";
import {
  handleSchedulerAdd,
  handleSchedulerList,
  handleSchedulerRemove,
  handleSchedulerRun,
  handleSchedulerUpdate,
} from "../../kernel/scheduler";
import {
  packageRouteBase,
  packageScopeEquals,
  visiblePackageScopesForActor,
  type InstalledPackageRecord,
  type PackageEntrypoint,
} from "../../kernel/packages";
import {
  collectFilesystemSkillDocuments,
  listSkillFiles,
  resolveSkillDocument,
  type SkillDocument,
} from "../../kernel/skills";
import type { ShellExecArgs, ShellExecResult } from "../../syscalls/shell";
import type { SyscallName } from "../../syscalls";
import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";
import type { Frame } from "../../protocol/frames";
import { renderManualPage } from "./man-pages";
import { buildNotifyCommands } from "./notify-shell";
import { sendFrameToProcess } from "../../shared/utils";
import { CODEMODE_RUN } from "../../syscalls/constants";
import type { CodeModeRunResult } from "../../syscalls/codemode";
import type { SchedulerAddArgs, ScheduleExpression, ScheduleTarget } from "../../syscalls/scheduler";
import type { AiContextProfile } from "../../syscalls/ai";

export async function handleShellExec(
  args: ShellExecArgs,
  ctx: KernelContext,
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
  const bash = createBash(ctx, identity, cwd);

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
      error: `Command exited with code ${result.exitCode}`,
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

function createBash(ctx: KernelContext, identity: ProcessIdentity, cwd: string): Bash {
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
      workspaces: ctx.workspaces,
    },
    undefined,
    sourceBackend,
    createHomeKnowledgeBackend(ctx.env.STORAGE, ctx.env.RIPGIT, identity),
    createWorkspaceBackend(ctx.env, identity, ctx.workspaces),
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
    customCommands: buildCustomCommands(fs, identity, ctx),
  });
}


// Remove this once https://github.com/vercel-labs/just-bash/pull/150 is merged
function formatMode(mode: number, isDirectory: boolean): string {
  const type = isDirectory ? "d" : "-";
  const bits = [
    mode & 0o400 ? "r" : "-", mode & 0o200 ? "w" : "-", mode & 0o100 ? "x" : "-",
    mode & 0o040 ? "r" : "-", mode & 0o020 ? "w" : "-", mode & 0o010 ? "x" : "-",
    mode & 0o004 ? "r" : "-", mode & 0o002 ? "w" : "-", mode & 0o001 ? "x" : "-",
  ];
  return type + bits.join("");
}

function formatDate(d: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mon = months[d.getMonth()];
  const day = String(d.getDate()).padStart(2, " ");
  const now = new Date();
  const sixMonthsAgo = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
  if (d > sixMonthsAgo) {
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    return `${mon} ${day} ${h}:${m}`;
  }
  return `${mon} ${day}  ${d.getFullYear()}`;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return String(bytes);
  if (bytes < 1024 * 1024) {
    const k = bytes / 1024;
    return k < 10 ? `${k.toFixed(1)}K` : `${Math.round(k)}K`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    const m = bytes / (1024 * 1024);
    return m < 10 ? `${m.toFixed(1)}M` : `${Math.round(m)}M`;
  }
  const g = bytes / (1024 * 1024 * 1024);
  return g < 10 ? `${g.toFixed(1)}G` : `${Math.round(g)}G`;
}

function classifyIndicator(st: ExtendedStat): string {
  if (st.isDirectory) return "/";
  if (st.isSymbolicLink) return "@";
  if ((st.mode & 0o111) !== 0) return "*";
  return "";
}

type NameCache = { uid: Map<number, string>; gid: Map<number, string> };
type PackageCommandResult = {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
};
type PackageRunnerStub = {
  ensureRuntime(input: {
    packageId: string;
    packageName: string;
    routeBase: string;
    entrypointName: string;
    artifact: InstalledPackageRecord["artifact"];
    appFrame: {
      uid: number;
      username: string;
      packageId: string;
      packageName: string;
      entrypointName: string;
      routeBase: string;
      issuedAt: number;
      expiresAt: number;
    };
  }): Promise<void>;
  runCommand(input: AppRunnerCommandInput): Promise<PackageCommandResult>;
};

function loadNameCache(ctx: KernelContext, identity: ProcessIdentity): NameCache {
  const uid = new Map<number, string>();
  const gid = new Map<number, string>();
  uid.set(identity.uid, identity.username);
  uid.set(0, "root");
  gid.set(0, "root");

  for (const e of ctx.auth.getPasswdEntries()) {
    uid.set(e.uid, e.username);
  }
  for (const e of ctx.auth.getGroupEntries()) {
    gid.set(e.gid, e.name);
  }

  return { uid, gid };
}

function resolveOwner(cache: NameCache, fileUid: number, fileGid: number): { owner: string; group: string } {
  return {
    owner: cache.uid.get(fileUid) ?? String(fileUid),
    group: cache.gid.get(fileGid) ?? String(fileGid),
  };
}

function buildLsCommand(fs: GsvFs, identity: ProcessIdentity, kernelCtx: KernelContext) {
  return defineCommand("ls", async (args, ctx): Promise<ExecResult> => {
    const flags = {
      all: false, almostAll: false, long: false, human: false,
      recursive: false, reverse: false, sortSize: false, classify: false,
      dirOnly: false, sortTime: false, onePerLine: false,
    };
    const paths: string[] = [];

    for (const arg of args) {
      if (arg === "--help") {
        return { stdout: "ls [OPTION]... [FILE]...\n  -a  all\n  -A  almost-all\n  -l  long\n  -h  human-readable\n  -r  reverse\n  -R  recursive\n  -S  sort by size\n  -F  classify\n  -d  directory\n  -t  sort by time\n  -1  one per line\n", stderr: "", exitCode: 0 };
      }
      if (arg === "--") { continue; }
      if (arg.startsWith("-") && arg.length > 1 && !arg.startsWith("--")) {
        for (const ch of arg.slice(1)) {
          if (ch === "a") flags.all = true;
          else if (ch === "A") flags.almostAll = true;
          else if (ch === "l") flags.long = true;
          else if (ch === "h") flags.human = true;
          else if (ch === "R") flags.recursive = true;
          else if (ch === "r") flags.reverse = true;
          else if (ch === "S") flags.sortSize = true;
          else if (ch === "F") flags.classify = true;
          else if (ch === "d") flags.dirOnly = true;
          else if (ch === "t") flags.sortTime = true;
          else if (ch === "1") flags.onePerLine = true;
        }
        continue;
      }
      if (arg === "--all") flags.all = true;
      else if (arg === "--almost-all") flags.almostAll = true;
      else if (arg === "--human-readable") flags.human = true;
      else if (arg === "--recursive") flags.recursive = true;
      else if (arg === "--reverse") flags.reverse = true;
      else if (arg === "--classify") flags.classify = true;
      else if (arg === "--directory") flags.dirOnly = true;
      else paths.push(arg);
    }

    if (paths.length === 0) paths.push(".");

    let nameCache: NameCache | null = null;
    if (flags.long) {
      nameCache = loadNameCache(kernelCtx, identity);
    }

    let stdout = "";
    let stderr = "";
    let exitCode = 0;

    for (let i = 0; i < paths.length; i++) {
      const target = paths[i];
      if (i > 0 && stdout && !stdout.endsWith("\n\n")) stdout += "\n";

      const resolved = ctx.fs.resolvePath(ctx.cwd, target);

      if (flags.dirOnly) {
        try {
          const st = await fs.statExtended(resolved);
          if (flags.long) {
            stdout += formatLongEntry(target, st, nameCache!, flags.human, flags.classify) + "\n";
          } else {
            const suffix = flags.classify ? classifyIndicator(st) : "";
            stdout += target + suffix + "\n";
          }
        } catch {
          stderr += `ls: cannot access '${target}': No such file or directory\n`;
          exitCode = 2;
        }
        continue;
      }

      try {
        const st = await fs.statExtended(resolved);
        if (!st.isDirectory) {
          if (flags.long) {
            stdout += formatLongEntry(target, st, nameCache!, flags.human, flags.classify) + "\n";
          } else {
            const suffix = flags.classify ? classifyIndicator(st) : "";
            stdout += target + suffix + "\n";
          }
          continue;
        }
      } catch {
        stderr += `ls: cannot access '${target}': No such file or directory\n`;
        exitCode = 2;
        continue;
      }

      const result = await listDir(
        fs, resolved, target, flags, nameCache, paths.length > 1, false,
        ctx.cwd,
      );
      stdout += result.stdout;
      stderr += result.stderr;
      if (result.exitCode !== 0) exitCode = result.exitCode;
    }

    return { stdout, stderr, exitCode };
  });
}

async function listDir(
  fs: GsvFs,
  resolved: string,
  display: string,
  flags: { all: boolean; almostAll: boolean; long: boolean; human: boolean; recursive: boolean; reverse: boolean; sortSize: boolean; classify: boolean; sortTime: boolean; onePerLine: boolean },
  nameCache: NameCache | null,
  showHeader: boolean,
  isRecursive: boolean,
  cwd: string,
): Promise<ExecResult> {
  let stdout = "";
  const stderr = "";

  let entries: string[];
  try {
    entries = await fs.readdir(resolved);
  } catch {
    return { stdout: "", stderr: `ls: cannot open directory '${display}': No such file or directory\n`, exitCode: 2 };
  }

  const showAll = flags.all || flags.almostAll;
  if (!showAll) {
    entries = entries.filter(e => !e.startsWith("."));
  }
  if (flags.all && !flags.almostAll) {
    entries = [".", "..", ...entries];
  }

  type EntryInfo = { name: string; stat: ExtendedStat | null };
  const infos: EntryInfo[] = [];

  for (const name of entries) {
    if (name === "." || name === "..") {
      infos.push({ name, stat: null });
      continue;
    }
    const full = resolved === "/" ? `/${name}` : `${resolved}/${name}`;
    try {
      infos.push({ name, stat: await fs.statExtended(full) });
    } catch {
      infos.push({ name, stat: null });
    }
  }

  if (flags.sortSize) {
    const dots = infos.filter(e => e.name === "." || e.name === "..");
    const rest = infos.filter(e => e.name !== "." && e.name !== "..");
    rest.sort((a, b) => (b.stat?.size ?? 0) - (a.stat?.size ?? 0));
    infos.length = 0;
    infos.push(...dots, ...rest);
  } else if (flags.sortTime) {
    const dots = infos.filter(e => e.name === "." || e.name === "..");
    const rest = infos.filter(e => e.name !== "." && e.name !== "..");
    rest.sort((a, b) => (b.stat?.mtime?.getTime() ?? 0) - (a.stat?.mtime?.getTime() ?? 0));
    infos.length = 0;
    infos.push(...dots, ...rest);
  }

  if (flags.reverse) infos.reverse();

  if (showHeader || isRecursive) {
    stdout += `${display}:\n`;
  }

  if (flags.long) {
    stdout += `total ${infos.filter(e => e.name !== "." && e.name !== "..").length}\n`;
    for (const { name, stat: st } of infos) {
      if (name === "." || name === "..") {
        stdout += `drwxr-xr-x 1 root root     0 Jan  1 00:00 ${name}\n`;
        continue;
      }
      if (!st) {
        stdout += `?????????? ? ?    ?        ? ?          ? ${name}\n`;
        continue;
      }
      stdout += formatLongEntry(name, st, nameCache!, flags.human, flags.classify) + "\n";
    }
  } else {
    for (const { name, stat: st } of infos) {
      const suffix = flags.classify && st ? classifyIndicator(st) : (flags.classify && name === "." || name === ".." ? "/" : "");
      stdout += name + suffix + "\n";
    }
  }

  if (flags.recursive) {
    const subdirs = infos.filter(e => e.name !== "." && e.name !== ".." && e.stat?.isDirectory);
    if (flags.reverse) subdirs.reverse();
    for (const { name } of subdirs) {
      stdout += "\n";
      const subPath = resolved === "/" ? `/${name}` : `${resolved}/${name}`;
      const subDisplay = display === "." ? `./${name}` : `${display}/${name}`;
      const sub = await listDir(fs, subPath, subDisplay, flags, nameCache, true, true, cwd);
      stdout += sub.stdout;
    }
  }

  return { stdout, stderr, exitCode: 0 };
}

function formatLongEntry(
  name: string,
  st: ExtendedStat,
  nameCache: NameCache,
  humanReadable: boolean,
  classify: boolean,
): string {
  const mode = formatMode(st.mode, st.isDirectory);
  const { owner, group } = resolveOwner(nameCache, st.uid, st.gid);
  const size = humanReadable ? humanSize(st.size).padStart(5) : String(st.size).padStart(5);
  const date = formatDate(st.mtime ?? new Date(0));
  const suffix = classify ? classifyIndicator(st) : "";
  return `${mode} 1 ${owner} ${group} ${size} ${date} ${name}${suffix}`;
}

// =============================================================================
// Custom stat command — also uses real metadata
// =============================================================================

function buildStatCommand(fs: GsvFs, identity: ProcessIdentity, kernelCtx: KernelContext) {
  return defineCommand("stat", async (args, ctx): Promise<ExecResult> => {
    let format: string | null = null;
    const paths: string[] = [];

    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-c" && i + 1 < args.length) {
        format = args[++i];
      } else if (args[i] === "--help") {
        return { stdout: "stat [-c FORMAT] FILE...\n", stderr: "", exitCode: 0 };
      } else {
        paths.push(args[i]);
      }
    }

    if (paths.length === 0) {
      return { stdout: "", stderr: "stat: missing operand\n", exitCode: 1 };
    }

    let nameCache: NameCache | null = null;
    if (!format || format.includes("%U") || format.includes("%G")) {
      nameCache = loadNameCache(kernelCtx, identity);
    }

    let stdout = "";
    let stderr = "";
    let exitCode = 0;

    for (const p of paths) {
      const resolved = ctx.fs.resolvePath(ctx.cwd, p);
      try {
        const st = await fs.statExtended(resolved);
        const { owner, group } = resolveOwner(nameCache ?? { uid: new Map(), gid: new Map() }, st.uid, st.gid);

        if (format) {
          let out = format;
          out = out.replace(/%n/g, p);
          out = out.replace(/%N/g, `'${p}'`);
          out = out.replace(/%s/g, String(st.size));
          out = out.replace(/%F/g, st.isDirectory ? "directory" : "regular file");
          out = out.replace(/%a/g, st.mode.toString(8));
          out = out.replace(/%A/g, formatMode(st.mode, st.isDirectory));
          out = out.replace(/%u/g, String(st.uid));
          out = out.replace(/%U/g, owner);
          out = out.replace(/%g/g, String(st.gid));
          out = out.replace(/%G/g, group);
          stdout += out + "\n";
        } else {
          stdout += `  File: ${p}\n`;
          stdout += `  Size: ${st.size}\tBlocks: 0\t${st.isDirectory ? "directory" : "regular file"}\n`;
          stdout += `Access: (${st.mode.toString(8).padStart(4, "0")}/${formatMode(st.mode, st.isDirectory)})\tUid: (${String(st.uid).padStart(5)}/${owner})\tGid: (${String(st.gid).padStart(5)}/${group})\n`;
        }
      } catch {
        stderr += `stat: cannot statx '${p}': No such file or directory\n`;
        exitCode = 1;
      }
    }

    return { stdout, stderr, exitCode };
  });
}

// =============================================================================
// Other custom commands
// =============================================================================

type CodeModeCommandOptions = {
  code?: string;
  file?: string;
  target?: string;
  cwd?: string;
  json: boolean;
  args: unknown;
  argv: string[];
};

function buildCodeModeCommand(fs: GsvFs, identity: ProcessIdentity, kernelCtx: KernelContext) {
  return defineCommand("codemode", async (commandArgs, bashCtx): Promise<ExecResult> => {
    try {
      const options = parseCodeModeCommandArgs(commandArgs);

      if (!options.code && !options.file) {
        return { stdout: codeModeUsage(), stderr: "", exitCode: 0 };
      }

      requireCommandCapability(kernelCtx, CODEMODE_RUN);
      const code = options.code ?? await readCodeModeScript(fs, bashCtx.cwd, options.file!);
      const pid = await ensureCodeModeProcess(identity, kernelCtx);
      const cwd = resolveCodeModeCwd(options.cwd, options.target, bashCtx.cwd, identity);
      const response = await sendFrameToProcess(pid, {
        type: "req",
        id: crypto.randomUUID(),
        call: CODEMODE_RUN,
        args: {
          pid,
          code,
          target: options.target,
          cwd,
          argv: options.argv,
          args: options.args,
        },
      });

      if (!response || response.type !== "res") {
        return {
          stdout: "",
          stderr: "codemode: process did not return a response\n",
          exitCode: 1,
        };
      }
      if (!response.ok) {
        return {
          stdout: "",
          stderr: `codemode: ${response.error.message}\n`,
          exitCode: 1,
        };
      }

      return formatCodeModeCommandResult(response.data as CodeModeRunResult, options.json);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { stdout: "", stderr: `codemode: ${message}\n`, exitCode: 1 };
    }
  });
}

function parseCodeModeCommandArgs(args: string[]): CodeModeCommandOptions {
  const parsed: CodeModeCommandOptions = {
    json: false,
    args: null,
    argv: [],
  };
  const commandArgs = args[0] === "run" ? args.slice(1) : args;
  let passthrough = false;

  for (let index = 0; index < commandArgs.length; index += 1) {
    const current = commandArgs[index];
    if (passthrough) {
      parsed.argv.push(current);
      continue;
    }
    if (current === "--") {
      passthrough = true;
      continue;
    }
    if (current === "--help" || current === "-h") {
      parsed.code = "";
      parsed.file = "";
      return parsed;
    }
    if (current === "--json") {
      parsed.json = true;
      continue;
    }
    if (current === "-e" || current === "--eval") {
      index += 1;
      parsed.code = requireCodeModeOptionValue(commandArgs[index], current);
      continue;
    }
    if (current === "--target") {
      index += 1;
      parsed.target = requireCodeModeOptionValue(commandArgs[index], current);
      continue;
    }
    if (current === "--cwd") {
      index += 1;
      parsed.cwd = requireCodeModeOptionValue(commandArgs[index], current);
      continue;
    }
    if (current === "--arg") {
      index += 1;
      parsed.args = mergeCodeModeArg(parsed.args, requireCodeModeOptionValue(commandArgs[index], current));
      continue;
    }
    if (current === "--args-json") {
      index += 1;
      parsed.args = JSON.parse(requireCodeModeOptionValue(commandArgs[index], current));
      continue;
    }
    if (!parsed.file && parsed.code === undefined) {
      parsed.file = current;
      continue;
    }
    parsed.argv.push(current);
  }

  if (parsed.code !== undefined && parsed.file) {
    throw new Error("use either -e/--eval or a script file, not both");
  }
  return parsed;
}

function requireCodeModeOptionValue(value: string | undefined, option: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function mergeCodeModeArg(existing: unknown, spec: string): Record<string, unknown> {
  const args = existing && typeof existing === "object" && !Array.isArray(existing)
    ? { ...(existing as Record<string, unknown>) }
    : {};
  const eq = spec.indexOf("=");
  if (eq <= 0) {
    throw new Error("--arg requires key=value");
  }
  args[spec.slice(0, eq)] = spec.slice(eq + 1);
  return args;
}

async function readCodeModeScript(fs: GsvFs, cwd: string, file: string): Promise<string> {
  const path = fs.resolvePath(cwd, file);
  return await fs.readFile(path);
}

async function ensureCodeModeProcess(
  identity: ProcessIdentity,
  ctx: KernelContext,
): Promise<string> {
  const ensured = ctx.procs.ensureInit(identity);
  if (ensured.created) {
    const response = await sendFrameToProcess(ensured.pid, {
      type: "req",
      id: crypto.randomUUID(),
      call: "proc.setidentity",
      args: {
        pid: ensured.pid,
        identity,
        profile: "init",
      },
    });
    if (!response || response.type !== "res" || !response.ok) {
      throw new Error("failed to initialize CodeMode process");
    }
  }
  return ensured.pid;
}

function resolveCodeModeCwd(
  cwd: string | undefined,
  target: string | undefined,
  shellCwd: string,
  identity: ProcessIdentity,
): string | undefined {
  if (cwd) {
    return target && target !== "gsv"
      ? cwd
      : resolveUserPath(cwd, identity.home, shellCwd);
  }
  return target && target !== "gsv" ? undefined : shellCwd;
}

function formatCodeModeCommandResult(result: CodeModeRunResult, json: boolean): ExecResult {
  if (json) {
    return {
      stdout: `${JSON.stringify(result, null, 2)}\n`,
      stderr: "",
      exitCode: result.status === "completed" ? 0 : 1,
    };
  }

  const logs = result.logs && result.logs.length > 0
    ? `${result.logs.join("\n")}\n`
    : "";
  if (result.status === "failed") {
    return {
      stdout: "",
      stderr: `${logs}${result.error}\n`,
      exitCode: 1,
    };
  }

  return {
    stdout: formatCodeModeValue(result.result),
    stderr: logs,
    exitCode: 0,
  };
}

function formatCodeModeValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value.endsWith("\n") ? value : `${value}\n`;
  }
  return `${JSON.stringify(value, null, 2)}\n`;
}

function codeModeUsage(): string {
  return [
    "codemode <script.js> [options] [-- argv...]",
    "codemode run <script.js> [options] [-- argv...]",
    "codemode -e <code> [options] [-- argv...]",
    "",
    "Options:",
    "  --target <device>   default target for shell/fs calls",
    "  --cwd <path>        default cwd for shell calls and relative fs paths",
    "  --json              print the full CodeMode result envelope",
    "  --arg key=value     expose scalar args[key] to the script",
    "  --args-json <json>  expose structured args to the script",
    "",
  ].join("\n");
}

function buildCustomCommands(
  fs: GsvFs,
  identity: ProcessIdentity,
  ctx: KernelContext,
) {
  const whoami = defineCommand("whoami", async (): Promise<ExecResult> => ({
    stdout: identity.username + "\n",
    stderr: "",
    exitCode: 0,
  }));

  const id = defineCommand("id", async (): Promise<ExecResult> => ({
    stdout: `uid=${identity.uid}(${identity.username}) gid=${identity.gid} groups=${identity.gids.join(",")}\n`,
    stderr: "",
    exitCode: 0,
  }));

  const hostname = defineCommand("hostname", async (): Promise<ExecResult> => ({
    stdout: (ctx.config.get("config/server/name") ?? "gsv") + "\n",
    stderr: "",
    exitCode: 0,
  }));

  const uname = defineCommand("uname", async (args): Promise<ExecResult> => {
    const name = ctx.config.get("config/server/name") ?? "gsv";
    const ver = ctx.config.get("config/server/version") ?? "0.1.2";
    const flag = args[0] ?? "";
    if (flag.includes("a") || flag === "-a") {
      return { stdout: `GSV ${name} ${ver} #1 cloudflare-worker\n`, stderr: "", exitCode: 0 };
    }
    if (flag.includes("r") || flag === "-r") {
      return { stdout: ver + "\n", stderr: "", exitCode: 0 };
    }
    return { stdout: "GSV\n", stderr: "", exitCode: 0 };
  });

  const chown = defineCommand("chown", async (args): Promise<ExecResult> => {
    if (identity.uid !== 0) {
      return { stdout: "", stderr: "chown: Operation not permitted\n", exitCode: 1 };
    }
    if (args.length < 2) {
      return { stdout: "", stderr: "chown: missing operand\n", exitCode: 1 };
    }

    const ownerSpec = args[0];
    const targets = args.slice(1);

    const parts = ownerSpec.split(":");
    const newUid = parts[0] ? parseInt(parts[0], 10) : undefined;
    const newGid = parts.length > 1 && parts[1] ? parseInt(parts[1], 10) : undefined;

    if ((newUid !== undefined && isNaN(newUid)) || (newGid !== undefined && isNaN(newGid))) {
      return { stdout: "", stderr: `chown: invalid user: '${ownerSpec}'\n`, exitCode: 1 };
    }

    try {
      for (const target of targets) {
        await fs.chown(target, newUid, newGid);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { stdout: "", stderr: `chown: ${msg}\n`, exitCode: 1 };
    }
  });

  const chmod = defineCommand("chmod", async (args): Promise<ExecResult> => {
    if (args.length < 2) {
      return { stdout: "", stderr: "chmod: missing operand\n", exitCode: 1 };
    }

    const modeStr = args[0];
    const targets = args.slice(1);
    const mode = parseInt(modeStr, 8);

    if (isNaN(mode) || mode < 0 || mode > 0o777) {
      return { stdout: "", stderr: `chmod: invalid mode: '${modeStr}'\n`, exitCode: 1 };
    }

    try {
      for (const target of targets) {
        await fs.chmod(target, mode);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { stdout: "", stderr: `chmod: ${msg}\n`, exitCode: 1 };
    }
  });

  const ps = defineCommand("ps", async (): Promise<ExecResult> => {
    const procs = ctx.procs;
    if (!procs) {
      return { stdout: "PID\tSTATE\tLABEL\n", stderr: "", exitCode: 0 };
    }

    const list = procs.list();
    const lines = ["PID\tSTATE\tLABEL"];
    for (const proc of list) {
      lines.push(`${proc.processId}\t${proc.state}\t${proc.label ?? ""}`);
    }
    return { stdout: lines.join("\n") + "\n", stderr: "", exitCode: 0 };
  });

  const man = defineCommand("man", async (args): Promise<ExecResult> => {
    const page = renderManualPage(args[0]);
    if (!page) {
      const topic = String(args[0] ?? "").trim();
      return {
        stdout: "",
        stderr: `man: no manual entry for ${topic || "that topic"}\n`,
        exitCode: 1,
      };
    }
    return {
      stdout: `${page.endsWith("\n") ? page : `${page}\n`}`,
      stderr: "",
      exitCode: 0,
    };
  });

  const ls = buildLsCommand(fs, identity, ctx);
  const stat = buildStatCommand(fs, identity, ctx);
  const codemode = buildCodeModeCommand(fs, identity, ctx);
  const pkg = buildPkgCommand(ctx);
  const skills = buildSkillsCommand(fs, ctx, identity);
  const proc = buildProcCommand(ctx);
  const sched = buildSchedCommand(ctx);
  const notifyCommands = buildNotifyCommands(ctx);
  const packageCommands = buildPackageCommands(identity, ctx);

  return [
    whoami,
    id,
    hostname,
    uname,
    chown,
    chmod,
    ps,
    man,
    ls,
    stat,
    codemode,
    proc,
    sched,
    pkg,
    skills,
    ...notifyCommands,
    ...packageCommands,
  ];
}

function buildPackageCommands(identity: ProcessIdentity, ctx: KernelContext) {
  const commands = [];
  const reserved = new Set([
    "pkg",
    "proc",
    "sched",
    "mem",
    "notify",
    "whoami",
    "id",
    "hostname",
    "uname",
    "chown",
    "chmod",
    "ps",
    "man",
    "ls",
    "stat",
    "wiki",
    "skills",
    "codemode",
  ]);
  const packageRecords = ctx.packages.list({
    enabled: true,
    scopes: visiblePackageScopesForActor(identity),
  });

  for (const record of packageRecords) {
    if (!isBuiltinWikiPackage(record)) continue;
    const wikiEntrypoint = record.manifest.entrypoints.find((entrypoint) =>
      entrypoint.kind === "command" && entrypoint.command?.trim() === "wiki"
    );
    if (wikiEntrypoint) {
      commands.push(buildPackageCommand("wiki", record, wikiEntrypoint, identity, ctx));
    }
    break;
  }

  for (const record of packageRecords) {
    for (const entrypoint of record.manifest.entrypoints) {
      if (entrypoint.kind !== "command") continue;
      const commandName = entrypoint.command?.trim();
      if (!commandName || reserved.has(commandName)) continue;
      reserved.add(commandName);
      commands.push(buildPackageCommand(commandName, record, entrypoint, identity, ctx));
    }
  }

  return commands;
}

function buildPackageCommand(
  commandName: string,
  record: InstalledPackageRecord,
  entrypoint: PackageEntrypoint,
  identity: ProcessIdentity,
  ctx: KernelContext,
) {
  return defineCommand(commandName, async (args, bashCtx): Promise<ExecResult> => {
    try {
      const result = await runPackageCommand(record, entrypoint, args, bashCtx.cwd, identity, ctx);
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.exitCode ?? 0,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        stdout: "",
        stderr: `${commandName}: ${message}\n`,
        exitCode: 1,
      };
    }
  });
}

function isBuiltinWikiPackage(record: InstalledPackageRecord): boolean {
  return record.packageId.startsWith("builtin:wiki@") && record.manifest.name === "wiki";
}

function buildPkgCommand(ctx: KernelContext) {
  return defineCommand("pkg", async (args, bashCtx): Promise<ExecResult> => {
    try {
      return await runPkgCommand(args, ctx, bashCtx.cwd);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        stdout: "",
        stderr: `pkg: ${message}\n`,
        exitCode: 1,
      };
    }
  });
}

function buildSkillsCommand(fs: GsvFs, ctx: KernelContext, identity: ProcessIdentity) {
  return defineCommand("skills", async (args): Promise<ExecResult> => {
    try {
      return await runSkillsCommand(args, fs, ctx, identity);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        stdout: "",
        stderr: `skills: ${message}\n`,
        exitCode: 1,
      };
    }
  });
}

function buildProcCommand(ctx: KernelContext) {
  return defineCommand("proc", async (args): Promise<ExecResult> => {
    try {
      return await runProcCommand(args, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        stdout: "",
        stderr: `proc: ${message}\n`,
        exitCode: 1,
      };
    }
  });
}

function buildSchedCommand(ctx: KernelContext) {
  return defineCommand("sched", async (args): Promise<ExecResult> => {
    try {
      return await runSchedCommand(args, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        stdout: "",
        stderr: `sched: ${message}\n`,
        exitCode: 1,
      };
    }
  });
}

async function runProcCommand(args: string[], ctx: KernelContext): Promise<ExecResult> {
  const [subcommand = "help", ...rest] = args;

  switch (subcommand) {
    case "help":
    case "--help":
    case "-h":
      return { stdout: procUsage(), stderr: "", exitCode: 0 };
    case "self": {
      if (!ctx.processId) {
        return { stdout: "", stderr: "proc self: no current process\n", exitCode: 1 };
      }
      return { stdout: `${ctx.processId}\n`, stderr: "", exitCode: 0 };
    }
    case "list": {
      requireCommandCapability(ctx, "proc.list");
      const list = ctx.procs.list(ctx.identity!.process.uid);
      const lines = ["PID\tSTATE\tPROFILE\tLABEL"];
      for (const proc of list) {
        lines.push(`${proc.processId}\t${proc.state}\t${proc.profile}\t${proc.label ?? ""}`);
      }
      return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
    }
    case "segments": {
      requireCommandCapability(ctx, "proc.conversation.segments");
      const parsed = parseProcSegmentsCommand(rest, ctx);
      const result = await runProcConversationSyscall(ctx, parsed.pid, "proc.conversation.segments", {
        pid: parsed.pid,
        conversationId: parsed.conversationId,
      });
      if (!result.ok) {
        return { stdout: "", stderr: `proc segments: ${result.error}\n`, exitCode: 1 };
      }
      const lines = ["ID\tGEN\tFROM\tTO\tSUMMARY\tARCHIVE"];
      for (const segment of result.segments) {
        lines.push([
          segment.id,
          String(segment.generation),
          String(segment.fromMessageId),
          String(segment.toMessageId),
          segment.summaryMessageId === null ? "-" : String(segment.summaryMessageId),
          segment.archivePath,
        ].join("\t"));
      }
      return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
    }
    case "policy": {
      const parsed = parseProcPolicyCommand(rest, ctx);
      const call = parsed.set
        ? "proc.conversation.policy.set"
        : "proc.conversation.policy.get";
      requireCommandCapability(ctx, call);
      const result = await runProcConversationSyscall(ctx, parsed.pid, call, parsed);
      if (!result.ok) {
        return { stdout: "", stderr: `proc policy: ${result.error}\n`, exitCode: 1 };
      }
      const policy = result.policy;
      return {
        stdout: [
          `conversation=${policy.conversationId}`,
          `overflow=${policy.overflow}`,
          `compact_at=${policy.compactAtPressure}`,
          `keep_last=${policy.keepLast}`,
        ].join(" ") + "\n",
        stderr: "",
        exitCode: 0,
      };
    }
    case "segment": {
      requireCommandCapability(ctx, "proc.conversation.segment.read");
      const parsed = parseProcSegmentReadCommand(rest, ctx);
      const result = await runProcConversationSyscall(ctx, parsed.pid, "proc.conversation.segment.read", parsed);
      if (!result.ok) {
        return { stdout: "", stderr: `proc segment: ${result.error}\n`, exitCode: 1 };
      }
      return {
        stdout: formatProcSegmentReadResult(result, parsed.json),
        stderr: "",
        exitCode: 0,
      };
    }
    case "compact": {
      requireCommandCapability(ctx, "proc.conversation.compact");
      const parsed = parseProcCompactCommand(rest, ctx);
      const result = await runProcConversationSyscall(ctx, parsed.pid, "proc.conversation.compact", parsed);
      if (!result.ok) {
        return { stdout: "", stderr: `proc compact: ${result.error}\n`, exitCode: 1 };
      }
      return {
        stdout: [
          `segment_id=${result.segment.id}`,
          `archived=${result.archivedMessages}`,
          `archive=${result.archivedTo}`,
          `summary_message_id=${result.summaryMessageId}`,
        ].join(" ") + "\n",
        stderr: "",
        exitCode: 0,
      };
    }
    case "fork": {
      requireCommandCapability(ctx, "proc.conversation.fork");
      const parsed = parseProcForkCommand(rest, ctx);
      const result = await runProcConversationSyscall(ctx, parsed.pid, "proc.conversation.fork", parsed);
      if (!result.ok) {
        return { stdout: "", stderr: `proc fork: ${result.error}\n`, exitCode: 1 };
      }
      return {
        stdout: [
          `conversation_id=${result.targetConversation.id}`,
          `restored=${result.restoredMessages}`,
          `segment_id=${result.segment.id}`,
          `included_live_suffix=${result.includedLiveSuffix}`,
        ].join(" ") + "\n",
        stderr: "",
        exitCode: 0,
      };
    }
    case "send": {
      requireCommandCapability(ctx, "proc.ipc.send");
      const parsed = parseProcMessageCommand(rest, false);
      const result = await handleProcIpcSend(parsed, ctx);
      if (!result.ok) {
        return { stdout: "", stderr: `proc send: ${result.error}\n`, exitCode: 1 };
      }
      return {
        stdout: `accepted run_id=${result.runId} queued=${result.queued === true}\n`,
        stderr: "",
        exitCode: 0,
      };
    }
    case "call": {
      requireCommandCapability(ctx, "proc.ipc.call");
      const parsed = parseProcMessageCommand(rest, true);
      const result = await handleProcIpcCall(parsed, ctx);
      if (!result.ok) {
        return { stdout: "", stderr: `proc call: ${result.error}\n`, exitCode: 1 };
      }
      return {
        stdout: [
          `call_id=${result.callId}`,
          `run_id=${result.runId}`,
          `queued=${result.queued === true}`,
          `deadline=${new Date(result.deadlineAt).toISOString()}`,
        ].join(" ") + "\n",
        stderr: "",
        exitCode: 0,
      };
    }
    default:
      return { stdout: "", stderr: `proc: unknown command: ${subcommand}\n${procUsage()}`, exitCode: 1 };
  }
}

async function runProcConversationSyscall(
  ctx: KernelContext,
  pid: string,
  call: SyscallName,
  args: Record<string, unknown>,
): Promise<any> {
  const identity = ctx.identity!;
  const proc = ctx.procs.get(pid);
  if (!proc) {
    throw new Error(`Process not found: ${pid}`);
  }
  if (proc.uid !== identity.process.uid && identity.process.uid !== 0) {
    throw new Error(`Permission denied: cannot access process ${pid}`);
  }

  const frame = {
    type: "req",
    id: crypto.randomUUID(),
    call,
    args,
  } as Frame;
  const response = await sendFrameToProcess(pid, frame);
  if (!response || response.type !== "res") {
    throw new Error("invalid process response");
  }
  if (!response.ok) {
    throw new Error(response.error.message);
  }
  return response.data;
}

function parseProcSegmentsCommand(args: string[], ctx: KernelContext): {
  pid: string;
  conversationId?: string;
} {
  const parsed = parseProcConversationOptions(args, ctx);
  if (parsed.positional.length > 0) {
    throw new Error(`unexpected argument: ${parsed.positional[0]}`);
  }
  return {
    pid: parsed.pid,
    ...(parsed.conversationId ? { conversationId: parsed.conversationId } : {}),
  };
}

function parseProcPolicyCommand(args: string[], ctx: KernelContext): {
  pid: string;
  conversationId?: string;
  overflow?: string;
  compactAtPressure?: number;
  keepLast?: number;
  set: boolean;
} {
  let pid: string | undefined;
  let conversationId: string | undefined;
  let overflow: string | undefined;
  let compactAtPressure: number | undefined;
  let keepLast: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--pid") {
      index += 1;
      pid = requireProcOptionValue(args[index], current);
      continue;
    }
    if (current === "--conversation") {
      index += 1;
      conversationId = requireProcOptionValue(args[index], current);
      continue;
    }
    if (current === "--overflow") {
      index += 1;
      overflow = requireProcOptionValue(args[index], current);
      continue;
    }
    if (current === "--compact-at") {
      index += 1;
      compactAtPressure = parsePressureShellNumber(requireProcOptionValue(args[index], current), current);
      continue;
    }
    if (current === "--keep-last") {
      index += 1;
      keepLast = parseNonNegativeShellInteger(requireProcOptionValue(args[index], current), current);
      continue;
    }
    throw new Error(`unexpected argument: ${current}`);
  }

  return {
    pid: pid ?? requireCurrentProcessId(ctx),
    ...(conversationId ? { conversationId } : {}),
    ...(overflow ? { overflow } : {}),
    ...(compactAtPressure !== undefined ? { compactAtPressure } : {}),
    ...(keepLast !== undefined ? { keepLast } : {}),
    set: overflow !== undefined || compactAtPressure !== undefined || keepLast !== undefined,
  };
}

function parseProcSegmentReadCommand(args: string[], ctx: KernelContext): {
  pid: string;
  conversationId?: string;
  segmentId: string;
  limit?: number;
  offset?: number;
  json?: boolean;
} {
  let pid: string | undefined;
  let conversationId: string | undefined;
  let limit: number | undefined;
  let offset: number | undefined;
  let json = false;
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--pid") {
      index += 1;
      pid = requireProcOptionValue(args[index], current);
      continue;
    }
    if (current === "--conversation") {
      index += 1;
      conversationId = requireProcOptionValue(args[index], current);
      continue;
    }
    if (current === "--limit") {
      index += 1;
      limit = parsePositiveShellInteger(requireProcOptionValue(args[index], current), current);
      continue;
    }
    if (current === "--offset") {
      index += 1;
      offset = parseNonNegativeShellInteger(requireProcOptionValue(args[index], current), current);
      continue;
    }
    if (current === "--json") {
      json = true;
      continue;
    }
    positional.push(current);
  }

  const segmentId = positional.shift();
  if (!segmentId) {
    throw new Error("missing segment id");
  }
  if (positional.length > 0) {
    throw new Error(`unexpected argument: ${positional[0]}`);
  }

  return {
    pid: pid ?? requireCurrentProcessId(ctx),
    segmentId,
    ...(conversationId ? { conversationId } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(offset !== undefined ? { offset } : {}),
    ...(json ? { json } : {}),
  };
}

function parseProcCompactCommand(args: string[], ctx: KernelContext): {
  pid: string;
  conversationId?: string;
  summary?: string;
  generateSummary?: boolean;
  keepLast?: number;
  throughMessageId?: number;
} {
  let pid: string | undefined;
  let conversationId: string | undefined;
  let summary: string | undefined;
  let generateSummary = false;
  let keepLast: number | undefined;
  let throughMessageId: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--pid") {
      index += 1;
      pid = requireProcOptionValue(args[index], current);
      continue;
    }
    if (current === "--conversation") {
      index += 1;
      conversationId = requireProcOptionValue(args[index], current);
      continue;
    }
    if (current === "--summary") {
      index += 1;
      summary = requireProcOptionValue(args[index], current);
      continue;
    }
    if (current === "--generate-summary") {
      generateSummary = true;
      continue;
    }
    if (current === "--keep-last") {
      index += 1;
      keepLast = parseNonNegativeShellInteger(requireProcOptionValue(args[index], current), current);
      continue;
    }
    if (current === "--through-message-id") {
      index += 1;
      throughMessageId = parsePositiveShellInteger(requireProcOptionValue(args[index], current), current);
      continue;
    }
    throw new Error(`unexpected argument: ${current}`);
  }

  if (summary && generateSummary) {
    throw new Error("use either --summary or --generate-summary, not both");
  }
  if ((keepLast === undefined) === (throughMessageId === undefined)) {
    throw new Error("provide exactly one of --keep-last or --through-message-id");
  }

  return {
    pid: pid ?? requireCurrentProcessId(ctx),
    ...(conversationId ? { conversationId } : {}),
    ...(summary ? { summary } : { generateSummary: true }),
    ...(keepLast !== undefined ? { keepLast } : {}),
    ...(throughMessageId !== undefined ? { throughMessageId } : {}),
  };
}

function parseProcForkCommand(args: string[], ctx: KernelContext): {
  pid: string;
  conversationId?: string;
  segmentId?: string;
  throughMessageId?: number;
  targetConversationId?: string;
  title?: string;
  includeLiveSuffix?: boolean;
} {
  let pid: string | undefined;
  let conversationId: string | undefined;
  let throughMessageId: number | undefined;
  let targetConversationId: string | undefined;
  let title: string | undefined;
  let includeLiveSuffix = true;
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--pid") {
      index += 1;
      pid = requireProcOptionValue(args[index], current);
      continue;
    }
    if (current === "--conversation") {
      index += 1;
      conversationId = requireProcOptionValue(args[index], current);
      continue;
    }
    if (current === "--message-id") {
      index += 1;
      throughMessageId = parsePositiveShellInteger(requireProcOptionValue(args[index], current), current);
      continue;
    }
    if (current === "--target") {
      index += 1;
      targetConversationId = requireProcOptionValue(args[index], current);
      continue;
    }
    if (current === "--title") {
      index += 1;
      title = requireProcOptionValue(args[index], current);
      continue;
    }
    if (current === "--segment-only") {
      includeLiveSuffix = false;
      continue;
    }
    positional.push(current);
  }

  const segmentId = positional.shift();
  if (Boolean(segmentId) === (throughMessageId !== undefined)) {
    throw new Error("provide exactly one of segment id or --message-id");
  }
  if (positional.length > 0) {
    throw new Error(`unexpected argument: ${positional[0]}`);
  }

  return {
    pid: pid ?? requireCurrentProcessId(ctx),
    ...(segmentId ? { segmentId } : {}),
    ...(throughMessageId !== undefined ? { throughMessageId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(targetConversationId ? { targetConversationId } : {}),
    ...(title ? { title } : {}),
    ...(includeLiveSuffix ? {} : { includeLiveSuffix: false }),
  };
}

function parseProcConversationOptions(args: string[], ctx: KernelContext): {
  pid: string;
  conversationId?: string;
  positional: string[];
} {
  let pid: string | undefined;
  let conversationId: string | undefined;
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--pid") {
      index += 1;
      pid = requireProcOptionValue(args[index], current);
      continue;
    }
    if (current === "--conversation") {
      index += 1;
      conversationId = requireProcOptionValue(args[index], current);
      continue;
    }
    positional.push(current);
  }

  return {
    pid: pid ?? requireCurrentProcessId(ctx),
    ...(conversationId ? { conversationId } : {}),
    positional,
  };
}

function requireCurrentProcessId(ctx: KernelContext): string {
  if (!ctx.processId) {
    throw new Error("missing --pid outside a process");
  }
  return ctx.processId;
}

function parseNonNegativeShellInteger(value: string, option: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== value.trim()) {
    throw new Error(`${option} must be a non-negative integer`);
  }
  return parsed;
}

function parsePositiveShellInteger(value: string, option: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== value.trim()) {
    throw new Error(`${option} must be a positive integer`);
  }
  return parsed;
}

function parsePressureShellNumber(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    throw new Error(`${option} must be > 0 and <= 1`);
  }
  return parsed;
}

function parseProcMessageCommand(args: string[], allowTimeout: boolean): {
  pid: string;
  conversationId?: string;
  message: string;
  metadata?: Record<string, unknown>;
  timeoutMs?: number;
} {
  let conversationId: string | undefined;
  let metadata: Record<string, unknown> | undefined;
  let timeoutMs: number | undefined;
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--conversation") {
      index += 1;
      conversationId = requireProcOptionValue(args[index], current);
      continue;
    }
    if (current === "--metadata-json") {
      index += 1;
      const parsed = JSON.parse(requireProcOptionValue(args[index], current));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("--metadata-json must be a JSON object");
      }
      metadata = parsed as Record<string, unknown>;
      continue;
    }
    if (current === "--timeout") {
      if (!allowTimeout) {
        throw new Error("--timeout is only valid for proc call");
      }
      index += 1;
      timeoutMs = parseDurationMs(requireProcOptionValue(args[index], current));
      continue;
    }
    positional.push(current);
  }

  const pid = positional.shift();
  if (!pid) {
    throw new Error("missing pid");
  }
  const message = positional.join(" ").trim();
  if (!message) {
    throw new Error("missing message");
  }
  return {
    pid,
    message,
    ...(conversationId ? { conversationId } : {}),
    ...(metadata ? { metadata } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

function requireProcOptionValue(value: string | undefined, option: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function parseDurationMs(value: string): number {
  const match = value.match(/^(\d+)(ms|s|m|h|d)?$/);
  if (!match) {
    throw new Error(`invalid duration: ${value}`);
  }
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2] ?? "ms";
  if (unit === "d") return amount * 24 * 60 * 60_000;
  if (unit === "h") return amount * 60 * 60_000;
  if (unit === "m") return amount * 60_000;
  if (unit === "s") return amount * 1_000;
  return amount;
}

function formatProcSegmentReadResult(result: any, json: boolean | undefined): string {
  if (json) {
    return `${JSON.stringify(result, null, 2)}\n`;
  }

  const lines = [
    `Segment ${result.segment.id}`,
    `Conversation: ${result.conversationId}`,
    `Messages: ${result.messages.length}/${result.messageCount}${result.truncated ? " (truncated)" : ""}`,
    "",
  ];
  for (let index = 0; index < result.messages.length; index += 1) {
    const message = result.messages[index];
    const timestamp = typeof message.timestamp === "number"
      ? new Date(message.timestamp).toISOString()
      : "-";
    lines.push(`[${index + 1}] ${message.role} ${timestamp}`);
    lines.push(formatProcHistoryContent(message.content));
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function formatProcHistoryContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text;
    }
    if (typeof record.output === "string") {
      return record.output;
    }
  }
  return JSON.stringify(content, null, 2);
}

function procUsage(): string {
  return [
    "Usage:",
    "  proc self",
    "  proc list",
    "  proc segments [--pid PID] [--conversation id]",
    "  proc policy [--pid PID] [--conversation id] [--overflow manual|auto-compact|fail] [--compact-at N] [--keep-last N]",
    "  proc segment <segment-id> [--pid PID] [--conversation id] [--limit N] [--offset N] [--json]",
    "  proc compact [--pid PID] [--conversation id] (--keep-last N | --through-message-id ID) [--summary TEXT | --generate-summary]",
    "  proc fork (<segment-id> | --message-id ID) [--pid PID] [--conversation id] [--target id] [--title TITLE] [--segment-only]",
    "  proc send <pid> [--conversation id] [--metadata-json json] <message>",
    "  proc call <pid> [--conversation id] [--metadata-json json] [--timeout 60s] <message>",
    "",
    "proc compact archives a conversation prefix and records a segment. Without",
    "--summary, it asks the process model to generate the visible summary.",
    "proc fork branches a conversation from a message or restores a compacted segment.",
    "",
    "proc send is asynchronous mail. proc call is bounded: the caller receives",
    "an ipc.reply or ipc.timeout message in its default conversation.",
    "",
  ].join("\n");
}

async function runSchedCommand(args: string[], ctx: KernelContext): Promise<ExecResult> {
  const [subcommand = "help", ...rest] = args;

  switch (subcommand) {
    case "help":
    case "--help":
    case "-h":
      return { stdout: schedUsage(), stderr: "", exitCode: 0 };
    case "list": {
      requireCommandCapability(ctx, "sched.list");
      const result = handleSchedulerList({ includeDisabled: rest.includes("--all") }, ctx);
      const lines = ["ID\tENABLED\tNEXT\tLAST\tERROR\tNAME\tTARGET"];
      for (const schedule of result.schedules) {
        lines.push([
          schedule.id,
          schedule.enabled ? "yes" : "no",
          schedule.state.nextRunAtMs === null ? "-" : new Date(schedule.state.nextRunAtMs).toISOString(),
          schedule.state.lastStatus ?? "-",
          formatScheduleListText(schedule.state.lastError),
          schedule.name,
          formatScheduleTarget(schedule.target),
        ].join("\t"));
      }
      return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
    }
    case "add": {
      requireCommandCapability(ctx, "sched.add");
      const parsed = parseSchedAddCommand(rest);
      const result = await handleSchedulerAdd(parsed, ctx);
      return {
        stdout: `schedule_id=${result.schedule.id} next=${result.schedule.state.nextRunAtMs === null ? "-" : new Date(result.schedule.state.nextRunAtMs).toISOString()}\n`,
        stderr: "",
        exitCode: 0,
      };
    }
    case "remove": {
      requireCommandCapability(ctx, "sched.remove");
      const id = requireSchedId(rest[0]);
      const result = await handleSchedulerRemove({ id }, ctx);
      return { stdout: `removed=${result.removed}\n`, stderr: "", exitCode: result.removed ? 0 : 1 };
    }
    case "enable":
    case "disable": {
      requireCommandCapability(ctx, "sched.update");
      const id = requireSchedId(rest[0]);
      const result = await handleSchedulerUpdate({
        id,
        patch: { enabled: subcommand === "enable" },
      }, ctx);
      return {
        stdout: `schedule_id=${result.schedule.id} enabled=${result.schedule.enabled}\n`,
        stderr: "",
        exitCode: 0,
      };
    }
    case "run": {
      requireCommandCapability(ctx, "sched.run");
      const id = requireSchedId(rest[0]);
      const force = rest.includes("--force");
      const result = await handleSchedulerRun({ id, mode: force ? "force" : "due" }, ctx);
      return {
        stdout: JSON.stringify(result) + "\n",
        stderr: "",
        exitCode: result.results.some((item) => item.status === "error") ? 1 : 0,
      };
    }
    default:
      return { stdout: "", stderr: `sched: unknown command: ${subcommand}\n${schedUsage()}`, exitCode: 1 };
  }
}

function parseSchedAddCommand(args: string[]): SchedulerAddArgs {
  let name: string | undefined;
  let description: string | undefined;
  let label: string | undefined;
  let profile: string | undefined;
  let timezone: string | undefined;
  let pid: string | undefined;
  let conversationId: string | undefined;
  let data: Record<string, unknown> | undefined;
  let expression: ScheduleExpression | undefined;
  let prompt: string | undefined;
  let enabled = true;
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--json") {
      return JSON.parse(requireProcOptionValue(args[index + 1], current)) as SchedulerAddArgs;
    }
    if (current === "--name") {
      index += 1;
      name = requireProcOptionValue(args[index], current);
      continue;
    }
    if (current === "--description") {
      index += 1;
      description = requireProcOptionValue(args[index], current);
      continue;
    }
    if (current === "--label") {
      index += 1;
      label = requireProcOptionValue(args[index], current);
      continue;
    }
    if (current === "--profile") {
      index += 1;
      profile = requireProcOptionValue(args[index], current);
      continue;
    }
    if (current === "--timezone") {
      index += 1;
      timezone = requireProcOptionValue(args[index], current);
      continue;
    }
    if (current === "--pid") {
      index += 1;
      pid = requireProcOptionValue(args[index], current);
      continue;
    }
    if (current === "--conversation") {
      index += 1;
      conversationId = requireProcOptionValue(args[index], current);
      continue;
    }
    if (current === "--data-json") {
      index += 1;
      const parsed = JSON.parse(requireProcOptionValue(args[index], current));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("--data-json must be a JSON object");
      }
      data = parsed as Record<string, unknown>;
      continue;
    }
    if (current === "--prompt" || current === "--message") {
      index += 1;
      prompt = requireProcOptionValue(args[index], current);
      continue;
    }
    if (current === "--disabled") {
      enabled = false;
      continue;
    }
    if (current === "--every") {
      index += 1;
      expression = { kind: "every", everyMs: parseDurationMs(requireProcOptionValue(args[index], current)) };
      continue;
    }
    if (current === "--after") {
      index += 1;
      expression = { kind: "after", afterMs: parseDurationMs(requireProcOptionValue(args[index], current)) };
      continue;
    }
    if (current === "--at") {
      index += 1;
      expression = { kind: "at", atMs: parseScheduleAtMs(requireProcOptionValue(args[index], current)) };
      continue;
    }
    if (current === "--cron") {
      index += 1;
      expression = {
        kind: "cron",
        expr: requireProcOptionValue(args[index], current),
        timezone: timezone ?? "",
      };
      continue;
    }
    positional.push(current);
  }

  if (!name) {
    throw new Error("missing --name");
  }
  if (!expression) {
    throw new Error("missing schedule expression (--cron, --every, --after, or --at)");
  }
  if (expression.kind === "cron" && timezone !== undefined) {
    expression = { ...expression, timezone };
  }

  const message = prompt ?? positional.join(" ").trim();
  if (!message) {
    throw new Error("missing prompt/message");
  }

  const target: ScheduleTarget = pid
    ? {
        kind: "process.event",
        pid,
        message,
        ...(conversationId ? { conversationId } : {}),
        ...(data ? { data } : {}),
      }
    : {
        kind: "process.spawn",
        prompt: message,
        ...(profile ? { profile: profile as AiContextProfile } : {}),
        ...(label ? { label } : {}),
      };

  return {
    name,
    ...(description ? { description } : {}),
    enabled,
    expression,
    target,
  };
}

function parseScheduleAtMs(value: string): number {
  if (/^\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid --at value: ${value}`);
  }
  return parsed;
}

function requireSchedId(value: string | undefined): string {
  if (!value || value.trim().length === 0 || value.startsWith("--")) {
    throw new Error("missing schedule id");
  }
  return value.trim();
}

function formatScheduleTarget(target: ScheduleTarget): string {
  if (target.kind === "process.spawn") {
    return `spawn:${target.profile ?? "cron"}`;
  }
  return `event:${target.pid}`;
}

function formatScheduleListText(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }
  return value.replace(/[\t\r\n]+/g, " ").slice(0, 120);
}

function schedUsage(): string {
  return [
    "Usage:",
    "  sched list [--all]",
    "  sched add --name NAME (--cron EXPR [--timezone TZ] | --every DURATION | --after DURATION | --at TIME) [--pid PID] [--conversation id] [--profile PROFILE] [--label LABEL] <prompt/message>",
    "  sched add --json JSON",
    "  sched enable <id>",
    "  sched disable <id>",
    "  sched remove <id>",
    "  sched run <id> [--force]",
    "",
    "Without --pid, sched add spawns a process. With --pid, it delivers a",
    "process event to that process conversation.",
    "",
  ].join("\n");
}

async function runPkgCommand(args: string[], ctx: KernelContext, cwd: string): Promise<ExecResult> {
  const [subcommand = "help", ...rest] = args;

  switch (subcommand) {
    case "help":
    case "--help":
    case "-h":
      return { stdout: pkgUsage(), stderr: "", exitCode: 0 };
    case "list": {
      requireCommandCapability(ctx, "pkg.list");
      const result = handlePkgList({}, ctx);
      return { stdout: formatPkgList(result.packages), stderr: "", exitCode: 0 };
    }
    case "remotes": {
      requireCommandCapability(ctx, "pkg.remote.list");
      const result = handlePkgRemoteList({}, ctx);
      return { stdout: formatPkgRemotes(result.remotes), stderr: "", exitCode: 0 };
    }
    case "show":
    case "status": {
      requireCommandCapability(ctx, "pkg.list");
      const target = resolvePkgTarget(rest[0], ctx, cwd);
      return { stdout: formatPkgStatus(target, ctx), stderr: "", exitCode: 0 };
    }
    case "manifest": {
      requireCommandCapability(ctx, "pkg.list");
      const target = resolvePkgTarget(rest[0], ctx, cwd);
      return { stdout: `${JSON.stringify(target.manifest, null, 2)}\n`, stderr: "", exitCode: 0 };
    }
    case "capabilities": {
      requireCommandCapability(ctx, "pkg.list");
      const target = resolvePkgTarget(rest[0], ctx, cwd);
      return { stdout: formatPkgCapabilities(target), stderr: "", exitCode: 0 };
    }
    case "refs": {
      requireCommandCapability(ctx, "repo.refs");
      const target = resolvePkgTarget(rest[0], ctx, cwd);
      const result = await handleRepoRefs({ repo: target.manifest.source.repo }, ctx);
      return { stdout: formatPkgRefs(target, result), stderr: "", exitCode: 0 };
    }
    case "log": {
      requireCommandCapability(ctx, "repo.log");
      const parsed = parsePkgLogArgs(rest);
      const target = resolvePkgTarget(parsed.packageId, ctx, cwd);
      const result = await handleRepoLog({
        repo: target.manifest.source.repo,
        ref: target.manifest.source.ref,
        limit: parsed.limit,
        offset: parsed.offset,
      }, ctx);
      return { stdout: formatPkgLog(target, result), stderr: "", exitCode: 0 };
    }
    case "source": {
      return runPkgSourceCommand(rest, ctx, cwd);
    }
    case "add": {
      requireCommandCapability(ctx, "pkg.add");
      const result = await handlePkgAdd(parsePkgAddArgs(rest), ctx);
      return {
        stdout: `${result.package.enabled ? "imported and enabled" : "imported"} ${result.package.name} from ${result.imported.repo} (${result.imported.ref})\n`,
        stderr: "",
        exitCode: 0,
      };
    }
    case "create": {
      requireCommandCapability(ctx, "pkg.create");
      const result = await handlePkgCreate(parsePkgCreateArgs(rest), ctx);
      return {
        stdout: `${result.created ? "created" : "updated"} ${result.package.name} in ${result.repo}:${result.subdir} (${result.ref})\n`,
        stderr: "",
        exitCode: 0,
      };
    }
    case "remote": {
      const [remoteSubcommand, ...remoteArgs] = rest;
      if (!remoteSubcommand || remoteSubcommand === "list") {
        requireCommandCapability(ctx, "pkg.remote.list");
        const result = handlePkgRemoteList({}, ctx);
        return { stdout: formatPkgRemotes(result.remotes), stderr: "", exitCode: 0 };
      }
      if (remoteSubcommand === "add") {
        requireCommandCapability(ctx, "pkg.remote.add");
        const result = handlePkgRemoteAdd(parsePkgRemoteAddArgs(remoteArgs), ctx);
        return {
          stdout: `${result.changed ? "added" : "updated"} remote ${result.remote.name} -> ${result.remote.baseUrl}\n`,
          stderr: "",
          exitCode: 0,
        };
      }
      if (remoteSubcommand === "remove") {
        requireCommandCapability(ctx, "pkg.remote.remove");
        const name = String(remoteArgs[0] ?? "").trim();
        if (!name) {
          throw new Error("Usage: pkg remote remove <name>");
        }
        const result = handlePkgRemoteRemove({ name }, ctx);
        return {
          stdout: `${result.removed ? "removed" : "missing"} remote ${name}\n`,
          stderr: "",
          exitCode: 0,
        };
      }
      throw new Error(`Unknown pkg remote subcommand: ${remoteSubcommand}`);
    }
    case "discover": {
      requireCommandCapability(ctx, "pkg.public.list");
      const result = await handlePkgPublicList({ remote: String(rest[0] ?? "").trim() || undefined }, ctx);
      return { stdout: formatPkgPublicCatalog(result), stderr: "", exitCode: 0 };
    }
    case "public": {
      const publicSubcommand = String(rest[0] ?? "").trim();
      if (!publicSubcommand || publicSubcommand === "list") {
        requireCommandCapability(ctx, "pkg.public.list");
        const result = await handlePkgPublicList({ remote: String(rest[1] ?? "").trim() || undefined }, ctx);
        return { stdout: formatPkgPublicCatalog(result), stderr: "", exitCode: 0 };
      }
      if (publicSubcommand === "on" || publicSubcommand === "off") {
        requireCommandCapability(ctx, "pkg.public.set");
        const result = handlePkgPublicSet({
          ...resolvePkgPublicTarget(rest[1], ctx, cwd),
          public: publicSubcommand === "on",
        }, ctx);
        return {
          stdout: `${result.public ? "published" : "hidden"} ${result.repo}\n`,
          stderr: "",
          exitCode: 0,
        };
      }
      throw new Error(`Unknown pkg public subcommand: ${publicSubcommand}`);
    }
    case "approve": {
      requireCommandCapability(ctx, "pkg.review.approve");
      const target = resolvePkgTarget(rest[0], ctx, cwd);
      const result = handlePkgReviewApprove({ packageId: target.packageId }, ctx);
      return { stdout: `${result.changed ? "approved" : "already approved"} ${result.package.name}\n`, stderr: "", exitCode: 0 };
    }
    case "enable": {
      requireCommandCapability(ctx, "pkg.install");
      const target = resolvePkgTarget(rest[0], ctx, cwd);
      const result = handlePkgInstall({ packageId: target.packageId }, ctx);
      return { stdout: `${result.changed ? "enabled" : "already enabled"} ${result.package.name}\n`, stderr: "", exitCode: 0 };
    }
    case "disable": {
      requireCommandCapability(ctx, "pkg.remove");
      const target = resolvePkgTarget(rest[0], ctx, cwd);
      const result = handlePkgRemove({ packageId: target.packageId }, ctx);
      return { stdout: `${result.changed ? "disabled" : "already disabled"} ${result.package.name}\n`, stderr: "", exitCode: 0 };
    }
    case "checkout": {
      requireCommandCapability(ctx, "pkg.checkout");
      const ref = String(rest[0] ?? "").trim();
      if (!ref) {
        throw new Error("Usage: pkg checkout <ref> [package]");
      }
      const target = resolvePkgTarget(rest[1], ctx, cwd);
      const result = await handlePkgCheckout({ packageId: target.packageId, ref }, ctx);
      return { stdout: `${result.changed ? "checked out" : "already on"} ${ref} for ${result.package.name}\n`, stderr: "", exitCode: 0 };
    }
    default:
      throw new Error(`Unknown pkg subcommand: ${subcommand}`);
  }
}

async function runSkillsCommand(
  args: string[],
  fs: GsvFs,
  ctx: KernelContext,
  identity: ProcessIdentity,
): Promise<ExecResult> {
  const [subcommand = "list", ...rest] = args;

  switch (subcommand) {
    case "help":
    case "--help":
    case "-h":
      return { stdout: skillsUsage(), stderr: "", exitCode: 0 };
    case "list":
    case "ls": {
      const docs = await collectFilesystemSkillDocuments(fs, ctx, identity);
      return { stdout: formatSkillsList(docs), stderr: "", exitCode: 0 };
    }
    case "search": {
      const query = rest.join(" ").trim();
      if (!query) {
        throw new Error("Usage: skills search <query>");
      }
      const docs = await collectFilesystemSkillDocuments(fs, ctx, identity);
      return { stdout: formatSkillsList(searchSkills(docs, query)), stderr: "", exitCode: 0 };
    }
    case "show": {
      const docs = await collectFilesystemSkillDocuments(fs, ctx, identity);
      const resolved = resolveSkillDocument(docs, rest[0]);
      if (!resolved.ok) {
        throw new Error(resolved.error);
      }
      return { stdout: formatSkillDocument(resolved.doc), stderr: "", exitCode: 0 };
    }
    case "files": {
      const docs = await collectFilesystemSkillDocuments(fs, ctx, identity);
      const resolved = resolveSkillDocument(docs, rest[0]);
      if (!resolved.ok) {
        throw new Error(resolved.error);
      }
      const files = await listSkillFiles(fs, resolved.doc);
      return { stdout: formatSkillFiles(resolved.doc, files), stderr: "", exitCode: 0 };
    }
    case "read": {
      const docs = await collectFilesystemSkillDocuments(fs, ctx, identity);
      const resolved = resolveSkillDocument(docs, rest[0]);
      if (!resolved.ok) {
        throw new Error(resolved.error);
      }
      const filePath = String(rest[1] ?? "").trim();
      if (!filePath) {
        throw new Error("Usage: skills read <skill> <file>");
      }
      if (filePath.startsWith("/") || filePath.split("/").includes("..")) {
        throw new Error("supporting file path must be relative and must not contain '..'");
      }
      const root = skillDirectoryPath(resolved.doc);
      if (!root) {
        throw new Error(`skill '${resolved.doc.id}' does not have supporting files`);
      }
      const content = await fs.readFile(`${root}/${filePath}`);
      return { stdout: content.endsWith("\n") ? content : `${content}\n`, stderr: "", exitCode: 0 };
    }
    default:
      throw new Error(`Unknown skills subcommand: ${subcommand}`);
  }
}

function formatSkillsList(docs: SkillDocument[]): string {
  if (docs.length === 0) {
    return "No skills available.\n";
  }
  const lines = ["NAME\tSOURCE\tWRITABLE\tDESCRIPTION"];
  for (const doc of docs) {
    lines.push(`${doc.id}\t${doc.source.label}\t${doc.source.writable ? "yes" : "no"}\t${doc.description}`);
  }
  return `${lines.join("\n")}\n`;
}

function searchSkills(docs: SkillDocument[], query: string): SkillDocument[] {
  const needle = query.toLowerCase();
  return docs.filter((doc) =>
    doc.id.toLowerCase().includes(needle)
    || doc.name.toLowerCase().includes(needle)
    || doc.description.toLowerCase().includes(needle)
    || doc.content.toLowerCase().includes(needle)
  );
}

function formatSkillDocument(doc: SkillDocument): string {
  return [
    `path: ${doc.path}`,
    `writable: ${doc.source.writable ? "yes" : "no"}`,
    "",
    doc.content,
    "",
  ].join("\n");
}

function formatSkillFiles(doc: SkillDocument, files: string[]): string {
  if (files.length === 0) {
    return `No supporting files for ${doc.id}.\n`;
  }
  return `${files.map((file) => `${doc.id}\t${file}`).join("\n")}\n`;
}

function skillDirectoryPath(doc: SkillDocument): string | null {
  if (doc.path.endsWith("/SKILL.md")) {
    return doc.path.slice(0, -"/SKILL.md".length);
  }
  return null;
}

function resolvePkgTarget(rawPackageId: string | undefined, ctx: KernelContext, cwd: string): InstalledPackageRecord {
  const packageId = typeof rawPackageId === "string" ? rawPackageId.trim() : "";
  if (packageId) {
    return resolveInstalledPackage(packageId, ctx);
  }
  const currentPackage = currentSourcePackage(ctx, cwd);
  if (currentPackage) {
    return currentPackage;
  }
  throw new Error("packageId is required outside a package source context");
}

function currentSourcePackage(ctx: KernelContext, cwd: string): InstalledPackageRecord | null {
  const normalizedCwd = normalizePath(cwd);
  const packages = ctx.packages.list({ scopes: visiblePackageScopesForActor(ctx.identity?.process) });
  const match = normalizedCwd.match(/^\/src\/packages\/([^/]+)(?:\/|$)/);
  const packageName = match?.[1];
  if (packageName) {
    const pathNames = packageSourcePathNameMap(packages);
    const found = packages.find((candidate) => pathNames.get(candidate) === packageName);
    if (found) {
      return found;
    }
  }
  return currentMountedSourcePackage(ctx, normalizedCwd, packages);
}

function currentMountedSourcePackage(
  ctx: KernelContext,
  normalizedCwd: string,
  packages: InstalledPackageRecord[],
): InstalledPackageRecord | null {
  const mounts = ctx.processId ? ctx.procs.getMounts(ctx.processId) : [];
  let matchedMount: (typeof mounts)[number] | undefined;
  let matchedLength = -1;
  for (const mount of mounts) {
    const mountPath = normalizePath(mount.mountPath);
    if (
      mount.kind !== "ripgit-source" ||
      !mount.packageId ||
      (normalizedCwd !== mountPath && !normalizedCwd.startsWith(`${mountPath}/`))
    ) {
      continue;
    }
    if (mountPath.length > matchedLength) {
      matchedMount = mount;
      matchedLength = mountPath.length;
    }
  }
  if (!matchedMount?.packageId) {
    return null;
  }
  return packages.find((candidate) =>
    candidate.packageId === matchedMount.packageId &&
    (!matchedMount.scope || packageScopeEquals(candidate.scope, matchedMount.scope))
  ) ?? null;
}

async function runPkgSourceCommand(args: string[], ctx: KernelContext, cwd: string): Promise<ExecResult> {
  const [subcommand = "status", ...rest] = args;
  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    return { stdout: pkgSourceUsage(), stderr: "", exitCode: 0 };
  }

  if (subcommand === "status") {
    requireCommandCapability(ctx, "pkg.list");
    const target = resolvePkgTarget(rest[0], ctx, cwd);
    const status = await getProcessSourceStatus(processSourceOptions(ctx), target);
    return { stdout: formatPkgSourceStatus(status), stderr: "", exitCode: 0 };
  }

  if (subcommand === "diff") {
    requireCommandCapability(ctx, "pkg.list");
    const target = resolvePkgTarget(rest[0], ctx, cwd);
    const diff = await diffProcessSourceChanges(processSourceOptions(ctx), target);
    return { stdout: diff, stderr: "", exitCode: 0 };
  }

  if (subcommand === "commit") {
    requireCommandCapability(ctx, "repo.apply");
    const parsed = parsePkgSourceCommitArgs(rest);
    const target = resolvePkgTarget(parsed.packageId, ctx, cwd);
    const result = await commitProcessSourceChanges(processSourceOptions(ctx), target, {
      message: parsed.message,
      ...(parsed.branch ? { branch: parsed.branch } : {}),
    });
    return {
      stdout: result.committed
        ? `committed ${result.packageName} to ${result.branch ?? "-"} ${result.commitHead ?? "-"} (${result.ops} ops)\n`
        : `no staged source changes for ${result.packageName}\n`,
      stderr: "",
      exitCode: 0,
    };
  }

  if (subcommand === "discard") {
    requireCommandCapability(ctx, "fs.write");
    const target = resolvePkgTarget(rest[0], ctx, cwd);
    const before = await getProcessSourceStatus(processSourceOptions(ctx), target);
    await discardProcessSourceChanges(processSourceOptions(ctx), target);
    return {
      stdout: `discarded ${before.changes.length} staged source change(s) for ${target.manifest.name}\n`,
      stderr: "",
      exitCode: 0,
    };
  }

  throw new Error(`Unknown pkg source subcommand: ${subcommand}`);
}

function processSourceOptions(ctx: KernelContext) {
  const identity = ctx.identity!.process;
  return {
    identity,
    storage: ctx.env.STORAGE,
    ripgit: ctx.env.RIPGIT ? new RipgitClient(ctx.env.RIPGIT) : null,
    packages: ctx.packages.list({ scopes: visiblePackageScopesForActor(identity) }),
    mounts: ctx.processId ? ctx.procs.getMounts(ctx.processId) : null,
    processId: ctx.processId ?? null,
    config: ctx.config,
  };
}

function requireCommandCapability(ctx: KernelContext, capability: string): void {
  const capabilities = ctx.identity?.capabilities ?? [];
  if (!hasCapability(capabilities, capability)) {
    throw new Error(`Permission denied: ${capability}`);
  }
}

function formatPkgList(packages: Array<{
  name: string;
  scope: { kind: "global" | "user" | "workspace"; uid?: number; workspaceId?: string };
  enabled: boolean;
  review: { required: boolean; approvedAt: number | null };
  source: { repo: string; ref: string; public: boolean };
}>): string {
  const lines = ["NAME\tSCOPE\tSTATE\tREVIEW\tPUBLIC\tSOURCE\tREF"];
  for (const pkg of packages) {
    lines.push([
      pkg.name,
      formatPkgScope(pkg.scope),
      pkg.enabled ? "enabled" : "disabled",
      pkg.review.required && !pkg.review.approvedAt ? "pending" : (pkg.review.required ? "approved" : "n/a"),
      pkg.source.public ? "yes" : "no",
      pkg.source.repo,
      pkg.source.ref,
    ].join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

function formatPkgRemotes(remotes: { name: string; baseUrl: string }[]): string {
  const lines = ["NAME\tBASE URL"];
  for (const remote of remotes) {
    lines.push(`${remote.name}\t${remote.baseUrl}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatPkgStatus(pkg: InstalledPackageRecord, ctx: KernelContext): string {
  const review = pkg.reviewRequired
    ? (pkg.reviewedAt ? `approved at ${new Date(pkg.reviewedAt).toISOString()}` : "approval required")
    : "not required";
  const isPublic = isRepoPublic(pkg.manifest.source.repo, ctx.config);
  const bindings = getPkgDeclaredBindings(pkg).map((binding) => binding.binding);
  const entrypoints = pkg.manifest.entrypoints.length > 0
    ? pkg.manifest.entrypoints.map((entry) => `${entry.name}:${entry.kind}`).join(", ")
    : "none";
  return [
    `package: ${pkg.manifest.name}`,
    `packageId: ${pkg.packageId}`,
    `scope: ${formatPkgScope(pkg.scope)}`,
    `enabled: ${pkg.enabled ? "yes" : "no"}`,
    `review: ${review}`,
    `public: ${isPublic ? "yes" : "no"}`,
    `source: ${pkg.manifest.source.repo}`,
    `ref: ${pkg.manifest.source.ref}`,
    `subdir: ${pkg.manifest.source.subdir}`,
    `resolvedCommit: ${pkg.manifest.source.resolvedCommit ?? "unknown"}`,
    `bindings: ${bindings.length > 0 ? bindings.join(", ") : "none"}`,
    `entrypoints: ${entrypoints}`,
    "",
  ].join("\n");
}

function formatPkgCapabilities(pkg: InstalledPackageRecord): string {
  const declaredBindings = getPkgDeclaredBindings(pkg);
  const grantedBindings = pkg.grants?.bindings ?? [];
  const declaredEgress = pkg.manifest.capabilities?.egress;
  const grantedEgress = pkg.grants?.egress;
  const entrypointSyscalls = Array.from(new Set(pkg.manifest.entrypoints.flatMap((entry) => entry.syscalls ?? [])));
  return [
    `package: ${pkg.manifest.name}`,
    "declared bindings:",
    declaredBindings.length > 0
      ? declaredBindings.map((binding) =>
        `- ${binding.binding} (${binding.kind}, ${binding.interfaceName}, ${binding.required ? "required" : "optional"})`
      ).join("\n")
      : "none",
    "granted bindings:",
    grantedBindings.length > 0
      ? grantedBindings.map((binding) => `- ${binding.binding} -> ${binding.providerKind}:${binding.providerRef}`).join("\n")
      : "none",
    "declared egress:",
    formatPkgEgress(declaredEgress?.mode, declaredEgress?.allow),
    "granted egress:",
    formatPkgEgress(grantedEgress?.mode, grantedEgress?.allow),
    "entrypoint syscalls:",
    entrypointSyscalls.length > 0 ? `- ${entrypointSyscalls.join("\n- ")}` : "none",
    "",
  ].join("\n");
}

function getPkgDeclaredBindings(pkg: InstalledPackageRecord) {
  return pkg.manifest.capabilities?.bindings ?? [];
}

function formatPkgEgress(mode?: string, allow?: string[]): string {
  if (!mode) return "none";
  if (mode !== "allowlist") return mode;
  return Array.isArray(allow) && allow.length > 0
    ? `allowlist (${allow.join(", ")})`
    : "allowlist";
}

function formatPkgRefs(target: InstalledPackageRecord, result: Awaited<ReturnType<typeof handleRepoRefs>>): string {
  const lines = [
    `packageId: ${target.packageId}`,
    `repo: ${result.repo}`,
    `activeRef: ${target.manifest.source.ref}`,
    "",
    "heads:",
  ];
  for (const [name, hash] of Object.entries(result.heads).sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`- ${name}\t${hash}`);
  }
  lines.push("", "tags:");
  for (const [name, hash] of Object.entries(result.tags).sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`- ${name}\t${hash}`);
  }
  lines.push("");
  return lines.join("\n");
}

function formatPkgLog(target: InstalledPackageRecord, result: Awaited<ReturnType<typeof handleRepoLog>>): string {
  const lines = [`packageId: ${target.packageId}`, `repo: ${result.repo}`, `ref: ${result.ref}`, ""];
  for (const entry of result.entries) {
    lines.push(`${entry.hash.slice(0, 7)} ${entry.message.split("\n")[0] || "No message"}`);
    lines.push(`  author: ${entry.author} <${entry.authorEmail}>`);
    lines.push(`  time: ${new Date(entry.commitTime * 1000).toISOString()}`);
    if (entry.parents.length > 0) {
      lines.push(`  parents: ${entry.parents.join(", ")}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function formatPkgSourceStatus(result: Awaited<ReturnType<typeof getProcessSourceStatus>>): string {
  const lines = [
    `package: ${result.packageName}`,
    `packageId: ${result.packageId}`,
    `repo: ${result.repo}`,
    `sourceRef: ${result.sourceRef}`,
    `baseRef: ${result.baseRef}`,
    `branch: ${result.branch ?? "-"}`,
    `head: ${result.head ?? "-"}`,
    `changes: ${result.changes.length}`,
  ];
  for (const change of result.changes) {
    const suffix = change.type === "put" && typeof change.size === "number" ? ` ${change.size} bytes` : "";
    lines.push(`- ${change.type}\t${change.path}${suffix}`);
  }
  lines.push("");
  return lines.join("\n");
}

function formatPkgPublicCatalog(result: Awaited<ReturnType<typeof handlePkgPublicList>>): string {
  const lines = [
    `source: ${result.serverName}`,
    `origin: ${result.source.kind === "remote" ? result.source.baseUrl ?? result.source.name : "local"}`,
    "",
    "NAME\tRUNTIME\tREPO\tREF\tSUBDIR",
  ];
  for (const entry of result.packages) {
    lines.push(`${entry.name}\t${entry.runtime}\t${entry.source.repo}\t${entry.source.ref}\t${entry.source.subdir}`);
  }
  lines.push("");
  return lines.join("\n");
}

function parsePkgLogArgs(args: string[]): { packageId?: string; limit?: number; offset?: number } {
  const parsed: { packageId?: string; limit?: number; offset?: number } = {};
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--limit") {
      parsed.limit = Number.parseInt(String(args[index + 1] ?? ""), 10);
      index += 1;
      continue;
    }
    if (current === "--offset") {
      parsed.offset = Number.parseInt(String(args[index + 1] ?? ""), 10);
      index += 1;
      continue;
    }
    if (!parsed.packageId) {
      parsed.packageId = current;
    }
  }
  return parsed;
}

function parsePkgAddArgs(args: string[]): {
  repo?: string;
  remoteUrl?: string;
  ref?: string;
  subdir?: string;
  enable?: boolean;
} {
  const parsed: {
    repo?: string;
    remoteUrl?: string;
    ref?: string;
    subdir?: string;
    enable?: boolean;
  } = {};
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--repo") {
      parsed.repo = String(args[index + 1] ?? "").trim();
      index += 1;
      continue;
    }
    if (current === "--remote-url" || current === "--url") {
      parsed.remoteUrl = String(args[index + 1] ?? "").trim();
      index += 1;
      continue;
    }
    if (current === "--ref") {
      parsed.ref = String(args[index + 1] ?? "").trim();
      index += 1;
      continue;
    }
    if (current === "--subdir") {
      parsed.subdir = String(args[index + 1] ?? "").trim();
      index += 1;
      continue;
    }
    if (current === "--enable") {
      parsed.enable = true;
    }
  }
  return parsed;
}

function parsePkgCreateArgs(args: string[]): {
  repo: string;
  name?: string;
  displayName?: string;
  description?: string;
  ref?: string;
  subdir?: string;
  template?: "web-ui" | "command";
  command?: string;
  overwrite?: boolean;
  enable?: boolean;
} {
  const parsed: {
    repo?: string;
    name?: string;
    displayName?: string;
    description?: string;
    ref?: string;
    subdir?: string;
    template?: "web-ui" | "command";
    command?: string;
    overwrite?: boolean;
    enable?: boolean;
  } = {};

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--repo") {
      parsed.repo = String(args[index + 1] ?? "").trim();
      index += 1;
      continue;
    }
    if (current === "--name") {
      parsed.name = String(args[index + 1] ?? "").trim();
      index += 1;
      continue;
    }
    if (current === "--display-name") {
      parsed.displayName = String(args[index + 1] ?? "").trim();
      index += 1;
      continue;
    }
    if (current === "--description") {
      parsed.description = String(args[index + 1] ?? "").trim();
      index += 1;
      continue;
    }
    if (current === "--ref") {
      parsed.ref = String(args[index + 1] ?? "").trim();
      index += 1;
      continue;
    }
    if (current === "--subdir") {
      parsed.subdir = String(args[index + 1] ?? "").trim();
      index += 1;
      continue;
    }
    if (current === "--template") {
      const template = String(args[index + 1] ?? "").trim();
      if (template !== "web-ui" && template !== "command") {
        throw new Error("template must be web-ui or command");
      }
      parsed.template = template;
      index += 1;
      continue;
    }
    if (current === "--command") {
      parsed.command = String(args[index + 1] ?? "").trim();
      index += 1;
      continue;
    }
    if (current === "--overwrite") {
      parsed.overwrite = true;
      continue;
    }
    if (current === "--enable") {
      parsed.enable = true;
      continue;
    }
    if (!parsed.repo) {
      parsed.repo = current;
      continue;
    }
    throw new Error(`Unknown pkg create argument: ${current}`);
  }

  if (!parsed.repo) {
    throw new Error("Usage: pkg create --repo owner/repo [--name @owner/pkg]");
  }

  return {
    repo: parsed.repo,
    ...(parsed.name ? { name: parsed.name } : {}),
    ...(parsed.displayName ? { displayName: parsed.displayName } : {}),
    ...(parsed.description ? { description: parsed.description } : {}),
    ...(parsed.ref ? { ref: parsed.ref } : {}),
    ...(parsed.subdir ? { subdir: parsed.subdir } : {}),
    ...(parsed.template ? { template: parsed.template } : {}),
    ...(parsed.command ? { command: parsed.command } : {}),
    ...(typeof parsed.overwrite === "boolean" ? { overwrite: parsed.overwrite } : {}),
    ...(typeof parsed.enable === "boolean" ? { enable: parsed.enable } : {}),
  };
}

function parsePkgSourceCommitArgs(args: string[]): { packageId?: string; message: string; branch?: string } {
  let packageId: string | undefined;
  let message = "";
  let branch: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--message" || current === "-m") {
      index += 1;
      message = String(args[index] ?? "").trim();
      continue;
    }
    if (current === "--branch") {
      index += 1;
      branch = String(args[index] ?? "").trim();
      continue;
    }
    if (!packageId) {
      packageId = current;
      continue;
    }
    throw new Error(`Unknown pkg source commit argument: ${current}`);
  }

  if (!message) {
    throw new Error("Usage: pkg source commit [package] --message TEXT [--branch BRANCH]");
  }
  return {
    ...(packageId ? { packageId } : {}),
    message,
    ...(branch ? { branch } : {}),
  };
}

function parsePkgRemoteAddArgs(args: string[]): { name: string; baseUrl: string } {
  const name = String(args[0] ?? "").trim();
  const baseUrl = String(args[1] ?? "").trim();
  if (!name || !baseUrl) {
    throw new Error("Usage: pkg remote add <name> <baseUrl>");
  }
  return { name, baseUrl };
}

function resolvePkgPublicTarget(
  rawTarget: string | undefined,
  ctx: KernelContext,
  cwd: string,
): { packageId?: string; repo?: string } {
  const target = String(rawTarget ?? "").trim();
  if (!target) {
    const currentPackage = currentSourcePackage(ctx, cwd);
    if (!currentPackage) {
      throw new Error("packageId or repo is required outside a package source context");
    }
    return { repo: currentPackage.manifest.source.repo };
  }

  const found = ctx.packages.resolve(target, visiblePackageScopesForActor(ctx.identity?.process));
  if (found) {
    return { packageId: found.packageId };
  }

  if (target.includes("/")) {
    return { repo: target };
  }

  return { packageId: resolveInstalledPackage(target, ctx).packageId };
}

function formatPkgScope(scope: { kind: "global" | "user" | "workspace"; uid?: number; workspaceId?: string }): string {
  switch (scope.kind) {
    case "user":
      return `user:${scope.uid ?? "?"}`;
    case "workspace":
      return `workspace:${scope.workspaceId ?? "?"}`;
    default:
      return "global";
  }
}

function pkgUsage(): string {
  return [
    "Usage: pkg <subcommand> [args]",
    "",
    "Read-only:",
    "  pkg list",
    "  pkg remotes",
    "  pkg discover [remote]",
    "  pkg show [package]",
    "  pkg manifest [package]",
    "  pkg capabilities [package]",
    "  pkg refs [package]",
    "  pkg log [package] [--limit N] [--offset N]",
    "  pkg source status [package]",
    "  pkg source diff [package]",
    "  pkg public list [remote]",
    "",
    "Mutating:",
    "  pkg add --repo owner/repo [--ref main] [--subdir .] [--enable]",
    "  pkg add --remote-url https://... [--ref main] [--subdir .] [--enable]",
    "  pkg create --repo owner/repo [--template web-ui|command] [--enable]",
    "  pkg remote add <name> <baseUrl>",
    "  pkg remote remove <name>",
    "  pkg public on [package|owner/repo]",
    "  pkg public off [package|owner/repo]",
    "  pkg approve [package]",
    "  pkg enable [package]",
    "  pkg disable [package]",
    "  pkg checkout <ref> [package]",
    "  pkg source commit [package] --message TEXT [--branch BRANCH]",
    "  pkg source discard [package]",
    "",
    "When cwd is under /src/packages/<package>, [package] defaults to that source package.",
    "",
  ].join("\n");
}

function skillsUsage(): string {
  return [
    "Usage: skills <subcommand> [args]",
    "",
    "  skills list",
    "  skills search <query>",
    "  skills show <skill>",
    "  skills files <skill>",
    "  skills read <skill> <file>",
    "",
    "Skill names come from layered skills.d directories. Use `skills show`",
    "to load the full SKILL.md and see the backing source path.",
    "",
  ].join("\n");
}

function pkgSourceUsage(): string {
  return [
    "Usage: pkg source <subcommand> [args]",
    "",
    "  pkg source status [package]",
    "  pkg source diff [package]",
    "  pkg source commit [package] --message TEXT [--branch BRANCH]",
    "  pkg source discard [package]",
    "",
  ].join("\n");
}

async function runPackageCommand(
  record: InstalledPackageRecord,
  entrypoint: PackageEntrypoint,
  args: string[],
  cwd: string,
  identity: ProcessIdentity,
  ctx: KernelContext,
): Promise<PackageCommandResult> {
  if (!ctx.getAppRunner) {
    throw new Error("package command runtime is unavailable");
  }
  const commandName = entrypoint.command?.trim() || entrypoint.name;
  const routeBase = packageRouteBase(record.manifest.name);
  const runner = ctx.getAppRunner(identity.uid, record.packageId) as PackageRunnerStub;
  const now = Date.now();
  await runner.ensureRuntime({
    packageId: record.packageId,
    packageName: record.manifest.name,
    routeBase,
    entrypointName: commandName,
    artifact: record.artifact,
    appFrame: {
      uid: identity.uid,
      username: identity.username,
      packageId: record.packageId,
      packageName: record.manifest.name,
      entrypointName: commandName,
      routeBase,
      issuedAt: now,
      expiresAt: now + 365 * 24 * 60 * 60 * 1000,
    },
  });

  return runner.runCommand({
    commandName,
    args,
    cwd,
    uid: identity.uid,
    gid: identity.gid,
    username: identity.username,
  });
}

function truncate(str: string, maxBytes: number): string {
  if (new TextEncoder().encode(str).length <= maxBytes) return str;
  const truncated = str.slice(0, maxBytes);
  return truncated + "\n...[truncated]";
}
