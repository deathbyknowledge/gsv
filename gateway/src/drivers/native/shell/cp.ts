import { defineCommand, type CommandContext, type ExecResult } from "just-bash";
import type { GsvFs } from "../../../fs/gsv-fs";
import type { KernelContext } from "../../../kernel/context";
import { hasCapability } from "../../../kernel/capabilities";

type ShellCopyEndpoint = {
  target: string;
  path: string;
};

export function buildCpCommand(fs: GsvFs, kernelCtx: KernelContext) {
  return defineCommand("cp", async (args, ctx): Promise<ExecResult> => {
    if (args.includes("--help")) {
      return { stdout: "cp SOURCE DEST\n", stderr: "", exitCode: 0 };
    }

    const operands = args.filter((arg) => arg !== "--");
    const unsupported = operands.find((arg) => arg.startsWith("-"));
    if (unsupported) {
      return { stdout: "", stderr: `cp: unsupported option '${unsupported}'\n`, exitCode: 1 };
    }
    if (operands.length < 2) {
      return { stdout: "", stderr: "cp: missing destination file operand\n", exitCode: 1 };
    }
    if (operands.length > 2) {
      return { stdout: "", stderr: "cp: multiple source files are not supported yet\n", exitCode: 1 };
    }

    requireShellCapability(kernelCtx, "fs.read");
    requireShellCapability(kernelCtx, "fs.write");

    const source = parseShellCopyEndpoint(operands[0], ctx);
    let destination = parseShellCopyEndpoint(operands[1], ctx);

    if (source.target !== "gsv" || destination.target !== "gsv") {
      return {
        stdout: "",
        stderr: "cp: device endpoints are not wired yet; only gsv paths are supported\n",
        exitCode: 1,
      };
    }

    try {
      const destinationStat = await fs.statExtended(destination.path);
      if (destinationStat.isDirectory) {
        destination = {
          ...destination,
          path: joinShellPath(destination.path, shellBasename(source.path)),
        };
      }
    } catch {
      // Destination does not exist; copy to the requested path.
    }

    try {
      const opened = await fs.openFile(source.path);
      if (opened.status !== 200 || !opened.body) {
        return { stdout: "", stderr: `cp: cannot open '${operands[0]}'\n`, exitCode: 1 };
      }
      await fs.writeFileStream(destination.path, opened.body, {
        expectedSize: opened.size,
        ...(opened.contentType ? { contentType: opened.contentType } : {}),
      });
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { stdout: "", stderr: `cp: ${msg}\n`, exitCode: 1 };
    }
  });
}

function parseShellCopyEndpoint(spec: string, ctx: CommandContext): ShellCopyEndpoint {
  const match = spec.match(/^([A-Za-z0-9_.-]+):(.*)$/);
  if (match) {
    const target = match[1] || "gsv";
    const path = match[2] || ".";
    return {
      target,
      path: target === "gsv" ? ctx.fs.resolvePath(ctx.cwd, path) : path,
    };
  }
  return {
    target: "gsv",
    path: ctx.fs.resolvePath(ctx.cwd, spec),
  };
}

function requireShellCapability(ctx: KernelContext, capability: string): void {
  const capabilities = ctx.identity?.capabilities ?? [];
  if (!hasCapability(capabilities, capability)) {
    throw new Error(`Permission denied: ${capability}`);
  }
}

function shellBasename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

function joinShellPath(parent: string, child: string): string {
  return parent.endsWith("/") ? `${parent}${child}` : `${parent}/${child}`;
}
