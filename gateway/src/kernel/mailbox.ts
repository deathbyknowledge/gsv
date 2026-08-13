import type {
  BinaryBody,
  ConnectionIdentity,
  ManagedInboundMailAccepted,
  ManagedInboundMailCompletion,
  ManagedInboundMailMetadata,
  ManagedMailAddress,
  ManagedMailAttachmentMetadata,
  ManagedMailSummary,
  ProcessIdentity,
} from "@humansandmachines/gsv/protocol";
import { isLocked } from "../auth/shadow";
import type {
  ProcessRuntimeEventDeliverRequestFrame,
  ProcessRuntimeEventDeliverResult,
} from "../protocol/process-frames";
import { stableOpaqueId } from "../shared/stable-id";
import { sendFrameToProcess } from "../shared/utils";
import { accountIdentity } from "./accounts";
import type { KernelContext } from "./context";
import type { MailboxRecord } from "./mailbox-store";
import { handleProcSpawn } from "./proc-handlers";

const MAX_RAW_MAIL_BYTES = 25 * 1024 * 1024;
const MAX_PARSED_MAIL_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_MAIL_ATTACHMENTS = 256;
const INBOX_PROCESS_LABEL = "Inbox";
const TEXT_ENCODER = new TextEncoder();

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
  const pid = await ctx.ensureMailboxNotificationProcess(mailbox.mailboxId);
  const frame: ProcessRuntimeEventDeliverRequestFrame = {
    type: "req",
    id: crypto.randomUUID(),
    call: "proc.runtime.event.deliver",
    args: {
      event: {
        eventId: summarized.messageId,
        type: "mail.received",
        mailboxId: summarized.mailboxId,
        messageId: summarized.messageId,
        receivedAt: summarized.receivedAt,
        envelopeFrom: summarized.envelopeFrom,
        ...(summarized.displayFrom ? { displayFrom: summarized.displayFrom } : {}),
        ...(summarized.subject !== null ? { subject: summarized.subject } : {}),
        summary: completion.summary.summary,
        category: completion.summary.category,
        requiresAttention: completion.summary.requiresAttention,
        confidence: completion.summary.confidence,
      },
    },
  };
  const response = await sendFrameToProcess(ctx.installationId, pid, frame);
  if (!response || response.type !== "res" || response.id !== frame.id) {
    throw new Error("Inbox process returned no valid response");
  }
  if (!response.ok) throw new Error(response.error.message);
  const result = response.data as ProcessRuntimeEventDeliverResult | undefined;
  if (!result || result.eventId !== summarized.messageId) {
    throw new Error("Inbox process admitted an unexpected mail event");
  }
  ctx.mailboxes.markEventDelivered(summarized.messageId);
}

export async function ensureMailboxNotificationProcess(
  mailboxId: string,
  ctx: KernelContext,
): Promise<string> {
  const mailbox = ctx.mailboxes.getMailbox(mailboxId);
  if (!mailbox) throw new Error("Unknown mailbox");

  if (mailbox.notificationPid) {
    const process = ctx.procs.get(mailbox.notificationPid);
    if (process?.ownerUid === mailbox.ownerUid) return process.processId;
  }

  const recovered = ctx.procs.list(mailbox.ownerUid).find((process) => (
    process.label === INBOX_PROCESS_LABEL
  ));
  if (recovered) {
    ctx.mailboxes.setNotificationPid(mailbox.mailboxId, recovered.processId);
    return recovered.processId;
  }

  const human = requireHumanIdentity(ctx, mailbox.ownerUid);
  const identity: ConnectionIdentity = {
    role: "user",
    process: human,
    capabilities: ctx.caps.resolve(human.gids),
  };
  const spawnContext: KernelContext = {
    ...ctx,
    identity,
    callerOwnerUid: human.uid,
  };
  const spawned = await handleProcSpawn({
    interactive: true,
    label: INBOX_PROCESS_LABEL,
  }, spawnContext);
  if (!spawned.ok) throw new Error(spawned.error);
  ctx.mailboxes.setNotificationPid(mailbox.mailboxId, spawned.pid);
  return spawned.pid;
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
  if (!value || typeof value !== "object" || value.version !== 1) {
    throw new Error("Managed mail metadata version is invalid");
  }
  const intakeId = boundedIdentifier(value.intakeId, "intakeId", 256);
  if (!/^sha256:[0-9a-f]{64}$/.test(value.digest)) {
    throw new Error("Managed mail digest is invalid");
  }
  const receivedAt = validTimestamp(value.receivedAt, "receivedAt");
  if (
    !Number.isSafeInteger(value.rawSize)
    || value.rawSize <= 0
    || value.rawSize > MAX_RAW_MAIL_BYTES
  ) {
    throw new Error("Managed mail raw size is invalid");
  }
  if (!value.envelope || typeof value.envelope !== "object") {
    throw new Error("Managed mail envelope is invalid");
  }
  const envelope = {
    from: normalizeEnvelopeAddress(value.envelope.from, "envelope.from"),
    to: normalizeEnvelopeAddress(value.envelope.to, "envelope.to"),
  };
  const text = optionalBoundedText(
    value.text,
    "text",
    MAX_PARSED_MAIL_TEXT_BYTES,
    false,
  );
  const html = optionalBoundedText(
    value.html,
    "html",
    MAX_PARSED_MAIL_TEXT_BYTES,
    false,
  );
  return {
    version: 1,
    intakeId,
    digest: value.digest,
    receivedAt,
    rawSize: value.rawSize,
    envelope,
    ...(value.rfcMessageId === undefined
      ? {}
      : { rfcMessageId: boundedText(value.rfcMessageId, "rfcMessageId", 2_048, true) }),
    ...(value.sentAt === undefined
      ? {}
      : { sentAt: validTimestamp(value.sentAt, "sentAt") }),
    ...(value.from === undefined ? {} : { from: normalizeMailAddress(value.from, "from") }),
    to: normalizeAddressList(value.to, "to"),
    cc: normalizeAddressList(value.cc, "cc"),
    replyTo: normalizeAddressList(value.replyTo, "replyTo"),
    ...(value.subject === undefined
      ? {}
      : { subject: boundedText(value.subject, "subject", 4_096, true) }),
    ...(text === undefined ? {} : { text }),
    ...(html === undefined ? {} : { html }),
    attachments: normalizeAttachments(value.attachments, value.rawSize),
  };
}

function normalizeCompletion(
  value: ManagedInboundMailCompletion,
): ManagedInboundMailCompletion {
  if (!value || typeof value !== "object" || value.version !== 1) {
    throw new Error("Managed mail completion version is invalid");
  }
  return {
    version: 1,
    intakeId: boundedIdentifier(value.intakeId, "intakeId", 256),
    messageId: boundedIdentifier(value.messageId, "messageId", 256),
    summary: normalizeSummary(value.summary),
  };
}

function normalizeSummary(value: ManagedMailSummary): ManagedMailSummary {
  if (!value || typeof value !== "object") {
    throw new Error("Managed mail summary is invalid");
  }
  const categories = new Set([
    "personal",
    "work",
    "transactional",
    "newsletter",
    "spam",
    "suspicious",
    "other",
  ]);
  if (!categories.has(value.category)) {
    throw new Error("Managed mail summary category is invalid");
  }
  if (typeof value.requiresAttention !== "boolean") {
    throw new Error("Managed mail attention flag is invalid");
  }
  if (
    typeof value.confidence !== "number"
    || !Number.isFinite(value.confidence)
    || value.confidence < 0
    || value.confidence > 1
  ) {
    throw new Error("Managed mail confidence is invalid");
  }
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
  if (!value || typeof value !== "object") {
    throw new Error(`Managed mail ${name} address is invalid`);
  }
  return {
    address: normalizeEnvelopeAddress(value.address, `${name}.address`),
    ...(value.name === undefined
      ? {}
      : { name: boundedText(value.name, `${name}.name`, 512, true) }),
  };
}

function normalizeAttachments(
  value: ManagedMailAttachmentMetadata[],
  rawSize: number,
): ManagedMailAttachmentMetadata[] {
  if (!Array.isArray(value) || value.length > MAX_MAIL_ATTACHMENTS) {
    throw new Error("Managed mail attachments are invalid");
  }
  return value.map((attachment, index) => {
    if (!attachment || typeof attachment !== "object") {
      throw new Error(`Managed mail attachment ${index} is invalid`);
    }
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
    return {
      mimeType: boundedText(attachment.mimeType, `attachments[${index}].mimeType`, 256, false),
      size: attachment.size,
      ...(attachment.filename === undefined
        ? {}
        : { filename: boundedText(attachment.filename, `attachments[${index}].filename`, 1_024, true) }),
      ...(attachment.disposition === undefined ? {} : { disposition: attachment.disposition }),
      ...(attachment.contentId === undefined
        ? {}
        : { contentId: boundedText(attachment.contentId, `attachments[${index}].contentId`, 1_024, true) }),
    };
  });
}

function assertInboundBody(body: BinaryBody, rawSize: number): void {
  if (!body || typeof body !== "object" || !(body.stream instanceof ReadableStream)) {
    throw new Error("Managed mail body is invalid");
  }
  if (body.stream.locked) throw new Error("Managed mail body is already locked");
  if (body.length !== rawSize) {
    throw new Error("Managed mail body length does not match metadata");
  }
}

function normalizeEnvelopeAddress(value: unknown, name: string): string {
  const address = boundedText(value, name, 512, false).toLowerCase();
  const separator = address.lastIndexOf("@");
  if (separator <= 0 || separator === address.length - 1 || /\s/.test(address)) {
    throw new Error(`Managed mail ${name} is invalid`);
  }
  return address;
}

function boundedIdentifier(value: unknown, name: string, maxBytes: number): string {
  const normalized = boundedText(value, name, maxBytes, false).trim();
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`Managed mail ${name} is invalid`);
  }
  return normalized;
}

function boundedText(
  value: unknown,
  name: string,
  maxBytes: number,
  allowEmpty: boolean,
): string {
  if (typeof value !== "string") {
    throw new Error(`Managed mail ${name} must be a string`);
  }
  if ((!allowEmpty && value.length === 0) || TEXT_ENCODER.encode(value).byteLength > maxBytes) {
    throw new Error(`Managed mail ${name} is invalid`);
  }
  return value;
}

function optionalBoundedText(
  value: unknown,
  name: string,
  maxBytes: number,
  allowEmpty: boolean,
): string | undefined {
  return value === undefined
    ? undefined
    : boundedText(value, name, maxBytes, allowEmpty);
}

function validTimestamp(value: unknown, name: string): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
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
