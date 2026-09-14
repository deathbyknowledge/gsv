import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { GSVClient } from "@humansandmachines/gsv/client";
import { stableOpaqueId } from "../../../workers/gateway/src/shared/stable-id.ts";

type HistoryClient = {
  ai: Pick<GSVClient["ai"], "models">;
  conversation: Pick<GSVClient["conversation"], "forProcess" | "send" | "history">;
  proc: Pick<GSVClient["proc"], "history">;
};
const intentSchema = z.strictObject({ pid: z.string().min(1), conversationId: z.string().min(1), idempotencyKey: z.string().min(1), sentinel: z.string().min(1) });
export type LegacyHistoryIntent = z.infer<typeof intentSchema>;
const conversationSchema = z.object({ id: z.string(), handlerPid: z.string(), kind: z.string(), ownerUid: z.number().int() });
const messageSchema = z.object({ id: z.string(), conversationId: z.string(), sequence: z.number().int().positive(),
  author: z.object({ kind: z.string() }).catchall(z.json()), text: z.string(), processId: z.string().optional(), runId: z.string().optional() }).catchall(z.json());
const recordSchema = z.object({ id: z.number().int().positive(), messageId: z.number().int().positive(), index: z.number().int().nonnegative(),
  generation: z.number().int().nonnegative(), kind: z.string(), payload: z.record(z.string(), z.json()), runId: z.string().nullable() }).catchall(z.json());
const processHistorySchema = z.object({ ok: z.literal(true), pid: z.string(), format: z.literal(2), records: z.array(recordSchema),
  activeRunId: z.string().nullable().optional(), hasMore: z.boolean(), hasMoreBefore: z.boolean().optional(),
  hasMoreAfter: z.boolean().optional(), truncated: z.boolean().optional() });
const conversationHistorySchema = z.object({ conversation: conversationSchema, messages: z.array(messageSchema), hasMore: z.boolean() });
const generationFailureSchema = z.object({ kind: z.literal("generation.failed"), payload: z.object({ error: z.string() }) });
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const recordProofSchema = z.strictObject({ id: z.number().int().positive(), messageId: z.number().int().positive(),
  index: z.number().int().nonnegative(), generation: z.number().int().nonnegative(), sha256: digest });
const conversationProofSchema = z.strictObject({ id: z.string().min(1), sequence: z.number().int().positive(), sha256: digest });
export const legacyHistoryProofSchema = z.strictObject({ version: z.literal(1), pid: z.string().min(1), conversationId: z.string().min(1),
  runId: z.string().min(1), intentSha256: digest,
  conversation: conversationProofSchema, processInput: recordProofSchema, processError: recordProofSchema,
  conversationPrefix: z.array(conversationProofSchema).min(1), processPrefix: z.array(recordProofSchema).min(2) });
export type LegacyHistoryProof = z.infer<typeof legacyHistoryProofSchema>;

type HistoryJson = z.infer<ReturnType<typeof z.json>>;
function canonical(value: HistoryJson): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  // This is a parsed recursive JSON value; object keys are sorted solely for stable hashing.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}
type HashInput = HistoryJson | LegacyHistoryIntent | z.infer<typeof messageSchema> | z.infer<typeof recordSchema>;
function hash(value: HashInput): string { return createHash("sha256").update(canonical(z.json().parse(JSON.parse(JSON.stringify(value))))).digest("hex"); }
function recordProof(record: z.infer<typeof recordSchema>) {
  const { id, messageId, index, generation } = record;
  return { id, messageId, index, generation, sha256: hash(record) };
}
function conversationProof(message: z.infer<typeof messageSchema>) {
  return { id: message.id, sequence: message.sequence, sha256: hash(message) };
}
async function requireConversation(client: HistoryClient, intent: LegacyHistoryIntent) {
  intentSchema.parse(intent);
  const { conversation } = z.object({ conversation: conversationSchema }).parse(await client.conversation.forProcess({ pid: intent.pid }));
  if (conversation.id !== intent.conversationId || conversation.handlerPid !== intent.pid || conversation.kind !== "ship") {
    throw new Error("History intent does not target its own Ship conversation");
  }
  return conversation;
}
async function histories(client: HistoryClient, intent: LegacyHistoryIntent) {
  const [conversationValue, processValue] = await Promise.all([
    client.conversation.history({ conversationId: intent.conversationId, limit: 100 }),
    client.proc.history({ pid: intent.pid, format: 2, tail: true, limit: 1000 }),
  ]);
  const conversation = conversationHistorySchema.parse(conversationValue);
  const process = processHistorySchema.parse(processValue);
  if (conversation.conversation.id !== intent.conversationId || conversation.conversation.handlerPid !== intent.pid
    || !process.ok || process.pid !== intent.pid || process.format !== 2) throw new Error("History response belongs to another fixture or format");
  if (conversation.hasMore || process.hasMoreBefore || process.hasMoreAfter || process.truncated || process.hasMore) {
    throw new Error("Fixture history exceeds the complete bounded evidence window");
  }
  return { conversation, process };
}

type CaptureOptions = { client: HistoryClient; intent: LegacyHistoryIntent; managedInferenceEnabled: false; timeoutMs?: number; pollIntervalMs?: number };
async function requireDisabledInference(input: CaptureOptions) {
  if (input.managedInferenceEnabled !== false) throw new Error("Explicit legacy history authorization and disabled inference are required");
  const { client, intent } = input;
  const conversation = await requireConversation(client, intent);
  const models = z.object({ models: z.array(z.object({ provider: z.string(), source: z.string() })) }).parse(await client.ai.models({}));
  if (models.models.length === 0 || models.models.some((model) => model.provider !== "gsv" || model.source !== "base")) {
    throw new Error("History seed requires only the disabled deployment GSV model");
  }
  return { ownerUid: conversation.ownerUid, messageId: await stableOpaqueId("msg", [intent.conversationId, intent.idempotencyKey]) };
}
function requireIntentMessage(message: z.infer<typeof messageSchema>, intent: LegacyHistoryIntent, expected: { ownerUid: number; messageId: string }): void {
  if (message.id !== expected.messageId || message.conversationId !== intent.conversationId || message.author.kind !== "user"
    || message.author.uid !== expected.ownerUid || message.text !== intent.sentinel || message.processId !== intent.pid
    || message.runId !== `run:${expected.messageId}`) throw new Error("History admission returned an unrelated message or run");
}

/** Normal protocol admission: local user input is committed, then disabled inference fails before provider execution. */
export async function seedLegacyUpgradeHistory(input: CaptureOptions & { phase: "seed-legacy" }): Promise<LegacyHistoryProof> {
  if (input.phase !== "seed-legacy") throw new Error("Explicit legacy history authorization and disabled inference are required");
  const expected = await requireDisabledInference(input);
  const { client, intent } = input;
  const sent = z.object({ handlerPid: z.string(), runId: z.string(), message: messageSchema }).parse(
    await client.conversation.send({ conversationId: intent.conversationId, text: intent.sentinel, idempotencyKey: intent.idempotencyKey }));
  requireIntentMessage(sent.message, intent, expected);
  if (sent.handlerPid !== intent.pid || sent.runId !== sent.message.runId) throw new Error("History admission returned an unrelated message or run");
  return captureTerminalHistory(input, sent.message);
}

/** Recover evidence for an already committed intent using reads only; an absent message is never resent. */
export async function captureLegacyUpgradeHistory(input: CaptureOptions & { phase: "capture-legacy" }): Promise<LegacyHistoryProof> {
  if (input.phase !== "capture-legacy") throw new Error("Explicit read-only legacy capture phase is required");
  const expected = await requireDisabledInference(input);
  const { conversation } = await histories(input.client, input.intent);
  const messages = conversation.messages.filter((message) => message.id === expected.messageId);
  if (messages.length !== 1) throw new Error("Saved history intent has no unique committed message; read-only capture will not send");
  requireIntentMessage(messages[0], input.intent, expected);
  return captureTerminalHistory(input, messages[0]);
}

async function captureTerminalHistory(input: CaptureOptions, admitted: z.infer<typeof messageSchema>): Promise<LegacyHistoryProof> {
  const { client, intent } = input;
  const runId = `run:${admitted.id}`;
  const deadline = Date.now() + (input.timeoutMs ?? 60_000);
  do {
    const { conversation, process } = await histories(client, intent);
    const messages = conversation.messages.filter((message) => message.id === admitted.id);
    const inputs = process.records.filter((record) => record.runId === runId && record.kind === "message"
      && record.payload.direction === "in" && record.payload.text === intent.sentinel);
    const errors = process.records.filter((record) => record.runId === runId && record.kind === "event"
      && record.payload.kind === "generation.failed");
    // The historical GSV provider deliberately hides the underlying disabled-service exception.
    // This exact projection is evidence only alongside the fresh false binding and base-only model checks above.
    if (errors.some((record) => generationFailureSchema.parse(record.payload).payload.error !== "GSV inference is unavailable")) {
      throw new Error("History seed encountered an unexpected generation failure");
    }
    if (messages.length > 1 || inputs.length > 1 || errors.length > 1) throw new Error("History seed contains duplicate records");
    if (messages.length === 1 && inputs.length === 1 && errors.length === 1 && process.activeRunId === null) {
      if (hash(messages[0]) !== hash(admitted)) throw new Error("Committed history differs from the admitted message");
      return legacyHistoryProofSchema.parse({ version: 1, pid: intent.pid, conversationId: intent.conversationId, runId,
        intentSha256: hash(intent), conversation: conversationProof(messages[0]), processInput: recordProof(inputs[0]), processError: recordProof(errors[0]),
        conversationPrefix: conversation.messages.map(conversationProof), processPrefix: process.records.map(recordProof) });
    }
    if (Date.now() >= deadline) break;
    await delay(Math.min(input.pollIntervalMs ?? 250, Math.max(0, deadline - Date.now())));
  } while (Date.now() <= deadline);
  throw new Error("History seed did not reach its recorded disabled-inference terminal state");
}

/** Read only: compare selected immutable records, not changing status, counts or head cursors. */
export async function verifyLegacyUpgradeHistory(input: { client: HistoryClient; intent: LegacyHistoryIntent; proof: LegacyHistoryProof }): Promise<void> {
  const { client, intent } = input;
  const proof = legacyHistoryProofSchema.parse(input.proof);
  if (proof.pid !== intent.pid || proof.conversationId !== intent.conversationId || proof.intentSha256 !== hash(intent)) throw new Error("History proof belongs to another persisted intent");
  await requireConversation(client, intent);
  const { conversation, process } = await histories(client, intent);
  if (hash(conversation.messages.slice(0, proof.conversationPrefix.length).map(conversationProof)) !== hash(proof.conversationPrefix)) {
    throw new Error("Legacy conversation prefix content or identity changed");
  }
  if (hash(process.records.slice(0, proof.processPrefix.length).map(recordProof)) !== hash(proof.processPrefix)) {
    throw new Error("Legacy Process prefix content or identity changed");
  }
  const messages = conversation.messages.filter((message) => message.id === proof.conversation.id);
  if (messages.length !== 1 || hash(conversationProof(messages[0])) !== hash(proof.conversation)) throw new Error("Legacy conversation content or identity changed");
  for (const expected of [proof.processInput, proof.processError]) {
    const records = process.records.filter((record) => record.id === expected.id);
    if (records.length !== 1 || records[0].runId !== proof.runId || hash(recordProof(records[0])) !== hash(expected)) {
      throw new Error("Legacy Process content or identity changed");
    }
  }
}
