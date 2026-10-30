import type { JsonValue, ProcHilRequest } from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import { t, type TextKey } from "../../../i18n/locale";
import { callArgumentText as argText, describeCall, normalizeCallPurpose } from "./callDescription";

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
  purpose: z.string().optional(),
  createdAt: z.number().finite().optional(),
});

const APPROVE_ANSWERS = new Set(["y", "yes", "yep", "yeah", "ok", "okay", "sure", "go", "go ahead", "do it", "run it", "sí", "si"]);
// "stop" is deliberately absent: it must keep going out as a message, which supersedes and aborts the run.
const DENY_ANSWERS = new Set(["n", "no", "nope", "don't", "dont", "deny"]);

/** Maps a typed reply to a pending approval onto a decision, so typing an answer does not cancel the request. */
export function approvalAnswer(text: string): "approve" | "deny" | null {
  const answer = text.trim().toLowerCase().replace(/[.!]$/, "").trim().replace(/\s+/g, " ");
  if (APPROVE_ANSWERS.has(answer)) return "approve";
  if (DENY_ANSWERS.has(answer)) return "deny";
  return null;
}

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
  const purpose = normalizeCallPurpose(request.purpose);
  if (purpose) {
    normalized.purpose = purpose;
  }
  return normalized;
}

/** The sentence a person reads before deciding: the model's purpose, or one built from the request shape. */
export function hilRequestSentence(request: ProcHilRequest, place: string): string {
  const text = normalizeCallPurpose(request.purpose) ?? describeCall(request, place);
  const first = Array.from(text)[0] ?? "";
  return `${first.toLocaleUpperCase()}${text.slice(first.length)}`;
}

/**
 * The folded rail: a shell request reads as a terminal would show it, behind `who@place $`;
 * a file request leads with the place and a plain verb; mail names its recipient and subject;
 * anything else shows the tool's plain name and its text arguments. Never the dotted syscall id.
 */
export type HilRequestLine = {
  lead: "prompt" | "place" | "none";
  text: string;
};

const FILE_LINES = new Map<string, TextKey>([
  ["fs.read", "chat.hil.read"],
  ["fs.write", "chat.hil.write"],
  ["fs.edit", "chat.hil.edit"],
  ["fs.delete", "chat.hil.delete"],
]);

export function hilRequestLine(request: ProcHilRequest): HilRequestLine | null {
  const cronJobs = request.syscall === "sched.add" ? argText(request, "jobs") : null;
  if (cronJobs) return { lead: "none", text: `${argText(request, "path") ?? ""}\n${cronJobs}`.trimStart() };
  switch (request.syscall) {
    case "atproto.write": {
      const publication = hilPublication(request);
      return publication ? { lead: "none", text: publication.changes.map((change) => change.record).join(" · ") } : null;
    }
    case "shell.exec": {
      const command = argText(request, "input") ?? argText(request, "command");
      return command ? { lead: "prompt", text: command } : null;
    }
    case "fs.read":
    case "fs.write":
    case "fs.edit":
    case "fs.delete": {
      const path = argText(request, "path");
      const line = FILE_LINES.get(request.syscall);
      return path && line ? { lead: "place", text: t(line, { path }) } : null;
    }
    case "fs.search": {
      const query = argText(request, "query") ?? argText(request, "pattern");
      const path = argText(request, "path");
      if (query && path) return { lead: "place", text: t("chat.hil.searchIn", { query, path }) };
      if (query) return { lead: "place", text: t("chat.hil.search", { query }) };
      return path ? { lead: "place", text: t("chat.hil.searchPath", { path }) } : null;
    }
    case "net.fetch": {
      const url = argText(request, "url");
      return url ? { lead: "place", text: t("chat.hil.fetch", { url }) } : null;
    }
    case "mail.send": {
      const to = argText(request, "to");
      const subject = argText(request, "subject");
      const replyTo = argText(request, "replyToMessageId");
      if (to) return { lead: "none", text: subject ? t("chat.hil.mailToAbout", { to, subject }) : t("chat.hil.mailTo", { to }) };
      if (replyTo) return { lead: "none", text: subject ? t("chat.hil.replyAbout", { message: replyTo, subject }) : t("chat.hil.reply", { message: replyTo }) };
      return subject ? { lead: "none", text: subject } : null;
    }
    default: {
      const name = request.syscall === "sys.mcp.call" ? argText(request, "name") ?? plainToolName(request.toolName) : plainToolName(request.toolName);
      const args = Object.entries(request.args)
        .filter(([key, value]) => key !== "target" && key !== "serverId" && key !== "name" && isText(value))
        .map(([, value]) => value);
      return { lead: "place", text: [name, ...args].join(" ") };
    }
  }
}

/** A file a published record references, as the Ship uploaded it. */
export type HilPublishedFile = { cid: string; mimeType: string; size: number };

/** A publish to the open network: the Ship's handle and address, each change, and the files the records reference. */
export type HilPublication = {
  handle: string;
  address: string;
  changes: Array<{ action: "create" | "put" | "delete"; record: string }>;
  files: HilPublishedFile[];
};

const publicationSchema = z.object({
  handle: z.string().min(1),
  address: z.string().min(1),
  writes: z.array(z.object({
    action: z.enum(["create", "put", "delete"]),
    collection: z.string().min(1),
    rkey: z.string().optional(),
    record: hilWireValueSchema.optional(),
  })).min(1),
});
const blobSchema = z.object({
  $type: z.literal("blob"),
  ref: z.object({ $link: z.string().min(1) }),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
});

export function hilPublication(request: ProcHilRequest): HilPublication | null {
  if (request.syscall !== "atproto.write") return null;
  const parsed = publicationSchema.safeParse(request.args);
  if (!parsed.success) return null;
  const files = new Map<string, HilPublishedFile>();
  for (const write of parsed.data.writes) collectFiles(write.record, files);
  return {
    handle: parsed.data.handle,
    address: parsed.data.address,
    changes: parsed.data.writes.map((write) => ({
      action: write.action,
      record: write.rkey ? `${write.collection}/${write.rkey}` : write.collection,
    })),
    files: [...files.values()],
  };
}

function collectFiles(value: HilWireValue | undefined, files: Map<string, HilPublishedFile>): void {
  const blob = blobSchema.safeParse(value);
  if (blob.success) {
    files.set(blob.data.ref.$link, { cid: blob.data.ref.$link, mimeType: blob.data.mimeType, size: blob.data.size });
  } else if (Array.isArray(value)) {
    for (const item of value) collectFiles(item, files);
  } else if (isHilWireRecord(value)) {
    for (const item of Object.values(value)) collectFiles(item, files);
  }
}

function isHilWireRecord(value: HilWireValue | undefined): value is HilWireRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function plainToolName(toolName: string): string {
  return toolName.split(".").at(-1) ?? toolName;
}

export function hilDetailLabel(request: ProcHilRequest): string {
  return t(request.syscall === "shell.exec" ? "chat.hil.showCommand" : "chat.hil.showDetails");
}

function isText(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}
