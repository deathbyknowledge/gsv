import type { AdapterDataScope } from "../../shared/src/retirement";
import type { ProcHilRequest } from "../../../../packages/gsv/src/protocol/syscalls/proc.js";
import type { AdapterGatewayBinding } from "../../shared/src/gateway-rpc";
import {
  attachAdapterHilApprovalMessage,
  prepareAdapterHilApproval,
  submitAdapterHilApproval,
  type AdapterHilDecision,
  type AdapterHilResolution,
  type StoredAdapterHilRequest,
} from "../../shared/src/hil-approval";
import {
  createAdapterHilPresentation,
  renderAdapterHilPrompt,
  renderAdapterHilResolution,
  type AdapterHilPresentation,
} from "../../shared/src/peer-render";
import type {
  AdapterInstallationContext,
  AdapterDeliveryContext,
} from "./types";
import type { WhatsAppOutboundPayload } from "./whatsapp-api";
import type { WhatsAppApprovalReply } from "./whatsapp-webhook";

export type WhatsAppReplyButton = {
  id: string;
  title: string;
};

export type WhatsAppApprovalControls = {
  token: string;
  text: string;
  buttons: WhatsAppReplyButton[];
};

/**
 * What the peer keeps to present an approval again later: the delivery
 * context, the request identity and the rendered presentation. The tool
 * arguments never leave the original request.
 */
export type WhatsAppApprovalSource = {
  context: Pick<
    AdapterDeliveryContext,
    "deliveryId" | "accountId" | "actorId" | "surface" | "routeGeneration" | "processId" | "runId"
  >;
  request: StoredAdapterHilRequest;
  presentation: AdapterHilPresentation;
};

const PROVIDER = "whatsapp";
const APPROVAL_REPLY_PREFIX = "gsvh:";
/** Meta's limit for an interactive message body. */
export const WHATSAPP_INTERACTIVE_BODY_LIMIT = 1024;
/** Meta allows three reply buttons with titles of at most twenty characters. */
const REPLY_BUTTON_TITLE_LIMIT = 20;

/** Reduces one approval send to what the peer may keep and present again. */
export function describeWhatsAppApproval(
  context: AdapterDeliveryContext,
  request: ProcHilRequest,
): WhatsAppApprovalSource {
  const stored: WhatsAppApprovalSource["context"] = {
    deliveryId: context.deliveryId,
    accountId: context.accountId,
    surface: context.surface,
  };
  if (context.actorId !== undefined) stored.actorId = context.actorId;
  if (context.routeGeneration !== undefined) stored.routeGeneration = context.routeGeneration;
  if (context.processId !== undefined) stored.processId = context.processId;
  if (context.runId !== undefined) stored.runId = context.runId;
  return {
    context: stored,
    request: { pid: request.pid, requestId: request.requestId, runId: request.runId },
    presentation: createAdapterHilPresentation(context, request),
  };
}

export function whatsAppApprovalPrompt(source: WhatsAppApprovalSource): string {
  return renderAdapterHilPrompt(source.presentation, "native");
}

/**
 * Persist a callback capability before exposing reply buttons. Returns null
 * when the prompt cannot be presented natively, so the caller falls back to
 * the plain text that directs the person to Chat. Preparing the same source
 * again yields the same token, so a held prompt can be presented later.
 */
export async function prepareWhatsAppApproval(
  storage: DurableObjectStorage,
  source: WhatsAppApprovalSource,
  owner?: AdapterDataScope,
): Promise<WhatsAppApprovalControls | null> {
  const text = whatsAppApprovalPrompt(source);
  if ([...text].length > WHATSAPP_INTERACTIVE_BODY_LIMIT) return null;
  const token = await prepareAdapterHilApproval(
    storage,
    PROVIDER,
    undefined,
    source.context,
    source.request,
    source.presentation,
    owner,
  );
  if (!token) return null;
  return {
    token,
    text,
    buttons: [
      { id: replyButtonId(token, "o"), title: "Approve once" },
      { id: replyButtonId(token, "a"), title: "Always approve" },
      { id: replyButtonId(token, "d"), title: "Deny" },
    ].map((button) => ({ ...button, title: button.title.slice(0, REPLY_BUTTON_TITLE_LIMIT) })),
  };
}

export function buildWhatsAppInteractivePayload(
  to: string,
  controls: WhatsAppApprovalControls,
  replyToId?: string,
): WhatsAppOutboundPayload {
  const payload: WhatsAppOutboundPayload = {
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: controls.text },
      action: {
        buttons: controls.buttons.map((button) => ({
          type: "reply",
          reply: { id: button.id, title: button.title },
        })),
      },
    },
  };
  if (replyToId) payload.context = { message_id: replyToId };
  return payload;
}

export async function attachWhatsAppApprovalMessage(
  storage: DurableObjectStorage,
  token: string,
  providerMessageId: string | undefined,
): Promise<void> {
  await attachAdapterHilApprovalMessage(storage, PROVIDER, token, providerMessageId);
}

/**
 * Resolve a reply button through the ordinary linked-human proc.hil path and
 * return the status text to send back. WhatsApp cannot edit a sent message,
 * so the decision is delivered as a reply quoting the prompt.
 */
export async function handleWhatsAppApprovalReply(
  storage: DurableObjectStorage,
  gateway: AdapterGatewayBinding,
  installation: AdapterInstallationContext,
  reply: WhatsAppApprovalReply,
): Promise<string | null> {
  const parsed = parseReplyButtonId(reply.data);
  if (!parsed) return null;
  const submission = await submitAdapterHilApproval(
    storage,
    gateway,
    installation,
    {
      provider: PROVIDER,
      token: parsed.token,
      actorId: reply.actorId,
      surface: { kind: "dm", id: reply.surfaceId },
      providerMessageId: reply.providerMessageId,
      interactionId: reply.interactionId,
      decision: parsed.decision.decision,
      remember: parsed.decision.remember,
    },
  );
  if (submission.kind === "invalid") return "This approval is no longer available.";
  if (submission.kind === "processing") {
    return renderAdapterHilResolution(submission.presentation, "This approval is already being handled.");
  }
  return renderAdapterHilResolution(submission.presentation, resolutionText(submission.resolution));
}

function resolutionText(resolution: AdapterHilResolution | undefined): string {
  switch (resolution) {
    case "approve": return "Approved once.";
    case "approve_always": return "Approved for this conversation.";
    case "deny": return "Denied.";
    default: return "This approval is no longer pending.";
  }
}

function replyButtonId(token: string, action: "o" | "a" | "d"): string {
  return `${APPROVAL_REPLY_PREFIX}${token}:${action}`;
}

function parseReplyButtonId(value: string): {
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
