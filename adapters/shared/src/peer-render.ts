import type {
  AdapterOutboundMessage,
  AdapterPeerDeliveryContext,
  AdapterPeerSignalFrame,
  ProcHilRequest,
} from "./types";
import type { JsonValue } from "../../../packages/gsv/src/protocol/json.js";

export type RenderedAdapterPeerSignal = {
  message: AdapterOutboundMessage;
  hil?: ProcHilRequest;
};

/** Default text/media projection. Platform adapters may replace presentation. */
export function renderAdapterPeerSignal(
  context: AdapterPeerDeliveryContext,
  frame: AdapterPeerSignalFrame,
): RenderedAdapterPeerSignal {
  const message: AdapterOutboundMessage = {
    deliveryId: context.deliveryId,
    surface: context.surface,
    text: frame.signal === "message.committed"
      ? prefixProcessMode(frame.payload.message.text, context)
      : prefixProcessMode(renderAdapterHilText(frame.payload, context.surface.kind), context),
  };
  if (context.actorId) message.actorId = context.actorId;
  if (context.routeGeneration) message.routeGeneration = context.routeGeneration;
  if (context.replyToId) message.replyToId = context.replyToId;
  if (context.media?.length) message.media = context.media;
  return frame.signal === "proc.run.hil.requested"
    ? { message, hil: frame.payload }
    : { message };
}

export function renderAdapterHilText(
  request: ProcHilRequest,
  surfaceKind: AdapterPeerDeliveryContext["surface"]["kind"],
): string {
  const responseLine = surfaceKind === "dm"
    ? "Use Approve, Always approve, or Deny below. If buttons are unavailable, open Chat to decide."
    : "Open Chat to approve or deny this action.";
  return [
    "I need your confirmation before I can continue.",
    "",
    summarizeAdapterHilRequest(request),
    "",
    responseLine,
  ].join("\n");
}

function prefixProcessMode(
  text: string,
  context: AdapterPeerDeliveryContext,
): string {
  const prefix = context.processMode === "work"
    ? "[WORK SESSION]"
    : context.processMode === "ship" && context.shipDisplaced
      ? "[PERSONAL INTELLIGENCE]"
      : "";
  return prefix ? (text ? `${prefix} ${text}` : prefix) : text;
}

function summarizeAdapterHilRequest(request: ProcHilRequest): string {
  const path = safeQuotedDetail(request.args.path, 512);
  const command = safeQuotedDetail(request.args.input, 1_200);
  if (request.syscall === "shell.exec") {
    return command
      ? `Requested action: run ${command}.`
      : "Requested action: run a shell command.";
  }
  if (request.syscall === "fs.read") {
    return path ? `Requested action: read ${path}.` : "Requested action: read a file.";
  }
  if (request.syscall === "fs.write") {
    return path ? `Requested action: write ${path}.` : "Requested action: write a file.";
  }
  if (request.syscall === "fs.edit") {
    return path ? `Requested action: edit ${path}.` : "Requested action: edit a file.";
  }
  if (request.syscall === "fs.delete") {
    return path ? `Requested action: delete ${path}.` : "Requested action: delete a file.";
  }
  if (request.syscall === "mail.send") {
    const recipient = safeQuotedDetail(request.args.to);
    const subject = safeQuotedDetail(request.args.subject);
    const replyToMessageId = safeQuotedDetail(request.args.replyToMessageId);
    if (recipient && subject) {
      return `Requested action: send an email to ${recipient} with subject ${subject}.`;
    }
    if (recipient) return `Requested action: send an email to ${recipient}.`;
    if (subject) return `Requested action: send an email with subject ${subject}.`;
    if (replyToMessageId) return `Requested action: reply to stored email ${replyToMessageId}.`;
    return "Requested action: send an email.";
  }
  return `Requested action: ${safeQuotedDetail(request.toolName, 160) ?? "an operation"}.`;
}

function safeQuotedDetail(
  value: JsonValue | string | undefined,
  maximum = 160,
): string | null {
  if (typeof value !== "string") return null;
  const singleLine = value
    .replace(/[\p{Cc}\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!singleLine) return null;
  const quoted = JSON.stringify(singleLine);
  if (quoted.length <= maximum) return quoted;
  let encoded = "";
  for (const character of singleLine) {
    const part = JSON.stringify(character).slice(1, -1);
    if (encoded.length + part.length > maximum - 3) break;
    encoded += part;
  }
  return `"${encoded}…"`;
}
