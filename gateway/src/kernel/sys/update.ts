import type {
  SysCliDownloadsResult,
  SysUpdateArgs,
  SysUpdateResult,
  SysUpdateTarget,
} from "@humansandmachines/gsv/protocol";
import {
  CLI_BINARY_ASSETS,
  CLI_RELEASE_CHANNELS,
  parseCliReleaseChannel,
  readDefaultCliChannel,
  mirrorCliChannel,
  storeCliInstallScripts,
  storeDefaultCliChannel,
  type CliReleaseChannel,
} from "../../downloads/cli";
import type { KernelContext } from "../context";

type CliRefreshStep = <T>(label: string, run: () => T | Promise<T>) => Promise<T>;
type CliRefreshLimit = <T>(run: () => T | Promise<T>) => Promise<T>;

export type CliDownloadsRefreshOptions = {
  defaultChannel?: CliReleaseChannel;
  step?: CliRefreshStep;
  limit?: CliRefreshLimit;
};

const ALL_UPDATE_TARGETS: readonly SysUpdateTarget[] = ["artifacts.cli"];

export async function handleSysUpdate(
  args: SysUpdateArgs | undefined,
  ctx: KernelContext,
): Promise<SysUpdateResult> {
  if (!ctx.env.STORAGE) {
    throw new Error("STORAGE binding is required for system update");
  }

  const targets = parseUpdateTargets(args?.targets);
  const defaultChannel = parseRequestedDefaultChannel(args?.options?.["artifacts.cli"]?.defaultChannel);
  const startedAt = Date.now();
  try {
    const updates: SysUpdateResult["updates"] = [];
    if (targets.includes("artifacts.cli")) {
      updates.push({
        target: "artifacts.cli",
        cli: await refreshCliDownloads(ctx.env.STORAGE, { defaultChannel }),
      });
    }
    console.info(
      `[sys.update] updated targets=${targets.join(",")} in ${Date.now() - startedAt}ms`,
    );
    return {
      updatedAt: Date.now(),
      updates,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[sys.update] failed after ${Date.now() - startedAt}ms: ${message}`);
    throw error;
  }
}

export async function refreshCliDownloads(
  bucket: R2Bucket,
  options: CliDownloadsRefreshOptions = {},
): Promise<SysCliDownloadsResult> {
  const step = options.step ?? defaultStep;
  const limit = options.limit ?? defaultLimit;
  const defaultChannel = options.defaultChannel
    ?? await step("read-default-cli-channel", () => readDefaultCliChannel(bucket))
    ?? "dev";

  const mirroredChannels = await allSettledOrThrow(CLI_RELEASE_CHANNELS.map((channel) =>
    limit(async () => {
      await step(`mirror-cli:${channel}`, () => mirrorCliChannel(bucket, channel));
      return channel;
    })
  ));

  await allSettledOrThrow([
    limit(() => step("store-default-cli-channel", () => storeDefaultCliChannel(bucket, defaultChannel))),
    limit(() => step("store-cli-install-scripts", () => storeCliInstallScripts(bucket))),
  ]);

  return {
    defaultChannel,
    mirroredChannels,
    assets: [...CLI_BINARY_ASSETS],
    refreshedAt: Date.now(),
  };
}

async function defaultStep<T>(
  _label: string,
  run: () => T | Promise<T>,
): Promise<T> {
  return await run();
}

async function defaultLimit<T>(run: () => T | Promise<T>): Promise<T> {
  return await run();
}

function parseRequestedDefaultChannel(value: unknown): CliReleaseChannel | undefined {
  if (value === undefined) {
    return undefined;
  }
  const channel = parseCliReleaseChannel(value);
  if (!channel) {
    throw new Error("sys.update artifacts.cli defaultChannel must be stable or dev");
  }
  return channel;
}

function parseUpdateTargets(value: unknown): SysUpdateTarget[] {
  if (value === undefined) {
    return [...ALL_UPDATE_TARGETS];
  }
  if (!Array.isArray(value)) {
    throw new Error("sys.update targets must be an array");
  }
  if (value.length === 0) {
    return [...ALL_UPDATE_TARGETS];
  }

  const targets: SysUpdateTarget[] = [];
  for (const rawTarget of value) {
    if (!isUpdateTarget(rawTarget)) {
      throw new Error(`Unsupported sys.update target: ${String(rawTarget)}`);
    }
    if (!targets.includes(rawTarget)) {
      targets.push(rawTarget);
    }
  }
  return targets;
}

function isUpdateTarget(value: unknown): value is SysUpdateTarget {
  return (ALL_UPDATE_TARGETS as readonly unknown[]).includes(value);
}

async function allSettledOrThrow<T extends readonly unknown[]>(
  promises: { [K in keyof T]: Promise<T[K]> },
): Promise<T> {
  const results = await Promise.allSettled(promises);
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (rejected) {
    throw rejected.reason;
  }
  return results.map((result) => (result as PromiseFulfilledResult<unknown>).value) as unknown as T;
}
