import { MAX_FEDERATION_MESSAGE_BYTES, MAX_FEDERATION_MESSAGE_RESOURCE_BYTES, MAX_FEDERATION_MESSAGE_RESOURCES, resourceBlockSchema, type ContactSendArgs, type ConversationMessage, type ResourceBlock } from "@humansandmachines/gsv/protocol";
import { randomId } from "../../../services/ids";

export type EvidenceAttachment = { id: string; resource: ResourceBlock };

export function evidenceAttachments(messages: readonly ConversationMessage[]): EvidenceAttachment[] {
  return messages.flatMap((message) => (message.media ?? []).flatMap((media, index) => {
    const parsed = resourceBlockSchema.safeParse(media);
    return parsed.success ? [{ id: `${message.id}:${index}`, resource: parsed.data }] : [];
  }));
}

export function reportEvidence(contactId: string, messages: readonly ConversationMessage[], note: string, attachmentIds: ReadonlySet<string>): ContactSendArgs {
  if (!messages.length || messages.length > 20) throw new Error("Select between one and 20 messages for this report.");
  const selected = evidenceAttachments(messages).filter((entry) => attachmentIds.has(entry.id));
  if (selected.length !== attachmentIds.size) throw new Error("The selected attachments changed. Review them again.");
  if (selected.length > MAX_FEDERATION_MESSAGE_RESOURCES || selected.reduce((bytes, entry) => bytes + entry.resource.ref.size, 0) > MAX_FEDERATION_MESSAGE_RESOURCE_BYTES) {
    throw new Error("A report can include at most 16 attachments totalling 48 MiB.");
  }
  const blocks = messages.map((message) => {
    const author = message.author.kind === "contact" ? message.author.displayName : message.author.kind === "process" ? "Reporter's Ship" : "Reporter";
    const provenance = message.social?.provenance.kind;
    const submitted = provenance === "approved" ? "human-approved draft" : provenance === "process" ? "Ship" : provenance === "human" ? "person" : "submission type unavailable";
    const origin = message.social?.reference;
    const identity = origin ? `Origin: ${origin.actor.shipId} / ${origin.actor.subjectId}\nMessage: ${origin.messageId}`
      : message.author.kind === "contact" ? `Origin: ${message.author.shipId} / ${message.author.subjectId}\nLocal message: ${message.id}` : `Local message: ${message.id}`;
    return `${author} · ${submitted} · ${new Date(message.createdAt).toISOString()}\n${identity}\n\n${message.text || "[Attachment message]"}`;
  });
  const text = ["Private report", ...(note.trim() ? [note.trim()] : []), `Selected message copies (${messages.length})`, ...blocks,
    `Attachments included: ${selected.length}${selected.length ? `\n${selected.map((entry) => entry.resource.filename || "Unnamed file").join("\n")}` : ""}`].join("\n\n────\n\n");
  if (new TextEncoder().encode(text).length > MAX_FEDERATION_MESSAGE_BYTES) throw new Error("This report is too long. Select fewer messages or shorten your note.");
  const media = selected.map(({ resource }): ResourceBlock => ({ type: "resource", ref: resource.ref,
    ...(resource.mediaType ? { mediaType: resource.mediaType } : undefined), ...(resource.filename ? { filename: resource.filename } : undefined) }));
  return { contactId, text, ...(media.length ? { media } : undefined), idempotencyKey: randomId() };
}
