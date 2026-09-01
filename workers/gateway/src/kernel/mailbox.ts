import type {
  BinaryBody,
  ManagedInboundMailAccepted,
  ManagedInboundMailCompletion,
  ManagedInboundMailMetadata,
  ManagedMailAddress,
  ManagedMailAttachmentMetadata,
  ManagedMailSummary,
  JsonObject,
  ProcessIdentity,
} from "@humansandmachines/gsv/protocol";
import { binaryBodySchema } from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import { isLocked } from "../auth/shadow";
import { stableOpaqueId } from "../shared/stable-id";
import { accountIdentity } from "./accounts";
import type { KernelContext } from "./context";

const MAX_RAW_MAIL_BYTES = 25 * 1024 * 1024;
const MAX_PARSED_MAIL_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_MAIL_ATTACHMENTS = 256;
const TEXT_ENCODER = new TextEncoder();

const mailAddressSchema = z.strictObject({
  address: z.string(),
  name: z.string().optional(),
});
const mailAttachmentSchema = z.strictObject({
  mimeType: z.string(),
  size: z.number(),
  filename: z.string().optional(),
  disposition: z.enum(["attachment", "inline"]).optional(),
  contentId: z.string().optional(),
});
const mailSummarySchema = z.strictObject({
  summary: z.string(),
  category: z.enum([
    "personal",
    "work",
    "transactional",
    "newsletter",
    "spam",
    "suspicious",
    "other",
  ]),
  requiresAttention: z.boolean(),
  confidence: z.number().min(0).max(1),
});
const inboundMailMetadataSchema = z.strictObject({
  version: z.literal(1),
  intakeId: z.string(),
  digest: z.string(),
  receivedAt: z.number(),
  rawSize: z.number(),
  envelope: z.strictObject({ from: z.string(), to: z.string() }),
  rfcMessageId: z.string().optional(),
  sentAt: z.number().optional(),
  from: mailAddressSchema.optional(),
  to: z.array(mailAddressSchema),
  cc: z.array(mailAddressSchema),
  replyTo: z.array(mailAddressSchema),
  subject: z.string().optional(),
  text: z.string().optional(),
  html: z.string().optional(),
  attachments: z.array(mailAttachmentSchema),
});
const inboundMailCompletionSchema = z.strictObject({
  version: z.literal(1),
  intakeId: z.string(),
  messageId: z.string(),
  summary: mailSummarySchema,
});

export async function acceptManagedInboundMail(
  metadataValue: ManagedInboundMailMetadata,
  body: BinaryBody,
  ctx: KernelContext,
): Promise<ManagedInboundMailAccepted> {
  const metadata = normalizeInboundMetadata(metadataValue);
  assertInboundBody(body, metadata.rawSize);

  const owner = resolveMailboxOwner(ctx);
  const address = normalizeEnvelopeAddress(metadata.envelope.to, "envelope.to");
  const mailboxId = `mailbox:${owner.uid}:primary`;
  const existingMailbox = ctx.mailboxes.getPrimaryMailbox();
  if (existingMailbox && existingMailbox.mailboxId !== mailboxId) {
    throw new Error("Managed mail is already assigned to another local owner");
  }
  const mailbox = ctx.mailboxes.ensureMailbox(mailboxId, owner.uid, address);
  const replay = ctx.mailboxes.acceptReplay({
    mailboxId,
    intakeId: metadata.intakeId,
    digest: metadata.digest,
    receivedAt: metadata.receivedAt,
  });
  if (replay) {
    await cancelBody(body, "Managed mail was already accepted");
    return { messageId: replay.messageId };
  }

  const messageId = await stableOpaqueId("mail", [
    ctx.installationId,
    mailbox.mailboxId,
    metadata.digest,
  ]);
  const messageRoot = `${owner.home}/.gsv/mail/inbox/${messageId}`;
  const rawPath = `${messageRoot}/raw.eml`;
  const textPath = `${messageRoot}/message.txt`;

  await writeMailboxFiles(ctx.env.STORAGE, owner, {
    body,
    rawSize: metadata.rawSize,
    rawPath,
    textPath,
    text: renderMessageText(metadata),
  });

  try {
    const recorded = ctx.mailboxes.recordMessage({
      messageId,
      mailboxId: mailbox.mailboxId,
      intakeId: metadata.intakeId,
      digest: metadata.digest,
      envelopeFrom: metadata.envelope.from,
      envelopeTo: address,
      headerMessageId: metadata.rfcMessageId ?? null,
      displayFrom: metadata.from ? formatMailAddress(metadata.from) : null,
      to: metadata.to.map(formatMailAddress),
      cc: metadata.cc.map(formatMailAddress),
      replyTo: metadata.replyTo.map(formatMailAddress),
      subject: metadata.subject ?? null,
      sentAt: metadata.sentAt ?? null,
      receivedAt: metadata.receivedAt,
      rawPath,
      textPath,
      sizeBytes: metadata.rawSize,
      attachments: metadata.attachments,
    });
    return { messageId: recorded.message.messageId };
  } catch (error) {
    await deleteMailboxFiles(ctx.env.STORAGE, rawPath, textPath);
    throw error;
  }
}

export async function completeManagedInboundMail(
  completionValue: ManagedInboundMailCompletion,
  ctx: KernelContext,
): Promise<void> {
  const completion = normalizeCompletion(completionValue);
  const accepted = ctx.mailboxes.assertIntakeMessage(
    completion.intakeId,
    completion.messageId,
  );
  const summarized = ctx.mailboxes.completeSummary(
    accepted.messageId,
    completion.summary,
  ).message;
  if (summarized.eventDeliveredAt !== null) return;

  const mailbox = ctx.mailboxes.getMailbox(summarized.mailboxId);
  if (!mailbox) throw new Error("Mail message belongs to an unknown mailbox");
  if (!ctx.responsibilitySources.isEnabled(mailbox.ownerUid, "mail.received")) {
    ctx.mailboxes.markEventDelivered(summarized.messageId);
    return;
  }
  const details: JsonObject = {
    eventType: "mail.received",
    messageId: summarized.messageId,
    receivedAt: summarized.receivedAt,
    summary: completion.summary.summary,
    category: completion.summary.category,
    requiresAttention: completion.summary.requiresAttention,
    contentTrust: "untrusted",
  };
  if (completion.summary.confidence !== undefined) {
    details.confidence = completion.summary.confidence;
  }
  ctx.responsibilities.create({
    ownerUid: mailbox.ownerUid,
    title: `Review received email ${summarized.messageId}`,
    details,
    source: {
      kind: "event",
      eventType: "mail.received",
      eventId: summarized.messageId,
    },
    assignee: { kind: "ship" },
    state: "open",
    priority: completion.summary.requiresAttention ? "high" : "normal",
    dedupeKey: `mail.received:${summarized.messageId}`,
    actor: { kind: "system", component: "mail" },
    observedByShip: false,
    now: Date.now(),
  });
  ctx.mailboxes.markEventDelivered(summarized.messageId);
  ctx.defer(ctx.reconcileResponsibilityWake(mailbox.ownerUid).catch((error) => {
    console.warn("[Kernel] Failed to schedule received-mail responsibility:", error);
  }));
}

export function managedMailAddressForOwner(
  ownerUid: number,
  ctx: KernelContext,
): string | null {
  const mailbox = ctx.mailboxes.getMailboxForOwner(ownerUid);
  if (mailbox) return mailbox.address;
  const owner = resolveMailboxOwner(ctx);
  if (owner.uid !== ownerUid) return null;
  const identity = ctx.installationIdentity;
  if (!identity?.handle) return null;
  const hostname = new URL(identity.canonicalOrigin).hostname.toLowerCase();
  const prefix = `${identity.handle.toLowerCase()}.`;
  if (!hostname.startsWith(prefix) || hostname.length === prefix.length) return null;
  return `${identity.handle.toLowerCase()}@${hostname.slice(prefix.length)}`;
}

type WriteMailboxFilesInput = {
  body: BinaryBody;
  rawSize: number;
  rawPath: string;
  textPath: string;
  text: string;
};

async function writeMailboxFiles(
  storage: R2Bucket,
  owner: ProcessIdentity,
  input: WriteMailboxFilesInput,
): Promise<void> {
  const rawKey = pathToStorageKey(input.rawPath);
  const textKey = pathToStorageKey(input.textPath);
  const directoryKey = `${rawKey.slice(0, rawKey.lastIndexOf("/"))}/.dir`;
  const metadata = {
    uid: String(owner.uid),
    gid: String(owner.gid),
    mode: "640",
  };
  const fixed = new FixedLengthStream(input.rawSize);
  try {
    await Promise.all([
      storage.put(rawKey, fixed.readable, {
        httpMetadata: { contentType: "message/rfc822" },
        customMetadata: metadata,
      }),
      input.body.stream.pipeTo(fixed.writable),
    ]);
    await Promise.all([
      storage.put(textKey, input.text, {
        httpMetadata: { contentType: "text/plain; charset=utf-8" },
        customMetadata: metadata,
      }),
      storage.put(directoryKey, "", {
        customMetadata: {
          uid: String(owner.uid),
          gid: String(owner.gid),
          mode: "750",
          dirmarker: "1",
        },
      }),
    ]);
  } catch (error) {
    await cancelBody(input.body, "Managed mail storage failed");
    await storage.delete([rawKey, textKey, directoryKey]).catch(() => {});
    throw error;
  }
}

async function deleteMailboxFiles(
  storage: R2Bucket,
  rawPath: string,
  textPath: string,
): Promise<void> {
  const rawKey = pathToStorageKey(rawPath);
  const textKey = pathToStorageKey(textPath);
  const directoryKey = `${rawKey.slice(0, rawKey.lastIndexOf("/"))}/.dir`;
  await storage.delete([rawKey, textKey, directoryKey]).catch(() => {});
}

function resolveMailboxOwner(ctx: KernelContext): ProcessIdentity {
  const persisted = ctx.mailboxes.getPrimaryMailbox();
  if (persisted) return requireHumanIdentity(ctx, persisted.ownerUid);

  const human = ctx.auth.getPasswdEntries().find((entry) => {
    if (entry.uid < 1000 || ctx.auth.isPersonalAgentUid(entry.uid)) return false;
    const shadow = ctx.auth.getShadowByUsername(entry.username);
    return Boolean(shadow && !isLocked(shadow));
  });
  if (!human) {
    throw new Error("Managed mail requires a configured human account");
  }
  return accountIdentity(ctx.auth, human);
}

function requireHumanIdentity(ctx: KernelContext, uid: number): ProcessIdentity {
  const entry = ctx.auth.getPasswdByUid(uid);
  const shadow = entry ? ctx.auth.getShadowByUsername(entry.username) : null;
  if (
    !entry
    || entry.uid < 1000
    || ctx.auth.isPersonalAgentUid(entry.uid)
    || !shadow
    || isLocked(shadow)
  ) {
    throw new Error("Mailbox owner is not an active human account");
  }
  return accountIdentity(ctx.auth, entry);
}

function normalizeInboundMetadata(
  value: ManagedInboundMailMetadata,
): ManagedInboundMailMetadata {
  const parsed = inboundMailMetadataSchema.parse(value);
  const intakeId = boundedIdentifier(parsed.intakeId, "intakeId", 256);
  if (!/^sha256:[0-9a-f]{64}$/.test(parsed.digest)) {
    throw new Error("Managed mail digest is invalid");
  }
  const receivedAt = validTimestamp(parsed.receivedAt, "receivedAt");
  if (
    !Number.isSafeInteger(parsed.rawSize)
    || parsed.rawSize <= 0
    || parsed.rawSize > MAX_RAW_MAIL_BYTES
  ) {
    throw new Error("Managed mail raw size is invalid");
  }
  const envelope = {
    from: normalizeEnvelopeAddress(parsed.envelope.from, "envelope.from"),
    to: normalizeEnvelopeAddress(parsed.envelope.to, "envelope.to"),
  };
  const text = optionalBoundedText(
    parsed.text,
    "text",
    MAX_PARSED_MAIL_TEXT_BYTES,
    false,
  );
  const html = optionalBoundedText(
    parsed.html,
    "html",
    MAX_PARSED_MAIL_TEXT_BYTES,
    false,
  );
  const normalized: ManagedInboundMailMetadata = {
    version: 1,
    intakeId,
    digest: parsed.digest,
    receivedAt,
    rawSize: parsed.rawSize,
    envelope,
    to: normalizeAddressList(parsed.to, "to"),
    cc: normalizeAddressList(parsed.cc, "cc"),
    replyTo: normalizeAddressList(parsed.replyTo, "replyTo"),
    attachments: normalizeAttachments(parsed.attachments, parsed.rawSize),
  };
  if (parsed.rfcMessageId !== undefined) {
    normalized.rfcMessageId = boundedText(parsed.rfcMessageId, "rfcMessageId", 2_048, true);
  }
  if (parsed.sentAt !== undefined) normalized.sentAt = validTimestamp(parsed.sentAt, "sentAt");
  if (parsed.from !== undefined) normalized.from = normalizeMailAddress(parsed.from, "from");
  if (parsed.subject !== undefined) {
    normalized.subject = boundedText(parsed.subject, "subject", 4_096, true);
  }
  if (text !== undefined) normalized.text = text;
  if (html !== undefined) normalized.html = html;
  return normalized;
}

function normalizeCompletion(
  value: ManagedInboundMailCompletion,
): ManagedInboundMailCompletion {
  const parsed = inboundMailCompletionSchema.parse(value);
  return {
    version: 1,
    intakeId: boundedIdentifier(parsed.intakeId, "intakeId", 256),
    messageId: boundedIdentifier(parsed.messageId, "messageId", 256),
    summary: normalizeSummary(parsed.summary),
  };
}

function normalizeSummary(value: ManagedMailSummary): ManagedMailSummary {
  return {
    summary: boundedText(value.summary, "summary", 280, false),
    category: value.category,
    requiresAttention: value.requiresAttention,
    confidence: value.confidence,
  };
}

function normalizeAddressList(value: ManagedMailAddress[], name: string): ManagedMailAddress[] {
  if (!Array.isArray(value) || value.length > 200) {
    throw new Error(`Managed mail ${name} recipients are invalid`);
  }
  return value.map((address, index) => normalizeMailAddress(address, `${name}[${index}]`));
}

function normalizeMailAddress(value: ManagedMailAddress, name: string): ManagedMailAddress {
  const normalized: ManagedMailAddress = {
    address: normalizeEnvelopeAddress(value.address, `${name}.address`),
  };
  if (value.name !== undefined) {
    normalized.name = boundedText(value.name, `${name}.name`, 512, true);
  }
  return normalized;
}

function normalizeAttachments(
  value: ManagedMailAttachmentMetadata[],
  rawSize: number,
): ManagedMailAttachmentMetadata[] {
  if (!Array.isArray(value) || value.length > MAX_MAIL_ATTACHMENTS) {
    throw new Error("Managed mail attachments are invalid");
  }
  return value.map((attachment, index) => {
    if (
      !Number.isSafeInteger(attachment.size)
      || attachment.size < 0
      || attachment.size > rawSize
    ) {
      throw new Error(`Managed mail attachment ${index} size is invalid`);
    }
    if (
      attachment.disposition !== undefined
      && attachment.disposition !== "attachment"
      && attachment.disposition !== "inline"
    ) {
      throw new Error(`Managed mail attachment ${index} disposition is invalid`);
    }
    const normalized: ManagedMailAttachmentMetadata = {
      mimeType: boundedText(attachment.mimeType, `attachments[${index}].mimeType`, 256, false),
      size: attachment.size,
    };
    if (attachment.filename !== undefined) {
      normalized.filename = boundedText(
        attachment.filename,
        `attachments[${index}].filename`,
        1_024,
        true,
      );
    }
    if (attachment.disposition !== undefined) {
      normalized.disposition = attachment.disposition;
    }
    if (attachment.contentId !== undefined) {
      normalized.contentId = boundedText(
        attachment.contentId,
        `attachments[${index}].contentId`,
        1_024,
        true,
      );
    }
    return normalized;
  });
}

function assertInboundBody(body: BinaryBody, rawSize: number): void {
  if (!binaryBodySchema.safeParse(body).success) {
    throw new Error("Managed mail body is invalid");
  }
  if (body.stream.locked) throw new Error("Managed mail body is already locked");
  if (body.length !== rawSize) {
    throw new Error("Managed mail body length does not match metadata");
  }
}

function normalizeEnvelopeAddress(value: string, name: string): string {
  const address = boundedText(value, name, 512, false).toLowerCase();
  const separator = address.lastIndexOf("@");
  if (separator <= 0 || separator === address.length - 1 || /\s/.test(address)) {
    throw new Error(`Managed mail ${name} is invalid`);
  }
  return address;
}

function boundedIdentifier(value: string, name: string, maxBytes: number): string {
  const normalized = boundedText(value, name, maxBytes, false).trim();
  if ([...normalized].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  })) {
    throw new Error(`Managed mail ${name} is invalid`);
  }
  return normalized;
}

function boundedText(
  value: string,
  name: string,
  maxBytes: number,
  allowEmpty: boolean,
): string {
  if ((!allowEmpty && value.length === 0) || TEXT_ENCODER.encode(value).byteLength > maxBytes) {
    throw new Error(`Managed mail ${name} is invalid`);
  }
  return value;
}

function optionalBoundedText(
  value: string | undefined,
  name: string,
  maxBytes: number,
  allowEmpty: boolean,
): string | undefined {
  return value === undefined
    ? undefined
    : boundedText(value, name, maxBytes, allowEmpty);
}

function validTimestamp(value: number, name: string): number {
  if (
    !Number.isSafeInteger(value)
    || value < 0
    || value > 8_640_000_000_000_000
  ) {
    throw new Error(`Managed mail ${name} is invalid`);
  }
  return value;
}

function formatMailAddress(value: ManagedMailAddress): string {
  return value.name ? `${value.name} <${value.address}>` : value.address;
}

function renderMessageText(metadata: ManagedInboundMailMetadata): string {
  const headers = [
    `From: ${metadata.from ? formatMailAddress(metadata.from) : metadata.envelope.from}`,
    `To: ${metadata.to.map(formatMailAddress).join(", ") || metadata.envelope.to}`,
    ...(metadata.cc.length > 0 ? [`Cc: ${metadata.cc.map(formatMailAddress).join(", ")}`] : []),
    ...(metadata.replyTo.length > 0
      ? [`Reply-To: ${metadata.replyTo.map(formatMailAddress).join(", ")}`]
      : []),
    ...(metadata.sentAt === undefined ? [] : [`Date: ${new Date(metadata.sentAt).toISOString()}`]),
    ...(metadata.subject === undefined ? [] : [`Subject: ${metadata.subject}`]),
    ...(metadata.rfcMessageId === undefined ? [] : [`Message-ID: ${metadata.rfcMessageId}`]),
  ];
  return `${headers.join("\n")}\n\n${metadata.text ?? "[No plain-text body. Read raw.eml for the original message.]"}\n`;
}

function pathToStorageKey(path: string): string {
  if (!path.startsWith("/") || path.includes("\0")) {
    throw new Error("Managed mail storage path is invalid");
  }
  return path.slice(1);
}

async function cancelBody(body: BinaryBody, reason: string): Promise<void> {
  if (!body.stream.locked) await body.stream.cancel(reason).catch(() => {});
}
