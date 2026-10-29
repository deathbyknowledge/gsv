import type { PhoneCallState } from "@humansandmachines/gsv/protocol";

export type PhoneCallRecord = {
  callId: string;
  ownerUid: number;
  revision: number;
  state: PhoneCallState;
  askedQuestionId: string | null;
  transcriptPath: string | null;
  settledAt: number | null;
};

type PhoneCallRow = {
  call_id: string;
  owner_uid: number;
  revision: number;
  state: PhoneCallState;
  asked_question_id: string | null;
  transcript_path: string | null;
  settled_at: number | null;
};

/** The Kernel's fence over calls service notifications. Call inside the caller's transaction. */
export class PhoneCallStore {
  private readonly sql: SqlStorage;
  constructor(storage: DurableObjectStorage) { this.sql = storage.sql; }

  get(callId: string): PhoneCallRecord | null {
    const row = this.sql.exec<PhoneCallRow>(
      `SELECT call_id, owner_uid, revision, state, asked_question_id, transcript_path, settled_at
       FROM phone_calls WHERE call_id = ?`,
      callId,
    ).toArray()[0];
    if (!row) return null;
    return {
      callId: row.call_id,
      ownerUid: row.owner_uid,
      revision: row.revision,
      state: row.state,
      askedQuestionId: row.asked_question_id,
      transcriptPath: row.transcript_path,
      settledAt: row.settled_at,
    };
  }

  /** Records a revision; an older one never replaces a newer one, and a settled call never changes. */
  observe(ownerUid: number, callId: string, revision: number, state: PhoneCallState, now: number): void {
    this.sql.exec(
      `INSERT INTO phone_calls (call_id, owner_uid, revision, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (call_id) DO UPDATE SET revision = excluded.revision, state = excluded.state, updated_at = excluded.updated_at
       WHERE phone_calls.settled_at IS NULL AND phone_calls.revision <= excluded.revision`,
      callId, ownerUid, revision, state, now, now,
    );
  }

  asked(callId: string, questionId: string, now: number): void {
    this.sql.exec("UPDATE phone_calls SET asked_question_id = ?, updated_at = ? WHERE call_id = ?", questionId, now, callId);
  }

  settle(callId: string, transcriptPath: string | null, now: number): void {
    this.sql.exec(
      "UPDATE phone_calls SET transcript_path = ?, settled_at = ?, updated_at = ? WHERE call_id = ? AND settled_at IS NULL",
      transcriptPath, now, now, callId,
    );
  }
}
