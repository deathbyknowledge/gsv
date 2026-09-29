import type { SysBootstrapArgs, SysBootstrapResult } from "@humansandmachines/gsv/protocol";
import { RipgitClient } from "../../fs/ripgit/client";
import type { KernelContext } from "../context";
import { principalOf, requirePrincipal } from "../context";
import { seedBuiltinSkillsToHome } from "./skills-seed";

type BootstrapTiming = {
  label: string;
  ms: number;
};

async function timeBootstrapStep<T>(
  timings: BootstrapTiming[],
  label: string,
  run: () => T | Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await run();
  } finally {
    timings.push({ label, ms: Date.now() - startedAt });
  }
}

function formatBootstrapTimings(timings: BootstrapTiming[]): string {
  if (timings.length === 0) {
    return "no steps completed";
  }
  return timings.map((timing) => `${timing.label}=${timing.ms}ms`).join(", ");
}

export async function handleSysBootstrap(
  args: SysBootstrapArgs | undefined,
  ctx: KernelContext,
): Promise<SysBootstrapResult> {
  if (args && Object.keys(args).length > 0) {
    throw new Error("sys.bootstrap does not accept source overrides");
  }
  if (!ctx.env.RIPGIT) {
    throw new Error("RIPGIT binding is required for system bootstrap");
  }
  if (!principalOf(ctx)) {
    throw new Error("Authenticated identity required");
  }

  const ripgit = new RipgitClient(ctx.env.RIPGIT);
  const startedAt = Date.now();
  const timings: BootstrapTiming[] = [];

  try {
    const imported = await timeBootstrapStep(timings, "import-gsv-manual", () => ctx.manual.refresh());
    await timeBootstrapStep(timings, "seed-skills", () => seedBuiltinSkillsToHome(
      ripgit,
      requirePrincipal(ctx).account,
    ));

    console.info(
      `[sys.bootstrap] completed in ${Date.now() - startedAt}ms (${formatBootstrapTimings(timings)})`,
    );

    return imported;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[sys.bootstrap] failed after ${Date.now() - startedAt}ms (${formatBootstrapTimings(timings)}): ${message}`,
    );
    throw error;
  }
}
