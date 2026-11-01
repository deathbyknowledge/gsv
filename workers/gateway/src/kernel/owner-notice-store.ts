import { z } from "zod";
import type { NoticeKind } from "@humansandmachines/gsv/protocol";

/** New contact messages collapse into one notice per contact within this window. */
export const OWNER_NOTICE_COLLAPSE_MS = 10 * 60_000;

/** What a notice is about. The Kernel rechecks it before sending; contact names and text are untrusted. */
export type OwnerNoticeSubject = {
  contactId: string;
  contactGeneration?: string;
  conversationId?: string;
  approachId?: string;
  from: string;
  handle?: string;
  preview?: string;
};

export type OwnerNotice = {
  key: string;
  ownerUid: number;
  topic: NoticeKind;
  subject: OwnerNoticeSubject;
  pendingCount: number;
  round: number;
  /** Row creation time; with the round it names this notice once, even after a row is forgotten. */
  createdAtMs: number;
  attemptCount: number;
  nextAttemptAtMs: number;
};

type OwnerNoticeRow = {
  notice_key: string;
  owner_uid: number;
  topic: NoticeKind;
  subject_json: string;
  pending_count: number;
  round: number;
  created_at: number;
  attempt_count: number;
  next_attempt_at: number;
};

const subjectSchema = z.object({
  contactId: z.string(),
  contactGeneration: z.string().optional(),
  conversationId: z.string().optional(),
  approachId: z.string().optional(),
  from: z.string(),
  handle: z.string().optional(),
  preview: z.string().optional(),
});

/**
 * Durable notices for an owner's messenger. A row is written in the producer's transaction,
 * so a notice is neither lost nor counted twice; one row per key collapses repeats.
 */
export class OwnerNoticeStore {
  private readonly sql: SqlStorage;
  constructor(storage: DurableObjectStorage) { this.sql = storage.sql; }

  /**
   * Count one contact message. A message after a sent notice waits out the collapse window,
   * then goes out as one notice covering every message since.
   */
  noteContactMessage(ownerUid: number, subject: OwnerNoticeSubject, sequence: number, now: number): void {
    const key = `contact.message:${subject.contactId}`;
    const row = this.sql.exec<{ state: string; counted_sequence: number | null; sent_at: number | null }>(
      "SELECT state, counted_sequence, sent_at FROM owner_notices WHERE notice_key = ?", key,
    ).toArray()[0];
    if (!row) {
      this.sql.exec(
        `INSERT INTO owner_notices (notice_key, owner_uid, topic, subject_json, pending_count, counted_sequence,
          state, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, 'contact.message', ?, 1, ?, 'pending', ?, ?, ?)`,
        key, ownerUid, JSON.stringify(subject), sequence, now, now, now,
      );
      return;
    }
    if (row.counted_sequence !== null && sequence <= row.counted_sequence) return;
    if (row.state === "pending") {
      this.sql.exec(
        `UPDATE owner_notices SET subject_json = ?, pending_count = pending_count + 1, counted_sequence = ?, updated_at = ?
         WHERE notice_key = ?`,
        JSON.stringify(subject), sequence, now, key,
      );
      return;
    }
    const due = Math.max(now, (row.sent_at ?? 0) + OWNER_NOTICE_COLLAPSE_MS);
    this.sql.exec(
      `UPDATE owner_notices SET subject_json = ?, pending_count = 1, counted_sequence = ?, state = 'pending',
        round = round + 1, attempt_count = 0, last_error = NULL, next_attempt_at = ?, updated_at = ?
       WHERE notice_key = ?`,
      JSON.stringify(subject), sequence, due, now, key,
    );
  }

  /** Queue a notice that is sent at most once for its key. */
  noteOnce(ownerUid: number, key: string, topic: NoticeKind, subject: OwnerNoticeSubject, now: number): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO owner_notices (notice_key, owner_uid, topic, subject_json, pending_count,
        state, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 'pending', ?, ?, ?)`,
      key, ownerUid, topic, JSON.stringify(subject), now, now, now,
    );
  }

  /** The owner's earliest pending notice. */
  next(ownerUid: number): OwnerNotice | null {
    const row = this.sql.exec<OwnerNoticeRow>(
      `SELECT notice_key, owner_uid, topic, subject_json, pending_count, round, created_at, attempt_count, next_attempt_at
       FROM owner_notices WHERE owner_uid = ? AND state = 'pending'
       ORDER BY next_attempt_at, created_at, notice_key LIMIT 1`,
      ownerUid,
    ).toArray()[0];
    if (!row) return null;
    return {
      key: row.notice_key,
      ownerUid: row.owner_uid,
      topic: row.topic,
      subject: subjectSchema.parse(JSON.parse(row.subject_json)),
      pendingCount: row.pending_count,
      round: row.round,
      createdAtMs: row.created_at,
      attemptCount: row.attempt_count,
      nextAttemptAtMs: row.next_attempt_at,
    };
  }

  /**
   * Record a sent round. Contact messages keep their row through the collapse window;
   * a notice sent once is finished.
   */
  sent(notice: OwnerNotice, now: number): void {
    if (notice.topic !== "contact.message") {
      this.sql.exec("UPDATE owner_notices SET state = 'sent', sent_at = ?, updated_at = ? WHERE notice_key = ? AND round = ?",
        now, now, notice.key, notice.round);
      return;
    }
    // Messages that arrived while this round was sending start the next round after the window.
    this.sql.exec(
      `UPDATE owner_notices SET
        state = CASE WHEN pending_count > ? THEN 'pending' ELSE 'sent' END,
        round = CASE WHEN pending_count > ? THEN round + 1 ELSE round END,
        attempt_count = 0, last_error = NULL, next_attempt_at = ?,
        pending_count = pending_count - ?, sent_at = ?, updated_at = ?
       WHERE notice_key = ? AND round = ?`,
      notice.pendingCount, notice.pendingCount, now + OWNER_NOTICE_COLLAPSE_MS,
      notice.pendingCount, now, now, notice.key, notice.round,
    );
  }

  /**
   * Nothing will be sent for this round: its subject was read, decided or ended, or the
   * owner had no messenger. A later contact message starts a fresh notice right away.
   */
  dismissed(notice: OwnerNotice, now: number): void {
    if (notice.topic !== "contact.message") {
      this.sql.exec("UPDATE owner_notices SET state = 'sent', updated_at = ? WHERE notice_key = ? AND round = ?",
        now, notice.key, notice.round);
      return;
    }
    this.sql.exec("DELETE FROM owner_notices WHERE notice_key = ? AND round = ?", notice.key, notice.round);
  }

  failed(notice: OwnerNotice, error: string, nextAttemptAtMs: number, now: number): void {
    this.sql.exec(
      `UPDATE owner_notices SET attempt_count = attempt_count + 1, last_error = ?, next_attempt_at = ?, updated_at = ?
       WHERE notice_key = ? AND round = ?`,
      error.slice(0, 1_000), nextAttemptAtMs, now, notice.key, notice.round,
    );
  }

  /** Forget contact rows whose collapse window has passed. Keys sent once stay as their receipt. */
  prune(now: number): void {
    this.sql.exec(
      "DELETE FROM owner_notices WHERE topic = 'contact.message' AND state = 'sent' AND sent_at < ?",
      now - OWNER_NOTICE_COLLAPSE_MS,
    );
  }

  ownersWithPending(): number[] {
    return this.sql.exec<{ owner_uid: number }>("SELECT DISTINCT owner_uid FROM owner_notices WHERE state = 'pending'")
      .toArray().map(({ owner_uid }) => owner_uid);
  }
}
