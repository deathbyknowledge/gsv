import type { KernelContext } from "./context";
import { resolveCallerOwnerUid } from "./context";
import type { SignalWatchTargetInput } from "./signal-watches";
import type { SignalUnwatchArgs, SignalUnwatchResult, SignalWatchArgs, SignalWatchResult } from "@humansandmachines/gsv/protocol";

const DEFAULT_SIGNAL_WATCH_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SIGNAL_WATCH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function handleSignalWatch(
  args: SignalWatchArgs,
  ctx: KernelContext,
): SignalWatchResult {
  const target = resolveSignalWatchTarget(ctx, args);
  const ownerUid = resolveCallerOwnerUid(ctx);

  const signal = args.signal.trim();
  if (!signal) {
    throw new Error("signal is required");
  }

  const processId = typeof args.processId === "string" && args.processId.trim().length > 0
    ? args.processId.trim()
    : null;
  if (processId) {
    const proc = ctx.procs.get(processId);
    if (!proc || proc.ownerUid !== ownerUid) {
      throw new Error(`Unknown process: ${processId}`);
    }
  }
  if (!processId) {
    throw new Error("process runtimes must watch an explicit processId");
  }
  if (processId === target.processId) {
    throw new Error("process runtimes cannot watch their own signals");
  }

  const expiresAt = Date.now() + clampSignalWatchTtl(args.ttlMs);
  const key = typeof args.key === "string" && args.key.trim().length > 0
    ? args.key.trim()
    : null;

  const { watch, created } = ctx.signalWatches.upsert({
    uid: ownerUid,
    target,
    signal,
    processId,
    key,
    state: args.state,
    once: args.once,
    expiresAt,
  });

  return {
    watchId: watch.watchId,
    created,
    createdAt: watch.createdAt,
    expiresAt: watch.expiresAt,
  };
}

export function handleSignalUnwatch(
  args: SignalUnwatchArgs,
  ctx: KernelContext,
): SignalUnwatchResult {
  const target = resolveSignalWatchTarget(ctx, args);
  const uid = resolveCallerOwnerUid(ctx);

  if ("watchId" in args) {
    if (typeof args.watchId !== "string") {
      throw new Error("signal.unwatch watchId must be a string");
    }
    return {
      removed: ctx.signalWatches.removeById(uid, target, args.watchId),
    };
  }

  if (!("key" in args) || typeof args.key !== "string") {
    throw new Error("signal.unwatch requires either watchId or key");
  }

  return {
    removed: ctx.signalWatches.removeByKey(uid, target, args.key),
  };
}

function resolveSignalWatchTarget(
  ctx: KernelContext,
  _args: SignalWatchArgs | SignalUnwatchArgs,
): SignalWatchTargetInput {
  if (ctx.processId) {
    return {
      kind: "process",
      processId: ctx.processId,
    };
  }
  throw new Error("signal.watch is only available to process runtimes");
}

function clampSignalWatchTtl(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SIGNAL_WATCH_TTL_MS;
  }
  return Math.max(1_000, Math.min(MAX_SIGNAL_WATCH_TTL_MS, Math.trunc(value)));
}
