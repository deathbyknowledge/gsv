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
import { createPackageBackend, createWorkspaceBackend, resolveUserPath } from "../../fs";
import type { KernelContext } from "../../kernel/context";
import {
  packageArtifactToWorkerCode,
  packageDoName,
  packageRouteBase,
  packageWorkerKey,
  type InstalledPackageRecord,
  type PackageEntrypoint,
} from "../../kernel/packages";
import type { ShellExecArgs, ShellExecResult } from "../../syscalls/shell";
import type { ProcessIdentity } from "../../syscalls/system";

export async function handleShellExec(
  args: ShellExecArgs,
  ctx: KernelContext,
): Promise<ShellExecResult> {
  const identity = ctx.identity!.process;
  const cwd = args.workdir
    ? resolveUserPath(args.workdir, identity.home, identity.cwd)
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
      result = await bash.exec(args.command, {
        cwd,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const stdout = truncate(result.stdout, maxOutput);
    const stderr = truncate(result.stderr, maxOutput);

    return {
      ok: true,
      pid: 0,
      exitCode: result.exitCode,
      stdout,
      stderr,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: `Command timed out after ${timeout}ms` };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function createBash(ctx: KernelContext, identity: ProcessIdentity, cwd: string): Bash {
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
type PackageCommandInput = {
  args: string[];
  cwd: string;
  uid: number;
  gid: number;
  username: string;
};
type PackageCommandResult = {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
};
type PackageCommandStub = {
  run: (input?: PackageCommandInput) => Promise<PackageCommandResult>;
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
    const ver = ctx.config.get("config/server/version") ?? "0.0.1";
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

  const ls = buildLsCommand(fs, identity, ctx);
  const stat = buildStatCommand(fs, identity, ctx);
  const packageCommands = buildPackageCommands(identity, ctx);

  return [whoami, id, hostname, uname, chown, chmod, ps, ls, stat, ...packageCommands];
}

function buildPackageCommands(identity: ProcessIdentity, ctx: KernelContext) {
  const commands = [];
  const reserved = new Set([
    "whoami",
    "id",
    "hostname",
    "uname",
    "chown",
    "chmod",
    "ps",
    "ls",
    "stat",
  ]);

  for (const record of ctx.packages.list({ enabled: true })) {
    for (const entrypoint of record.manifest.entrypoints) {
      if (entrypoint.kind !== "command") continue;
      const commandName = entrypoint.command?.trim();
      if (!commandName || reserved.has(commandName)) continue;
      reserved.add(commandName);
      commands.push(defineCommand(commandName, async (args, bashCtx): Promise<ExecResult> => {
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
      }));
    }
  }

  return commands;
}

async function runPackageCommand(
  record: InstalledPackageRecord,
  entrypoint: PackageEntrypoint,
  args: string[],
  cwd: string,
  identity: ProcessIdentity,
  ctx: KernelContext,
): Promise<PackageCommandResult> {
  const worker = ctx.env.LOADER.get(
    packageWorkerKey(record),
    () => packageArtifactToWorkerCode(record.artifact, {
      PACKAGE_NAME: record.manifest.name,
      PACKAGE_ID: record.packageId,
      PACKAGE_DO_NAME: packageDoName(record.manifest.name),
    }),
  );
  const stub = worker.getEntrypoint(resolvePackageCommandExportName(entrypoint.exportName), {
    props: {
      commandName: entrypoint.command ?? entrypoint.name,
      packageId: record.packageId,
      routeBase: packageRouteBase(record.manifest.name),
    },
  }) as unknown as PackageCommandStub;

  return stub.run({
    args,
    cwd,
    uid: identity.uid,
    gid: identity.gid,
    username: identity.username,
  });
}

function resolvePackageCommandExportName(exportName?: string): string | undefined {
  if (!exportName || exportName === "default") {
    return undefined;
  }
  return exportName;
}

function truncate(str: string, maxBytes: number): string {
  if (new TextEncoder().encode(str).length <= maxBytes) return str;
  const truncated = str.slice(0, maxBytes);
  return truncated + "\n...[truncated]";
}
