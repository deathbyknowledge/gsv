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
  selection?: AdapterHilDecision;
  processingInteractionId?: string;
  processingAt?: number;
  providerMessageId?: string;
  resolution?: AdapterHilResolution;
  createdAt: number;
  expiresAt: number;
};

type ProcessingAdapterHilRecord = AdapterHilRecord & {
  state: "processing";
  selection: AdapterHilDecision;
  processingInteractionId: string;
  processingAt: number;
};

type AdapterHilJsonRow = {
  record_json: string;
};

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
  const now = Date.now();
  storage.transactionSync(() => {
    const existing = readAdapterHilRecord(storage.sql, normalizedProvider, token);
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
    writeAdapterHilRecord(storage.sql, record);
  });
  pruneAdapterHilApprovals(storage.sql, now);
  return token;
}

export async function attachAdapterHilApprovalMessage(
  storage: DurableObjectStorage,
  provider: string,
  token: string,
  providerMessageId: string | undefined,
): Promise<void> {
  if (!providerMessageId) return;
  const normalizedProvider = requireProvider(provider);
  const normalizedToken = requireApprovalToken(token);
  storage.transactionSync(() => {
    const record = readAdapterHilRecord(storage.sql, normalizedProvider, normalizedToken);
    if (!record || record.providerMessageId === providerMessageId) return;
    writeAdapterHilRecord(storage.sql, {
      ...record,
      providerMessageId,
    } satisfies AdapterHilRecord);
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
  const token = requireApprovalToken(callback.token);
  const now = Date.now();
  const claimed = storage.transactionSync(() => {
    const record = readAdapterHilRecord(storage.sql, provider, token);
    if (!matchesCallback(record, provider, callback, now)) {
      return { kind: "invalid" as const };
    }
    if (record.state === "resolved") {
      return { kind: "resolved" as const, record };
    }
    // The Process may have accepted the first decision even when its response
    // is delayed or lost, so later callbacks may retry but never replace it.
    if (record.selection && !sameHilSelection(record.selection, callback)) {
      return { kind: "processing" as const };
    }
    if (
      record.state === "processing"
      && (record.processingAt ?? record.createdAt) + APPROVAL_PROCESSING_LEASE_MS > now
    ) {
      return { kind: "processing" as const };
    }
    const processing: ProcessingAdapterHilRecord = {
      ...record,
      state: "processing",
      selection: record.selection ?? {
        decision: callback.decision,
        remember: callback.remember,
      },
      processingInteractionId: callback.interactionId,
      processingAt: now,
    };
    writeAdapterHilRecord(storage.sql, processing);
    return { kind: "claimed" as const, record: processing };
  });

  if (claimed.kind === "invalid" || claimed.kind === "processing") return claimed;
  if (claimed.kind === "resolved") {
    return { kind: "resolved", resolution: claimed.record.resolution };
  }

  const record = claimed.record;
  const selection = record.selection;
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
        decision: selection.decision,
        remember: selection.remember,
      },
    );
  } catch (error) {
    releaseAdapterHilApproval(storage, provider, token, callback.interactionId);
    throw error;
  }

  const resolution: AdapterHilResolution = result.ok
    ? selection.decision === "deny"
      ? "deny"
      : selection.remember
        ? "approve_always"
        : "approve"
    : "stale";
  return storage.transactionSync((): AdapterHilSubmission => {
    const current = readAdapterHilRecord(storage.sql, provider, token);
    if (!current) return { kind: "invalid" };
    if (current.state === "resolved") {
      return {
        kind: "submitted",
        resolution: current.resolution ?? resolution,
      };
    }
    if (!current.selection || !sameHilSelection(current.selection, selection)) {
      return { kind: "processing" };
    }
    const ownsAttempt = current.state === "processing"
      && current.processingInteractionId === callback.interactionId;
    // Any success completes the immutable selection. A failed stale attempt
    // cannot overwrite a newer attempt that may still complete successfully.
    if (!ownsAttempt && !result.ok) {
      return { kind: "processing" };
    }
    const {
      processingAt: _,
      processingInteractionId: __,
      ...resolved
    } = current;
    writeAdapterHilRecord(storage.sql, {
      ...resolved,
      state: "resolved",
      providerMessageId: current.providerMessageId ?? callback.providerMessageId,
      resolution,
    } satisfies AdapterHilRecord);
    return { kind: "submitted", resolution };
  });
}

function sameHilSelection(
  left: AdapterHilDecision,
  right: AdapterHilDecision,
): boolean {
  return left.decision === right.decision && left.remember === right.remember;
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

function releaseAdapterHilApproval(
  storage: DurableObjectStorage,
  provider: string,
  token: string,
  interactionId: string,
): void {
  storage.transactionSync(() => {
    const current = readAdapterHilRecord(storage.sql, provider, token);
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
    writeAdapterHilRecord(storage.sql, {
      ...pending,
      state: "pending",
    } satisfies AdapterHilRecord);
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

function requireApprovalToken(token: string): string {
  if (!/^[A-Za-z0-9_-]{16}$/.test(token)) throw new Error("Adapter approval token is invalid");
  return token;
}

function requireProvider(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,40}$/.test(normalized)) {
    throw new Error("Adapter approval provider is invalid");
  }
  return normalized;
}

function readAdapterHilRecord(
  sql: SqlStorage,
  provider: string,
  token: string,
): AdapterHilRecord | undefined {
  const row = sql.exec<AdapterHilJsonRow>(
    `SELECT record_json
     FROM adapter_hil_approvals
     WHERE provider = ? AND token = ?
     LIMIT 1`,
    provider,
    token,
  ).toArray()[0];
  // SAFETY: This table is private to this module and every write serializes an
  // AdapterHilRecord through writeAdapterHilRecord in the same schema version.
  return row ? JSON.parse(row.record_json) as AdapterHilRecord : undefined;
}

function writeAdapterHilRecord(sql: SqlStorage, record: AdapterHilRecord): void {
  sql.exec(
    `INSERT INTO adapter_hil_approvals
       (provider, token, state, record_json, expires_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(provider, token) DO UPDATE SET
       state = excluded.state,
       record_json = excluded.record_json,
       expires_at = excluded.expires_at`,
    record.provider,
    record.token,
    record.state,
    JSON.stringify(record),
    record.expiresAt,
  );
}

function pruneAdapterHilApprovals(
  sql: SqlStorage,
  now: number,
): void {
  sql.exec("DELETE FROM adapter_hil_approvals WHERE expires_at <= ?", now);
}
