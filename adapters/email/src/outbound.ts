import {
  bodyToBytes,
  type ManagedOutboundMailClaim,
  type ManagedOutboundMailClaimOutcome,
  type ManagedOutboundMailCompletion,
  type ManagedOutboundMailDraft,
  type ManagedOutboundMailReference,
} from "@humansandmachines/gsv/protocol";
import { mailAddressForHandle } from "./address";
import type { MailEnv, MailLimits } from "./env";

const ABSOLUTE_MAX_TEXT_BYTES = 1024 * 1024;
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
const TEXT_ENCODER = new TextEncoder();

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
  text: string;
  headers?: Record<string, string>;
};

export class OutboundDeliveryCoordinator {
  private readonly active = new Map<string, Promise<void>>();

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: MailEnv,
    private readonly installationId: string,
    private readonly limits: MailLimits,
  ) {}

  async deliver(
    referenceValue: ManagedOutboundMailReference,
  ): Promise<void> {
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
      if (!this.limits.outboundEnabled) {
        row = this.insertTerminal(
          reference,
          null,
          "failed",
          "outbound_disabled",
        );
        await this.notify(row);
        return;
      }
      this.insertClaiming(reference);
    }

    if (!this.limits.outboundEnabled) {
      this.setTerminal(reference, "failed", "outbound_disabled");
      await this.notify(this.requireByReference(reference));
      return;
    }

    await this.scheduleNextAlarm();
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
    const reference = rowReference(row);
    if (!this.limits.outboundEnabled) {
      this.setTerminal(reference, "failed", "outbound_disabled");
      await this.notify(this.requireByReference(reference));
      return;
    }
    let reserved = this.reserveClaim(reference, now);
    if (!reserved) return;
    await this.scheduleNextAlarm();

    let expectedFrom: string;
    try {
      const installation = await this.env.ACCOUNTS.resolveInstallation(
        this.installationId,
      );
      if (!installation.found) {
        this.setTerminal(reference, "failed", "installation_inactive");
        await this.notify(this.requireByReference(reference));
        return;
      }
      if (installation.installationId !== this.installationId) {
        throw new Error("Accounts returned a mismatched mail installation");
      }
      if (installation.state !== "active") {
        this.setTerminal(reference, "failed", "installation_inactive");
        await this.notify(this.requireByReference(reference));
        return;
      }
      expectedFrom = mailAddressForHandle(
        installation.handle,
        this.env.MAIL_DOMAIN,
      );
    } catch (error) {
      this.deferClaim(reference, reserved.claim_attempts, error);
      return;
    }
    if (reserved.expected_from === null) {
      reserved = this.pinExpectedFrom(reference, expectedFrom, reserved.claim_attempts);
    }
    if (expectedFrom !== reserved.expected_from) {
      this.setTerminal(reference, "failed", "sender_identity_changed");
      await this.notify(this.requireByReference(reference));
      return;
    }

    let claim: ManagedOutboundMailClaim | undefined;
    try {
      let outcome: ManagedOutboundMailClaimOutcome;
      try {
        outcome = await this.env.GATEWAY.claimManagedOutboundMail(
          { installationId: this.installationId },
          reference,
        );
      } catch (error) {
        this.deferClaim(reference, reserved.claim_attempts, error);
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
          expectedFrom,
        );
      } catch (error) {
        if (!(error instanceof InvalidDraftError)) {
          this.deferClaim(reference, reserved.claim_attempts, error);
          return;
        }
        this.setTerminal(reference, "failed", "invalid_draft");
        await this.notify(this.requireByReference(reference));
        return;
      }

      if (!this.reserveAttempt(reference, outbound.draft.textSize)) {
        await this.notify(this.requireByReference(reference));
        return;
      }

      try {
        await this.scheduleNextAlarm();
        const result = await this.send(outbound);
        const messageId = parseProviderMessageId(result.messageId);
        this.setTerminal(reference, "accepted", null, messageId);
      } catch {
        this.setTerminal(
          reference,
          "unknown",
          "delivery_outcome_unknown",
        );
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
    expectedFrom: string,
  ): Promise<ValidatedOutbound> {
    if (!claim || typeof claim !== "object") {
      throw new InvalidDraftError();
    }
    const draft = claim.draft;
    if (
      !draft
      || draft.version !== 1
      || draft.outboundId !== reference.outboundId
      || draft.fingerprint !== reference.fingerprint
      || !validFingerprint(draft.bodyDigest)
      || !Number.isSafeInteger(draft.createdAt)
      || draft.createdAt < 0
      || !Number.isSafeInteger(draft.textSize)
      || draft.textSize <= 0
      || draft.textSize > Math.min(
        ABSOLUTE_MAX_TEXT_BYTES,
        this.limits.maxOutboundTextBytes,
      )
      || !validAddress(draft.from)
      || draft.from !== expectedFrom
      || !validAddress(draft.to)
      || !validSubject(draft.subject)
      || !validOptionalHeader(draft.inReplyTo)
      || !validOptionalHeader(draft.references)
      || !validOptionalOpaqueId(draft.replyToMessageId)
      || !claim.body
      || claim.body.length !== draft.textSize
    ) {
      throw new InvalidDraftError();
    }
    const bytes = await bodyToBytes(
      claim.body,
      Math.min(ABSOLUTE_MAX_TEXT_BYTES, this.limits.maxOutboundTextBytes),
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
    const headers: Record<string, string> = {};
    if (draft.inReplyTo) headers["In-Reply-To"] = draft.inReplyTo;
    if (draft.references) headers.References = draft.references;
    return {
      draft,
      text,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
  }

  private async send(outbound: ValidatedOutbound): Promise<EmailSendResult> {
    return await this.env.EMAIL.send({
      to: outbound.draft.to,
      from: outbound.draft.from,
      subject: outbound.draft.subject,
      text: outbound.text,
      ...(outbound.headers ? { headers: outbound.headers } : {}),
    });
  }

  private reserveAttempt(
    reference: ManagedOutboundMailReference,
    textSize: number,
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
        usage.outbound_messages + 1 > this.limits.dailyOutboundMessages
        || usage.outbound_bytes + textSize > this.limits.dailyOutboundBytes
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
         SET outbound_messages = outbound_messages + 1,
             outbound_bytes = outbound_bytes + ?
         WHERE day = ?`,
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
    error: unknown,
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
      errorType: error instanceof Error ? error.name : typeof error,
    }));
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
    return this.requireByReference(reference);
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
  }

  private setTerminal(
    reference: ManagedOutboundMailReference,
    state: "accepted" | "failed" | "unknown",
    errorCode: string | null,
    providerMessageId: string | null = null,
  ): void {
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
  }

  private async notify(row: OutboundRow): Promise<void> {
    if (!isTerminal(row.state) || row.callback_completed_at !== null) return;
    const completion: ManagedOutboundMailCompletion = {
      version: 1,
      outboundId: row.outbound_id,
      fingerprint: row.fingerprint,
      state: row.state,
      ...(row.provider_message_id
        ? { providerMessageId: row.provider_message_id }
        : {}),
      ...(row.error_code ? { errorCode: row.error_code } : {}),
    };
    const now = Date.now();
    try {
      await this.env.GATEWAY.completeManagedOutboundMail(
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
        errorType: error instanceof Error ? error.name : typeof error,
      }));
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
    const next = this.nextAlarmAt();
    if (next === null) return;
    const target = Math.max(next, Date.now() + 100);
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || target < existing) {
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
    || typeof value !== "object"
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

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.trim() === value
    && TEXT_ENCODER.encode(value).byteLength <= MAX_OPAQUE_ID_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function validAddress(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const separator = value.lastIndexOf("@");
  return value.length > 0
    && TEXT_ENCODER.encode(value).byteLength <= MAX_ADDRESS_LENGTH
    && value.trim() === value
    && separator > 0
    && value.indexOf("@") === separator
    && separator < value.length - 1
    && value.slice(separator + 1).toLowerCase() === value.slice(separator + 1)
    && !/[\s\u0000-\u001f\u007f<>(),;:\"]/.test(value)
    && !value.includes("..");
}

function validSubject(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.trim() === value
    && TEXT_ENCODER.encode(value).byteLength <= MAX_SUBJECT_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validOptionalHeader(value: unknown): boolean {
  return value === undefined
    || (typeof value === "string"
      && value.length > 0
      && TEXT_ENCODER.encode(value).byteLength <= MAX_HEADER_LENGTH
      && !/[\u0000-\u001f\u007f]/.test(value));
}

function validOptionalOpaqueId(value: unknown): boolean {
  return value === undefined || validOpaqueId(value);
}

function parseProviderMessageId(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || TEXT_ENCODER.encode(value).byteLength > MAX_OPAQUE_ID_LENGTH
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/.test(value)
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
  reason: unknown,
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
