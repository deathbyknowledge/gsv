import * as z from "zod/mini";

const bounded = (limit: number) => z.optional(z.string().check(z.maxLength(limit)));

/** Selected error fields only; never serialize a request, response, or SDK error object. */
export const exceptionDiagnosticProperties = {
  exceptionName: bounded(128),
  exceptionMessage: bounded(2048),
  exceptionStack: bounded(8192),
  exceptionCause: bounded(2048),
  errorCode: bounded(128),
  errorSubcode: bounded(128),
  providerRequestId: bounded(256),
  providerStatusCode: z.optional(z.number().check(z.int(), z.gte(100), z.lte(599))),
};
export const exceptionDiagnosticsSchema = z.strictObject(exceptionDiagnosticProperties);
export type ExceptionDiagnostics = {
  exceptionName?: string;
  exceptionMessage?: string;
  exceptionStack?: string;
  exceptionCause?: string;
  errorCode?: string;
  errorSubcode?: string;
  providerRequestId?: string;
  providerStatusCode?: number;
};

const optionalText = z.catch(z.optional(z.string()), undefined);
const optionalCode = z.catch(z.optional(z.union([z.string(), z.number()])), undefined);
const messageSchema = z.object({ message: optionalText });
const errorInputSchema = z.object({
  name: optionalText, message: optionalText, stack: optionalText,
  code: optionalCode, subcode: optionalCode,
  request_id: optionalText, requestID: optionalText, requestId: optionalText,
  status: z.catch(z.optional(z.number().check(z.int(), z.gte(100), z.lte(599))), undefined),
  cause: z.catch(z.optional(z.union([z.string(), messageSchema])), undefined),
});
const errorResponseSchema = z.object({ message: optionalText, error: z.optional(messageSchema) });

/** Best-effort scrubbing of error text, not a license to log user content. */
export function redactDiagnosticText(value: string, limit: number): string {
  let text = value.replace(/\b(Bearer|Basic)\s+[^\s"'<>;,]+/gi, "$1 [redacted]");
  text = text.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, "[redacted]");
  text = text.replace(/\bhttps?:\/\/[^\s<>"']+/gi, (raw) => {
    try {
      const url = new URL(raw);
      url.username = "";
      url.password = "";
      if (url.search) url.search = "?[redacted]";
      if (url.hash) url.hash = "#[redacted]";
      return url.toString();
    } catch { return "[redacted URL]"; }
  });
  text = text.replace(/(["']?\b(?:authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|client[_-]?secret|chat[_-]?id|actor[_-]?id|recipient[_-]?id|phone[_-]?number)["']?\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;}]+)/gi, "$1[redacted]");
  text = text.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted email]");
  text = text.replace(/(?:\/home\/|\/Users\/|[A-Z]:\\Users\\)[^\s:)"']+/gi, "[redacted path]");
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function errorMessage(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  // Some SDKs stringify the entire response into Error.message. Keep its
  // selected message, never sibling payloads such as the failed request.
  const start = value.indexOf("{");
  if (start >= 0) {
    try {
      const parsed = errorResponseSchema.safeParse(JSON.parse(value.slice(start)));
      const message = parsed.success ? parsed.data.error?.message ?? parsed.data.message : undefined;
      return `${value.slice(0, start)}${message ?? "Provider returned an error response"}`;
    } catch { /* Ordinary error prose may contain braces. */ }
  }
  return value;
}

export function exceptionDiagnostics(cause: unknown): ExceptionDiagnostics {
  const text = z.string().safeParse(cause);
  const parsed = errorInputSchema.safeParse(cause);
  if (!parsed.success && !text.success) return {};
  const error: z.infer<typeof errorInputSchema> = parsed.success ? parsed.data : { message: text.data };
  const result: ExceptionDiagnostics = {};
  const strings: [Exclude<keyof ExceptionDiagnostics, "providerStatusCode">, string | number | undefined, number][] = [
    ["exceptionName", error?.name, 128],
    ["exceptionMessage", errorMessage(error.message), 2048],
    ["errorCode", error?.code, 128],
    ["errorSubcode", error?.subcode, 128],
    ["providerRequestId", error?.request_id ?? error?.requestID ?? error?.requestId, 256],
  ];
  for (const [key, input, limit] of strings) {
    if (input !== undefined) result[key] = redactDiagnosticText(String(input), limit);
  }
  if (error.stack !== undefined) {
    // Rebuild the first line from the selected message: Error.stack often
    // repeats an SDK's full JSON response even after message selection.
    const frames = error.stack.split("\n").filter((line) => /^\s+at\s/.test(line)).join("\n");
    result.exceptionStack = redactDiagnosticText(`${result.exceptionName ?? "Error"}: ${result.exceptionMessage ?? ""}${frames ? `\n${frames}` : ""}`, 8192);
  }
  if (error.status !== undefined) result.providerStatusCode = error.status;
  const causeText = z.string().safeParse(error.cause);
  const causeRecord = messageSchema.safeParse(error.cause);
  const causeMessage = errorMessage(causeText.success ? causeText.data : causeRecord.data?.message);
  if (causeMessage) result.exceptionCause = redactDiagnosticText(causeMessage, 2048);
  return result;
}

/** Reapply scrubbing when consuming diagnostics across a trust boundary. */
export function sanitizeExceptionDiagnostics(value: ExceptionDiagnostics): ExceptionDiagnostics {
  return exceptionDiagnostics({
    name: value.exceptionName, message: value.exceptionMessage, stack: value.exceptionStack,
    status: value.providerStatusCode, cause: value.exceptionCause, code: value.errorCode, subcode: value.errorSubcode, requestId: value.providerRequestId,
  });
}
