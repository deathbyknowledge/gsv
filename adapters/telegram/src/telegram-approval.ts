import type { ProcHilRequest } from "../../../packages/gsv/src/protocol/syscalls/proc.js";
import { callLinkedAdapterGateway, type AdapterGatewayBinding } from "../../shared/src/gateway-rpc";
import type {
  AdapterInstallationContext,
  AdapterPeerDeliveryContext,
} from "./types";

export type TelegramApprovalCallback = {
  callbackQueryId: string;
  actorId: string;
  surfaceId: string;
  providerMessageId: string;
  data: string;
};

export type TelegramInlineKeyboardMarkup = {
  inline_keyboard: Array<Array<{
    text: string;
    callback_data: string;
  }>>;
};

export type TelegramApprovalControls = {
  token: string;
  replyMarkup: TelegramInlineKeyboardMarkup;
};

export type TelegramApprovalApi = {
  answerCallbackQuery(callbackQueryId: string, text: string): Promise<void>;
  clearInlineKeyboard(surfaceId: string, providerMessageId: string): Promise<void>;
};

type TelegramApprovalDecision = {
  decision: "approve" | "deny";
  remember: boolean;
};

type StoredTelegramApprovalRequest = Pick<
  ProcHilRequest,
  "pid" | "requestId" | "runId"
>;

type TelegramApprovalRecord = {
  version: 1;
  token: string;
  context: AdapterPeerDeliveryContext;
  request: StoredTelegramApprovalRequest;
  state: "pending" | "processing" | "resolved";
  processingCallbackId?: string;
  processingAt?: number;
  providerMessageId?: string;
  resolution?: "approve" | "approve_always" | "deny" | "stale";
  createdAt: number;
  expiresAt: number;
};

const APPROVAL_PREFIX = "telegram_approval:v1:";
const APPROVAL_CALLBACK_PREFIX = "gsvh:";
const APPROVAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const APPROVAL_PROCESSING_LEASE_MS = 60_000;

/** Persist a callback capability before exposing its buttons to Telegram. */
export async function prepareTelegramApproval(
  storage: DurableObjectStorage,
  context: AdapterPeerDeliveryContext,
  request: ProcHilRequest,
): Promise<TelegramApprovalControls | null> {
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
  const key = approvalKey(token);
  const now = Date.now();
  await storage.transaction(async (txn) => {
    const existing = await txn.get<TelegramApprovalRecord>(key);
    if (existing && existing.expiresAt > now) {
      if (!sameApproval(existing, context, request)) {
        throw new Error("Telegram approval token is already bound to another request");
      }
      return;
    }
    await txn.put(key, {
      version: 1,
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
    } satisfies TelegramApprovalRecord);
  });
  await pruneTelegramApprovals(storage, now);

  return {
    token,
    replyMarkup: {
      inline_keyboard: [
        [
          { text: "Approve once", callback_data: approvalCallbackData(token, "o") },
          { text: "Always approve", callback_data: approvalCallbackData(token, "a") },
        ],
        [{ text: "Deny", callback_data: approvalCallbackData(token, "d") }],
      ],
    },
  };
}

export async function attachTelegramApprovalMessage(
  storage: DurableObjectStorage,
  token: string,
  providerMessageId: string | undefined,
): Promise<void> {
  if (!providerMessageId) return;
  const key = approvalKey(token);
  await storage.transaction(async (txn) => {
    const record = await txn.get<TelegramApprovalRecord>(key);
    if (!record || record.providerMessageId === providerMessageId) return;
    await txn.put(key, { ...record, providerMessageId } satisfies TelegramApprovalRecord);
  });
}

/** Resolve a Telegram button through the ordinary linked-human proc.hil request path. */
export async function handleTelegramApprovalCallback(
  storage: DurableObjectStorage,
  gateway: AdapterGatewayBinding,
  installation: AdapterInstallationContext,
  callback: TelegramApprovalCallback,
  api: TelegramApprovalApi,
): Promise<void> {
  const parsed = parseApprovalCallbackData(callback.data);
  if (!parsed) return;
  const key = approvalKey(parsed.token);
  const now = Date.now();

  const claimed = await storage.transaction(async (txn) => {
    const record = await txn.get<TelegramApprovalRecord>(key);
    if (
      !record
      || record.expiresAt <= now
      || record.context.actorId !== callback.actorId
      || record.context.surface.kind !== "dm"
      || record.context.surface.id !== callback.surfaceId
      || (
        record.providerMessageId !== undefined
        && record.providerMessageId !== callback.providerMessageId
      )
    ) {
      return { kind: "invalid" as const };
    }
    if (record.state === "resolved") {
      return { kind: "resolved" as const, record };
    }
    if (
      record.state === "processing"
      && (record.processingAt ?? record.createdAt) + APPROVAL_PROCESSING_LEASE_MS > now
    ) {
      return { kind: "processing" as const, record };
    }
    const processing: TelegramApprovalRecord = {
      ...record,
      state: "processing",
      processingCallbackId: callback.callbackQueryId,
      processingAt: now,
    };
    await txn.put(key, processing);
    return { kind: "claimed" as const, record: processing };
  });

  if (claimed.kind === "invalid") {
    await api.answerCallbackQuery(callback.callbackQueryId, "This approval is no longer available.")
      .catch(() => undefined);
    return;
  }
  if (claimed.kind === "resolved") {
    await finishTelegramCallback(api, callback, resolutionText(claimed.record.resolution));
    return;
  }
  if (claimed.kind === "processing") {
    await api.answerCallbackQuery(callback.callbackQueryId, "This approval is already being handled.")
      .catch(() => undefined);
    return;
  }

  const record = claimed.record;
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
        interactionId: callback.callbackQueryId,
      },
      "proc.hil",
      {
        pid: record.request.pid,
        requestId: record.request.requestId,
        decision: parsed.decision.decision,
        remember: parsed.decision.remember,
      },
    );
  } catch (error) {
    await storage.transaction(async (txn) => {
      const current = await txn.get<TelegramApprovalRecord>(key);
      if (
        current?.state === "processing"
        && current.processingCallbackId === callback.callbackQueryId
      ) {
        const { processingAt: _, processingCallbackId: __, ...pending } = current;
        await txn.put(key, {
          ...pending,
          state: "pending",
        } satisfies TelegramApprovalRecord);
      }
    });
    throw error;
  }

  const resolution: TelegramApprovalRecord["resolution"] = result.ok
    ? parsed.decision.decision === "deny"
      ? "deny"
      : parsed.decision.remember
        ? "approve_always"
        : "approve"
    : "stale";
  await storage.transaction(async (txn) => {
    const current = await txn.get<TelegramApprovalRecord>(key);
    if (!current) return;
    const { processingAt: _, processingCallbackId: __, ...resolved } = current;
    await txn.put(key, {
      ...resolved,
      state: "resolved",
      providerMessageId: current.providerMessageId ?? callback.providerMessageId,
      resolution,
    } satisfies TelegramApprovalRecord);
  });
  await finishTelegramCallback(api, callback, resolutionText(resolution));
}

function sameApproval(
  record: TelegramApprovalRecord,
  context: AdapterPeerDeliveryContext,
  request: ProcHilRequest,
): boolean {
  return record.context.deliveryId === context.deliveryId
    && record.context.accountId === context.accountId
    && record.context.actorId === context.actorId
    && record.context.surface.id === context.surface.id
    && record.context.routeGeneration === context.routeGeneration
    && record.request.pid === request.pid
    && record.request.runId === request.runId
    && record.request.requestId === request.requestId;
}

async function finishTelegramCallback(
  api: TelegramApprovalApi,
  callback: TelegramApprovalCallback,
  text: string,
): Promise<void> {
  await Promise.all([
    api.answerCallbackQuery(callback.callbackQueryId, text).catch(() => undefined),
    api.clearInlineKeyboard(callback.surfaceId, callback.providerMessageId).catch(() => undefined),
  ]);
}

function resolutionText(resolution: TelegramApprovalRecord["resolution"]): string {
  switch (resolution) {
    case "approve": return "Approved once.";
    case "approve_always": return "Approved and remembered.";
    case "deny": return "Denied.";
    default: return "This approval is no longer pending.";
  }
}

function approvalCallbackData(token: string, action: "o" | "a" | "d"): string {
  return `${APPROVAL_CALLBACK_PREFIX}${token}:${action}`;
}

function parseApprovalCallbackData(value: string): {
  token: string;
  decision: TelegramApprovalDecision;
} | null {
  const match = /^gsvh:([A-Za-z0-9_-]{16}):(o|a|d)$/.exec(value);
  if (!match) return null;
  const action = match[2];
  return {
    token: match[1]!,
    decision: action === "d"
      ? { decision: "deny", remember: false }
      : { decision: "approve", remember: action === "a" },
  };
}

async function approvalToken(deliveryId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`gsv-telegram-hil-v1:${deliveryId}`),
  ));
  let binary = "";
  for (const byte of digest.subarray(0, 12)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function approvalKey(token: string): string {
  return `${APPROVAL_PREFIX}${token}`;
}

async function pruneTelegramApprovals(
  storage: DurableObjectStorage,
  now: number,
): Promise<void> {
  const records = await storage.list<TelegramApprovalRecord>({ prefix: APPROVAL_PREFIX });
  const expired = [...records.entries()]
    .filter(([, record]) => record.expiresAt <= now)
    .map(([key]) => key);
  for (let offset = 0; offset < expired.length; offset += 128) {
    await storage.delete(expired.slice(offset, offset + 128));
  }
}
