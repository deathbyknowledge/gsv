import type { FsCopyEndpoint } from "@humansandmachines/gsv/protocol";
import type { CommandContext } from "just-bash";
import type { KernelContext } from "../../../kernel/context";

export function parseShellFsEndpoint(
  spec: string,
  ctx: CommandContext,
  kernelCtx: KernelContext,
): Required<FsCopyEndpoint> {
  const bracket = spec.match(/^\[([^\]]+)]:(.*)$/);
  if (bracket) {
    return resolveEndpoint(bracket[1] || "gsv", bracket[2] || ".", ctx);
  }

  for (const target of knownFsTargets(kernelCtx)) {
    const prefix = `${target}:`;
    if (spec.startsWith(prefix)) {
      return resolveEndpoint(target, spec.slice(prefix.length) || ".", ctx);
    }
  }

  const match = spec.match(/^([A-Za-z0-9_.-]+):(.*)$/);
  if (match) {
    return resolveEndpoint(match[1] || "gsv", match[2] || ".", ctx);
  }

  return resolveEndpoint("gsv", spec, ctx);
}

function resolveEndpoint(
  target: string,
  path: string,
  ctx: CommandContext,
): Required<FsCopyEndpoint> {
  return {
    target,
    path: target === "gsv" ? ctx.fs.resolvePath(ctx.cwd, path) : path,
  };
}

function knownFsTargets(kernelCtx: KernelContext): string[] {
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
