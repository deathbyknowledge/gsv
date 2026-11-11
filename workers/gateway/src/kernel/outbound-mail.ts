import { deploymentDomains, deploymentPresentation } from "@humansandmachines/gsv/services/deployment";
import {
  MAIL_MAX_INVITE_BYTES as MAX_INVITE_BYTES,
  MAIL_MAX_OUTBOUND_TEXT_BYTES as MAX_OUTBOUND_TEXT_BYTES,
  MAIL_MAX_QUOTE_BYTES as MAX_QUOTE_BYTES,
  MAIL_MAX_RECIPIENTS as MAX_RECIPIENTS,
  MAIL_MAX_SENDER_NAME_BYTES as MAX_SENDER_NAME_BYTES,
} from "@humansandmachines/gsv/services/mail";
import type {
  JsonObject,
  MailInviteApproval,
  MailSendArgs,
  MailSendResult,
  ManagedOutboundMailClaimOutcome,
  ManagedOutboundMailCommand,
  ManagedOutboundMailCompletion,
  ManagedOutboundMailDraft,
  ManagedOutboundMailInvite,
  ManagedOutboundMailLookup,
  ManagedOutboundMailQuote,
  ManagedOutboundMailReference,
} from "@humansandmachines/gsv/protocol";
import * as z from "zod/mini";
import { isLocked } from "../auth/shadow";
import { stableOpaqueId } from "../shared/stable-id";
import { resolveCallerOwnerUid, type KernelContext } from "./context";
import { calendarEvents, calendarWhen, firstProperty, parseCalendar, serializeCalendar } from "./icalendar";
import { MAIL_NO_TEXT_BODY, managedMailAddressForOwner } from "./mailbox";
import { ownerDisplayName } from "./profiles";
import { normalizeTimezone, ownerTimezone } from "./timezone";
import { authorizeNestedOperation } from "./tool-approval";
import type {
  MailMessageRecord,
  MailOutboundRecord,
  RecordMailOutboundInput,
} from "./mailbox-store";

const MAX_OUTBOUND_SUBJECT_BYTES = 998;
const MAX_OUTBOUND_IDENTIFIER_BYTES = 256;
const MAX_OUTBOUND_HEADER_BYTES = 998;
const OUTBOUND_ENQUEUE_RETRY_BASE_MS = 5_000;
const OUTBOUND_ENQUEUE_RETRY_MAX_MS = 60 * 60 * 1_000;
const TEXT_ENCODER = new TextEncoder();
const OUTBOUND_LOOKUP_SCHEMA = z.strictObject({ outboundId: z.string() });

type NormalizedMailSend = {
  deliveryId: string;
  text: string;
  textSize: number;
  to: string[];
  cc: string[];
  subject: string;
  replyToMessageId?: string;
  inReplyTo?: string;
  references?: string;
  invite?: NormalizedInvite;
};

/** An invite as sent, the guests who must receive it, and how its approval shows it. */
type NormalizedInvite = ManagedOutboundMailInvite & {
  guests: string[];
  approval: MailInviteApproval;
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
    const normalized = normalizeMailSend(value, ownerUid, from, ctx);
    // The owner approves who actually gets the message, including a reply's derived recipients.
    // One recipient stays a string, as clients that predate lists show it.
    const approved: JsonObject = {
      ...value,
      to: normalized.to.length === 1 ? normalized.to[0] : normalized.to,
      subject: normalized.subject,
    };
    // Approval args must be JSON: the Kernel drops an approval signal that carries an undefined field.
    if (normalized.cc.length > 0) approved.cc = normalized.cc;
    else delete approved.cc;
    // The owner reads the event an invite carries, not its iCalendar text.
    if (normalized.invite) approved.invite = normalized.invite.approval;
    await authorizeNestedOperation(ctx, "mail.send", approved);
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
      to: normalized.to.join(", "),
      // Left out without copies, so a single-recipient intent keeps its earlier fingerprint.
      cc: normalized.cc.length > 0 ? normalized.cc.join(", ") : undefined,
      subject: normalized.subject,
      textSize: normalized.textSize,
      bodyDigest,
      replyToMessageId: normalized.replyToMessageId ?? null,
      inReplyTo: normalized.inReplyTo ?? null,
      references: normalized.references ?? null,
      // Left out without an invite, so plain mail keeps its earlier fingerprint.
      inviteDigest: normalized.invite ? await sha256(normalized.invite.text) : undefined,
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
      cc: normalized.cc,
      subject: normalized.subject,
      bodyDigest,
      bodyPath,
      textSize: normalized.textSize,
      createdAt: Date.now(),
    };
    if (normalized.replyToMessageId) input.replyToMessageId = normalized.replyToMessageId;
    if (normalized.inReplyTo) input.inReplyTo = normalized.inReplyTo;
    if (normalized.references) input.references = normalized.references;
    if (normalized.invite) input.invite = { method: normalized.invite.method, text: normalized.invite.text };
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
      to: outbound.to.join(", "),
      subject: outbound.subject,
      replayed: !ensured.created,
    };
    if (outbound.cc.length > 0) result.cc = outbound.cc.join(", ");
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
  ) {
    return null;
  }
  // A queued reference may already be claimed, even when the Queue reply was lost.
  // Only staging owns pre-publication validation; Mail owns the queued outcome.
  if (outbound.state === "staging" && !await outboundBodyMatches(outbound, ctx.env.STORAGE)) {
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
    version: 2,
    installationId: ctx.installationId,
    outboundId: outbound.outboundId,
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
    || (!scheduleSuccessor && current.enqueuedAt !== null)
  ) {
    return current;
  }

  const nextAt = Date.now()
    + outboundEnqueueRetryDelay(current.enqueueAttempts + 1);
  const attempted = ctx.mailboxes.beginOutboundEnqueue(current.outboundId, current.fingerprint, nextAt);
  if (attempted.state !== "staging" && attempted.state !== "queued") return attempted;
  if (scheduleSuccessor) {
    // Queue acceptance is not delivery: keep this durable intent live until completion.
    await ctx.scheduleManagedOutboundEnqueue(current.outboundId, nextAt);
  }
  try {
    const installation = await ctx.env.INSTALLATION_DIRECTORY.resolveInstallation(ctx.installationId);
    if (installation.found && installation.installationId !== ctx.installationId) {
      throw new Error("Directory returned a mismatched mail installation");
    }
    if (!installation.found || ["retained", "deleting", "deleted"].includes(installation.state)) {
      const remaining = ctx.mailboxes.getOutbound(outboundId);
      if (remaining?.state === "staging") ctx.mailboxes.markOutboundQueued(outboundId, remaining.fingerprint);
      if (remaining?.state === "staging" || remaining?.state === "queued") {
        ctx.mailboxes.completeOutbound({ version: 1, outboundId, fingerprint: remaining.fingerprint,
          state: "failed", errorCode: "installation_inactive" });
      }
      return ctx.mailboxes.getOutbound(outboundId);
    }
    if (installation.state !== "active") return ctx.mailboxes.getOutbound(outboundId);
    const command = await prepareManagedOutboundEnqueue(current.outboundId, ctx);
    if (!command) return ctx.mailboxes.getOutbound(current.outboundId);

    const queue = managedOutboundQueue(ctx);
    if (!queue) return ctx.mailboxes.getOutbound(current.outboundId);
    const claimed = ctx.mailboxes.getOutbound(outboundId);
    if (claimed?.state !== "queued") return claimed;
    await queue.send(command);
    return ctx.mailboxes.markOutboundEnqueued(
      current.outboundId,
      current.fingerprint,
    );
  } catch {
    return ctx.mailboxes.getOutbound(current.outboundId);
  }
}

export function resolveOutboundMailReference(
  lookup: ManagedOutboundMailLookup,
  ctx: KernelContext,
): ManagedOutboundMailReference | null {
  const input = OUTBOUND_LOOKUP_SCHEMA.parse(lookup);
  const outboundId = normalizeIdentifier(input.outboundId, "outboundId");
  if (outboundId !== input.outboundId) throw new Error("Outbound mail lookup is invalid");
  const outbound = ctx.mailboxes.getOutbound(outboundId);
  return outbound
    ? { version: 1, outboundId: outbound.outboundId, fingerprint: outbound.fingerprint }
    : null;
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
  const draft = outboundDraft(outbound);
  const fromName = senderName(outbound.ownerUid, ctx);
  if (fromName) draft.fromName = fromName;
  const quote = outbound.replyToMessageId
    ? await replyQuote(outbound.replyToMessageId, outbound.ownerUid, ctx)
    : undefined;
  if (quote) draft.quote = quote;
  return {
    status: "ready",
    draft,
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
  from: string,
  ctx: KernelContext,
): NormalizedMailSend {
  const deliveryId = normalizeIdentifier(
    value.deliveryId,
    "deliveryId",
  );
  const text = normalizeText(value.text);
  const textSize = TEXT_ENCODER.encode(text).byteLength;
  const replySelector = optionalIdentifier(value.replyToMessageId, "replyToMessageId");
  if (value.replyAll !== undefined && value.replyAll !== true && value.replyAll !== false) {
    throw new MailSendError("replyAll must be true or false", false);
  }
  const copies = addressList(value.cc, "cc");
  const invite = value.invite === undefined
    ? undefined
    : normalizeInvite(value.invite, from, displayTimeZone(ownerUid, ctx));
  if (replySelector) {
    if (value.to !== undefined) {
      throw new MailSendError("A reply derives its recipient from the original message", false);
    }
    const source = ctx.mailboxes.getMessage(ownerUid, replySelector);
    if (!source) throw new MailSendError(`Mail message not found: ${replySelector}`, false);
    const replyToMessageId = source.messageId;
    const { to, cc } = recipientLists(
      [replyRecipient(source)],
      value.replyAll ? [...originalRecipients(source, from, ctx), ...copies] : copies,
    );
    const subject = value.subject === undefined
      ? replySubject(source.subject)
      : normalizeSubject(value.subject);
    const inReplyTo = optionalThreadHeader(source.headerMessageId);
    const reply: NormalizedMailSend = {
      deliveryId,
      text,
      textSize,
      to,
      cc,
      subject,
      replyToMessageId,
    };
    if (inReplyTo) {
      reply.inReplyTo = inReplyTo;
      reply.references = inReplyTo;
    }
    if (invite) reply.invite = requireGuests(invite, to, cc);
    return reply;
  }

  if (value.replyToMessageId !== undefined) {
    throw new MailSendError("replyToMessageId is invalid", false);
  }
  if (value.replyAll) throw new MailSendError("replyAll needs replyToMessageId", false);
  // Without To, an invite goes to its guests, less any the message copies.
  const copied = new Set(copies.map((address) => address.toLowerCase()));
  const to = value.to === undefined && invite
    ? invite.guests.filter((guest) => !copied.has(guest.toLowerCase()))
    : addressList(value.to, "to");
  if (to.length === 0) throw new MailSendError("to is required", false);
  if (value.subject === undefined) throw new MailSendError("subject is required", false);
  const send: NormalizedMailSend = {
    deliveryId,
    text,
    textSize,
    ...recipientLists(to, copies),
    subject: normalizeSubject(value.subject),
  };
  if (invite) send.invite = requireGuests(invite, send.to, send.cc);
  return send;
}

/**
 * An event this account organizes, as one VEVENT with REQUEST or CANCEL, rewritten
 * with CRLF lines. Its organizer must be the sender, so replies come back here.
 */
function normalizeInvite(value: string, from: string, timeZone: string): NormalizedInvite {
  if (String(value) !== value || TEXT_ENCODER.encode(value).byteLength > MAX_INVITE_BYTES) {
    throw new MailSendError(`invite must be iCalendar text of at most ${MAX_INVITE_BYTES} bytes`, false);
  }
  let calendar: ReturnType<typeof parseCalendar>;
  let events: ReturnType<typeof calendarEvents>;
  try {
    calendar = parseCalendar(value);
    events = calendarEvents(calendar);
  } catch (error) {
    throw new MailSendError(`invite is not a valid calendar: ${errorMessage(error)}`, false);
  }
  const methodProperty = firstProperty(calendar, "METHOD");
  const method = methodProperty?.value.trim().toUpperCase();
  if (!methodProperty || (method !== "REQUEST" && method !== "CANCEL")) {
    throw new MailSendError("invite must have METHOD:REQUEST to invite or METHOD:CANCEL to cancel", false);
  }
  // The email Worker finds the method in the text, written as the approval names it.
  methodProperty.params = {};
  methodProperty.value = method;
  if (events.length !== 1 || calendar.components.some((component) => !["VEVENT", "VTIMEZONE"].includes(component.name))) {
    throw new MailSendError("invite must hold exactly one event", false);
  }
  const [event] = events;
  if (!firstProperty(event.component, "DTSTAMP")) throw new MailSendError("invite event has no DTSTAMP", false);
  // The approval shows one date, so the event may not repeat or stand for a date of a series.
  if (["RRULE", "RDATE", "EXRULE", "EXDATE", "RECURRENCE-ID"].some((name) => firstProperty(event.component, name))) {
    throw new MailSendError("invite must be an event that happens once, without RRULE, RDATE, EXRULE, EXDATE or RECURRENCE-ID", false);
  }
  // The approval shows when the event ends, which DURATION leaves each calendar to work out.
  if (firstProperty(event.component, "DURATION")) {
    throw new MailSendError("invite gives its length as DURATION, which GSV can't send; write DTEND", false);
  }
  if (event.organizer?.address.toLowerCase() !== from.toLowerCase()) {
    throw new MailSendError(`invite must be organized by ${from}, so replies come back to it`, false);
  }
  const guests = recipientLists(
    event.attendees
      .map((attendee) => normalizeAddress(attendee.address, "invite"))
      .filter((address) => address.toLowerCase() !== from.toLowerCase()),
    [],
  ).to;
  if (guests.length === 0) throw new MailSendError("invite has no guests", false);
  const when = calendarWhen(event, timeZone);
  const approval: MailInviteApproval = { method, allDay: when.allDay, start: when.start };
  if (event.title) approval.title = event.title;
  if (when.end) approval.end = when.end;
  if (event.location) approval.location = event.location;
  const text = serializeCalendar(calendar);
  // CRLF lines and folding can carry a calendar past the size the email Worker accepts.
  if (TEXT_ENCODER.encode(text).byteLength > MAX_INVITE_BYTES) {
    throw new MailSendError(`invite is more than ${MAX_INVITE_BYTES} bytes once written to send`, false);
  }
  // eslint-disable-next-line no-control-regex -- The email Worker refuses any control character but CR, LF and tab.
  if (/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new MailSendError("invite holds a control character", false);
  return { method, text, guests, approval };
}

/** Everyone the invite lists gets it, and nobody else. */
function requireGuests(invite: NormalizedInvite, to: readonly string[], cc: readonly string[]): NormalizedInvite {
  const recipients = [...to, ...cc];
  const sorted = (addresses: readonly string[]) => addresses.map((address) => address.toLowerCase()).sort().join(", ");
  if (sorted(recipients) !== sorted(invite.guests)) {
    throw new MailSendError(
      `An invite goes to exactly its guests (${invite.guests.join(", ")}); this message goes to ${recipients.join(", ")}`,
      false,
    );
  }
  return invite;
}

function addressList(value: MailSendArgs["to"], field: "to" | "cc"): string[] {
  if (value === undefined) return [];
  const entries = Array.isArray(value) ? value : [value];
  if (entries.length > MAX_RECIPIENTS) throw tooManyRecipients(entries.length);
  return entries.map((entry) => {
    if (String(entry) !== entry) throw new MailSendError(`${field} must list email addresses`, false);
    if (entry.includes(",")) throw new MailSendError(`${field}: give several addresses as a list`, false);
    return normalizeAddress(entry, field);
  });
}

/** Each address once, To before Cc, within the recipient limit. */
function recipientLists(to: readonly string[], cc: readonly string[]) {
  const seen = new Set<string>();
  const unique = (addresses: readonly string[]) => addresses.filter((address) => {
    const key = address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const lists = { to: unique(to), cc: unique(cc) };
  const count = lists.to.length + lists.cc.length;
  if (count > MAX_RECIPIENTS) throw tooManyRecipients(count);
  return lists;
}

function tooManyRecipients(count: number): MailSendError {
  return new MailSendError(`A message can go to at most ${MAX_RECIPIENTS} people; this one has ${count}`, false);
}

/** Everyone the original was sent to or copied, except this Ship under any of its addresses. */
function originalRecipients(source: MailMessageRecord, from: string, ctx: KernelContext): string[] {
  const handle = ctx.installationIdentity?.handle?.toLowerCase();
  const domains = deploymentDomains(deploymentPresentation(ctx.env.GSV_PUBLIC_CONFIG));
  const own = new Set([
    from,
    source.envelopeTo,
    ...(handle ? domains.map((domain) => `${handle}@${domain}`) : []),
  ].map((address) => address.toLowerCase()));
  return [...source.to, ...source.cc]
    .map((entry) => extractAddress(entry).trim())
    .filter((address) => !own.has(address.toLowerCase()))
    .map((address) => normalizeAddress(address, "cc"));
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
  ), "to");
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

function normalizeAddress(value: string, field: "to" | "cc" | "invite"): string {
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
    throw new MailSendError(`${field} has an invalid email address: ${source}`, false);
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

/** A Message-ID to thread on: printable ASCII, as mail headers carry it unencoded. */
function optionalThreadHeader(value: string | null): string | undefined {
  return value
    && /^[\x20-\x7e]+$/.test(value)
    && value.length <= MAX_OUTBOUND_HEADER_BYTES
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
    version: outbound.invite ? 2 : 1,
    outboundId: outbound.outboundId,
    fingerprint: outbound.fingerprint,
    from: outbound.from,
    to: outbound.to.length === 1 && outbound.cc.length === 0 ? outbound.to[0] : [...outbound.to],
    subject: outbound.subject,
    bodyDigest: outbound.bodyDigest,
    textSize: outbound.textSize,
    createdAt: outbound.createdAt,
  };
  if (outbound.cc.length > 0) draft.cc = [...outbound.cc];
  if (outbound.replyToMessageId) draft.replyToMessageId = outbound.replyToMessageId;
  if (outbound.inReplyTo) draft.inReplyTo = outbound.inReplyTo;
  if (outbound.references) draft.references = outbound.references;
  if (outbound.invite) draft.invite = { ...outbound.invite };
  return draft;
}

/** The owner's name for the From line, as they show it to other people; read at send time. */
function senderName(ownerUid: number, ctx: KernelContext): string | undefined {
  const name = ownerDisplayName(ownerUid, ctx)?.trim();
  return name
    && !/\p{Cc}/u.test(name)
    && TEXT_ENCODER.encode(name).byteLength <= MAX_SENDER_NAME_BYTES
    ? name
    : undefined;
}

/** The original of a reply, from the owner's stored copy; none once that copy is gone. */
async function replyQuote(
  messageId: string,
  ownerUid: number,
  ctx: KernelContext,
): Promise<ManagedOutboundMailQuote | undefined> {
  const source = ctx.mailboxes.getMessage(ownerUid, messageId);
  if (source?.messageId !== messageId) return undefined;
  const object = await ctx.env.STORAGE.get(pathToStorageKey(source.textPath));
  if (!object) return undefined;
  const rendered = new TextDecoder().decode(await object.arrayBuffer());
  // message.txt is a header block, a blank line, then the text.
  const boundary = rendered.indexOf("\n\n");
  const text = boundary === -1 ? "" : rendered.slice(boundary + 2).trimEnd();
  if (!text.trim() || text === MAIL_NO_TEXT_BODY) return undefined;
  return {
    // A received name may hold control characters; the attribution line can't.
    from: (source.displayFrom ?? source.envelopeFrom).replace(/\p{Cc}+/gu, " "),
    sentAt: source.sentAt ?? source.receivedAt,
    timeZone: displayTimeZone(ownerUid, ctx),
    text: truncateQuote(text),
  };
}

// The server default isn't validated when written, and neither a reply's date line nor an
// invite's approval may fail over it.
function displayTimeZone(ownerUid: number, ctx: KernelContext): string {
  try {
    return normalizeTimezone(ownerTimezone(ctx.config, ownerUid));
  } catch {
    return "UTC";
  }
}

function truncateQuote(text: string): string {
  if (TEXT_ENCODER.encode(text).byteLength <= MAX_QUOTE_BYTES) return text;
  const marker = "\n[…]";
  const bytes = new Uint8Array(MAX_QUOTE_BYTES - TEXT_ENCODER.encode(marker).byteLength);
  const { written = 0 } = TEXT_ENCODER.encodeInto(text, bytes);
  return `${new TextDecoder().decode(bytes.subarray(0, written))}${marker}`;
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
