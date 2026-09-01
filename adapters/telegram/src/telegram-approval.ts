import type { ProcHilRequest } from "../../../packages/gsv/src/protocol/syscalls/proc.js";
import type { AdapterGatewayBinding } from "../../shared/src/gateway-rpc";
import {
  attachAdapterHilApprovalMessage,
  prepareAdapterHilApproval,
  submitAdapterHilApproval,
  type AdapterHilDecision,
  type AdapterHilResolution,
} from "../../shared/src/hil-approval";
import {
  createAdapterHilPresentation,
  renderAdapterHilPrompt,
  renderAdapterHilResolution,
} from "../../shared/src/peer-render";
import type {
  AdapterInstallationContext,
  AdapterDeliveryContext,
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
  text: string;
  replyMarkup: TelegramInlineKeyboardMarkup;
};

export type TelegramApprovalApi = {
  answerCallbackQuery(callbackQueryId: string, text: string): Promise<void>;
  replaceMessage(surfaceId: string, providerMessageId: string, text: string): Promise<void>;
};

const PROVIDER = "telegram";
const APPROVAL_CALLBACK_PREFIX = "gsvh:";

/** Persist a callback capability before exposing its buttons to Telegram. */
export async function prepareTelegramApproval(
  storage: DurableObjectStorage,
  context: AdapterDeliveryContext,
  request: ProcHilRequest,
): Promise<TelegramApprovalControls | null> {
  const presentation = createAdapterHilPresentation(context, request);
  const token = await prepareAdapterHilApproval(
    storage,
    PROVIDER,
    undefined,
    context,
    request,
    presentation,
  );
  if (!token) return null;
  return {
    token,
    text: renderAdapterHilPrompt(presentation, "native"),
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
  await attachAdapterHilApprovalMessage(storage, PROVIDER, token, providerMessageId);
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
  const submission = await submitAdapterHilApproval(
    storage,
    gateway,
    installation,
    {
      provider: PROVIDER,
      token: parsed.token,
      actorId: callback.actorId,
      surface: { kind: "dm", id: callback.surfaceId },
      providerMessageId: callback.providerMessageId,
      interactionId: callback.callbackQueryId,
      decision: parsed.decision.decision,
      remember: parsed.decision.remember,
    },
  );

  if (submission.kind === "invalid") {
    await finishTelegramCallback(
      api,
      callback,
      "This approval is no longer available.",
      "This approval is no longer available.",
    );
    return;
  }
  if (submission.kind === "processing") {
    const status = "This approval is already being handled.";
    await finishTelegramCallback(
      api,
      callback,
      status,
      renderAdapterHilResolution(submission.presentation, status),
    );
    return;
  }
  const status = resolutionText(submission.resolution);
  await finishTelegramCallback(
    api,
    callback,
    status,
    renderAdapterHilResolution(submission.presentation, status),
  );
}

async function finishTelegramCallback(
  api: TelegramApprovalApi,
  callback: TelegramApprovalCallback,
  callbackText: string,
  messageText: string,
): Promise<void> {
  await Promise.all([
    api.answerCallbackQuery(callback.callbackQueryId, callbackText).catch(() => undefined),
    api.replaceMessage(callback.surfaceId, callback.providerMessageId, messageText)
      .catch(() => undefined),
  ]);
}

function resolutionText(resolution: AdapterHilResolution | undefined): string {
  switch (resolution) {
    case "approve": return "Approved once.";
    case "approve_always": return "Approved for this conversation.";
    case "deny": return "Denied.";
    default: return "This approval is no longer pending.";
  }
}

function approvalCallbackData(token: string, action: "o" | "a" | "d"): string {
  return `${APPROVAL_CALLBACK_PREFIX}${token}:${action}`;
}

function parseApprovalCallbackData(value: string): {
  token: string;
  decision: AdapterHilDecision;
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
