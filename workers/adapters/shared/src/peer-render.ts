import type {
  AdapterDeliveryContext,
  AdapterOutboundMessage,
  ProcHilRequest,
} from "./types";
import type { JsonValue } from "../../../../packages/gsv/src/protocol/json.js";
import * as z from "zod/mini";

export type RenderedAdapterSend = {
  message: AdapterOutboundMessage;
  hil?: ProcHilRequest;
};

export type AdapterHilPresentation = {
  action: string;
  scope?: "work" | "personal";
};

/** Default text/media projection. Platform adapters may replace presentation. */
export function renderAdapterSend(
  context: AdapterDeliveryContext,
  input: AdapterOutboundMessage,
): RenderedAdapterSend {
  const hilPresentation = context.hil
    ? createAdapterHilPresentation(context, context.hil)
    : undefined;
  const message = {
    ...input,
    text: hilPresentation
      ? renderAdapterHilPrompt(hilPresentation, "chat")
      : prefixProcessMode(input.text, context),
  };
  return context.hil ? { message, hil: context.hil } : { message };
}

export function createAdapterHilPresentation(
  context: AdapterDeliveryContext,
  request: ProcHilRequest,
): AdapterHilPresentation {
  const presentation: AdapterHilPresentation = {
    action: summarizeAdapterHilRequest(request),
  };
  if (context.processMode === "work") presentation.scope = "work";
  if (context.processMode === "ship" && context.shipDisplaced) {
    presentation.scope = "personal";
  }
  return presentation;
}

export function renderAdapterHilPrompt(
  presentation: AdapterHilPresentation,
  controls: "native" | "chat",
): string {
  const lines = [
    "I need your confirmation before I can continue.",
    "",
    presentation.action,
  ];
  if (controls === "chat") {
    lines.push("", "Open Chat to approve or deny this action.");
  }
  return prefixHilScope(lines.join("\n"), presentation.scope);
}

export function renderAdapterHilResolution(
  presentation: AdapterHilPresentation | undefined,
  status: string,
): string {
  if (!presentation) return status;
  return prefixHilScope(
    `${status}\n\n${presentation.action}`,
    presentation.scope,
  );
}

function prefixProcessMode(
  text: string,
  context: AdapterDeliveryContext,
): string {
  const prefix = processModePrefix(context);
  return prefix ? (text ? `${prefix} ${text}` : prefix) : text;
}

function prefixHilScope(
  text: string,
  scope: AdapterHilPresentation["scope"],
): string {
  const prefix = scope === "work"
    ? "[WORK SESSION]"
    : scope === "personal"
      ? "[PERSONAL INTELLIGENCE]"
      : "";
  return prefix ? `${prefix} ${text}` : text;
}

function processModePrefix(context: AdapterDeliveryContext): string {
  return context.processMode === "work"
    ? "[WORK SESSION]"
    : context.processMode === "ship" && context.shipDisplaced
      ? "[PERSONAL INTELLIGENCE]"
      : "";
}

/**
 * What the person reads before deciding: the model's own sentence when it wrote one,
 * otherwise a sentence built from the request shape with the raw detail on a second line.
 */
function summarizeAdapterHilRequest(request: ProcHilRequest): string {
  const purpose = safePlainDetail(request.purpose, 400);
  if (purpose) return asSentence(purpose);
  const summary = asSentence(describeAdapterHilRequest(request));
  const detail = adapterHilRequestDetail(request);
  return detail ? `${summary}\n${detail}` : summary;
}

function describeAdapterHilRequest(request: ProcHilRequest): string {
  const place = request.target === "gsv"
    ? "in your cloud home"
    : `on ${safePlainDetail(request.target, 80) ?? "a connected place"}`;
  switch (request.syscall) {
    case "shell.exec": return `run a command ${place}`;
    case "fs.read": return `read a file ${place}`;
    case "fs.write": return `write a file ${place}`;
    case "fs.edit": return `edit a file ${place}`;
    case "fs.delete": return `delete a file ${place}`;
    case "net.fetch": return `fetch a web address ${place}`;
    case "mail.send": {
      const recipient = safeQuotedDetail(request.args.to);
      const subject = safeQuotedDetail(request.args.subject);
      const replyToMessageId = safeQuotedDetail(request.args.replyToMessageId);
      if (recipient && subject) return `send an email to ${recipient} with subject ${subject}`;
      if (recipient) return `send an email to ${recipient}`;
      if (subject) return `send an email with subject ${subject}`;
      if (replyToMessageId) return `reply to stored email ${replyToMessageId}`;
      return "send an email";
    }
    default: return `use ${safePlainDetail(request.toolName, 80) ?? "a tool"} ${place}`;
  }
}

function adapterHilRequestDetail(request: ProcHilRequest): string | null {
  switch (request.syscall) {
    case "shell.exec": return safeQuotedDetail(request.args.input, 1_200);
    case "fs.read":
    case "fs.write":
    case "fs.edit":
    case "fs.delete": return safeQuotedDetail(request.args.path, 512);
    case "net.fetch": return safeQuotedDetail(request.args.url, 512);
    default: return null;
  }
}

function asSentence(text: string): string {
  const first = Array.from(text)[0] ?? "";
  const capitalized = `${first.toLocaleUpperCase()}${text.slice(first.length)}`;
  return /[.!?…]$/u.test(capitalized) ? capitalized : `${capitalized}.`;
}

function singleLineDetail(value: JsonValue | string | undefined): string | null {
  const parsed = z.string().safeParse(value);
  if (!parsed.success) return null;
  const singleLine = parsed.data
    .replace(/[\p{Cc}\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return singleLine || null;
}

function safePlainDetail(
  value: JsonValue | string | undefined,
  maximum: number,
): string | null {
  const singleLine = singleLineDetail(value);
  if (!singleLine) return null;
  const characters = Array.from(singleLine);
  return characters.length <= maximum
    ? singleLine
    : `${characters.slice(0, maximum - 1).join("")}…`;
}

function safeQuotedDetail(
  value: JsonValue | string | undefined,
  maximum = 160,
): string | null {
  const singleLine = singleLineDetail(value);
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
