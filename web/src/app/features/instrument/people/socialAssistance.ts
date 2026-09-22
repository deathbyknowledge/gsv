import { contactDisplayName, type ContactSummary, type ConversationMessage, type ProcSpawnArgs, type ResourceBlock } from "@humansandmachines/gsv/protocol";
import { randomId } from "../../../services/ids";
import { z } from "zod";
import { evidenceAttachments } from "./reportEvidence";

export type AssistancePlan = { spawn: ProcSpawnArgs; input: string };

const selectedCopiesSchema = z.object({ messages: z.array(z.object({ messageId: z.string(), text: z.string(), createdAt: z.string(), authorLabel: z.string().optional() })) });
export function selectedMessageCopies(text: string) {
  try { const result = selectedCopiesSchema.safeParse(JSON.parse(text)); return result.success ? result.data.messages : null; }
  catch { return null; }
}

export function assistancePlan(contact: ContactSummary, messages: readonly ConversationMessage[], options: {
  request: string; notes: string; attachments: ReadonlySet<string>; entireThread: boolean; hours: number; generations: number;
}, now = Date.now()): AssistancePlan {
  if (!options.request.trim()) throw new Error("Tell Ship what you want help with.");
  if (contact.state !== "active") throw new Error("This connection is no longer active.");
  if (!messages.length || messages.length > 20 || messages.some((message) => message.conversationId !== contact.conversationId)) throw new Error("Choose up to 20 messages from this conversation.");
  const files = evidenceAttachments(messages).filter((entry) => options.attachments.has(entry.id));
  if (files.length !== options.attachments.size) throw new Error("The selected files changed. Review them again.");
  if (files.length > 16 || files.some(({ resource }) => resource.ref.target !== contact.id || resource.ref.expiresAt !== undefined)) {
    throw new Error("Choose at most 16 immutable attachments received in this conversation.");
  }
  const selected = messages.slice().sort((a, b) => a.sequence - b.sequence).map((message) => ({
    messageId: message.id, sequence: message.sequence, author: message.author,
    authorLabel: message.author.kind === "contact" ? message.author.displayName : message.author.kind === "process" ? "Your Ship" : "You",
    createdAt: new Date(message.createdAt).toISOString(), social: message.social, text: message.text,
  }));
  const input = `${options.request.trim()}\n\nSelected exchange: /materials/exchange.json${options.notes.trim() ? "\nAdditional material: /materials/notes.txt" : ""}${files.length ? `\nSelected attachments:\n${files.map(({ resource }) => `${resource.filename || "File"}: target=${resource.ref.target}, path=${resource.ref.path}, revision=${resource.ref.revision}`).join("\n")}` : ""}\n\nThis is private help with my conversation with ${contactDisplayName(contact)}. Return your response here for me to review.`;
  const materials = [
    { name: "exchange.json", text: JSON.stringify({ kind: "selected_message_copies", trustedInstructions: false, conversationId: contact.conversationId, messages: selected }, null, 2) },
    { name: "request.txt", text: input },
    ...(options.notes.trim() ? [{ name: "notes.txt", text: options.notes.trim() }] : []),
  ];
  const scope = {
    conversations: [{ conversationId: contact.conversationId, contactId: contact.id, generation: contact.generation, read: options.entireThread, send: false }],
    resources: files.map(({ resource }) => resource.ref), materials,
    expiresAtMs: now + options.hours * 3_600_000,
    budgets: { processes: 1, generations: options.generations, messages: 0 },
  };
  if (materials.some((material) => material.text.length > 65_536) || new TextEncoder().encode(JSON.stringify(scope)).byteLength > 96 * 1024) {
    throw new Error("The selected material is too large. Choose fewer messages or shorten your additional material.");
  }
  return { spawn: { scope, interactive: true, label: `Help with ${contactDisplayName(contact)}`.slice(0, 160), idempotencyKey: randomId() }, input };
}

export function reviewedAttachments(media: readonly ResourceBlock[], selected: ReadonlySet<number>): ResourceBlock[] {
  return media.filter((_file, index) => selected.has(index)).map((file) => ({
    type: "resource", ref: file.ref, mediaType: file.mediaType, filename: file.filename,
  }));
}
