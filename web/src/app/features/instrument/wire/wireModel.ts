import { z } from "zod";
import type { ConsoleProcess, ConsoleTarget } from "../../../domain/system/consoleModels";
import { normalizeProcessState } from "../../../domain/system/consoleNormalization";
import type { LedgerLine } from "../fleet/fleetModel";
import { sysLedgerListResultSchema } from "../fleet/fleetModel";
import type { SysLedgerChangedSignal } from "@humansandmachines/gsv/protocol";

/* what each signal carries, as far as the instrument needs it */

export const targetStatusSignalSchema = z.object({
  event: z.enum(["connected", "disconnected"]),
  target: z.object({
    targetId: z.string(),
    label: z.string().optional(),
    description: z.string().optional(),
    lastSeenAt: z.number().nullable().optional(),
  }),
});

export const procSignalSchema = z.object({
  pid: z.string(),
  changes: z.array(z.string()).optional(),
  runId: z.string().optional(),
  queuedCount: z.number().optional(),
  timestamp: z.number().optional(),
  runtime: z.object({
    state: z.enum(["idle", "queued", "running", "waiting_tool", "waiting_hil"]),
    activeRunId: z.string().nullable(),
    queuedCount: z.number().int().nonnegative(),
    lastActiveAt: z.number().nullable(),
  }).optional(),
  aiConfig: z.object({
    version: z.literal(2),
    modelId: z.string().optional(),
    reasoning: z.string().optional(),
    updatedAt: z.number(),
  }).nullable().optional(),
});

// eslint-disable-next-line anti-slop/no-shape-in-symbol-names -- shape is Zod's public schema accessor.
export const ledgerChangedSignalSchema = z.object({ lines: sysLedgerListResultSchema.shape.lines.max(32) }) satisfies z.ZodType<SysLedgerChangedSignal>;

export type Patch<T> = { next: T; known: boolean };

/** A target's status from the wire, applied to the cached list; `known` is false when the list has never seen it. */
export function patchTargets(current: readonly ConsoleTarget[], signal: z.infer<typeof targetStatusSignalSchema>, now: number): Patch<ConsoleTarget[]> {
  const online = signal.event === "connected";
  const index = current.findIndex((target) => target.deviceId === signal.target.targetId);
  if (index < 0) return { next: [...current], known: false };
  const next = current.map((target, position) =>
    position === index
      ? {
          ...target,
          online,
          label: signal.target.label ?? target.label,
          description: signal.target.description ?? target.description,
          lastSeenAt: online ? now : (signal.target.lastSeenAt ?? now),
        }
      : target,
  );
  return { next, known: true };
}

export type ProcessSignalName = "proc.changed" | "process.exit";

export function isProcessSignal(signal: string): signal is ProcessSignalName {
  return signal === "proc.changed" || signal === "process.exit";
}

/** A process signal applied to the cached list: run state, queue length, last activity, or removal on exit. */
export function patchProcesses(
  current: readonly ConsoleProcess[],
  signal: ProcessSignalName,
  payload: z.infer<typeof procSignalSchema>,
): Patch<ConsoleProcess[]> {
  const index = current.findIndex((process) => process.pid === payload.pid);
  if (index < 0) return { next: [...current], known: signal === "process.exit" };
  if (signal === "process.exit") return { next: current.filter((process) => process.pid !== payload.pid), known: true };
  const runtime = payload.runtime;
  if (!runtime) return { next: [...current], known: true };
  const next = current.map((process, position) => {
    if (position !== index) return process;
    return {
      ...process,
      ...runtime,
      rawState: runtime.state,
      state: normalizeProcessState(runtime.state, runtime.activeRunId, runtime.queuedCount),
    };
  });
  return { next, known: true };
}

export type LedgerPage = { lines: LedgerLine[]; nextCursor: string | null };
export type LedgerPages = { pages: LedgerPage[]; pageParams: (string | null)[] };

export function ledgerSequence(line: LedgerLine | undefined): number {
  return Number(line?.id.slice("sys:".length) ?? 0);
}

/** Patch loaded rows and insert rows newer than the ordinary snapshot, including out-of-order owner batches. */
export function mergeLedgerChanges(data: LedgerPages, changes: readonly LedgerLine[], snapshotHead: number): LedgerPages {
  const updates = new Map(changes.map((line) => [line.id, line]));
  const seen = new Set<string>();
  let changed = false;
  const pages = data.pages.map((page) => {
    let pageChanged = false;
    const lines = page.lines.map((line) => {
      seen.add(line.id);
      const update = updates.get(line.id);
      if (!update || (line.outcome !== "running" && update.outcome === "running")) return line;
      if (line.outcome === update.outcome && line.costNanoUsd === update.costNanoUsd) return line;
      pageChanged = changed = true;
      return update;
    });
    return pageChanged ? { ...page, lines } : page;
  });
  const fresh = [...updates.values()].filter((line) => !seen.has(line.id) && ledgerSequence(line) > snapshotHead);
  const patched = changed ? { ...data, pages } : data;
  if (fresh.length === 0) return patched;
  const next = prependLedger(patched, fresh);
  next.pages[0].lines.sort((a, b) => ledgerSequence(b) - ledgerSequence(a));
  return next;
}

/** Fresh lines, newest first, put in front of the first cached page; lines the cache already holds are skipped. */
export function prependLedger(data: LedgerPages, fresh: readonly LedgerLine[]): LedgerPages {
  if (data.pages.length === 0) return { pages: [{ lines: [...fresh], nextCursor: null }], pageParams: [null] };
  const seen = new Set(data.pages.flatMap((page) => page.lines.map((line) => line.id)));
  const added = fresh.filter((line) => !seen.has(line.id));
  if (added.length === 0) return data;
  const [first, ...rest] = data.pages;
  return { pages: [{ ...first, lines: [...added, ...first.lines] }, ...rest], pageParams: data.pageParams };
}
