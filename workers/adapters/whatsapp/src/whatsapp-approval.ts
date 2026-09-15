import type { AdapterDataScope } from "../../shared/src/retirement";
import type { ProcHilRequest } from "../../../../packages/gsv/src/protocol/syscalls/proc.js";
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

const PROVIDER = "whatsapp";
const APPROVAL_REPLY_PREFIX = "gsvh:";
/** Meta's limit for an interactive message body. */
export const WHATSAPP_INTERACTIVE_BODY_LIMIT = 1024;
/** Meta allows three reply buttons with titles of at most twenty characters. */
const REPLY_BUTTON_TITLE_LIMIT = 20;

/**
 * Persist a callback capability before exposing reply buttons. Returns null
 * when the prompt cannot be presented natively, so the caller falls back to
 * the plain text that directs the person to Chat.
 */
export async function prepareWhatsAppApproval(
  storage: DurableObjectStorage,
  context: AdapterDeliveryContext,
  request: ProcHilRequest,
  owner?: AdapterDataScope,
): Promise<WhatsAppApprovalControls | null> {
  const presentation = createAdapterHilPresentation(context, request);
  const text = renderAdapterHilPrompt(presentation, "native");
  if ([...text].length > WHATSAPP_INTERACTIVE_BODY_LIMIT) return null;
  const token = await prepareAdapterHilApproval(
    storage,
    PROVIDER,
    undefined,
    context,
    request,
    presentation,
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
