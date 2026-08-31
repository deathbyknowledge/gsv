import type { ProcHilRequest } from "../../../packages/gsv/src/protocol/syscalls/proc.js";
import { callLinkedAdapterGateway, type AdapterGatewayBinding } from "../../shared/src/gateway-rpc";
import type {
  AdapterInstallationContext,
  AdapterPeerDeliveryContext,
} from "./types";
import {
  buildSlackApprovalBlocks,
  buildSlackApprovalStatusMessage,
  type SlackApprovalCallback,
  type SlackApprovalSubmittedMessage,
  type SlackBlock,
} from "./slack-interactions";

export type SlackApprovalControls = {
  token: string;
  blocks: SlackBlock[];
};

export type SlackApprovalApi = {
  updateMessage(
    callback: SlackApprovalCallback,
    message: SlackApprovalSubmittedMessage,
  ): Promise<void>;
};

type StoredSlackApprovalRequest = Pick<
  ProcHilRequest,
  "pid" | "requestId" | "runId"
>;

type SlackApprovalRecord = {
  version: 1;
  token: string;
  teamId: string;
  context: AdapterPeerDeliveryContext;
  request: StoredSlackApprovalRequest;
  state: "pending" | "processing" | "resolved";
  processingInteractionId?: string;
  processingAt?: number;
  providerMessageId?: string;
  resolution?: "approve" | "approve_always" | "deny" | "stale";
  createdAt: number;
  expiresAt: number;
};

const APPROVAL_PREFIX = "slack_approval:v1:";
const APPROVAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const APPROVAL_PROCESSING_LEASE_MS = 60_000;

export async function prepareSlackApproval(
  storage: DurableObjectStorage,
  teamId: string,
  context: AdapterPeerDeliveryContext,
  request: ProcHilRequest,
  text: string,
): Promise<SlackApprovalControls | null> {
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
  const token = await approvalToken(context.deliveryId);
  const blocks = buildSlackApprovalBlocks(text, token);
  if (!blocks) return null;
  const key = approvalKey(token);
  const now = Date.now();
  await storage.transaction(async (txn) => {
    const existing = await txn.get<SlackApprovalRecord>(key);
    if (existing && existing.expiresAt > now) {
      if (!sameApproval(existing, teamId, context, request)) {
        throw new Error("Slack approval token is already bound to another request");
      }
      return;
    }
    await txn.put(key, {
      version: 1,
      token,
      teamId,
      context,
      request: {
        pid: request.pid,
        requestId: request.requestId,
        runId: request.runId,
      },
      state: "pending",
      createdAt: now,
      expiresAt: now + APPROVAL_RETENTION_MS,
    } satisfies SlackApprovalRecord);
  });
  await pruneSlackApprovals(storage, now);
  return { token, blocks };
}

export async function attachSlackApprovalMessage(
  storage: DurableObjectStorage,
  token: string,
  providerMessageId: string | undefined,
): Promise<void> {
  if (!providerMessageId) return;
  const key = approvalKey(token);
  await storage.transaction(async (txn) => {
    const record = await txn.get<SlackApprovalRecord>(key);
    if (!record || record.providerMessageId === providerMessageId) return;
    await txn.put(key, { ...record, providerMessageId } satisfies SlackApprovalRecord);
  });
}

export async function handleSlackApprovalCallback(
  storage: DurableObjectStorage,
  gateway: AdapterGatewayBinding,
  installation: AdapterInstallationContext,
  callback: SlackApprovalCallback,
  api: SlackApprovalApi,
): Promise<void> {
  const key = approvalKey(callback.token);
  const now = Date.now();
  const claimed = await storage.transaction(async (txn) => {
    const record = await txn.get<SlackApprovalRecord>(key);
    if (
      !record
      || record.expiresAt <= now
      || record.teamId !== callback.teamId
      || record.context.actorId !== callback.actorId
      || record.context.surface.kind !== "dm"
      || record.context.surface.id !== callback.surface.id
      || record.context.surface.threadId !== callback.surface.threadId
      || (
        record.providerMessageId !== undefined
        && record.providerMessageId !== callback.sourceMessageId
      )
    ) {
      return { kind: "invalid" as const };
    }
    if (record.state === "resolved") return { kind: "resolved" as const, record };
    if (
      record.state === "processing"
      && (record.processingAt ?? record.createdAt) + APPROVAL_PROCESSING_LEASE_MS > now
    ) {
      return { kind: "processing" as const, record };
    }
    const processing: SlackApprovalRecord = {
      ...record,
      state: "processing",
      processingInteractionId: callback.interactionId,
      processingAt: now,
    };
    await txn.put(key, processing);
    return { kind: "claimed" as const, record: processing };
  });

  if (claimed.kind === "invalid") {
    await api.updateMessage(
      callback,
      buildSlackApprovalStatusMessage(callback.sourceText, "This approval is no longer available."),
    ).catch(() => undefined);
    return;
  }
  if (claimed.kind === "resolved" || claimed.kind === "processing") {
    const status = claimed.kind === "processing"
      ? "This approval is already being handled."
      : resolutionStatus(claimed.record.resolution);
    await api.updateMessage(
      callback,
      buildSlackApprovalStatusMessage(callback.sourceText, status),
    ).catch(() => undefined);
    return;
  }

  const record = claimed.record;
  const decision = callback.action === "deny" ? "deny" : "approve";
  const remember = callback.action === "approve_always";
  let result;
  try {
    result = await callLinkedAdapterGateway(
      gateway,
      installation,
      {
        accountId: record.context.accountId,
        actorId: callback.actorId,
        surface: record.context.surface,
        ...(record.context.routeGeneration
          ? { routeGeneration: record.context.routeGeneration }
          : {}),
        interactionId: callback.interactionId,
      },
      "proc.hil",
      {
        pid: record.request.pid,
        requestId: record.request.requestId,
        decision,
        remember,
      },
    );
  } catch (error) {
    await storage.transaction(async (txn) => {
      const current = await txn.get<SlackApprovalRecord>(key);
      if (
        current?.state === "processing"
        && current.processingInteractionId === callback.interactionId
      ) {
        const {
          processingAt: _,
          processingInteractionId: __,
          ...pending
        } = current;
        await txn.put(key, { ...pending, state: "pending" } satisfies SlackApprovalRecord);
      }
    });
    throw error;
  }

  const resolution: SlackApprovalRecord["resolution"] = result.ok
    ? callback.action
    : "stale";
  await storage.transaction(async (txn) => {
    const current = await txn.get<SlackApprovalRecord>(key);
    if (!current) return;
    const {
      processingAt: _,
      processingInteractionId: __,
      ...resolved
    } = current;
    await txn.put(key, {
      ...resolved,
      state: "resolved",
      providerMessageId: current.providerMessageId ?? callback.sourceMessageId,
      resolution,
    } satisfies SlackApprovalRecord);
  });
  await api.updateMessage(
    callback,
    buildSlackApprovalStatusMessage(callback.sourceText, resolutionStatus(resolution)),
  ).catch(() => undefined);
}

function resolutionStatus(resolution: SlackApprovalRecord["resolution"]): string {
  switch (resolution) {
    case "approve": return "Decision submitted: Approve once.";
    case "approve_always": return "Decision submitted: Always approve.";
    case "deny": return "Decision submitted: Deny.";
    default: return "This approval is no longer pending.";
  }
}

function sameApproval(
  record: SlackApprovalRecord,
  teamId: string,
  context: AdapterPeerDeliveryContext,
  request: ProcHilRequest,
): boolean {
  return record.teamId === teamId
    && record.context.deliveryId === context.deliveryId
    && record.context.accountId === context.accountId
    && record.context.actorId === context.actorId
    && record.context.surface.id === context.surface.id
    && record.context.routeGeneration === context.routeGeneration
    && record.request.pid === request.pid
    && record.request.runId === request.runId
    && record.request.requestId === request.requestId;
}

async function approvalToken(deliveryId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`gsv-slack-hil-v1:${deliveryId}`),
  ));
  let binary = "";
  for (const byte of digest.subarray(0, 12)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function approvalKey(token: string): string {
  return `${APPROVAL_PREFIX}${token}`;
}

async function pruneSlackApprovals(storage: DurableObjectStorage, now: number): Promise<void> {
  const records = await storage.list<SlackApprovalRecord>({ prefix: APPROVAL_PREFIX });
  const expired = [...records.entries()]
    .filter(([, record]) => record.expiresAt <= now)
    .map(([key]) => key);
  for (let offset = 0; offset < expired.length; offset += 128) {
    await storage.delete(expired.slice(offset, offset + 128));
  }
}
