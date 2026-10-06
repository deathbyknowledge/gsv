import type { ProcHistoryEvent } from "@humansandmachines/gsv/protocol";

/** What went wrong, in the terms a person can act on; the gateway's own wording stays in `detail`. */
export type ChatErrorKind =
  | "timeout"
  | "cancelled"
  | "context-limit"
  | "provider-account"
  | "rate-limit"
  | "authentication"
  | "provider-unavailable"
  | "setup"
  | "empty-response"
  | "network"
  | "runtime"
  | "delivery"
  | "media"
  | "incomplete-response"
  | "process-timeout"
  | "unknown";

export type ChatErrorPresentation = {
  kind: ChatErrorKind;
  /** One plain sentence saying what happened. */
  summary: string;
  /** The recommended next step. */
  action: string;
  /** The original text, kept inspectable for diagnosis. */
  detail: string;
};

/** Summary and action for a failure whose cause the client could not recognise. */
export type ChatErrorContext = Pick<ChatErrorPresentation, "summary" | "action">;

const PRESENTATION = {
  "timeout": {
    summary: "The model took too long to respond.",
    action: "Try again. If it keeps happening, wait a few minutes or switch to another model.",
  },
  "cancelled": {
    summary: "The request was cancelled before it finished.",
    action: "Send your message again if you still need an answer.",
  },
  "context-limit": {
    summary: "This conversation is too long for the model to read at once.",
    action: "Compact or reset the conversation, remove large attachments, or switch to a model with a larger context window.",
  },
  "provider-account": {
    summary: "The AI provider account needs attention.",
    action: "Check credits, quota, or billing for your AI provider, then try again.",
  },
  "rate-limit": {
    summary: "The AI provider is receiving too many requests right now.",
    action: "Wait a few minutes, then try again.",
  },
  "authentication": {
    summary: "The AI provider did not accept the configured credentials.",
    action: "Check the API key for your AI provider, then try again.",
  },
  "provider-unavailable": {
    summary: "The AI provider is unavailable right now.",
    action: "Wait a few minutes, then try again, or switch to another model.",
  },
  "setup": {
    summary: "No AI model is ready to answer.",
    action: "Check the AI provider and model configuration, then try again.",
  },
  "empty-response": {
    summary: "The model returned no usable answer.",
    action: "Try again. If it keeps happening, switch to another model.",
  },
  "network": {
    summary: "The connection was interrupted.",
    action: "Check your connection, then try again.",
  },
  "runtime": {
    summary: "This process ran into an internal problem and stopped.",
    action: "Try again. If it keeps happening, restart the process.",
  },
  "delivery": {
    summary: "A reply could not be delivered.",
    action: "Check the messaging connection, then try again in a few minutes.",
  },
  "media": {
    summary: "An attachment could not be processed.",
    action: "Attach it again, or try a smaller or different file.",
  },
  "incomplete-response": {
    summary: "The reply stopped before it was finished.",
    action: "Try again, or rephrase your request.",
  },
  "process-timeout": {
    summary: "Another process did not reply in time.",
    action: "Try again, or check on that process.",
  },
  "unknown": {
    summary: "Something went wrong.",
    action: "Try again. If it keeps happening, restart the process and check the details.",
  },
} satisfies Record<ChatErrorKind, ChatErrorContext>;

/** Ordered: the first match wins, so a timed-out connection reads as a timeout and a quota 429 as an account issue. */
const TEXT_CLASSIFIERS: ReadonlyArray<readonly [ChatErrorKind, RegExp]> = [
  ["timeout", /timed?[\s_-]*out|timeout|deadline exceeded|\bHTTP\s*(?:408|504)\b/i],
  ["cancelled", /\bcancel+ed\b|\baborted\b/i],
  ["context-limit", /context limit|maximum context|request_too_large|(?:context(?: length| window)?|input|prompt)\b.*(?:too (?:large|long)|exceed|maximum)|\bHTTP\s*413\b/i],
  ["provider-account", /provider account issue|payment[\s_-]+required|insufficient[\s_-]+(?:funds|credits|balance|quota)|out[\s_-]+of[\s_-]+(?:credits?|quota)|quota[\s_-]+exceeded|exceeded[\s_-]+(?:your[\s_-]+)?quota|billing|\bHTTP\s*402\b/i],
  ["rate-limit", /provider rate limit|rate[\s_-]*limit|too many requests|\bHTTP\s*429\b|\b429\b/i],
  ["authentication", /unauthori[sz]ed|forbidden|authentication|invalid (?:api )?key|missing (?:api )?key|\bHTTP\s*40[13]\b/i],
  ["provider-unavailable", /(?:at|over|out of) capacity|overloaded|no (?:available )?capacity|temporarily unavailable|service unavailable|bad gateway|HTML (?:error|challenge)|\bHTTP\s*5\d\d\b|\b50[023]\b/i],
  ["setup", /not configured|no (?:default )?model|model not found|unknown model/i],
  ["empty-response", /empty response|no final response|returned no text|output token limit|malformed tool call/i],
  ["network", /network|fetch failed|connection|socket|disconnect|offline|\bdns\b|econn|enotfound/i],
];

function classify(detail: string): ChatErrorKind {
  return TEXT_CLASSIFIERS.find(([, pattern]) => pattern.test(detail))?.[0] ?? "unknown";
}

function present(kind: ChatErrorKind, detail: string, context?: ChatErrorContext): ChatErrorPresentation {
  const copy = kind === "unknown" && context ? context : PRESENTATION[kind];
  return { kind, ...copy, detail };
}

/**
 * Turn an error string from the gateway into a plain summary and a next step. `context` describes what was being
 * attempted, and stands in when the cause itself is not one the client recognises.
 */
export function describeChatError(detail: string, context?: ChatErrorContext): ChatErrorPresentation {
  return present(classify(detail), detail, context);
}

/** The person-facing presentation of an error-severity Process event; other events are not failures. */
export function describeHistoryEventError(event: ProcHistoryEvent, detail: string): ChatErrorPresentation | null {
  if (event.severity !== "error") return null;
  switch (event.kind) {
    case "generation.failed":
      return present(event.payload.reason === "generation.empty" ? "empty-response" : classify(detail), detail);
    case "context.failed": return present("context-limit", detail);
    case "runtime.failed": {
      const kind = classify(detail);
      return present(kind === "unknown" ? "runtime" : kind, detail);
    }
    case "delivery.failed": return present("delivery", detail);
    case "media.failed": return present("media", detail);
    case "correction.exhausted": return present("incomplete-response", detail);
    case "ipc.timeout": return present("process-timeout", detail);
  }
  return describeChatError(detail);
}
