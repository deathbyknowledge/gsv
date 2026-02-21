import { snapshot, type Proxied } from "../shared/persisted-object";
import type { EventFrame } from "../protocol/frames";
import type {
  NodeProbePayload,
  NodeProbeResultParams,
  NodeRuntimeInfo,
} from "../protocol/tools";
import type { Gateway } from "./do";

const DEFAULT_SKILL_PROBE_TIMEOUT_MS = 15_000;
const MAX_SKILL_PROBE_TIMEOUT_MS = 120_000;
const MAX_SKILL_PROBE_ATTEMPTS = 2;
const DEFAULT_SKILL_PROBE_MAX_AGE_MS = 10 * 60_000;
const MIN_SKILL_PROBE_MAX_AGE_MS = 1000;
const MAX_SKILL_PROBE_MAX_AGE_MS = 24 * 60 * 60_000;

type PendingNodeProbe = {
  nodeId: string;
  agentId: string;
  kind: "bins";
  bins: string[];
  timeoutMs: number;
  attempts: number;
  createdAt: number;
  sentAt?: number;
  expiresAt?: number;
};

export type SkillProbeDeps = {
  scheduleAlarm: () => Promise<void>;
};

export function canNodeProbeBins(gw: Gateway, nodeId: string): boolean {
  const runtime = gw.nodeRuntimeRegistry[nodeId];
  if (!runtime) {
    return false;
  }
  return runtime.hostCapabilities.includes("shell.exec");
}

export function sanitizeSkillBinName(bin: string): string | null {
  const trimmed = bin.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (!/^[A-Za-z0-9._+-]+$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export function clampSkillProbeTimeoutMs(timeoutMs?: number): number {
  const timeoutInput =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
      ? Math.floor(timeoutMs)
      : DEFAULT_SKILL_PROBE_TIMEOUT_MS;
  return Math.max(1000, Math.min(timeoutInput, MAX_SKILL_PROBE_TIMEOUT_MS));
}

export function resolveSkillProbeMaxAgeMs(gw: Gateway): number {
  const configured = gw.getFullConfig().timeouts.skillProbeMaxAgeMs;
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return DEFAULT_SKILL_PROBE_MAX_AGE_MS;
  }

  const normalized = Math.floor(configured);
  return Math.max(
    MIN_SKILL_PROBE_MAX_AGE_MS,
    Math.min(normalized, MAX_SKILL_PROBE_MAX_AGE_MS),
  );
}

function collectPendingProbeBinsForNode(gw: Gateway, nodeId: string): Set<string> {
  const bins = new Set<string>();
  for (const probe of Object.values(gw.pendingNodeProbes)) {
    if (probe.nodeId !== nodeId || probe.kind !== "bins") {
      continue;
    }
    for (const bin of probe.bins) {
      bins.add(bin);
    }
  }
  return bins;
}

function cloneNodeRuntimeInfo(
  runtime: NodeRuntimeInfo,
  overrides?: Partial<NodeRuntimeInfo>,
): NodeRuntimeInfo {
  const plainRuntime = snapshot(
    runtime as unknown as Proxied<NodeRuntimeInfo>,
  );
  const hostCapabilities =
    overrides?.hostCapabilities ?? plainRuntime.hostCapabilities;
  const toolCapabilities =
    overrides?.toolCapabilities ?? plainRuntime.toolCapabilities;
  const hostEnv = overrides?.hostEnv ?? plainRuntime.hostEnv;
  const hostBinStatus = overrides?.hostBinStatus ?? plainRuntime.hostBinStatus;

  return {
    hostRole: overrides?.hostRole ?? plainRuntime.hostRole,
    hostCapabilities: [...hostCapabilities],
    toolCapabilities: Object.fromEntries(
      Object.entries(toolCapabilities).map(([toolName, capabilities]) => [
        toolName,
        [...capabilities],
      ]),
    ),
    hostOs: overrides?.hostOs ?? plainRuntime.hostOs,
    hostEnv: hostEnv ? [...hostEnv] : undefined,
    hostBinStatus: hostBinStatus
      ? Object.fromEntries(
          Object.entries(hostBinStatus).map(([bin, available]) => [
            bin,
            available === true,
          ]),
        )
      : undefined,
    hostBinStatusUpdatedAt:
      overrides?.hostBinStatusUpdatedAt ??
      plainRuntime.hostBinStatusUpdatedAt,
  };
}

function clonePendingNodeProbe(
  probe: PendingNodeProbe,
  overrides?: Partial<PendingNodeProbe>,
): PendingNodeProbe {
  const plainProbe = snapshot(
    probe as unknown as Proxied<PendingNodeProbe>,
  );
  const bins = overrides?.bins ?? plainProbe.bins;
  return {
    nodeId: overrides?.nodeId ?? plainProbe.nodeId,
    agentId: overrides?.agentId ?? plainProbe.agentId,
    kind: overrides?.kind ?? plainProbe.kind,
    bins: [...bins],
    timeoutMs: overrides?.timeoutMs ?? plainProbe.timeoutMs,
    attempts: overrides?.attempts ?? plainProbe.attempts,
    createdAt: overrides?.createdAt ?? plainProbe.createdAt,
    sentAt: overrides?.sentAt ?? plainProbe.sentAt,
    expiresAt: overrides?.expiresAt ?? plainProbe.expiresAt,
  };
}

function dispatchNodeProbe(
  gw: Gateway,
  probeId: string,
  probe: PendingNodeProbe,
): boolean {
  const nodeWs = gw.nodes.get(probe.nodeId);
  if (!nodeWs || nodeWs.readyState !== WebSocket.OPEN) {
    return false;
  }

  const evt: EventFrame<NodeProbePayload> = {
    type: "evt",
    event: "node.probe",
    payload: {
      probeId,
      kind: probe.kind,
      bins: [...probe.bins],
      timeoutMs: probe.timeoutMs,
    },
  };

  try {
    nodeWs.send(JSON.stringify(evt));
  } catch {
    return false;
  }

  const sentAt = Date.now();
  gw.pendingNodeProbes[probeId] = clonePendingNodeProbe(probe, {
    attempts: probe.attempts + 1,
    sentAt,
    expiresAt: sentAt + probe.timeoutMs,
  });
  return true;
}

export function queueNodeBinProbe(
  gw: Gateway,
  params: {
    nodeId: string;
    agentId: string;
    bins: string[];
    timeoutMs: number;
  },
): { probeId?: string; bins: string[]; dispatched: boolean } {
  gcPendingNodeProbes(gw, Date.now(), `queue:${params.nodeId}`);
  const pendingBins = collectPendingProbeBinsForNode(gw, params.nodeId);
  const bins = params.bins
    .map((bin) => sanitizeSkillBinName(bin))
    .filter((bin): bin is string => bin !== null)
    .filter((bin) => !pendingBins.has(bin))
    .sort();

  if (bins.length === 0) {
    return { bins, dispatched: false };
  }

  const probeId = crypto.randomUUID();
  const probe: PendingNodeProbe = {
    nodeId: params.nodeId,
    agentId: params.agentId,
    kind: "bins",
    bins,
    timeoutMs: params.timeoutMs,
    attempts: 0,
    createdAt: Date.now(),
  };
  gw.pendingNodeProbes[probeId] = probe;

  const dispatched = dispatchNodeProbe(gw, probeId, probe);
  return { probeId, bins, dispatched };
}

export function markPendingNodeProbesAsQueued(
  gw: Gateway,
  nodeId: string,
  reason: string,
): void {
  for (const [probeId, probe] of Object.entries(gw.pendingNodeProbes)) {
    if (probe.nodeId !== nodeId || !probe.sentAt) {
      continue;
    }
    gw.pendingNodeProbes[probeId] = clonePendingNodeProbe(probe, {
      attempts: 0,
      sentAt: undefined,
      expiresAt: undefined,
    });
  }
  console.warn(`[Gateway] Marked pending node probes for ${nodeId} as queued: ${reason}`);
}

export async function dispatchPendingNodeProbesForNode(
  gw: Gateway,
  nodeId: string,
  deps: SkillProbeDeps,
): Promise<number> {
  gcPendingNodeProbes(gw, Date.now(), `dispatch:${nodeId}`);
  let dispatched = 0;
  for (const [probeId, probe] of Object.entries(gw.pendingNodeProbes)) {
    if (probe.nodeId !== nodeId || probe.sentAt || probe.attempts >= MAX_SKILL_PROBE_ATTEMPTS) {
      continue;
    }
    if (dispatchNodeProbe(gw, probeId, probe)) {
      dispatched += 1;
    }
  }
  await deps.scheduleAlarm();
  return dispatched;
}

export function nextPendingNodeProbeExpiryAtMs(
  gw: Gateway,
): number | undefined {
  let next: number | undefined;
  for (const probe of Object.values(gw.pendingNodeProbes)) {
    if (!probe.expiresAt) {
      continue;
    }
    if (next === undefined || probe.expiresAt < next) {
      next = probe.expiresAt;
    }
  }
  return next;
}

export function nextPendingNodeProbeGcAtMs(
  gw: Gateway,
  now = Date.now(),
): number | undefined {
  const maxAgeMs = resolveSkillProbeMaxAgeMs(gw);
  let next: number | undefined;
  for (const probe of Object.values(gw.pendingNodeProbes)) {
    const gcAt = probe.createdAt + maxAgeMs;
    const candidate = gcAt <= now ? now : gcAt;
    if (next === undefined || candidate < next) {
      next = candidate;
    }
  }
  return next;
}

export function gcPendingNodeProbes(
  gw: Gateway,
  now = Date.now(),
  reason?: string,
): number {
  const maxAgeMs = resolveSkillProbeMaxAgeMs(gw);
  let removed = 0;
  for (const [probeId, probe] of Object.entries(gw.pendingNodeProbes)) {
    if (probe.createdAt + maxAgeMs > now) {
      continue;
    }
    delete gw.pendingNodeProbes[probeId];
    removed += 1;
  }

  if (removed > 0) {
    console.warn(
      `[Gateway] GC removed ${removed} stale pending node probes${reason ? ` (${reason})` : ""}`,
    );
  }
  return removed;
}

export async function handlePendingNodeProbeTimeouts(
  gw: Gateway,
): Promise<void> {
  const now = Date.now();
  gcPendingNodeProbes(gw, now, "timeout-scan");
  for (const [probeId, probe] of Object.entries(gw.pendingNodeProbes)) {
    if (!probe.expiresAt || probe.expiresAt > now) {
      continue;
    }

    if (probe.attempts < MAX_SKILL_PROBE_ATTEMPTS) {
      const queued: PendingNodeProbe = clonePendingNodeProbe(probe, {
        sentAt: undefined,
        expiresAt: undefined,
      });
      gw.pendingNodeProbes[probeId] = queued;
      const dispatched = dispatchNodeProbe(gw, probeId, queued);
      if (dispatched) {
        console.warn(
          `[Gateway] Retrying node probe ${probeId} for ${probe.nodeId} (attempt ${queued.attempts + 1})`,
        );
        continue;
      }
    }

    console.warn(
      `[Gateway] Node probe ${probeId} timed out for ${probe.nodeId} after ${probe.attempts} attempts`,
    );
    delete gw.pendingNodeProbes[probeId];
  }
}

export async function handleNodeProbeResult(
  gw: Gateway,
  nodeId: string,
  params: NodeProbeResultParams,
  deps: SkillProbeDeps,
): Promise<{ ok: true; dropped?: true }> {
  const probe = gw.pendingNodeProbes[params.probeId];
  if (!probe) {
    return { ok: true, dropped: true };
  }
  if (probe.nodeId !== nodeId) {
    throw new Error(`Node ${nodeId} is not authorized for probe ${params.probeId}`);
  }

  if (probe.kind === "bins") {
    const reported =
      params.bins && typeof params.bins === "object" && !Array.isArray(params.bins)
        ? (params.bins as Record<string, unknown>)
        : {};
    const resultStatus = Object.fromEntries(
      probe.bins.map((bin) => [bin, false]),
    ) as Record<string, boolean>;
    for (const bin of probe.bins) {
      const raw = reported[bin];
      if (typeof raw === "boolean") {
        resultStatus[bin] = raw;
      }
    }

    const runtime = gw.nodeRuntimeRegistry[nodeId];
    if (runtime) {
      const existingStatus = runtime.hostBinStatus ?? {};
      gw.nodeRuntimeRegistry[nodeId] = cloneNodeRuntimeInfo(runtime, {
        hostBinStatus: Object.fromEntries(
          Object.entries({
            ...existingStatus,
            ...resultStatus,
          }).sort(([left], [right]) => left.localeCompare(right)),
        ),
        hostBinStatusUpdatedAt: Date.now(),
      });
    }
  }

  delete gw.pendingNodeProbes[params.probeId];
  await deps.scheduleAlarm();
  return { ok: true };
}
