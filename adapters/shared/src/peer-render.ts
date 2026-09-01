import type {
  AdapterDeliveryContext,
  AdapterOutboundMessage,
  ProcHilRequest,
} from "./types";
import type { JsonValue } from "../../../packages/gsv/src/protocol/json.js";
import * as z from "zod/mini";

export type RenderedAdapterSend = {
  message: AdapterOutboundMessage;
  hil?: ProcHilRequest;
};

/** Default text/media projection. Platform adapters may replace presentation. */
export function renderAdapterSend(
  context: AdapterDeliveryContext,
  input: AdapterOutboundMessage,
): RenderedAdapterSend {
  const message = {
    ...input,
    text: prefixProcessMode(
      context.hil
        ? renderAdapterHilText(context.hil, context.surface.kind)
        : input.text,
      context,
    ),
  };
  return context.hil ? { message, hil: context.hil } : { message };
}

export function renderAdapterHilText(
  request: ProcHilRequest,
  surfaceKind: AdapterDeliveryContext["surface"]["kind"],
): string {
  const requestToken = `hil[${request.requestId}]`;
  const responseLine = surfaceKind === "dm"
    ? `Use Approve, Always approve, or Deny controls when available. Otherwise, reply "approve ${requestToken}", "approve always ${requestToken}", or "deny ${requestToken}".`
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
  context: AdapterDeliveryContext,
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
  const parsed = z.string().safeParse(value);
  if (!parsed.success) return null;
  const singleLine = parsed.data
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
