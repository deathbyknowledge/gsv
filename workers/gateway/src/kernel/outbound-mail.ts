import type {
  MailSendArgs,
  MailSendResult,
  ManagedOutboundMailClaimOutcome,
  ManagedOutboundMailCommand,
  ManagedOutboundMailCompletion,
  ManagedOutboundMailDraft,
  ManagedOutboundMailReference,
} from "@humansandmachines/gsv/protocol";
import { isLocked } from "../auth/shadow";
import { stableOpaqueId } from "../shared/stable-id";
import { resolveCallerOwnerUid, type KernelContext } from "./context";
import { managedMailAddressForOwner } from "./mailbox";
import type {
  MailMessageRecord,
  MailOutboundRecord,
  RecordMailOutboundInput,
} from "./mailbox-store";

const MAX_OUTBOUND_TEXT_BYTES = 1024 * 1024;
const MAX_OUTBOUND_SUBJECT_BYTES = 998;
const MAX_OUTBOUND_IDENTIFIER_BYTES = 256;
const MAX_OUTBOUND_HEADER_BYTES = 998;
const OUTBOUND_ENQUEUE_RETRY_BASE_MS = 5_000;
const OUTBOUND_ENQUEUE_RETRY_MAX_MS = 60 * 60 * 1_000;
const TEXT_ENCODER = new TextEncoder();

type NormalizedMailSend = {
  deliveryId: string;
  text: string;
  textSize: number;
  to: string;
  subject: string;
  replyToMessageId?: string;
  inReplyTo?: string;
  references?: string;
};

export async function handleMailSend(
  value: MailSendArgs,
  ctx: KernelContext,
): Promise<MailSendResult> {
  let deliveryId: string | undefined;
  let outboundId: string | undefined;
  try {
    ctx.requestSignal?.throwIfAborted();
    const queue = managedOutboundQueue(ctx);
    if (!queue || !ctx.installationIdentity?.handle) {
      throw new MailSendError("Managed outbound mail is not available", false);
    }

    const ownerUid = resolveCallerOwnerUid(ctx);
    const owner = requireActiveHuman(ownerUid, ctx);
    const from = managedMailAddressForOwner(ownerUid, ctx);
    if (!from) {
      throw new MailSendError("Managed mail is not available for this account", false);
    }
    const normalized = normalizeMailSend(value, ownerUid, ctx);
    ctx.requestSignal?.throwIfAborted();
    deliveryId = normalized.deliveryId;
    outboundId = await stableOpaqueId("mail-outbound", [
      ctx.installationId,
      ownerUid,
      deliveryId,
    ]);
    const bodyDigest = await sha256(normalized.text);
    const fingerprint = await sha256(JSON.stringify({
      version: 1,
      from,
      to: normalized.to,
      subject: normalized.subject,
      textSize: normalized.textSize,
      bodyDigest,
      replyToMessageId: normalized.replyToMessageId ?? null,
      inReplyTo: normalized.inReplyTo ?? null,
      references: normalized.references ?? null,
    }));
    ctx.requestSignal?.throwIfAborted();
    const bodyPath = `${owner.home}/.gsv/mail/outbox/${outboundId}/${fingerprint.slice(7)}/message.txt`;
    const input: RecordMailOutboundInput = {
      version: 1 as const,
      outboundId,
      ownerUid,
      deliveryId,
      fingerprint,
      from,
      to: normalized.to,
      subject: normalized.subject,
      bodyDigest,
      bodyPath,
      textSize: normalized.textSize,
      createdAt: Date.now(),
    };
    if (normalized.replyToMessageId) input.replyToMessageId = normalized.replyToMessageId;
    if (normalized.inReplyTo) input.inReplyTo = normalized.inReplyTo;
    if (normalized.references) input.references = normalized.references;
    const existing = ctx.mailboxes.getOutboundForDelivery(ownerUid, deliveryId);
    let ensured: ReturnType<typeof ctx.mailboxes.ensureOutbound>;
    if (existing) {
      try {
        ensured = ctx.mailboxes.ensureOutbound(input);
      } catch (error) {
        throw new MailSendError(
          `Outbound mail conflicts with durable state: ${errorMessage(error)}`,
          false,
        );
      }
    } else {
      try {
        ensured = ctx.mailboxes.ensureOutbound(input);
      } catch (error) {
        throw new MailSendError(`Failed to record outbound mail: ${errorMessage(error)}`, true);
      }
    }

    let outbound = ensured.outbound;
    if (outbound.state === "staging") {
      try {
        await writeOutboundBody(outbound, normalized.text, owner.gid, ctx.env.STORAGE);
        await ctx.scheduleManagedOutboundEnqueue(
          outbound.outboundId,
          Date.now() + outboundEnqueueRetryDelay(outbound.enqueueAttempts + 1),
        );
        outbound = ctx.mailboxes.markOutboundQueued(outbound.outboundId, outbound.fingerprint);
      } catch (error) {
        throw new MailSendError(`Failed to store outbound mail: ${errorMessage(error)}`, true);
      }
    }
    if (outbound.state === "queued") {
      try {
        const bodyValid = await outboundBodyMatches(outbound, ctx.env.STORAGE);
        ctx.requestSignal?.throwIfAborted();
        if (!bodyValid) {
          await writeOutboundBody(outbound, normalized.text, owner.gid, ctx.env.STORAGE);
          ctx.requestSignal?.throwIfAborted();
        }
        if (outbound.enqueuedAt === null) {
          outbound = await recoverManagedOutboundEnqueue(outbound.outboundId, ctx)
            ?? outbound;
        }
      } catch (error) {
        throw new MailSendError(`Failed to verify outbound mail: ${errorMessage(error)}`, true);
      }
    }
    if (outbound.state === "staging") {
      throw new MailSendError("Outbound mail did not finish staging", true);
    }

    const result: Extract<MailSendResult, { ok: true }> = {
      ok: true,
      deliveryId: outbound.deliveryId,
      outboundId: outbound.outboundId,
      state: outbound.state,
      from: outbound.from,
      to: outbound.to,
      subject: outbound.subject,
      replayed: !ensured.created,
    };
    if (outbound.errorCode) result.errorCode = outbound.errorCode;
    return result;
  } catch (error) {
    const failure = error instanceof MailSendError
      ? error
      : new MailSendError(errorMessage(error), false);
    const result: Extract<MailSendResult, { ok: false }> = {
      ok: false,
      error: failure.message,
      retryable: failure.retryable,
    };
    if (deliveryId) result.deliveryId = deliveryId;
    if (outboundId) result.outboundId = outboundId;
    return result;
  }
}

export function outboundEnqueueRetryDelay(attemptNumber: number): number {
  const exponent = Math.max(0, Math.min(20, Math.trunc(attemptNumber) - 1));
  return Math.min(
    OUTBOUND_ENQUEUE_RETRY_MAX_MS,
    OUTBOUND_ENQUEUE_RETRY_BASE_MS * 2 ** exponent,
  );
}

export async function prepareManagedOutboundEnqueue(
  outboundId: string,
  ctx: KernelContext,
): Promise<ManagedOutboundMailCommand | null> {
  let outbound = ctx.mailboxes.getOutbound(outboundId);
  if (
    !outbound
    || (outbound.state !== "staging" && outbound.state !== "queued")
    || outbound.enqueuedAt !== null
  ) {
    return null;
  }
  if (!await outboundBodyMatches(outbound, ctx.env.STORAGE)) {
    if (outbound.state === "staging") {
      outbound = ctx.mailboxes.markOutboundQueued(outbound.outboundId, outbound.fingerprint);
    }
    ctx.mailboxes.completeOutbound({
      version: 1,
      outboundId: outbound.outboundId,
      fingerprint: outbound.fingerprint,
      state: "failed",
      errorCode: "body_unavailable",
    });
    return null;
  }
  if (outbound.state === "staging") {
    outbound = ctx.mailboxes.markOutboundQueued(outbound.outboundId, outbound.fingerprint);
  }
  return {
    version: 1,
    installationId: ctx.installationId,
    outboundId: outbound.outboundId,
    fingerprint: outbound.fingerprint,
  };
}

export async function recoverManagedOutboundEnqueue(
  outboundId: string,
  ctx: KernelContext,
  scheduleSuccessor = false,
): Promise<MailOutboundRecord | null> {
  ctx.requestSignal?.throwIfAborted();
  const current = ctx.mailboxes.getOutbound(outboundId);
  if (
    !current
    || (current.state !== "staging" && current.state !== "queued")
    || current.enqueuedAt !== null
  ) {
    return current;
  }

  const nextAt = Date.now()
    + outboundEnqueueRetryDelay(current.enqueueAttempts + 1);
  if (scheduleSuccessor) {
    await ctx.scheduleManagedOutboundEnqueue(current.outboundId, nextAt);
  }
  try {
    const command = await prepareManagedOutboundEnqueue(current.outboundId, ctx);
    if (!command) return ctx.mailboxes.getOutbound(current.outboundId);

    const queue = managedOutboundQueue(ctx);
    if (!queue) return ctx.mailboxes.getOutbound(current.outboundId);
    const claimed = ctx.mailboxes.beginOutboundEnqueue(
      current.outboundId,
      current.fingerprint,
      nextAt,
    );
    if (claimed.state !== "queued" || claimed.enqueuedAt !== null) return claimed;
    await queue.send(command);
    return ctx.mailboxes.markOutboundEnqueued(
      current.outboundId,
      current.fingerprint,
    );
  } catch {
    return ctx.mailboxes.getOutbound(current.outboundId);
  }
}

export async function claimManagedOutboundMail(
  referenceValue: ManagedOutboundMailReference,
  ctx: KernelContext,
): Promise<ManagedOutboundMailClaimOutcome> {
  const reference = normalizeReference(referenceValue);
  const outbound = ctx.mailboxes.getOutbound(reference.outboundId);
  if (!outbound || outbound.fingerprint !== reference.fingerprint) {
    return { status: "rejected", errorCode: "reference_mismatch" };
  }
  if (outbound.state === "staging") {
    throw new Error("Outbound mail body has not been staged");
  }
  if (outbound.state !== "queued") {
    return {
      status: "settled",
      completion: outboundCompletion(outbound),
    };
  }
  const object = await ctx.env.STORAGE.get(pathToStorageKey(outbound.bodyPath));
  if (!object || object.size !== outbound.textSize) {
    return settleUnavailableOutbound(outbound, ctx);
  }
  const body = await object.arrayBuffer();
  if (await sha256Bytes(body) !== outbound.bodyDigest) {
    return settleUnavailableOutbound(outbound, ctx);
  }
  return {
    status: "ready",
    draft: outboundDraft(outbound),
    body: {
      stream: new Blob([body]).stream(),
      length: object.size,
    },
  };
}

export function completeManagedOutboundMail(
  completionValue: ManagedOutboundMailCompletion,
  ctx: KernelContext,
): void {
  const completion = normalizeCompletion(completionValue);
  ctx.mailboxes.completeOutbound(completion);
}

function normalizeMailSend(
  value: MailSendArgs,
  ownerUid: number,
  ctx: KernelContext,
): NormalizedMailSend {
  const deliveryId = normalizeIdentifier(
    value.deliveryId,
    "deliveryId",
  );
  const text = normalizeText(value.text);
  const textSize = TEXT_ENCODER.encode(text).byteLength;
  const replySelector = optionalIdentifier(value.replyToMessageId, "replyToMessageId");
  if (replySelector) {
    if (value.to !== undefined) {
      throw new MailSendError("A reply derives its recipient from the original message", false);
    }
    const source = ctx.mailboxes.getMessage(ownerUid, replySelector);
    if (!source) throw new MailSendError(`Mail message not found: ${replySelector}`, false);
    const replyToMessageId = source.messageId;
    const to = replyRecipient(source);
    const subject = value.subject === undefined
      ? replySubject(source.subject)
      : normalizeSubject(value.subject);
    const inReplyTo = optionalThreadHeader(source.headerMessageId);
    const reply: NormalizedMailSend = {
      deliveryId,
      text,
      textSize,
      to,
      subject,
      replyToMessageId,
    };
    if (inReplyTo) {
      reply.inReplyTo = inReplyTo;
      reply.references = inReplyTo;
    }
    return reply;
  }

  if (value.replyToMessageId !== undefined) {
    throw new MailSendError("replyToMessageId is invalid", false);
  }
  if (value.to === undefined) throw new MailSendError("to is required", false);
  if (value.subject === undefined) throw new MailSendError("subject is required", false);
  return {
    deliveryId,
    text,
    textSize,
    to: normalizeAddress(value.to),
    subject: normalizeSubject(value.subject),
  };
}

function normalizeReference(value: ManagedOutboundMailReference): ManagedOutboundMailReference {
  if (value.version !== 1) {
    throw new Error("Outbound mail reference version is invalid");
  }
  const outboundId = normalizeIdentifier(value.outboundId, "outboundId");
  if (!/^sha256:[0-9a-f]{64}$/.test(value.fingerprint)) {
    throw new Error("Outbound mail fingerprint is invalid");
  }
  return { version: 1, outboundId, fingerprint: value.fingerprint };
}

function normalizeCompletion(
  value: ManagedOutboundMailCompletion,
): ManagedOutboundMailCompletion {
  const reference = normalizeReference(value);
  if (value.state !== "accepted" && value.state !== "failed" && value.state !== "unknown") {
    throw new Error("Outbound mail completion state is invalid");
  }
  const providerMessageId = optionalIdentifier(value.providerMessageId, "providerMessageId");
  const errorCode = optionalIdentifier(value.errorCode, "errorCode");
  if (value.state === "accepted" && !providerMessageId) {
    throw new Error("Accepted outbound mail requires a provider message id");
  }
  if (value.state === "accepted" && errorCode) {
    throw new Error("Accepted outbound mail cannot include an error code");
  }
  if (value.state !== "accepted" && (!errorCode || providerMessageId)) {
    throw new Error("Failed or unknown outbound mail requires only an error code");
  }
  const completion: ManagedOutboundMailCompletion = {
    ...reference,
    state: value.state,
  };
  if (providerMessageId) completion.providerMessageId = providerMessageId;
  if (errorCode) completion.errorCode = errorCode;
  return completion;
}

function requireActiveHuman(ownerUid: number, ctx: KernelContext) {
  const owner = ctx.auth.getPasswdByUid(ownerUid);
  const shadow = owner ? ctx.auth.getShadowByUsername(owner.username) : null;
  if (
    !owner
    || owner.uid < 1000
    || ctx.auth.isPersonalAgentUid(owner.uid)
    || !shadow
    || isLocked(shadow)
  ) {
    throw new MailSendError("Managed mail owner is not an active human account", false);
  }
  return owner;
}

function replyRecipient(message: MailMessageRecord): string {
  return normalizeAddress(extractAddress(
    message.replyTo[0] ?? message.displayFrom ?? message.envelopeFrom,
  ));
}

function extractAddress(value: string): string {
  const bracketed = value.match(/<([^<>]+)>\s*$/)?.[1];
  return bracketed ?? value;
}

function replySubject(subject: string | null): string {
  const source = subject?.trim() || "(no subject)";
  return truncateSubject(/^re\s*:/i.test(source) ? source : `Re: ${source}`);
}

function truncateSubject(value: string): string {
  if (TEXT_ENCODER.encode(value).byteLength <= MAX_OUTBOUND_SUBJECT_BYTES) {
    return normalizeSubject(value);
  }
  const suffix = "…";
  const suffixSize = TEXT_ENCODER.encode(suffix).byteLength;
  const bytes = new Uint8Array(MAX_OUTBOUND_SUBJECT_BYTES - suffixSize);
  const { written = 0 } = TEXT_ENCODER.encodeInto(value, bytes);
  return normalizeSubject(`${new TextDecoder().decode(bytes.subarray(0, written))}${suffix}`);
}

function normalizeAddress(value: string): string {
  const source = value.trim();
  const separator = source.lastIndexOf("@");
  const address = separator > 0
    ? `${source.slice(0, separator)}@${source.slice(separator + 1).toLowerCase()}`
    : source;
  if (
    address.length === 0
    || TEXT_ENCODER.encode(address).byteLength > 320
    || separator <= 0
    || separator === address.length - 1
    || address.indexOf("@") !== separator
    || containsAsciiControl(address)
    || /[\s<>(),;:"]/.test(address)
    || address.includes("..")
  ) {
    throw new MailSendError("to is not a valid single email address", false);
  }
  return address;
}

function normalizeSubject(value: string): string {
  const subject = value.trim();
  if (
    !subject
    || TEXT_ENCODER.encode(subject).byteLength > MAX_OUTBOUND_SUBJECT_BYTES
    || containsAsciiControl(subject)
  ) {
    throw new MailSendError("subject is invalid", false);
  }
  return subject;
}

function normalizeText(value: string): string {
  const size = TEXT_ENCODER.encode(value).byteLength;
  if (!value || size > MAX_OUTBOUND_TEXT_BYTES || value.includes("\0")) {
    throw new MailSendError("text is invalid or exceeds the outbound mail limit", false);
  }
  return value;
}

function normalizeIdentifier(value: string, name: string): string {
  const normalized = value.trim();
  if (
    !normalized
    || TEXT_ENCODER.encode(normalized).byteLength > MAX_OUTBOUND_IDENTIFIER_BYTES
    || containsAsciiControl(normalized)
  ) {
    throw new MailSendError(`${name} is invalid`, false);
  }
  return normalized;
}

function optionalIdentifier(value: string | undefined, name: string): string | undefined {
  return value === undefined ? undefined : normalizeIdentifier(value, name);
}

function optionalThreadHeader(value: string | null): string | undefined {
  return value
    && !containsAsciiControl(value)
    && TEXT_ENCODER.encode(value).byteLength <= MAX_OUTBOUND_HEADER_BYTES
    ? value
    : undefined;
}

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", TEXT_ENCODER.encode(value)));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

async function outboundBodyMatches(
  outbound: MailOutboundRecord,
  storage: R2Bucket,
): Promise<boolean> {
  const object = await storage.get(pathToStorageKey(outbound.bodyPath));
  if (!object || object.size !== outbound.textSize) return false;
  return await sha256Bytes(await object.arrayBuffer()) === outbound.bodyDigest;
}

async function writeOutboundBody(
  outbound: Pick<MailOutboundRecord, "bodyPath" | "ownerUid">,
  text: string,
  ownerGid: number,
  storage: R2Bucket,
): Promise<void> {
  const bodyKey = pathToStorageKey(outbound.bodyPath);
  const directoryKey = `${bodyKey.slice(0, bodyKey.lastIndexOf("/"))}/.dir`;
  const metadata = {
    uid: String(outbound.ownerUid),
    gid: String(ownerGid),
    mode: "640",
  };
  await Promise.all([
    storage.put(bodyKey, text, {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
      customMetadata: metadata,
    }),
    storage.put(directoryKey, "", {
      customMetadata: {
        uid: String(outbound.ownerUid),
        gid: String(ownerGid),
        mode: "750",
        dirmarker: "1",
      },
    }),
  ]);
}

async function sha256Bytes(value: BufferSource): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", value));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

function outboundDraft(outbound: MailOutboundRecord): ManagedOutboundMailDraft {
  const draft: ManagedOutboundMailDraft = {
    version: 1 as const,
    outboundId: outbound.outboundId,
    fingerprint: outbound.fingerprint,
    from: outbound.from,
    to: outbound.to,
    subject: outbound.subject,
    bodyDigest: outbound.bodyDigest,
    textSize: outbound.textSize,
    createdAt: outbound.createdAt,
  };
  if (outbound.replyToMessageId) draft.replyToMessageId = outbound.replyToMessageId;
  if (outbound.inReplyTo) draft.inReplyTo = outbound.inReplyTo;
  if (outbound.references) draft.references = outbound.references;
  return draft;
}

function outboundCompletion(
  outbound: MailOutboundRecord,
): ManagedOutboundMailCompletion {
  if (
    outbound.state !== "accepted"
    && outbound.state !== "failed"
    && outbound.state !== "unknown"
  ) {
    throw new Error("Outbound mail is not terminal");
  }
  const completion: ManagedOutboundMailCompletion = {
    version: 1,
    outboundId: outbound.outboundId,
    fingerprint: outbound.fingerprint,
    state: outbound.state,
  };
  if (outbound.providerMessageId) completion.providerMessageId = outbound.providerMessageId;
  if (outbound.errorCode) completion.errorCode = outbound.errorCode;
  return completion;
}

function settleUnavailableOutbound(
  outbound: MailOutboundRecord,
  ctx: KernelContext,
): ManagedOutboundMailClaimOutcome {
  const settled = ctx.mailboxes.completeOutbound({
    version: 1,
    outboundId: outbound.outboundId,
    fingerprint: outbound.fingerprint,
    state: "failed",
    errorCode: "body_unavailable",
  });
  return {
    status: "settled",
    completion: outboundCompletion(settled),
  };
}

function pathToStorageKey(path: string): string {
  if (!path.startsWith("/") || path.includes("\0")) {
    throw new Error("Outbound mail storage path is invalid");
  }
  return path.slice(1);
}

function errorMessage<ErrorValue>(error: ErrorValue): string {
  return error instanceof Error ? error.message : String(error);
}

function containsAsciiControl(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function managedOutboundQueue(ctx: KernelContext): Queue<ManagedOutboundMailCommand> | undefined {
  return ctx.env.MANAGED_MAIL_OUTBOUND;
}

class MailSendError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}
