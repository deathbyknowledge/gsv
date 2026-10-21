import type { ProcHistoryEvent } from "@humansandmachines/gsv/protocol";
import type { TextKey } from "../../../i18n/locale";

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
  summary: TextKey;
  /** The recommended next step. */
  action: TextKey;
  /** The original text, kept inspectable for diagnosis. */
  detail: string;
};

/** Summary and action for a failure whose cause the client could not recognise. */
export type ChatErrorContext = Pick<ChatErrorPresentation, "summary" | "action">;

const PRESENTATION = {
  "timeout": { summary: "chat.error.timeout.summary", action: "chat.error.timeout.action" },
  "cancelled": { summary: "chat.error.cancelled.summary", action: "chat.error.cancelled.action" },
  "context-limit": { summary: "chat.error.contextLimit.summary", action: "chat.error.contextLimit.action" },
  "provider-account": { summary: "chat.error.providerAccount.summary", action: "chat.error.providerAccount.action" },
  "rate-limit": { summary: "chat.error.rateLimit.summary", action: "chat.error.rateLimit.action" },
  "authentication": { summary: "chat.error.authentication.summary", action: "chat.error.authentication.action" },
  "provider-unavailable": { summary: "chat.error.providerUnavailable.summary", action: "chat.error.providerUnavailable.action" },
  "setup": { summary: "chat.error.setup.summary", action: "chat.error.setup.action" },
  "empty-response": { summary: "chat.error.emptyResponse.summary", action: "chat.error.emptyResponse.action" },
  "network": { summary: "chat.error.network.summary", action: "chat.error.network.action" },
  "runtime": { summary: "chat.error.runtime.summary", action: "chat.error.runtime.action" },
  "delivery": { summary: "chat.error.delivery.summary", action: "chat.error.delivery.action" },
  "media": { summary: "chat.error.media.summary", action: "chat.error.media.action" },
  "incomplete-response": { summary: "chat.error.incompleteResponse.summary", action: "chat.error.incompleteResponse.action" },
  "process-timeout": { summary: "chat.error.processTimeout.summary", action: "chat.error.processTimeout.action" },
  "unknown": { summary: "chat.error.unknown.summary", action: "chat.error.unknown.action" },
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
  const kind = classify(detail);
  // A gateway operation failing with "Unauthorized" or "timeout" does not identify an AI provider failure.
  return present(context && kind !== "network" && kind !== "cancelled" ? "unknown" : kind, detail, context);
}

/** The person-facing presentation of an error-severity Process event; other events are not failures. */
export function describeHistoryEventError(event: ProcHistoryEvent, detail: string): ChatErrorPresentation | null {
  if (event.severity !== "error") return null;
  switch (event.kind) {
    case "generation.failed":
      return present(event.payload.reason === "generation.empty" ? "empty-response" : classify(event.payload.error), detail);
    case "context.failed": {
      const { error } = event.payload;
      return present(error === undefined || classify(error) === "context-limit" ? "context-limit" : "unknown", detail, {
        summary: "chat.error.contextFailed.summary",
        action: "chat.error.contextFailed.action",
      });
    }
    case "runtime.failed": return present("runtime", detail);
    case "delivery.failed": return present("delivery", detail);
    case "media.failed": return present("media", detail);
    case "correction.exhausted": return present("incomplete-response", detail);
    case "ipc.timeout": return present("process-timeout", detail);
  }
  return describeChatError(detail);
}
