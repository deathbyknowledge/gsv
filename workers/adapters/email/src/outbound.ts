import {
  MAIL_MAX_INVITE_BYTES,
  MAIL_MAX_OUTBOUND_TEXT_BYTES as ABSOLUTE_MAX_TEXT_BYTES,
  MAIL_MAX_QUOTE_BYTES,
  MAIL_MAX_RECIPIENTS,
  MAIL_MAX_SENDER_NAME_BYTES,
} from "@humansandmachines/gsv/services/mail";
import { configuredDomainAliases } from "@humansandmachines/gsv/services/deployment";
import {
  bodyToBytes,
  type ManagedOutboundMailClaim,
  type ManagedOutboundMailClaimOutcome,
  type ManagedOutboundMailCompletion,
  type ManagedOutboundMailDraft,
  type ManagedOutboundMailReference,
} from "@humansandmachines/gsv/protocol";
import { mailAddressForHandle } from "./address";
import { composeMail } from "./compose";
import { mailFooter, mailSending, type MailEnv, type MailLimits, type MailSending } from "./env";
import type { MailPolicy } from "./policy";
import { emitTelemetry, exceptionDiagnostics, type ExceptionDiagnostics } from "@humansandmachines/gsv/telemetry";
import type { MailRetirement } from "./retirement";
import { renderMail, type MailFooter, type RenderedMail } from "./render";
import { EmailSendingError, sendRawMail, type SentMail } from "./sending";
interface ExternalObject { [key: string]: ExternalValue; }
type ExternalValue = string | number | boolean | ExternalObject | null | undefined;

const CLAIM_RESERVATION_MS = 5 * 60 * 1000;
const INITIAL_CLAIM_RETRY_MS = 5_000;
const MAX_CLAIM_RETRY_MS = 60 * 60 * 1000;
const ATTEMPT_EXPIRY_MS = 5 * 60 * 1000;
const INITIAL_CALLBACK_RETRY_MS = 5_000;
const MAX_CALLBACK_RETRY_MS = 60 * 60 * 1000;
const MAX_ADDRESS_LENGTH = 320;
const MAX_SUBJECT_LENGTH = 998;
const MAX_HEADER_LENGTH = 998;
const MAX_OPAQUE_ID_LENGTH = 256;
// A stored sender is a bounded name and address: `Name <address>`.
const MAX_QUOTE_SENDER_BYTES = 2048;
const TEXT_ENCODER = new TextEncoder();
const RATE_LIMITED = "provider_rate_limited";
/** Codes for mail Email Sending refused, or took and could deliver to nobody. */
const PROVIDER_FAILURES: ReadonlySet<string> = new Set([
  RATE_LIMITED, "sender_unavailable", "provider_rejected", "recipient_suppressed", "recipient_rejected",
]);

type OutboundState =
  | "claiming"
  | "attempting"
  | "accepted"
  | "failed"
  | "unknown";

type OutboundRow = {
  outbound_id: string;
  fingerprint: string;
  expected_from: string | null;
  state: OutboundState;
  text_size: number | null;
  usage_day: string | null;
  provider_message_id: string | null;
  error_code: string | null;
  claim_attempts: number;
  claim_next_attempt_at: number | null;
  attempting_expires_at: number | null;
  callback_attempts: number;
  callback_next_attempt_at: number | null;
  callback_completed_at: number | null;
  created_at: number;
  updated_at: number;
};

type ValidatedOutbound = {
  draft: ManagedOutboundMailDraft;
  /** To and Cc together; each counts toward the daily message allowance. */
  recipients: string[];
  /** The message as recipients see it, in MIME: HTML and plain text, footer and quote included. */
  mime: string;
};

export class OutboundDeliveryCoordinator {
  private readonly active = new Map<string, Promise<void>>();

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: MailEnv,
    private readonly installationId: string,
    private readonly policy: MailPolicy,
    private readonly retirement: MailRetirement,
  ) {}

  async deliver(
    referenceValue: ManagedOutboundMailReference,
  ): Promise<void> {
    this.retirement.requireLive();
    const reference = parseReference(referenceValue);
    try {
      await this.runActive(
        reference,
        async () => await this.admitAndProcess(reference),
      );
    } finally {
      await this.scheduleNextAlarm();
    }
  }

  recoverExpiredAttempts(now: number): void {
    const expired = this.ctx.storage.sql.exec<Pick<
      OutboundRow,
      "outbound_id" | "fingerprint"
    >>(
      `SELECT outbound_id, fingerprint
       FROM mail_outbound_deliveries
       WHERE state = 'attempting' AND attempting_expires_at <= ?`,
      now,
    ).toArray();
    for (const row of expired) {
      const key = `${row.outbound_id}\0${row.fingerprint}`;
      if (this.active.has(key)) {
        this.ctx.storage.sql.exec(
          `UPDATE mail_outbound_deliveries
           SET attempting_expires_at = ?, updated_at = ?
           WHERE outbound_id = ? AND fingerprint = ?
             AND state = 'attempting' AND attempting_expires_at <= ?`,
          now + ATTEMPT_EXPIRY_MS,
          now,
          row.outbound_id,
          row.fingerprint,
          now,
        );
        continue;
      }
      this.ctx.storage.sql.exec(
        `UPDATE mail_outbound_deliveries
         SET state = 'unknown', error_code = 'delivery_outcome_unknown',
             attempting_expires_at = NULL, callback_next_attempt_at = ?,
             updated_at = ?
         WHERE outbound_id = ? AND fingerprint = ?
           AND state = 'attempting' AND attempting_expires_at <= ?`,
        now,
        now,
        row.outbound_id,
        row.fingerprint,
        now,
      );
      this.emitTerminal(this.requireByReference({ version: 1, outboundId: row.outbound_id, fingerprint: row.fingerprint }));
    }
  }

  async processNextCallback(now: number): Promise<boolean> {
    const row = this.ctx.storage.sql.exec<OutboundRow>(
      `${OUTBOUND_SELECT}
       WHERE callback_completed_at IS NULL
         AND callback_next_attempt_at <= ?
       ORDER BY callback_next_attempt_at, created_at
       LIMIT 1`,
      now,
    ).toArray()[0];
    if (!row) return false;
    await this.notify(row);
    return true;
  }

  async processNextClaim(now: number): Promise<boolean> {
    const row = this.ctx.storage.sql.exec<OutboundRow>(
      `${OUTBOUND_SELECT}
       WHERE state = 'claiming' AND claim_next_attempt_at <= ?
       ORDER BY claim_next_attempt_at, created_at
       LIMIT 1`,
      now,
    ).toArray()[0];
    if (!row) return false;
    this.retirement.requireLive();
    const reference = rowReference(row);
    await this.runActive(
      reference,
      async () => await this.processDueClaim(row, now),
    );
    return true;
  }

  nextAlarmAt(): number | null {
    return this.ctx.storage.sql.exec<{ next_at: number | null }>(
      `SELECT MIN(next_at) AS next_at
       FROM (
         SELECT callback_next_attempt_at AS next_at
         FROM mail_outbound_deliveries
         WHERE callback_completed_at IS NULL
         UNION ALL
         SELECT claim_next_attempt_at AS next_at
         FROM mail_outbound_deliveries
         WHERE state = 'claiming'
         UNION ALL
         SELECT attempting_expires_at AS next_at
         FROM mail_outbound_deliveries
         WHERE state = 'attempting'
       )
       WHERE next_at IS NOT NULL`,
    ).one().next_at;
  }

  private async admitAndProcess(
    reference: ManagedOutboundMailReference,
  ): Promise<void> {
    let row = this.byReference(reference);
    if (row) {
      if (row.state === "attempting") {
        this.setTerminal(
          reference,
          "unknown",
          "delivery_outcome_unknown",
        );
        row = this.requireByReference(reference);
      }
      if (isTerminal(row.state)) {
        if (row.callback_completed_at === null) await this.notify(row);
        return;
      }
    } else {
      const conflict = this.ctx.storage.sql.exec<{ outbound_id: string }>(
        `SELECT outbound_id
         FROM mail_outbound_deliveries
         WHERE outbound_id = ? AND fingerprint <> ?
         LIMIT 1`,
        reference.outboundId,
        reference.fingerprint,
      ).toArray()[0];
      if (conflict) {
        row = this.insertTerminal(
          reference,
          null,
          "failed",
          "fingerprint_conflict",
          false,
        );
        return;
      }
      this.insertClaiming(reference);
    }

    await this.scheduleNextAlarm();
    if (this.retirement.retired) return;
    const claiming = this.requireByReference(reference);
    if (
      claiming.state === "claiming"
      && claiming.claim_next_attempt_at !== null
      && claiming.claim_next_attempt_at <= Date.now()
    ) {
      await this.processDueClaim(claiming, Date.now());
    }
  }

  private async processDueClaim(row: OutboundRow, now: number): Promise<void> {
    if (this.retirement.retired) return;
    const reference = rowReference(row);
    let reserved = this.reserveClaim(reference, now);
    if (!reserved) return;
    await this.scheduleNextAlarm();

    let expectedFrom: string;
    let allowedSenders: ReadonlySet<string>;
    let limits: MailLimits;
    let footer: MailFooter | undefined;
    try {
      const [installation, allowance] = await Promise.all([
        this.env.ACCOUNTS.resolveInstallation(this.installationId), this.policy.limits(),
      ]);
      limits = allowance;
      footer = mailFooter(this.env);
      if (this.retirement.retired) return;
      if (!installation.found) {
        this.setTerminal(reference, "failed", "installation_inactive");
        await this.notify(this.requireByReference(reference));
        return;
      }
      if (installation.installationId !== this.installationId) {
        throw new Error("Accounts returned a mismatched mail installation");
      }
      if (["retained", "deleting", "deleted"].includes(installation.state)) {
        this.setTerminal(reference, "failed", "installation_inactive");
        await this.notify(this.requireByReference(reference));
        return;
      }
      if (installation.state !== "active") {
        throw new Error("Mail installation is temporarily inactive");
      }
      expectedFrom = mailAddressForHandle(
        installation.handle,
        this.env.MAIL_DOMAIN,
      );
      allowedSenders = new Set([
        expectedFrom,
        ...configuredDomainAliases(this.env.MAIL_SENDING_DOMAINS).map((domain) =>
          mailAddressForHandle(installation.handle, domain)),
      ]);
    } catch (error) {
      if (this.retirement.retired) return;
      this.deferClaim(reference, reserved.claim_attempts, String(error));
      return;
    }
    if (!limits.outboundEnabled) {
      this.setTerminal(reference, "failed", "outbound_disabled");
      await this.notify(this.requireByReference(reference));
      return;
    }
    let sending: MailSending;
    try {
      sending = mailSending(this.env);
    } catch (error) {
      this.deferClaim(reference, reserved.claim_attempts, String(error));
      return;
    }
    if (reserved.expected_from === null) {
      reserved = this.pinExpectedFrom(reference, expectedFrom, reserved.claim_attempts);
    }
    // The pinned address fences the owner handle. The immutable draft's own
    // sender domain is checked against the current allowlist after claiming it.
    if (reserved.expected_from?.split("@", 1)[0] !== expectedFrom.split("@", 1)[0]) {
      this.setTerminal(reference, "failed", "sender_identity_changed");
      await this.notify(this.requireByReference(reference));
      return;
    }

    let claim: ManagedOutboundMailClaim | undefined;
    try {
      let outcome: ManagedOutboundMailClaimOutcome;
      try {
        outcome = await this.env.GATEWAY.claimOutboundMail(
          { installationId: this.installationId },
          reference,
        );
      } catch (error) {
        if (this.retirement.retired) return;
        this.deferClaim(reference, reserved.claim_attempts, String(error));
        return;
      }
      if (this.retirement.retired) {
        if (outcome.status === "ready") await cancelClaimBody(outcome, "Mail installation is retired");
        return;
      }
      if (outcome.status === "rejected") {
        this.setLocalTerminal(reference, "failed", outcome.errorCode);
        return;
      }
      if (outcome.status === "settled") {
        this.mirrorGatewayCompletion(reference, outcome.completion);
        return;
      }
      if (outcome.status !== "ready") {
        this.deferClaim(
          reference,
          reserved.claim_attempts,
          new Error("Managed outbound claim outcome is invalid"),
        );
        return;
      }
      claim = outcome;
      let outbound: ValidatedOutbound;
      try {
        outbound = await this.validateClaim(
          reference,
          claim,
          allowedSenders,
          limits,
          footer,
        );
      } catch (error) {
        if (this.retirement.retired) return;
        if (!(error instanceof InvalidDraftError)) {
          this.deferClaim(reference, reserved.claim_attempts, String(error));
          return;
        }
        this.setTerminal(reference, "failed", "invalid_draft");
        await this.notify(this.requireByReference(reference));
        return;
      }

      if (this.retirement.retired) return;
      try {
        limits = await this.policy.limits();
      } catch (error) {
        if (!this.retirement.retired) this.deferClaim(reference, reserved.claim_attempts, String(error));
        return;
      }
      if (this.retirement.retired) return;
      if (!limits.outboundEnabled || outbound.draft.textSize > limits.maxOutboundTextBytes) {
        this.setTerminal(reference, "failed", !limits.outboundEnabled ? "outbound_disabled" : "invalid_draft");
        await this.notify(this.requireByReference(reference));
        return;
      }
      if (!this.reserveAttempt(reference, outbound.draft.textSize, outbound.recipients.length, limits)) {
        this.emitTerminal(this.requireByReference(reference));
        await this.notify(this.requireByReference(reference));
        return;
      }

      try {
        await this.scheduleNextAlarm();
        this.retirement.requireLive();
        const sent = await this.send(outbound, sending);
        if (this.retirement.retired) return;
        const undeliverable = undelivered(sent);
        if (undeliverable === "recipient_suppressed") {
          // Email Sending dropped every recipient before delivery, so nothing left.
          this.refuseAttempt(reference, outbound, undeliverable, reserved.claim_attempts, {});
        } else if (undeliverable) {
          this.setTerminal(reference, "failed", undeliverable);
        } else {
          this.setTerminal(reference, "accepted", null, parseProviderMessageId(sent.messageId));
        }
      } catch (error) {
        if (this.retirement.retired) return;
        const diagnostics = exceptionDiagnostics(error);
        console.warn(JSON.stringify({
          service: "managed_mail",
          event: "provider_error",
          phase: "outbound_send",
          errorType: diagnostics.exceptionName ?? "Error",
          errorCode: diagnostics.errorCode,
        }));
        const refusal = error instanceof EmailSendingError ? providerRefusal(error) : undefined;
        if (refusal) {
          this.refuseAttempt(reference, outbound, refusal, reserved.claim_attempts, diagnostics);
          await this.scheduleNextAlarm();
        } else {
          this.setTerminal(reference, "unknown", "delivery_outcome_unknown", null, diagnostics);
        }
      }
      await this.notify(this.requireByReference(reference));
    } finally {
      if (claim) {
        await cancelClaimBody(claim, "Managed outbound mail claim finished");
      }
    }
  }

  private async validateClaim(
    reference: ManagedOutboundMailReference,
    claim: ManagedOutboundMailClaim,
    allowedSenders: ReadonlySet<string>,
    limits: MailLimits,
    footer: MailFooter | undefined,
  ): Promise<ValidatedOutbound> {
    if (!claim || claim.constructor !== Object) {
      throw new InvalidDraftError();
    }
    const draft = claim.draft;
    if (
      !draft
      || !validVersion(draft)
      || draft.outboundId !== reference.outboundId
      || draft.fingerprint !== reference.fingerprint
      || !validFingerprint(draft.bodyDigest)
      || !Number.isSafeInteger(draft.createdAt)
      || draft.createdAt < 0
      || !Number.isSafeInteger(draft.textSize)
      || draft.textSize <= 0
      || draft.textSize > Math.min(
        ABSOLUTE_MAX_TEXT_BYTES,
        limits.maxOutboundTextBytes,
      )
      || !validAddress(draft.from)
      || !allowedSenders.has(draft.from)
      || !validSubject(draft.subject)
      || !validOptionalHeader(draft.inReplyTo)
      || !validOptionalHeader(draft.references)
      || !validOptionalOpaqueId(draft.replyToMessageId)
      || !validOptionalSenderName(draft.fromName)
      || !validOptionalQuote(draft.quote)
      || !claim.body
      || claim.body.length !== draft.textSize
    ) {
      throw new InvalidDraftError();
    }
    const recipients = recipientList(draft.to, draft.cc);
    if (recipients === null) throw new InvalidDraftError();
    const bytes = await bodyToBytes(
      claim.body,
      Math.min(ABSOLUTE_MAX_TEXT_BYTES, limits.maxOutboundTextBytes),
      this.retirement.cancellation.signal,
    );
    if (bytes.byteLength !== draft.textSize) {
      throw new InvalidDraftError();
    }
    if (await sha256(bytes) !== draft.bodyDigest) {
      throw new InvalidDraftError();
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: false,
      }).decode(bytes);
    } catch {
      throw new InvalidDraftError();
    }
    let rendered: RenderedMail;
    try {
      rendered = renderMail(text, { footer, quote: draft.quote });
    } catch {
      throw new InvalidDraftError();
    }
    const mime = composeMail({
      from: draft.from,
      fromName: draft.fromName,
      to: Array.isArray(draft.to) ? draft.to : [draft.to],
      cc: draft.cc,
      subject: draft.subject,
      inReplyTo: draft.inReplyTo,
      references: draft.references,
      text: rendered.text,
      html: rendered.html,
      invite: draft.invite,
    });
    return { draft, recipients, mime };
  }

  private async send(outbound: ValidatedOutbound, sending: MailSending): Promise<SentMail> {
    return await sendRawMail(
      sending,
      { from: outbound.draft.from, recipients: outbound.recipients, mime: outbound.mime },
      this.retirement.cancellation.signal,
    );
  }

  private reserveAttempt(
    reference: ManagedOutboundMailReference,
    textSize: number,
    recipients: number,
    limits: MailLimits,
  ): boolean {
    return this.ctx.storage.transactionSync(() => {
      const row = this.requireByReference(reference);
      if (row.state !== "claiming") return false;
      const now = Date.now();
      const day = utcDay(now);
      this.ctx.storage.sql.exec(
        `INSERT INTO mail_daily_usage (day)
         VALUES (?)
         ON CONFLICT(day) DO NOTHING`,
        day,
      );
      const usage = this.ctx.storage.sql.exec<{
        outbound_messages: number;
        outbound_bytes: number;
      }>(
        `SELECT outbound_messages, outbound_bytes
         FROM mail_daily_usage
         WHERE day = ?`,
        day,
      ).one();
      if (
        usage.outbound_messages + recipients > limits.dailyOutboundMessages
        || usage.outbound_bytes + textSize > limits.dailyOutboundBytes
      ) {
        this.ctx.storage.sql.exec(
          `UPDATE mail_outbound_deliveries
           SET state = 'failed', text_size = ?, error_code = 'outbound_quota',
               claim_next_attempt_at = NULL, callback_next_attempt_at = ?,
               updated_at = ?
           WHERE outbound_id = ? AND fingerprint = ? AND state = 'claiming'`,
          textSize,
          now,
          now,
          reference.outboundId,
          reference.fingerprint,
        );
        return false;
      }
      this.ctx.storage.sql.exec(
        `UPDATE mail_daily_usage
         SET outbound_messages = outbound_messages + ?,
             outbound_bytes = outbound_bytes + ?
         WHERE day = ?`,
        recipients,
        textSize,
        day,
      );
      this.ctx.storage.sql.exec(
        `UPDATE mail_outbound_deliveries
         SET state = 'attempting', text_size = ?, usage_day = ?,
             error_code = NULL, claim_next_attempt_at = NULL,
             attempting_expires_at = ?, updated_at = ?
         WHERE outbound_id = ? AND fingerprint = ? AND state = 'claiming'`,
        textSize,
        day,
        now + ATTEMPT_EXPIRY_MS,
        now,
        reference.outboundId,
        reference.fingerprint,
      );
      return true;
    });
  }

  /**
   * The provider refused the send before handing it on, so the attempt stops counting toward
   * the daily allowance. A rate limit returns the delivery to claiming for a later attempt;
   * any other refusal fails it.
   */
  private refuseAttempt(
    reference: ManagedOutboundMailReference,
    outbound: ValidatedOutbound,
    errorCode: string,
    attempts: number,
    diagnostics: ExceptionDiagnostics,
  ): void {
    this.ctx.storage.transactionSync(() => {
      const row = this.requireByReference(reference);
      if (row.state !== "attempting") return;
      this.ctx.storage.sql.exec(
        `UPDATE mail_daily_usage
         SET outbound_messages = outbound_messages - ?,
             outbound_bytes = outbound_bytes - ?
         WHERE day = ?`,
        outbound.recipients.length,
        outbound.draft.textSize,
        row.usage_day,
      );
      if (errorCode !== RATE_LIMITED) {
        this.setTerminal(reference, "failed", errorCode, null, diagnostics);
        return;
      }
      const now = Date.now();
      this.ctx.storage.sql.exec(
        `UPDATE mail_outbound_deliveries
         SET state = 'claiming', error_code = ?, usage_day = NULL,
             attempting_expires_at = NULL, claim_next_attempt_at = ?,
             updated_at = ?
         WHERE outbound_id = ? AND fingerprint = ? AND state = 'attempting'`,
        errorCode,
        now + claimRetryDelay(attempts),
        now,
        reference.outboundId,
        reference.fingerprint,
      );
      emitTelemetry(this.env, { installationId: this.installationId, component: "mail", event: {
        stream: "operational", name: "mail.work.deferred", properties: { stage: "outbound_send", reason: "rate_limited" },
      } });
    });
  }

  private reserveClaim(
    reference: ManagedOutboundMailReference,
    now: number,
  ): OutboundRow | null {
    return this.ctx.storage.transactionSync(() => {
      const row = this.byReference(reference);
      if (
        !row
        || row.state !== "claiming"
        || row.claim_next_attempt_at === null
        || row.claim_next_attempt_at > now
      ) {
        return null;
      }
      this.ctx.storage.sql.exec(
        `UPDATE mail_outbound_deliveries
         SET claim_attempts = claim_attempts + 1,
             claim_next_attempt_at = ?, updated_at = ?
         WHERE outbound_id = ? AND fingerprint = ? AND state = 'claiming'
           AND claim_next_attempt_at <= ?`,
        now + CLAIM_RESERVATION_MS,
        now,
        reference.outboundId,
        reference.fingerprint,
        now,
      );
      return this.requireByReference(reference);
    });
  }

  private pinExpectedFrom(
    reference: ManagedOutboundMailReference,
    expectedFrom: string,
    attempts: number,
  ): OutboundRow {
    this.ctx.storage.sql.exec(
      `UPDATE mail_outbound_deliveries
       SET expected_from = ?, updated_at = ?
       WHERE outbound_id = ? AND fingerprint = ? AND state = 'claiming'
         AND claim_attempts = ? AND expected_from IS NULL`,
      expectedFrom,
      Date.now(),
      reference.outboundId,
      reference.fingerprint,
      attempts,
    );
    return this.requireByReference(reference);
  }

  private deferClaim(
    reference: ManagedOutboundMailReference,
    attempts: number,
    error: Error | string | null | undefined,
  ): void {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `UPDATE mail_outbound_deliveries
       SET error_code = 'claim_unavailable', claim_next_attempt_at = ?,
           updated_at = ?
       WHERE outbound_id = ? AND fingerprint = ? AND state = 'claiming'
         AND claim_attempts = ?`,
      now + claimRetryDelay(attempts),
      now,
      reference.outboundId,
      reference.fingerprint,
      attempts,
    );
    console.warn(JSON.stringify({
      service: "managed_mail",
      event: "retry_scheduled",
      phase: "outbound_claim",
      errorType: error instanceof Error ? error.name : "Error",
    }));
    emitTelemetry(this.env, { installationId: this.installationId, component: "mail", event: {
      stream: "operational", name: "mail.work.deferred", properties: { stage: "outbound_claim", reason: "unavailable" },
    } });
  }

  private insertClaiming(
    reference: ManagedOutboundMailReference,
  ): void {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO mail_outbound_deliveries (
         outbound_id, fingerprint, expected_from, state,
         claim_next_attempt_at, created_at, updated_at
       ) VALUES (?, ?, ?, 'claiming', ?, ?, ?)`,
      reference.outboundId,
      reference.fingerprint,
      null,
      now,
      now,
      now,
    );
  }

  private insertTerminal(
    reference: ManagedOutboundMailReference,
    expectedFrom: string | null,
    state: "failed" | "unknown",
    errorCode: string,
    callback = true,
  ): OutboundRow {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO mail_outbound_deliveries (
         outbound_id, fingerprint, expected_from, state, error_code,
         callback_next_attempt_at, callback_completed_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      reference.outboundId,
      reference.fingerprint,
      expectedFrom,
      state,
      errorCode,
      callback ? now : null,
      callback ? null : now,
      now,
      now,
    );
    const terminal = this.requireByReference(reference);
    this.emitTerminal(terminal);
    return terminal;
  }

  private mirrorGatewayCompletion(
    reference: ManagedOutboundMailReference,
    completion: ManagedOutboundMailCompletion,
  ): void {
    if (
      completion.version !== 1
      || completion.outboundId !== reference.outboundId
      || completion.fingerprint !== reference.fingerprint
      || (
        completion.state !== "accepted"
        && completion.state !== "failed"
        && completion.state !== "unknown"
      )
      || (completion.state === "accepted"
        ? !validOpaqueId(completion.providerMessageId) || completion.errorCode !== undefined
        : !validOpaqueId(completion.errorCode) || completion.providerMessageId !== undefined)
    ) {
      throw new Error("Managed outbound settled claim is invalid");
    }
    this.setLocalTerminal(
      reference,
      completion.state,
      completion.errorCode ?? null,
      completion.providerMessageId ?? null,
    );
  }

  private setLocalTerminal(
    reference: ManagedOutboundMailReference,
    state: "accepted" | "failed" | "unknown",
    errorCode: string | null,
    providerMessageId: string | null = null,
  ): void {
    const previous = this.requireByReference(reference);
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `UPDATE mail_outbound_deliveries
       SET state = ?, provider_message_id = ?, error_code = ?,
           claim_next_attempt_at = NULL, attempting_expires_at = NULL,
           callback_next_attempt_at = NULL, callback_completed_at = ?,
           updated_at = ?
       WHERE outbound_id = ? AND fingerprint = ?`,
      state,
      providerMessageId,
      errorCode,
      now,
      now,
      reference.outboundId,
      reference.fingerprint,
    );
    if (!isTerminal(previous.state)) this.emitTerminal(this.requireByReference(reference));
  }

  private setTerminal(
    reference: ManagedOutboundMailReference,
    state: "accepted" | "failed" | "unknown",
    errorCode: string | null,
    providerMessageId: string | null = null,
    diagnostics: ExceptionDiagnostics = {},
  ): void {
    const previous = this.requireByReference(reference);
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `UPDATE mail_outbound_deliveries
       SET state = ?, provider_message_id = ?, error_code = ?,
           claim_next_attempt_at = NULL, attempting_expires_at = NULL,
           callback_next_attempt_at = ?, updated_at = ?
       WHERE outbound_id = ? AND fingerprint = ?
         AND callback_completed_at IS NULL`,
      state,
      providerMessageId,
      errorCode,
      now,
      now,
      reference.outboundId,
      reference.fingerprint,
    );
    if (!isTerminal(previous.state)) this.emitTerminal(this.requireByReference(reference), diagnostics);
  }

  private emitTerminal(row: OutboundRow, diagnostics: ExceptionDiagnostics = {}): void {
    if (!isTerminal(row.state)) return;
    const reason = row.state === "accepted" ? "none" : row.state === "unknown" ? "provider_unknown"
      : row.error_code === "outbound_disabled" ? "disabled" : row.error_code === "outbound_quota" ? "quota"
      : row.error_code === "installation_inactive" ? "inactive"
      : PROVIDER_FAILURES.has(row.error_code ?? "") ? "provider_refused" : "invalid";
    emitTelemetry(this.env, { installationId: this.installationId, component: "mail",
      event: { stream: "operational", name: "mail.delivery.finished", properties: {
        ...diagnostics, outcome: row.state, reason, durationMs: Math.max(0, row.updated_at - row.created_at),
      } } });
  }

  private async notify(row: OutboundRow): Promise<void> {
    if (this.retirement.retired) return;
    if (!isTerminal(row.state) || row.callback_completed_at !== null) return;
    const completion: ManagedOutboundMailCompletion = {
      version: 1,
      outboundId: row.outbound_id,
      fingerprint: row.fingerprint,
      state: row.state,
      providerMessageId: row.provider_message_id ?? undefined,
      errorCode: row.error_code ?? undefined,
    };
    const now = Date.now();
    try {
      await this.env.GATEWAY.completeOutboundMail(
        { installationId: this.installationId },
        completion,
      );
      this.ctx.storage.sql.exec(
        `UPDATE mail_outbound_deliveries
         SET callback_attempts = callback_attempts + 1,
             callback_next_attempt_at = NULL,
             callback_completed_at = ?, updated_at = ?
         WHERE outbound_id = ? AND fingerprint = ?
           AND callback_completed_at IS NULL`,
        now,
        now,
        row.outbound_id,
        row.fingerprint,
      );
    } catch (error) {
      if (this.retirement.retired) return;
      const attempts = row.callback_attempts + 1;
      this.ctx.storage.sql.exec(
        `UPDATE mail_outbound_deliveries
         SET callback_attempts = ?, callback_next_attempt_at = ?,
             updated_at = ?
         WHERE outbound_id = ? AND fingerprint = ?
           AND callback_completed_at IS NULL`,
        attempts,
        now + callbackRetryDelay(attempts),
        now,
        row.outbound_id,
        row.fingerprint,
      );
      console.warn(JSON.stringify({
        service: "managed_mail",
        event: "retry_scheduled",
        phase: "outbound_completion",
        errorType: error instanceof Error ? error.name : "Error",
      }));
      emitTelemetry(this.env, { installationId: this.installationId, component: "mail", event: {
        stream: "operational", name: "mail.work.deferred", properties: { stage: "outbound_callback", reason: "unavailable" },
      } });
    }
  }

  private byReference(
    reference: ManagedOutboundMailReference,
  ): OutboundRow | null {
    return this.ctx.storage.sql.exec<OutboundRow>(
      `${OUTBOUND_SELECT}
       WHERE outbound_id = ? AND fingerprint = ?
       LIMIT 1`,
      reference.outboundId,
      reference.fingerprint,
    ).toArray()[0] ?? null;
  }

  private requireByReference(
    reference: ManagedOutboundMailReference,
  ): OutboundRow {
    const row = this.byReference(reference);
    if (!row) throw new Error("Managed outbound mail ledger row is unavailable");
    return row;
  }

  private async scheduleNextAlarm(): Promise<void> {
    if (this.retirement.retired) return;
    const next = this.nextAlarmAt();
    if (next === null) return;
    const target = Math.max(next, Date.now() + 100);
    const existing = await this.ctx.storage.getAlarm();
    if (!this.retirement.retired && (existing === null || target < existing)) {
      await this.ctx.storage.setAlarm(target);
    }
  }

  private async runActive(
    reference: ManagedOutboundMailReference,
    operationValue: () => Promise<void>,
  ): Promise<void> {
    const key = `${reference.outboundId}\0${reference.fingerprint}`;
    const active = this.active.get(key);
    if (active) return await active;
    const operation = operationValue();
    this.active.set(key, operation);
    try {
      await operation;
    } finally {
      if (this.active.get(key) === operation) this.active.delete(key);
    }
  }
}

const OUTBOUND_SELECT = `
  SELECT outbound_id, fingerprint, expected_from, state, text_size, usage_day,
         provider_message_id, error_code, claim_attempts,
         claim_next_attempt_at, attempting_expires_at, callback_attempts,
         callback_next_attempt_at, callback_completed_at, created_at, updated_at
  FROM mail_outbound_deliveries
`;

function parseReference(value: ManagedOutboundMailReference): ManagedOutboundMailReference {
  if (
    !value
    || value.constructor !== Object
    || value.version !== 1
    || !validOpaqueId(value.outboundId)
    || !validFingerprint(value.fingerprint)
  ) {
    throw new Error("Managed outbound mail reference is invalid");
  }
  return {
    version: 1,
    outboundId: value.outboundId,
    fingerprint: value.fingerprint,
  };
}

function validOpaqueId(value: ExternalValue): value is string {
  return String(value) === value
    && value.length > 0
    && value.trim() === value
    && TEXT_ENCODER.encode(value).byteLength <= MAX_OPAQUE_ID_LENGTH
    && !/\p{Cc}/u.test(value);
}

function validFingerprint(value: ExternalValue): value is string {
  return String(value) === value && /^sha256:[0-9a-f]{64}$/.test(value);
}

function validAddress(value: ExternalValue): value is string {
  if (String(value) !== value) return false;
  const separator = value.lastIndexOf("@");
  return value.length > 0
    && TEXT_ENCODER.encode(value).byteLength <= MAX_ADDRESS_LENGTH
    && value.trim() === value
    && separator > 0
    && value.indexOf("@") === separator
    && separator < value.length - 1
    && value.slice(separator + 1).toLowerCase() === value.slice(separator + 1)
    && !/[\s\p{Cc}<>(),;:"]/u.test(value)
    && !value.includes("..");
}

function validSubject(value: ExternalValue): value is string {
  return String(value) === value
    && value.length > 0
    && value.trim() === value
    && TEXT_ENCODER.encode(value).byteLength <= MAX_SUBJECT_LENGTH
    && !/\p{Cc}/u.test(value);
}

/** A threading header: message ids are printable ASCII, so the header needs no encoding. */
function validOptionalHeader(value: ExternalValue): boolean {
  return value === undefined
    || (String(value) === value
      && value.length > 0
      && value.length <= MAX_HEADER_LENGTH
      && /^[\x20-\x7e]+$/.test(value));
}

function validOptionalOpaqueId(value: ExternalValue): boolean {
  return value === undefined || validOpaqueId(value);
}

/** Everyone a draft reaches, or null unless each is a distinct valid address within the limit. */
function recipientList(
  to: ManagedOutboundMailDraft["to"],
  cc: ManagedOutboundMailDraft["cc"],
): string[] | null {
  if (Array.isArray(to) && to.length === 0) return null;
  if (cc !== undefined && !Array.isArray(cc)) return null;
  const addresses = [...(Array.isArray(to) ? to : [to]), ...(cc ?? [])];
  if (addresses.length > MAIL_MAX_RECIPIENTS || !addresses.every(validAddress)) return null;
  const distinct = new Set(addresses.map((address) => address.toLowerCase()));
  return distinct.size === addresses.length ? addresses : null;
}

/**
 * The code the owner sees for a send Email Sending refused. A refused request was never handed
 * on: a rate limit returns it to claiming, and a credential, account or request problem fails
 * it. A server error or a lost answer stays unknown, since the message may already have left.
 */
function providerRefusal(error: EmailSendingError): string | undefined {
  if (error.status < 400 || error.status >= 500) return undefined;
  if (error.status === 429) return RATE_LIMITED;
  return [401, 403, 404].includes(error.status) ? "sender_unavailable" : "provider_rejected";
}

/** Why nobody will get a message Email Sending took, or undefined while someone may. */
function undelivered(sent: SentMail): "recipient_suppressed" | "recipient_rejected" | undefined {
  if (sent.delivered.length > 0 || sent.queued.length > 0) return undefined;
  if (sent.permanentBounces.length > 0) return "recipient_rejected";
  return sent.suppressed.length > 0 ? "recipient_suppressed" : undefined;
}

function validOptionalSenderName(value: ExternalValue): boolean {
  return value === undefined
    || (String(value) === value
      && value.length > 0
      && value.trim() === value
      && TEXT_ENCODER.encode(value).byteLength <= MAIL_MAX_SENDER_NAME_BYTES
      && !/\p{Cc}/u.test(value));
}

function validOptionalQuote(value: ManagedOutboundMailDraft["quote"]): boolean {
  if (value === undefined) return true;
  return Boolean(value)
    && value.constructor === Object
    && String(value.from) === value.from
    && value.from.length > 0
    && TEXT_ENCODER.encode(value.from).byteLength <= MAX_QUOTE_SENDER_BYTES
    && !/\p{Cc}/u.test(value.from)
    && Number.isSafeInteger(value.sentAt)
    && value.sentAt >= 0
    && validTimeZone(value.timeZone)
    && String(value.text) === value.text
    && value.text.length > 0
    && TEXT_ENCODER.encode(value.text).byteLength <= MAIL_MAX_QUOTE_BYTES;
}

/** Version 1 is a plain message; version 2 carries an invite, and only version 2 does. */
function validVersion(draft: ManagedOutboundMailDraft): boolean {
  return draft.version === 1
    ? draft.invite === undefined
    : draft.version === 2 && validInvite(draft.invite);
}

/** An iCalendar object with CRLF lines whose METHOD matches the one the message declares. */
function validInvite(value: ManagedOutboundMailDraft["invite"]): boolean {
  if (!value || value.constructor !== Object) return false;
  const { method, text } = value;
  return (method === "REQUEST" || method === "CANCEL")
    && String(text) === text
    && TEXT_ENCODER.encode(text).byteLength <= MAIL_MAX_INVITE_BYTES
    && text.startsWith("BEGIN:VCALENDAR\r\n")
    && text.endsWith("\r\nEND:VCALENDAR\r\n")
    && text.includes(`\r\nMETHOD:${method}\r\n`)
    // eslint-disable-next-line no-control-regex -- Its lines end in CRLF, with no other control character.
    && !/\r(?!\n)|(?<!\r)\n|[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text);
}

function validTimeZone(value: ExternalValue): boolean {
  if (String(value) !== value || value.length === 0 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function parseProviderMessageId(value: ExternalValue): string {
  if (
    String(value) !== value
    || value.length === 0
    || TEXT_ENCODER.encode(value).byteLength > MAX_OPAQUE_ID_LENGTH
    || value.trim() !== value
    || /\p{Cc}/u.test(value)
  ) {
    throw new Error("Managed outbound provider message ID is invalid");
  }
  return value;
}

function isTerminal(
  state: OutboundState,
): state is "accepted" | "failed" | "unknown" {
  return state === "accepted" || state === "failed" || state === "unknown";
}

async function cancelClaimBody(
  claim: ManagedOutboundMailClaim,
  reason: Error | string | null | undefined,
): Promise<void> {
  if (claim.body?.stream && !claim.body.stream.locked) {
    await claim.body.stream.cancel(reason).catch(() => {});
  }
}

function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function callbackRetryDelay(attempt: number): number {
  return Math.min(
    MAX_CALLBACK_RETRY_MS,
    INITIAL_CALLBACK_RETRY_MS
      * (2 ** Math.min(Math.max(attempt - 1, 0), 10)),
  );
}

function claimRetryDelay(attempt: number): number {
  return Math.min(
    MAX_CLAIM_RETRY_MS,
    INITIAL_CLAIM_RETRY_MS
      * (2 ** Math.min(Math.max(attempt - 1, 0), 10)),
  );
}

function rowReference(row: OutboundRow): ManagedOutboundMailReference {
  return {
    version: 1,
    outboundId: row.outbound_id,
    fingerprint: row.fingerprint,
  };
}

class InvalidDraftError extends Error {}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${[...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}
