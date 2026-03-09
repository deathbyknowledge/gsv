/**
 * Native shell driver — executes bash commands inside the worker using just-bash.
 *
 * Wires up:
 * - R2BashFs as the primary filesystem (mounted at /)
 * - Virtual mounts for /proc, /dev
 * - Custom OS commands (chown, id, whoami, ps) that call back into kernel services
 * - Per-identity Bash instances with proper uid/gid/env
 */

import { Bash, InMemoryFs, defineCommand } from "just-bash";
import type { BashExecResult, ExecResult, IFileSystem } from "just-bash";
import { R2BashFs } from "./r2-bash-fs";
import type { KernelContext } from "../../kernel/context";
import type { ShellExecArgs, ShellExecResult } from "../../syscalls/shell";
import type { ProcessIdentity } from "../../syscalls/system";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 512 * 1024;

export async function handleShellExec(
  args: ShellExecArgs,
  ctx: KernelContext,
): Promise<ShellExecResult> {
  const identity = ctx.identity!.process;
  const bash = createBash(ctx.env.STORAGE, identity, ctx);
  const cwd = args.workdir ?? identity.home;
  const timeout = args.timeout ?? DEFAULT_TIMEOUT_MS;

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

    const stdout = truncate(result.stdout, MAX_OUTPUT_BYTES);
    const stderr = truncate(result.stderr, MAX_OUTPUT_BYTES);

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

function createBash(
  bucket: R2Bucket,
  identity: ProcessIdentity,
  ctx: KernelContext,
): Bash {
  const r2fs = new R2BashFs(bucket, identity);

  const procFs = new InMemoryFs({
    "self/status": {
      content: [
        `Name:\tinit`,
        `Pid:\t1`,
        `Uid:\t${identity.uid}`,
        `Gid:\t${identity.gid}`,
      ].join("\n"),
    },
  });

  const devFs = new InMemoryFs({
    null: { content: "" },
    zero: { content: "" },
  });

  const mounts: [string, IFileSystem][] = [
    ["/proc", procFs],
    ["/dev", devFs],
  ];

  const composedFs = composeMounts(r2fs, mounts);

  return new Bash({
    fs: composedFs,
    cwd: identity.home,
    env: {
      HOME: identity.home,
      USER: identity.username,
      LOGNAME: identity.username,
      SHELL: "/bin/bash",
      PATH: "/usr/local/bin:/usr/bin:/bin",
      PWD: identity.home,
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
      UID: String(identity.uid),
    },
    processInfo: {
      pid: 1,
      ppid: 0,
      uid: identity.uid,
      gid: identity.gid,
    },
    executionLimits: {
      maxCommandCount: 1000,
      maxCallDepth: 64,
      maxLoopIterations: 10_000,
      maxOutputSize: MAX_OUTPUT_BYTES,
    },
    customCommands: buildCustomCommands(r2fs, identity, ctx),
  });
}

function buildCustomCommands(
  r2fs: R2BashFs,
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
    stdout: "gsv\n",
    stderr: "",
    exitCode: 0,
  }));

  const uname = defineCommand("uname", async (args): Promise<ExecResult> => {
    const flags = args[0] ?? "";
    if (flags.includes("a") || flags === "-a") {
      return { stdout: "GSV gsv 1.0.0 #1 cloudflare-worker\n", stderr: "", exitCode: 0 };
    }
    if (flags.includes("r") || flags === "-r") {
      return { stdout: "1.0.0\n", stderr: "", exitCode: 0 };
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
        await r2fs.chown(target, newUid, newGid);
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
        await r2fs.chmod(target, mode);
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

  return [whoami, id, hostname, uname, chown, chmod, ps];
}

function truncate(str: string, maxBytes: number): string {
  if (new TextEncoder().encode(str).length <= maxBytes) return str;
  const truncated = str.slice(0, maxBytes);
  return truncated + "\n...[truncated]";
}

/**
 * Lightweight mount compositor. The browser bundle of just-bash excludes
 * MountableFs, so we roll a thin proxy that delegates based on path prefix.
 */
function composeMounts(
  base: IFileSystem,
  mounts: [string, IFileSystem][],
): IFileSystem {
  const sorted = [...mounts].sort((a, b) => b[0].length - a[0].length);

  function route(path: string): [IFileSystem, string] {
    for (const [prefix, fs] of sorted) {
      if (path === prefix || path.startsWith(prefix + "/")) {
        return [fs, path.slice(prefix.length) || "/"];
      }
    }
    return [base, path];
  }

  return {
    readFile(path, opts?) { const [fs, p] = route(path); return fs.readFile(p, opts); },
    readFileBuffer(path) { const [fs, p] = route(path); return fs.readFileBuffer(p); },
    writeFile(path, content, opts?) { const [fs, p] = route(path); return fs.writeFile(p, content, opts); },
    appendFile(path, content, opts?) { const [fs, p] = route(path); return fs.appendFile(p, content, opts); },
    exists(path) { const [fs, p] = route(path); return fs.exists(p); },
    stat(path) { const [fs, p] = route(path); return fs.stat(p); },
    lstat(path) { const [fs, p] = route(path); return fs.lstat(p); },
    mkdir(path, opts?) { const [fs, p] = route(path); return fs.mkdir(p, opts); },
    readdir(path) { const [fs, p] = route(path); return fs.readdir(p); },
    rm(path, opts?) { const [fs, p] = route(path); return fs.rm(p, opts); },
    cp(src, dest, opts?) { const [fs, p] = route(src); return fs.cp(p, dest, opts); },
    mv(src, dest) { const [fs, p] = route(src); return fs.mv(p, dest); },
    resolvePath(b, p) { return base.resolvePath(b, p); },
    getAllPaths() { return base.getAllPaths(); },
    chmod(path, mode) { const [fs, p] = route(path); return fs.chmod(p, mode); },
    symlink(target, linkPath) { const [fs, p] = route(linkPath); return fs.symlink(target, p); },
    link(existing, newPath) { const [fs, p] = route(newPath); return fs.link(existing, p); },
    readlink(path) { const [fs, p] = route(path); return fs.readlink(p); },
    realpath(path) { const [fs, p] = route(path); return fs.realpath(p); },
    utimes(path, atime, mtime) { const [fs, p] = route(path); return fs.utimes(p, atime, mtime); },
  };
}
