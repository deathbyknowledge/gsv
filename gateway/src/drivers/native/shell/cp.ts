import { defineCommand, type CommandContext, type ExecResult } from "just-bash";
import type { KernelContext } from "../../../kernel/context";
import { handleFsCopy, type FsCopyDeviceTransport } from "../fs";

type ShellCopyEndpoint = {
  target: string;
  path: string;
};

export function buildCpCommand(
  kernelCtx: KernelContext,
  transport?: FsCopyDeviceTransport,
) {
  return defineCommand("cp", async (args, ctx): Promise<ExecResult> => {
    if (args.includes("--help")) {
      return {
        stdout: [
          "cp SOURCE DEST",
          "",
          "Copy one file locally or across targets.",
          "Paths may be local, gsv:/path, target:/path, or [target-with-colons]:/path.",
          "",
          "Examples:",
          "  cp rearden:/home/hank/report.pdf /tmp/report.pdf",
          "  cp /tmp/report.pdf [rearden:brave]:/tmp/report.pdf",
          "",
        ].join("\n"),
        stderr: "",
        exitCode: 0,
      };
    }

    const operands = args.filter((arg) => arg !== "--");
    const unsupported = operands.find((arg) => arg.startsWith("-"));
    if (unsupported) {
      return {
        stdout: "",
        stderr: `cp: unsupported option '${unsupported}'\n`,
        exitCode: 1,
      };
    }
    if (operands.length < 2) {
      return {
        stdout: "",
        stderr: "cp: missing destination file operand\n",
        exitCode: 1,
      };
    }
    if (operands.length > 2) {
      return {
        stdout: "",
        stderr: "cp: multiple source files are not supported yet\n",
        exitCode: 1,
      };
    }

    const source = parseShellCopyEndpoint(operands[0], ctx, kernelCtx);
    const destination = parseShellCopyEndpoint(operands[1], ctx, kernelCtx);

    try {
      const result = await handleFsCopy(
        {
          source,
          destination,
        },
        kernelCtx,
        transport,
      );
      if (!result.ok) {
        return { stdout: "", stderr: `cp: ${result.error}\n`, exitCode: 1 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { stdout: "", stderr: `cp: ${msg}\n`, exitCode: 1 };
    }
  });
}

function parseShellCopyEndpoint(
  spec: string,
  ctx: CommandContext,
  kernelCtx: KernelContext,
): ShellCopyEndpoint {
  const bracket = spec.match(/^\[([^\]]+)]:(.*)$/);
  if (bracket) {
    const target = bracket[1] || "gsv";
    const path = bracket[2] || ".";
    return {
      target,
      path: target === "gsv" ? ctx.fs.resolvePath(ctx.cwd, path) : path,
    };
  }

  for (const target of knownCopyTargets(kernelCtx)) {
    const prefix = `${target}:`;
    if (!spec.startsWith(prefix)) {
      continue;
    }
    const path = spec.slice(prefix.length) || ".";
    return {
      target,
      path: target === "gsv" ? ctx.fs.resolvePath(ctx.cwd, path) : path,
    };
  }

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

function knownCopyTargets(kernelCtx: KernelContext): string[] {
  const identity = kernelCtx.identity?.process;
  const targets = new Set(["gsv"]);
  if (!identity) {
    return [...targets];
  }

  try {
    for (const device of kernelCtx.devices.listForUser(identity.uid, identity.gids)) {
      targets.add(device.device_id);
    }
  } catch {
    // Some tests and process contexts only need local GSV paths.
  }

  return [...targets].sort((left, right) => right.length - left.length);
}
