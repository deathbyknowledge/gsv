import type { JsonValue, ProcHilRequest } from "@humansandmachines/gsv/protocol";
import { z } from "zod";

type HilWireValue = string | number | boolean | null | HilWireValue[] | HilWireRecord;
type HilWireRecord = { [key: string]: HilWireValue };
const hilWireValueSchema: z.ZodType<HilWireValue> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(hilWireValueSchema),
  z.record(z.string(), hilWireValueSchema),
]));
const hilRequestSchema = z.object({
  pid: z.string(),
  requestId: z.string(),
  runId: z.string(),
  callId: z.string(),
  toolName: z.string(),
  syscall: z.string(),
  target: z.string(),
  args: z.record(z.string(), hilWireValueSchema).optional(),
  reason: z.string().optional(),
  createdAt: z.number().finite().optional(),
});

export function normalizeHilRequest<T>(value: T): ProcHilRequest | null {
  const parsed = hilRequestSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const request = parsed.data;
  if (!request.pid.trim() || !request.requestId.trim() || !request.runId.trim()
    || !request.callId.trim() || !request.toolName.trim() || !request.syscall.trim()
    || !request.target) {
    return null;
  }
  const normalized: ProcHilRequest = {
    pid: request.pid,
    requestId: request.requestId,
    runId: request.runId,
    callId: request.callId,
    toolName: request.toolName,
    syscall: request.syscall,
    target: request.target,
    args: request.args ?? {},
    createdAt: request.createdAt ?? Date.now(),
  };
  const reason = request.reason?.replace(/\s+/g, " ").trim();
  if (reason) {
    normalized.reason = reason;
  }
  return normalized;
}

/** The sentence a person reads before deciding: the model's reason, or one built from the request shape. */
export function hilRequestSentence(request: ProcHilRequest, place: string): string {
  const text = request.reason ?? describeHilRequest(request, place);
  const first = Array.from(text)[0] ?? "";
  return `${first.toLocaleUpperCase()}${text.slice(first.length)}`;
}

/** A bare verb phrase for a request the model did not explain, in the shape the reason would take. */
export function describeHilRequest(request: ProcHilRequest, place: string): string {
  const where = request.target === "gsv" ? `in ${place}` : `on ${place}`;
  switch (request.syscall) {
    case "shell.exec": return `run a command ${where}`;
    case "fs.read": return `read a file ${where}`;
    case "fs.write": return `write a file ${where}`;
    case "fs.edit": return `edit a file ${where}`;
    case "fs.delete": return `delete a file ${where}`;
    case "fs.search": return `search files ${where}`;
    case "net.fetch": return `fetch a web address ${where}`;
    case "mail.send": {
      const to = argText(request, "to");
      const subject = argText(request, "subject");
      if (to && subject) return `send an email to ${to} about ${subject}`;
      if (to) return `send an email to ${to}`;
      if (argText(request, "replyToMessageId")) return "reply to an email";
      return "send an email";
    }
    default: return `use ${request.toolName} ${where}`;
  }
}

/** The raw detail behind a request: the command, path or address it names. */
export function hilRequestDetail(request: ProcHilRequest): string | null {
  switch (request.syscall) {
    case "shell.exec": return argText(request, "input") ?? argText(request, "command");
    case "fs.read":
    case "fs.write":
    case "fs.edit":
    case "fs.delete":
    case "fs.search": return argText(request, "path");
    case "net.fetch": return argText(request, "url");
    case "mail.send": {
      const parts = [argText(request, "to"), argText(request, "subject")].filter((part) => part !== null);
      return parts.length ? parts.join(" · ") : null;
    }
    default: return Object.values(request.args).find(isText) ?? null;
  }
}

export function hilDetailLabel(request: ProcHilRequest): string {
  return request.syscall === "shell.exec" ? "show the command" : "show the details";
}

function isText(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}

function argText(request: ProcHilRequest, key: string): string | null {
  const value = request.args[key];
  return isText(value) && value.trim() ? value : null;
}
