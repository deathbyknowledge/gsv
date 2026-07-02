import type {
  SysCliRefreshArgs,
  SysCliRefreshResult,
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

export async function handleSysCliRefresh(
  args: SysCliRefreshArgs | undefined,
  ctx: KernelContext,
): Promise<SysCliRefreshResult> {
  if (!ctx.env.STORAGE) {
    throw new Error("STORAGE binding is required for CLI refresh");
  }

  const defaultChannel = parseRequestedDefaultChannel(args?.defaultChannel);
  const startedAt = Date.now();
  try {
    const result = await refreshCliDownloads(ctx.env.STORAGE, { defaultChannel });
    console.info(
      `[sys.cli.refresh] refreshed channels=${result.mirroredChannels.join(",")} default=${result.defaultChannel} in ${Date.now() - startedAt}ms`,
    );
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[sys.cli.refresh] failed after ${Date.now() - startedAt}ms: ${message}`);
    throw error;
  }
}

export async function refreshCliDownloads(
  bucket: R2Bucket,
  options: CliDownloadsRefreshOptions = {},
): Promise<SysCliRefreshResult> {
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
    throw new Error("sys.cli.refresh defaultChannel must be stable or dev");
  }
  return channel;
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
