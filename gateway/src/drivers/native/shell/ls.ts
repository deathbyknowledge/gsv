import { defineCommand } from "just-bash";
import type { ExecResult } from "just-bash";
import { GsvFs } from "../../../fs/gsv-fs";
import type { ExtendedStat } from "../../../fs/gsv-fs";
import type { KernelContext } from "../../../kernel/context";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import {
  classifyIndicator,
  formatDate,
  formatMode,
  humanSize,
  loadNameCache,
  resolveOwner,
  type NameCache,
} from "./metadata";

export function buildLsCommand(fs: GsvFs, identity: ProcessIdentity, kernelCtx: KernelContext) {
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
