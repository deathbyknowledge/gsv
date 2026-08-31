import type { ProcHilRequest } from "../../../packages/gsv/src/protocol/syscalls/proc.js";
import { callLinkedAdapterGateway, type AdapterGatewayBinding } from "./gateway-rpc";
import type {
  AdapterInstallationContext,
  AdapterLinkedPeerContext,
  AdapterPeerDeliveryContext,
  AdapterSurface,
} from "./types";

export type AdapterHilDecision = {
  decision: "approve" | "deny";
  remember: boolean;
};

export type AdapterHilResolution = "approve" | "approve_always" | "deny" | "stale";

export type AdapterHilCallback = AdapterHilDecision & {
  provider: string;
  token: string;
  binding?: string;
  actorId: string;
  surface: AdapterSurface;
  providerMessageId: string;
  interactionId: string;
};

export type AdapterHilSubmission =
  | { kind: "invalid" }
  | { kind: "processing" }
  | { kind: "resolved"; resolution?: AdapterHilResolution }
  | { kind: "submitted"; resolution: AdapterHilResolution };

type StoredAdapterHilRequest = Pick<ProcHilRequest, "pid" | "requestId" | "runId">;

type AdapterHilRecord = {
  version: 1;
  provider: string;
  token: string;
  binding?: string;
  context: AdapterPeerDeliveryContext;
  request: StoredAdapterHilRequest;
  state: "pending" | "processing" | "resolved";
  processingInteractionId?: string;
  processingAt?: number;
  providerMessageId?: string;
  resolution?: AdapterHilResolution;
  createdAt: number;
  expiresAt: number;
};

const APPROVAL_PREFIX = "adapter_hil:v1:";
const APPROVAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const APPROVAL_PROCESSING_LEASE_MS = 60_000;

/** Persist one interaction-scoped callback capability before rendering controls. */
export async function prepareAdapterHilApproval(
  storage: DurableObjectStorage,
  provider: string,
  binding: string | undefined,
  context: AdapterPeerDeliveryContext,
  request: ProcHilRequest,
): Promise<string | null> {
  if (
    context.surface.kind !== "dm"
    || !context.actorId
    || !context.processId
    || !context.runId
    || context.processId !== request.pid
    || context.runId !== request.runId
  ) {
    return null;
  }

  const normalizedProvider = requireProvider(provider);
  const token = await approvalToken(normalizedProvider, context.deliveryId);
  const key = approvalKey(normalizedProvider, token);
  const now = Date.now();
  await storage.transaction(async (txn) => {
    const existing = await txn.get<AdapterHilRecord>(key);
    if (existing && existing.expiresAt > now) {
      if (!sameApproval(existing, normalizedProvider, binding, context, request)) {
        throw new Error("Adapter approval token is already bound to another request");
      }
      return;
    }
    const record: AdapterHilRecord = {
      version: 1,
      provider: normalizedProvider,
      token,
      context,
      request: {
        pid: request.pid,
        requestId: request.requestId,
        runId: request.runId,
      },
      state: "pending",
      createdAt: now,
      expiresAt: now + APPROVAL_RETENTION_MS,
    };
    if (binding !== undefined) record.binding = binding;
    await txn.put(key, record);
  });
  await pruneAdapterHilApprovals(storage, now);
  return token;
}

export async function attachAdapterHilApprovalMessage(
  storage: DurableObjectStorage,
  provider: string,
  token: string,
  providerMessageId: string | undefined,
): Promise<void> {
  if (!providerMessageId) return;
  const key = approvalKey(requireProvider(provider), token);
  await storage.transaction(async (txn) => {
    const record = await txn.get<AdapterHilRecord>(key);
    if (!record || record.providerMessageId === providerMessageId) return;
    await txn.put(key, { ...record, providerMessageId } satisfies AdapterHilRecord);
  });
}

/** Resolve a provider callback through the ordinary linked-human proc.hil path. */
export async function submitAdapterHilApproval(
  storage: DurableObjectStorage,
  gateway: AdapterGatewayBinding,
  installation: AdapterInstallationContext,
  callback: AdapterHilCallback,
): Promise<AdapterHilSubmission> {
  const provider = requireProvider(callback.provider);
  const key = approvalKey(provider, callback.token);
  const now = Date.now();
  const claimed = await storage.transaction(async (txn) => {
    const record = await txn.get<AdapterHilRecord>(key);
    if (!matchesCallback(record, provider, callback, now)) {
      return { kind: "invalid" as const };
    }
    if (record.state === "resolved") {
      return { kind: "resolved" as const, record };
    }
    if (
      record.state === "processing"
      && (record.processingAt ?? record.createdAt) + APPROVAL_PROCESSING_LEASE_MS > now
    ) {
      return { kind: "processing" as const };
    }
    const processing: AdapterHilRecord = {
      ...record,
      state: "processing",
      processingInteractionId: callback.interactionId,
      processingAt: now,
    };
    await txn.put(key, processing);
    return { kind: "claimed" as const, record: processing };
  });

  if (claimed.kind === "invalid" || claimed.kind === "processing") return claimed;
  if (claimed.kind === "resolved") {
    return { kind: "resolved", resolution: claimed.record.resolution };
  }

  const record = claimed.record;
  let result;
  try {
    const linkedContext: AdapterLinkedPeerContext = {
      accountId: record.context.accountId,
      actorId: callback.actorId,
      surface: record.context.surface,
      interactionId: callback.interactionId,
    };
    if (record.context.routeGeneration) {
      linkedContext.routeGeneration = record.context.routeGeneration;
    }
    result = await callLinkedAdapterGateway(
      gateway,
      installation,
      linkedContext,
      "proc.hil",
      {
        pid: record.request.pid,
        requestId: record.request.requestId,
        decision: callback.decision,
        remember: callback.remember,
      },
    );
  } catch (error) {
    await releaseAdapterHilApproval(storage, key, callback.interactionId);
    throw error;
  }

  const resolution: AdapterHilResolution = result.ok
    ? callback.decision === "deny"
      ? "deny"
      : callback.remember
        ? "approve_always"
        : "approve"
    : "stale";
  await storage.transaction(async (txn) => {
    const current = await txn.get<AdapterHilRecord>(key);
    if (!current) return;
    const {
      processingAt: _,
      processingInteractionId: __,
      ...resolved
    } = current;
    await txn.put(key, {
      ...resolved,
      state: "resolved",
      providerMessageId: current.providerMessageId ?? callback.providerMessageId,
      resolution,
    } satisfies AdapterHilRecord);
  });
  return { kind: "submitted", resolution };
}

function matchesCallback(
  record: AdapterHilRecord | undefined,
  provider: string,
  callback: AdapterHilCallback,
  now: number,
): record is AdapterHilRecord {
  return Boolean(
    record
    && record.expiresAt > now
    && record.provider === provider
    && record.binding === callback.binding
    && record.context.actorId === callback.actorId
    && record.context.surface.kind === "dm"
    && callback.surface.kind === "dm"
    && record.context.surface.id === callback.surface.id
    && record.context.surface.threadId === callback.surface.threadId
    && (
      record.providerMessageId === undefined
      || record.providerMessageId === callback.providerMessageId
    ),
  );
}

async function releaseAdapterHilApproval(
  storage: DurableObjectStorage,
  key: string,
  interactionId: string,
): Promise<void> {
  await storage.transaction(async (txn) => {
    const current = await txn.get<AdapterHilRecord>(key);
    if (
      current?.state !== "processing"
      || current.processingInteractionId !== interactionId
    ) {
      return;
    }
    const {
      processingAt: _,
      processingInteractionId: __,
      ...pending
    } = current;
    await txn.put(key, { ...pending, state: "pending" } satisfies AdapterHilRecord);
  });
}

function sameApproval(
  record: AdapterHilRecord,
  provider: string,
  binding: string | undefined,
  context: AdapterPeerDeliveryContext,
  request: ProcHilRequest,
): boolean {
  return record.provider === provider
    && record.binding === binding
    && record.context.deliveryId === context.deliveryId
    && record.context.accountId === context.accountId
    && record.context.actorId === context.actorId
    && record.context.surface.id === context.surface.id
    && record.context.routeGeneration === context.routeGeneration
    && record.request.pid === request.pid
    && record.request.runId === request.runId
    && record.request.requestId === request.requestId;
}

async function approvalToken(provider: string, deliveryId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`gsv-${provider}-hil-v1:${deliveryId}`),
  ));
  let binary = "";
  for (const byte of digest.subarray(0, 12)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function approvalKey(provider: string, token: string): string {
  if (!/^[A-Za-z0-9_-]{16}$/.test(token)) throw new Error("Adapter approval token is invalid");
  return `${APPROVAL_PREFIX}${provider}:${token}`;
}

function requireProvider(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,40}$/.test(normalized)) {
    throw new Error("Adapter approval provider is invalid");
  }
  return normalized;
}

async function pruneAdapterHilApprovals(
  storage: DurableObjectStorage,
  now: number,
): Promise<void> {
  const records = await storage.list<AdapterHilRecord>({ prefix: APPROVAL_PREFIX });
  const expired = [...records.entries()]
    .filter(([, record]) => record.expiresAt <= now)
    .map(([key]) => key);
  for (let offset = 0; offset < expired.length; offset += 128) {
    await storage.delete(expired.slice(offset, offset + 128));
  }
}
