import { defineCommand } from "just-bash";
import type { ExecResult } from "just-bash";
import { GsvFs } from "../../../fs/gsv-fs";
import type { KernelContext } from "../../../kernel/context";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import { formatMode, loadNameCache, resolveOwner, type NameCache } from "./metadata";

export function buildStatCommand(fs: GsvFs, identity: ProcessIdentity, kernelCtx: KernelContext) {
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
