import { DurableObject } from "cloudflare:workers";
import {
  bodyToBytes,
  isAdapterInstallationContext,
  type AdapterInstallationContext,
  type BinaryBody,
  type ListManagedMailIntakesInput,
  type ManagedInboundMailMetadata,
  type ManagedMailIntakeDiagnostic,
  type ManagedMailIntakePage,
  type ManagedOutboundMailReference,
  type ManagedMailSummary,
} from "@humansandmachines/gsv/protocol";
import { mailLimits, type MailEnv, type MailLimits } from "./env";
import { parseMail } from "./mime";
import { OutboundDeliveryCoordinator } from "./outbound";
import { runMailSqlMigrations } from "./schema/migrations";

const ALARM_BATCH_SIZE = 20;
const SUMMARY_RESERVATION_MS = 5 * 60 * 1000;
const INITIAL_RETRY_MS = 5_000;
const MAX_RETRY_MS = 60 * 60 * 1000;
const MAX_ENVELOPE_ADDRESS_LENGTH = 512;
const MAX_MESSAGE_ID_LENGTH = 512;
const MAX_LIST_LIMIT = 100;
const RAW_CHUNK_BYTES = 1024 * 1024;
const UPLOAD_EXPIRY_MS = 24 * 60 * 60 * 1000;
const TEXT_ENCODER = new TextEncoder();

export type MailEnvelope = {
  from: string;
  to: string;
  rawSize: number;
};

export type MailIntakeResult =
  | { status: "accepted"; intakeId: string }
  | { status: "duplicate"; intakeId: string }
  | { status: "rejected"; reason: "invalid" | "quota" };

export type MailUsageSnapshot = {
  installationId: string;
  day: string;
  inboundMessages: number;
  inboundBytes: number;
  summarizationAttempts: number;
  outboundMessages: number;
  outboundBytes: number;
};

type IntakeRow = {
  intake_id: string;
  digest: string;
  received_at: number;
  raw_size: number;
  storage_state: "pending" | "stored";
  summary_state: "pending" | "running" | "notifying" | "deferred" | "complete";
  metadata_json: string | null;
  summary_input_json: string | null;
  summary_json: string | null;
  message_id: string | null;
  storage_attempts: number;
  summary_attempts: number;
  summary_generation: number;
  completion_attempts: number;
  stored_at: number | null;
  completed_at: number | null;
};

type SummaryInput = {
  from: string;
  subject: string;
  text: string;
};

type UploadRow = {
  intake_id: string;
  digest: string;
  received_at: number;
  raw_size: number;
  metadata_json: string;
  summary_input_json: string;
  usage_day: string;
  expires_at: number;
};

type UsageRow = {
  inbound_messages: number;
  inbound_bytes: number;
  summarization_attempts: number;
  outbound_messages: number;
  outbound_bytes: number;
};

export class MailInstallation extends DurableObject<MailEnv> {
  private readonly installationId: string;
  private readonly limits: MailLimits;
  private readonly activeIntakes = new Map<string, Promise<MailIntakeResult>>();
  private readonly outbound: OutboundDeliveryCoordinator;

  constructor(ctx: DurableObjectState, env: MailEnv) {
    super(ctx, env);
    const name = ctx.id.name;
    if (!isAdapterInstallationContext({ installationId: name })) {
      throw new Error("MailInstallation must be addressed by installation ID");
    }
    this.installationId = name as string;
    this.limits = mailLimits(env);
    runMailSqlMigrations(ctx.storage);
    this.ensureIdentity();
    this.outbound = new OutboundDeliveryCoordinator(
      ctx,
      env,
      this.installationId,
      this.limits,
    );
  }

  async intake(
    installation: AdapterInstallationContext,
    envelopeValue: MailEnvelope,
    body: BinaryBody,
  ): Promise<MailIntakeResult> {
    try {
      this.requireOwnedInstallation(installation);
      const envelope = parseEnvelope(envelopeValue, this.limits.maxMessageBytes);
      if (body.length !== envelope.rawSize) {
        await cancelBody(body, "Mail body length does not match its envelope");
        return { status: "rejected", reason: "invalid" };
      }
      const raw = await bodyToBytes(body, this.limits.maxMessageBytes);
      const digest = await messageDigest(raw);
      const active = this.activeIntakes.get(digest);
      if (active) {
        const result = await active;
        return result.status === "accepted"
          ? { status: "duplicate", intakeId: result.intakeId }
          : result;
      }
      const operation = this.persistIntake(envelope, raw, digest);
      this.activeIntakes.set(digest, operation);
      try {
        return await operation;
      } finally {
        if (this.activeIntakes.get(digest) === operation) {
          this.activeIntakes.delete(digest);
        }
      }
    } catch (error) {
      await cancelBody(body, error);
      throw error;
    }
  }

  async getIntake(
    installation: AdapterInstallationContext,
    intakeIdValue: string,
  ): Promise<ManagedMailIntakeDiagnostic | null> {
    this.requireOwnedInstallation(installation);
    const intakeId = parseOpaqueId(intakeIdValue, "intakeId");
    const row = this.ctx.storage.sql.exec<IntakeRow>(
      `${INTAKE_DIAGNOSTIC_SELECT}
       WHERE intake_id = ?
       LIMIT 1`,
      intakeId,
    ).toArray()[0];
    return row ? intakeDiagnostic(row) : null;
  }

  async listIntakes(
    installation: AdapterInstallationContext,
    inputValue: ListManagedMailIntakesInput = {},
  ): Promise<ManagedMailIntakePage> {
    this.requireOwnedInstallation(installation);
    const input = parseListInput(inputValue);
    const cursor = input.cursor
      ? this.cursorPosition(parseOpaqueId(input.cursor, "cursor"))
      : null;
    const rows = cursor
      ? this.ctx.storage.sql.exec<IntakeRow>(
        `${INTAKE_DIAGNOSTIC_SELECT}
         WHERE received_at < ? OR (received_at = ? AND intake_id < ?)
         ORDER BY received_at DESC, intake_id DESC
         LIMIT ?`,
        cursor.received_at,
        cursor.received_at,
        cursor.intake_id,
        input.limit + 1,
      ).toArray()
      : this.ctx.storage.sql.exec<IntakeRow>(
        `${INTAKE_DIAGNOSTIC_SELECT}
         ORDER BY received_at DESC, intake_id DESC
         LIMIT ?`,
        input.limit + 1,
      ).toArray();
    const hasMore = rows.length > input.limit;
    const pageRows = rows.slice(0, input.limit);
    return {
      items: pageRows.map(intakeDiagnostic),
      ...(hasMore && pageRows.length > 0
        ? { cursor: pageRows[pageRows.length - 1].intake_id }
        : {}),
    };
  }

  async usage(dayValue?: string): Promise<MailUsageSnapshot> {
    const day = dayValue ?? utcDay(Date.now());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      throw new Error("Mail usage day is invalid");
    }
    const row = this.ctx.storage.sql.exec<UsageRow>(
      `SELECT inbound_messages, inbound_bytes, summarization_attempts,
              outbound_messages, outbound_bytes
       FROM mail_daily_usage
       WHERE day = ?`,
      day,
    ).toArray()[0];
    return {
      installationId: this.installationId,
      day,
      inboundMessages: row?.inbound_messages ?? 0,
      inboundBytes: row?.inbound_bytes ?? 0,
      summarizationAttempts: row?.summarization_attempts ?? 0,
      outboundMessages: row?.outbound_messages ?? 0,
      outboundBytes: row?.outbound_bytes ?? 0,
    };
  }

  async deliverOutbound(
    installation: AdapterInstallationContext,
    referenceValue: ManagedOutboundMailReference,
  ): Promise<void> {
    this.requireOwnedInstallation(installation);
    await this.outbound.deliver(referenceValue);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    try {
      this.cleanupExpiredUploads(now);
      this.recoverExpiredSummaryReservations(now);
      this.outbound.recoverExpiredAttempts(now);
      for (let processed = 0; processed < ALARM_BATCH_SIZE; processed += 1) {
        if (await this.outbound.processNextCallback(Date.now())) continue;
        if (await this.outbound.processNextClaim(Date.now())) continue;
        const storage = this.nextStorageIntake(Date.now());
        if (storage) {
          await this.deliverStorage(storage);
          continue;
        }
        const summary = this.nextSummaryIntake(Date.now());
        if (summary) {
          await this.processSummary(summary);
          continue;
        }
        break;
      }
    } finally {
      await this.scheduleNextAlarm();
    }
  }

  private async persistIntake(
    envelope: MailEnvelope,
    raw: Uint8Array,
    digest: string,
  ): Promise<MailIntakeResult> {
    const existing = this.intakeByDigest(digest);
    if (existing) {
      await this.scheduleNextAlarm();
      return { status: "duplicate", intakeId: existing.intake_id };
    }

    let upload = this.uploadByDigest(digest);
    if (upload) {
      if (upload.raw_size !== raw.byteLength) {
        throw new Error("Staged mail intake conflicts with its digest");
      }
      this.touchUpload(upload.intake_id, Date.now());
      upload = this.uploadByDigest(digest);
      if (!upload) throw new Error("Staged mail intake disappeared");
    } else {
      const intakeId = `mail_${digest.slice("sha256:".length)}`;
      const receivedAt = Date.now();
      let parsed;
      try {
        parsed = await parseMail(raw, {
          intakeId,
          digest,
          receivedAt,
          envelopeFrom: envelope.from,
          envelopeTo: envelope.to,
        });
      } catch {
        return { status: "rejected", reason: "invalid" };
      }
      const reserved = this.reserveUpload({
        intakeId,
        digest,
        receivedAt,
        rawSize: raw.byteLength,
        metadataJson: JSON.stringify(parsed.metadata),
        summaryInputJson: JSON.stringify(parsed.summaryInput),
      });
      if (reserved.status !== "ready") return reserved.result;
      upload = reserved.upload;
    }

    await this.scheduleNextAlarm();
    this.storeRawMessage(upload.intake_id, raw);
    const result = this.finalizeUpload(upload.intake_id, digest);
    await this.scheduleNextAlarm();
    return result;
  }

  private ensureIdentity(): void {
    this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql.exec<{ installation_id: string }>(
        `SELECT installation_id
         FROM mail_installation_identity
         WHERE singleton = 1`,
      ).toArray()[0];
      if (existing && existing.installation_id !== this.installationId) {
        throw new Error("Mail installation identity changed");
      }
      if (!existing) {
        this.ctx.storage.sql.exec(
          `INSERT INTO mail_installation_identity
             (singleton, installation_id, created_at)
           VALUES (1, ?, ?)`,
          this.installationId,
          Date.now(),
        );
      }
    });
  }

  private requireOwnedInstallation(
    installation: AdapterInstallationContext,
  ): void {
    if (
      !isAdapterInstallationContext(installation)
      || installation.installationId !== this.installationId
    ) {
      throw new Error("Mail request belongs to another installation");
    }
  }

  private intakeByDigest(digest: string): Pick<IntakeRow, "intake_id"> | null {
    return this.ctx.storage.sql.exec<Pick<IntakeRow, "intake_id">>(
      `SELECT intake_id
       FROM mail_intakes
       WHERE digest = ?
       LIMIT 1`,
      digest,
    ).toArray()[0] ?? null;
  }

  private uploadByDigest(digest: string): UploadRow | null {
    return this.ctx.storage.sql.exec<UploadRow>(
      `SELECT intake_id, digest, received_at, raw_size, metadata_json,
              summary_input_json, usage_day, expires_at
       FROM mail_intake_uploads
       WHERE digest = ?
       LIMIT 1`,
      digest,
    ).toArray()[0] ?? null;
  }

  private touchUpload(intakeId: string, now: number): void {
    this.ctx.storage.sql.exec(
      `UPDATE mail_intake_uploads
       SET expires_at = ?, updated_at = ?
       WHERE intake_id = ?`,
      now + UPLOAD_EXPIRY_MS,
      now,
      intakeId,
    );
  }

  private reserveUpload(input: {
    intakeId: string;
    digest: string;
    receivedAt: number;
    rawSize: number;
    metadataJson: string;
    summaryInputJson: string;
  }):
    | { status: "ready"; upload: UploadRow }
    | { status: "rejected"; result: MailIntakeResult } {
    return this.ctx.storage.transactionSync(() => {
      const replay = this.intakeByDigest(input.digest);
      if (replay) {
        return {
          status: "rejected" as const,
          result: { status: "duplicate" as const, intakeId: replay.intake_id },
        };
      }
      const staged = this.uploadByDigest(input.digest);
      if (staged) return { status: "ready" as const, upload: staged };

      const day = utcDay(input.receivedAt);
      this.ensureUsageDay(day);
      const usage = this.usageRow(day);
      if (
        usage.inbound_messages + 1 > this.limits.dailyInboundMessages
        || usage.inbound_bytes + input.rawSize > this.limits.dailyInboundBytes
      ) {
        return {
          status: "rejected" as const,
          result: { status: "rejected" as const, reason: "quota" as const },
        };
      }

      const expiresAt = input.receivedAt + UPLOAD_EXPIRY_MS;
      this.ctx.storage.sql.exec(
        `INSERT INTO mail_intake_uploads (
           intake_id, digest, received_at, raw_size, metadata_json,
           summary_input_json, usage_day, expires_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.intakeId,
        input.digest,
        input.receivedAt,
        input.rawSize,
        input.metadataJson,
        input.summaryInputJson,
        day,
        expiresAt,
        input.receivedAt,
      );
      this.ctx.storage.sql.exec(
        `UPDATE mail_daily_usage
         SET inbound_messages = inbound_messages + 1,
             inbound_bytes = inbound_bytes + ?
         WHERE day = ?`,
        input.rawSize,
        day,
      );
      return {
        status: "ready" as const,
        upload: {
          intake_id: input.intakeId,
          digest: input.digest,
          received_at: input.receivedAt,
          raw_size: input.rawSize,
          metadata_json: input.metadataJson,
          summary_input_json: input.summaryInputJson,
          usage_day: day,
          expires_at: expiresAt,
        },
      };
    });
  }

  private finalizeUpload(intakeId: string, digest: string): MailIntakeResult {
    return this.ctx.storage.transactionSync(() => {
      const replay = this.intakeByDigest(digest);
      if (replay) return { status: "duplicate", intakeId: replay.intake_id };
      const upload = this.uploadByDigest(digest);
      if (!upload || upload.intake_id !== intakeId) {
        throw new Error("Staged mail intake disappeared");
      }
      const layout = this.rawMessageLayout(intakeId);
      const expectedChunks = Math.ceil(upload.raw_size / RAW_CHUNK_BYTES);
      if (
        layout.chunk_count !== expectedChunks
        || layout.first_chunk !== 0
        || layout.last_chunk !== expectedChunks - 1
        || layout.stored_bytes !== upload.raw_size
      ) {
        throw new Error("Staged mail intake has incomplete durable body chunks");
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO mail_intakes (
           intake_id, digest, received_at, raw_size, storage_state,
           summary_state, metadata_json, summary_input_json,
           storage_next_attempt_at, updated_at
         ) VALUES (?, ?, ?, ?, 'pending', 'pending', ?, ?, ?, ?)`,
        upload.intake_id,
        upload.digest,
        upload.received_at,
        upload.raw_size,
        upload.metadata_json,
        upload.summary_input_json,
        upload.received_at,
        upload.received_at,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM mail_intake_uploads WHERE intake_id = ?",
        upload.intake_id,
      );
      return { status: "accepted", intakeId: upload.intake_id };
    });
  }

  private cursorPosition(intakeId: string): {
    intake_id: string;
    received_at: number;
  } {
    const row = this.ctx.storage.sql.exec<{
      intake_id: string;
      received_at: number;
    }>(
      `SELECT intake_id, received_at
       FROM mail_intakes
       WHERE intake_id = ?
       LIMIT 1`,
      intakeId,
    ).toArray()[0];
    if (!row) throw new Error("Mail intake cursor is invalid");
    return row;
  }

  private ensureUsageDay(day: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO mail_daily_usage (day)
       VALUES (?)
       ON CONFLICT(day) DO NOTHING`,
      day,
    );
  }

  private usageRow(day: string): UsageRow {
    return this.ctx.storage.sql.exec<UsageRow>(
      `SELECT inbound_messages, inbound_bytes, summarization_attempts,
              outbound_messages, outbound_bytes
       FROM mail_daily_usage
       WHERE day = ?`,
      day,
    ).one();
  }

  private nextStorageIntake(now: number): IntakeRow | null {
    return this.ctx.storage.sql.exec<IntakeRow>(
      `${INTAKE_INTERNAL_SELECT}
       WHERE storage_state = 'pending'
         AND storage_next_attempt_at <= ?
       ORDER BY storage_next_attempt_at, received_at
       LIMIT 1`,
      now,
    ).toArray()[0] ?? null;
  }

  private async deliverStorage(row: IntakeRow): Promise<void> {
    let body: BinaryBody | undefined;
    const now = Date.now();
    try {
      if (!row.metadata_json) {
        throw new Error("Pending mail intake is missing its durable body");
      }
      const metadata = JSON.parse(row.metadata_json) as ManagedInboundMailMetadata;
      body = this.rawMessageBody(row);
      const result = await this.env.GATEWAY.acceptManagedInboundMail(
        { installationId: this.installationId },
        metadata,
        body,
      );
      const messageId = parseBoundedId(
        result?.messageId,
        "messageId",
        MAX_MESSAGE_ID_LENGTH,
      );
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          `UPDATE mail_intakes
           SET storage_state = 'stored', metadata_json = NULL,
               message_id = ?, storage_attempts = storage_attempts + 1,
               storage_next_attempt_at = NULL, summary_next_attempt_at = ?,
               stored_at = ?, updated_at = ?
           WHERE intake_id = ? AND storage_state = 'pending'`,
          messageId,
          now,
          now,
          now,
          row.intake_id,
        );
        this.ctx.storage.sql.exec(
          "DELETE FROM mail_intake_chunks WHERE intake_id = ?",
          row.intake_id,
        );
      });
    } catch (error) {
      const attempts = row.storage_attempts + 1;
      this.ctx.storage.sql.exec(
        `UPDATE mail_intakes
         SET storage_attempts = ?, storage_next_attempt_at = ?, updated_at = ?
         WHERE intake_id = ? AND storage_state = 'pending'`,
        attempts,
        now + retryDelay(attempts),
        now,
        row.intake_id,
      );
      logRetry("storage", error);
    } finally {
      if (body) {
        await cancelBody(body, "Managed mail storage RPC finished");
      }
    }
  }

  private nextSummaryIntake(now: number): IntakeRow | null {
    return this.ctx.storage.sql.exec<IntakeRow>(
      `${INTAKE_INTERNAL_SELECT}
       WHERE storage_state = 'stored'
         AND summary_state IN ('pending', 'notifying', 'deferred')
         AND summary_next_attempt_at <= ?
       ORDER BY
         CASE summary_state WHEN 'notifying' THEN 0 ELSE 1 END,
         summary_next_attempt_at,
         received_at
       LIMIT 1`,
      now,
    ).toArray()[0] ?? null;
  }

  private storeRawMessage(intakeId: string, raw: Uint8Array): void {
    for (let offset = 0, index = 0; offset < raw.byteLength; index += 1) {
      const end = Math.min(offset + RAW_CHUNK_BYTES, raw.byteLength);
      this.ctx.storage.sql.exec(
        `INSERT INTO mail_intake_chunks (intake_id, chunk_index, content)
         VALUES (?, ?, ?)
         ON CONFLICT(intake_id, chunk_index)
         DO UPDATE SET content = excluded.content`,
        intakeId,
        index,
        exactArrayBuffer(raw.subarray(offset, end)),
      );
      offset = end;
    }
    this.ctx.storage.sql.exec(
      `DELETE FROM mail_intake_chunks
       WHERE intake_id = ? AND chunk_index >= ?`,
      intakeId,
      Math.ceil(raw.byteLength / RAW_CHUNK_BYTES),
    );
  }

  private rawMessageLayout(intakeId: string): {
    chunk_count: number;
    first_chunk: number | null;
    last_chunk: number | null;
    stored_bytes: number | null;
  } {
    return this.ctx.storage.sql.exec<{
      chunk_count: number;
      first_chunk: number | null;
      last_chunk: number | null;
      stored_bytes: number | null;
    }>(
      `SELECT COUNT(*) AS chunk_count,
              MIN(chunk_index) AS first_chunk,
              MAX(chunk_index) AS last_chunk,
              SUM(length(content)) AS stored_bytes
       FROM mail_intake_chunks
       WHERE intake_id = ?`,
      intakeId,
    ).one();
  }

  private rawMessageBody(row: IntakeRow): BinaryBody {
    const layout = this.rawMessageLayout(row.intake_id);
    const expectedChunks = Math.ceil(row.raw_size / RAW_CHUNK_BYTES);
    if (
      layout.chunk_count !== expectedChunks
      || layout.first_chunk !== 0
      || layout.last_chunk !== expectedChunks - 1
      || layout.stored_bytes !== row.raw_size
    ) {
      throw new Error("Pending mail intake has invalid durable body chunks");
    }

    let index = 0;
    let remaining = row.raw_size;
    const stream = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        if (remaining === 0) {
          controller.close();
          return;
        }
        const chunk = this.ctx.storage.sql.exec<{ content: ArrayBuffer }>(
          `SELECT content
           FROM mail_intake_chunks
           WHERE intake_id = ? AND chunk_index = ?`,
          row.intake_id,
          index,
        ).toArray()[0];
        const expectedBytes = Math.min(RAW_CHUNK_BYTES, remaining);
        if (!chunk || chunk.content.byteLength !== expectedBytes) {
          controller.error(
            new Error("Pending mail intake has invalid durable body chunks"),
          );
          return;
        }
        controller.enqueue(new Uint8Array(chunk.content));
        index += 1;
        remaining -= expectedBytes;
      },
      cancel: () => {
        remaining = 0;
      },
    });
    return { stream, length: row.raw_size };
  }

  private async processSummary(row: IntakeRow): Promise<void> {
    if (row.summary_state === "notifying") {
      await this.notifySummary(row);
      return;
    }
    const now = Date.now();
    const reserved = this.reserveSummary(row.intake_id, now);
    if (!reserved) return;

    let input: SummaryInput;
    try {
      input = parseSummaryInput(row.summary_input_json);
    } catch (error) {
      this.deferSummaryFailure(
        row.intake_id,
        row.summary_attempts + 1,
        error,
        false,
      );
      return;
    }
    const request = {
      version: 1 as const,
      installationId: this.installationId,
      logicalRequestId: `summary:${row.intake_id}:attempt:${row.summary_generation}`,
      actor: { localUid: 0 },
      from: input.from,
      subject: input.subject,
      text: input.text,
    };
    let summary: ManagedMailSummary;
    try {
      summary = validateSummary(await this.env.INFERENCE.summarizeMail(request));
    } catch (error) {
      try {
        const status = await this.env.INFERENCE.getMailSummaryStatus(request);
        if (status.state === "completed") {
          summary = validateSummary(status.summary);
        } else {
          this.deferSummaryFailure(
            row.intake_id,
            row.summary_attempts + 1,
            error,
            ["failed", "aborted", "abandoned"].includes(status.state),
          );
          return;
        }
      } catch (statusError) {
        this.deferSummaryFailure(
          row.intake_id,
          row.summary_attempts + 1,
          statusError,
          false,
        );
        return;
      }
    }
    const completedAt = Date.now();
    this.ctx.storage.sql.exec(
      `UPDATE mail_intakes
       SET summary_state = 'notifying', summary_json = ?,
           summary_next_attempt_at = ?, summary_reservation_expires_at = NULL,
           updated_at = ?
       WHERE intake_id = ? AND summary_state = 'running'`,
      JSON.stringify(summary),
      completedAt,
      completedAt,
      row.intake_id,
    );
    const notifying = this.intakeById(row.intake_id);
    if (notifying) await this.notifySummary(notifying);
  }

  private reserveSummary(intakeId: string, now: number): boolean {
    return this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql.exec<{
        summary_state: IntakeRow["summary_state"];
      }>(
        `SELECT summary_state
         FROM mail_intakes
         WHERE intake_id = ?`,
        intakeId,
      ).toArray()[0];
      if (!row || !["pending", "deferred"].includes(row.summary_state)) {
        return false;
      }
      const day = utcDay(now);
      this.ensureUsageDay(day);
      const usage = this.usageRow(day);
      if (usage.summarization_attempts >= this.limits.dailySummarizations) {
        this.ctx.storage.sql.exec(
          `UPDATE mail_intakes
           SET summary_state = 'deferred', summary_next_attempt_at = ?,
               summary_reservation_expires_at = NULL, updated_at = ?
           WHERE intake_id = ?`,
          nextUtcDay(now),
          now,
          intakeId,
        );
        return false;
      }
      this.ctx.storage.sql.exec(
        `UPDATE mail_daily_usage
         SET summarization_attempts = summarization_attempts + 1
         WHERE day = ?`,
        day,
      );
      this.ctx.storage.sql.exec(
        `UPDATE mail_intakes
         SET summary_state = 'running', summary_attempts = summary_attempts + 1,
             summary_next_attempt_at = ?, summary_reservation_expires_at = ?,
             updated_at = ?
         WHERE intake_id = ?`,
        now + SUMMARY_RESERVATION_MS,
        now + SUMMARY_RESERVATION_MS,
        now,
        intakeId,
      );
      return true;
    });
  }

  private deferSummaryFailure(
    intakeId: string,
    attempts: number,
    error: unknown,
    advanceGeneration: boolean,
  ): void {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `UPDATE mail_intakes
       SET summary_state = 'pending', summary_next_attempt_at = ?,
           summary_reservation_expires_at = NULL,
           summary_generation = summary_generation + ?, updated_at = ?
       WHERE intake_id = ? AND summary_state = 'running'`,
      now + retryDelay(attempts),
      advanceGeneration ? 1 : 0,
      now,
      intakeId,
    );
    logRetry("summary", error);
  }

  private async notifySummary(row: IntakeRow): Promise<void> {
    const now = Date.now();
    try {
      if (!row.message_id || !row.summary_json) {
        throw new Error("Completed mail summary is missing durable state");
      }
      const summary = validateSummary(JSON.parse(row.summary_json));
      await this.env.GATEWAY.completeManagedInboundMail(
        { installationId: this.installationId },
        {
          version: 1,
          intakeId: row.intake_id,
          messageId: row.message_id,
          summary,
        },
      );
      this.ctx.storage.sql.exec(
        `UPDATE mail_intakes
         SET summary_state = 'complete', summary_input_json = NULL,
             summary_json = NULL, summary_next_attempt_at = NULL,
             completion_attempts = completion_attempts + 1,
             completed_at = ?, updated_at = ?
         WHERE intake_id = ? AND summary_state = 'notifying'`,
        now,
        now,
        row.intake_id,
      );
    } catch (error) {
      const attempts = row.completion_attempts + 1;
      this.ctx.storage.sql.exec(
        `UPDATE mail_intakes
         SET completion_attempts = ?, summary_next_attempt_at = ?, updated_at = ?
         WHERE intake_id = ? AND summary_state = 'notifying'`,
        attempts,
        now + retryDelay(attempts),
        now,
        row.intake_id,
      );
      logRetry("completion", error);
    }
  }

  private recoverExpiredSummaryReservations(now: number): void {
    this.ctx.storage.sql.exec(
      `UPDATE mail_intakes
       SET summary_state = 'pending', summary_next_attempt_at = ?,
           summary_reservation_expires_at = NULL, updated_at = ?
       WHERE summary_state = 'running'
         AND summary_reservation_expires_at <= ?`,
      now,
      now,
      now,
    );
  }

  private cleanupExpiredUploads(now: number): void {
    const uploads = this.ctx.storage.sql.exec<{
      intake_id: string;
      raw_size: number;
      usage_day: string;
    }>(
      `SELECT intake_id, raw_size, usage_day
       FROM mail_intake_uploads
       WHERE expires_at <= ?
       ORDER BY expires_at
       LIMIT ?`,
      now,
      ALARM_BATCH_SIZE,
    ).toArray();
    for (const upload of uploads) {
      const chunks = this.ctx.storage.sql.exec<{ chunk_index: number }>(
        `SELECT chunk_index
         FROM mail_intake_chunks
         WHERE intake_id = ?
         ORDER BY chunk_index`,
        upload.intake_id,
      ).toArray();
      for (const chunk of chunks) {
        this.ctx.storage.sql.exec(
          `DELETE FROM mail_intake_chunks
           WHERE intake_id = ? AND chunk_index = ?`,
          upload.intake_id,
          chunk.chunk_index,
        );
      }
      this.ctx.storage.transactionSync(() => {
        const expired = this.ctx.storage.sql.exec<{ expires_at: number }>(
          `SELECT expires_at
           FROM mail_intake_uploads
           WHERE intake_id = ?`,
          upload.intake_id,
        ).toArray()[0];
        if (!expired || expired.expires_at > now) return;
        this.ctx.storage.sql.exec(
          "DELETE FROM mail_intake_uploads WHERE intake_id = ?",
          upload.intake_id,
        );
        this.ctx.storage.sql.exec(
          `UPDATE mail_daily_usage
           SET inbound_messages = MAX(0, inbound_messages - 1),
               inbound_bytes = MAX(0, inbound_bytes - ?)
           WHERE day = ?`,
          upload.raw_size,
          upload.usage_day,
        );
      });
    }
  }

  private intakeById(intakeId: string): IntakeRow | null {
    return this.ctx.storage.sql.exec<IntakeRow>(
      `${INTAKE_INTERNAL_SELECT}
       WHERE intake_id = ?
       LIMIT 1`,
      intakeId,
    ).toArray()[0] ?? null;
  }

  private async scheduleNextAlarm(): Promise<void> {
    const inboundNext = this.ctx.storage.sql.exec<{
      next_attempt_at: number | null;
    }>(
      `SELECT MIN(next_attempt_at) AS next_attempt_at
       FROM (
         SELECT storage_next_attempt_at AS next_attempt_at
         FROM mail_intakes
         WHERE storage_state = 'pending'
         UNION ALL
         SELECT summary_next_attempt_at AS next_attempt_at
         FROM mail_intakes
         WHERE storage_state = 'stored'
           AND summary_state IN ('pending', 'running', 'notifying', 'deferred')
         UNION ALL
         SELECT expires_at AS next_attempt_at
         FROM mail_intake_uploads
       )
       WHERE next_attempt_at IS NOT NULL`,
    ).one().next_attempt_at;
    const outboundNext = this.outbound.nextAlarmAt();
    const next = inboundNext === null
      ? outboundNext
      : outboundNext === null
        ? inboundNext
        : Math.min(inboundNext, outboundNext);
    if (next === null) return;
    await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 100));
  }
}

const INTAKE_DIAGNOSTIC_SELECT = `
  SELECT intake_id, digest, received_at, raw_size, storage_state, summary_state,
         message_id, storage_attempts, summary_attempts, summary_generation,
         completion_attempts,
         stored_at, completed_at,
         NULL AS metadata_json, NULL AS summary_input_json,
         NULL AS summary_json
  FROM mail_intakes
`;

const INTAKE_INTERNAL_SELECT = `
  SELECT intake_id, digest, received_at, raw_size, storage_state, summary_state,
         metadata_json, summary_input_json, summary_json,
         message_id, storage_attempts, summary_attempts, summary_generation,
         completion_attempts,
         stored_at, completed_at
  FROM mail_intakes
`;

function intakeDiagnostic(row: IntakeRow): ManagedMailIntakeDiagnostic {
  return {
    intakeId: row.intake_id,
    digest: row.digest,
    receivedAt: row.received_at,
    rawSize: row.raw_size,
    storageState: row.storage_state,
    summaryState: row.summary_state,
    storageAttempts: row.storage_attempts,
    summaryAttempts: row.summary_attempts,
    completionAttempts: row.completion_attempts,
    ...(row.message_id ? { messageId: row.message_id } : {}),
    ...(row.stored_at === null ? {} : { storedAt: row.stored_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  };
}

function parseEnvelope(value: MailEnvelope, maxMessageBytes: number): MailEnvelope {
  const from = parseEnvelopeAddress(value?.from, "from");
  const to = parseEnvelopeAddress(value?.to, "to");
  const rawSize = value?.rawSize;
  if (
    !Number.isSafeInteger(rawSize)
    || rawSize <= 0
    || rawSize > maxMessageBytes
  ) {
    throw new Error("Mail rawSize is invalid");
  }
  return { from, to, rawSize };
}

function parseEnvelopeAddress(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || !value.trim()
    || value.length > MAX_ENVELOPE_ADDRESS_LENGTH
    || /[\r\n\0]/.test(value)
  ) {
    throw new Error(`Mail envelope ${field} is invalid`);
  }
  return value.trim();
}

function parseListInput(value: ListManagedMailIntakesInput): {
  cursor?: string;
  limit: number;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Mail intake list input is invalid");
  }
  const limit = value.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_LIST_LIMIT) {
    throw new Error("Mail intake list limit is invalid");
  }
  if (value.cursor !== undefined && typeof value.cursor !== "string") {
    throw new Error("Mail intake list cursor is invalid");
  }
  return { limit, ...(value.cursor ? { cursor: value.cursor } : {}) };
}

function parseSummaryInput(value: string | null): SummaryInput {
  if (!value) throw new Error("Mail summary input is unavailable");
  const parsed = JSON.parse(value) as Partial<SummaryInput>;
  if (
    typeof parsed.from !== "string"
    || typeof parsed.subject !== "string"
    || typeof parsed.text !== "string"
  ) {
    throw new Error("Mail summary input is invalid");
  }
  return {
    from: parsed.from,
    subject: parsed.subject,
    text: parsed.text,
  };
}

function validateSummary(value: unknown): ManagedMailSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Managed mail summary is invalid");
  }
  const candidate = value as Partial<ManagedMailSummary>;
  if (
    typeof candidate.summary !== "string"
    || candidate.summary.trim() !== candidate.summary
    || candidate.summary.length === 0
    || TEXT_ENCODER.encode(candidate.summary).byteLength > 280
    || /[\r\n\0]/.test(candidate.summary)
    || ![
      "personal",
      "work",
      "transactional",
      "newsletter",
      "spam",
      "suspicious",
      "other",
    ].includes(candidate.category ?? "")
    || typeof candidate.requiresAttention !== "boolean"
    || typeof candidate.confidence !== "number"
    || !Number.isFinite(candidate.confidence)
    || candidate.confidence < 0
    || candidate.confidence > 1
  ) {
    throw new Error("Managed mail summary is invalid");
  }
  return candidate as ManagedMailSummary;
}

function parseOpaqueId(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || !/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/.test(value)
  ) {
    throw new Error(`Mail ${field} is invalid`);
  }
  return value;
}

function parseBoundedId(value: unknown, field: string, maxLength: number): string {
  if (
    typeof value !== "string"
    || !value.trim()
    || value.length > maxLength
    || /[\r\n\0]/.test(value)
  ) {
    throw new Error(`Managed mail ${field} is invalid`);
  }
  return value;
}

async function messageDigest(raw: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  return `sha256:${[...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.buffer instanceof ArrayBuffer
    && bytes.byteOffset === 0
    && bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes.buffer;
  }
  return bytes.slice().buffer;
}

async function cancelBody(body: BinaryBody, reason: unknown): Promise<void> {
  if (!body.stream.locked) {
    await body.stream.cancel(reason).catch(() => {});
  }
}

function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function nextUtcDay(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 1,
  ) + 1_000;
}

function retryDelay(attempt: number): number {
  return Math.min(
    MAX_RETRY_MS,
    INITIAL_RETRY_MS * (2 ** Math.min(Math.max(attempt - 1, 0), 10)),
  );
}

function logRetry(
  phase: "storage" | "summary" | "completion",
  error: unknown,
): void {
  console.warn(JSON.stringify({
    service: "managed_mail",
    event: "retry_scheduled",
    phase,
    errorType: error instanceof Error ? error.name : typeof error,
  }));
}
