export type SetupRecoveryRecord = {
  username: string;
  uid: number;
  gid: number;
  planFingerprint: string;
  createdAt: number;
};

type SetupRecoveryRow = {
  username: string;
  uid: number;
  gid: number;
  plan_fingerprint: string;
  created_at: number;
};

/**
 * Durable state machine for the one mutating pre-authentication operation.
 *
 * The recovery marker and first-user auth state share the Kernel SQLite
 * transaction. The marker remains until all idempotent provisioning has
 * completed, then is removed in the same transaction that persists an
 * optional node token. Recovery metadata deliberately contains no credential
 * material; retries prove possession of the committed user's password.
 */
export class SetupRecoveryStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  current(): SetupRecoveryRecord | null {
    const row = this.storage.sql.exec<SetupRecoveryRow>(
      `SELECT username, uid, gid, plan_fingerprint, created_at
       FROM setup_recovery
       WHERE scope = 1`,
    ).toArray()[0];
    return row ? mapRecoveryRow(row) : null;
  }

  start(record: SetupRecoveryRecord, commitAuthState: () => void): void {
    this.storage.transactionSync(() => {
      if (this.current()) {
        throw new Error("Setup recovery is already active");
      }
      commitAuthState();
      this.storage.sql.exec(
        `INSERT INTO setup_recovery (
          scope, username, uid, gid, plan_fingerprint, created_at
        ) VALUES (1, ?, ?, ?, ?, ?)`,
        record.username,
        record.uid,
        record.gid,
        record.planFingerprint,
        record.createdAt,
      );
    });
  }

  finish<T>(record: SetupRecoveryRecord, commitFinalState: () => T): T {
    return this.storage.transactionSync(() => {
      const current = this.current();
      if (!current || !sameRecovery(current, record)) {
        throw new Error("Setup recovery state changed before completion");
      }
      const result = commitFinalState();
      this.storage.sql.exec("DELETE FROM setup_recovery WHERE scope = 1");
      return result;
    });
  }
}

function mapRecoveryRow(row: SetupRecoveryRow): SetupRecoveryRecord {
  return {
    username: row.username,
    uid: row.uid,
    gid: row.gid,
    planFingerprint: row.plan_fingerprint,
    createdAt: row.created_at,
  };
}

function sameRecovery(left: SetupRecoveryRecord, right: SetupRecoveryRecord): boolean {
  return left.username === right.username
    && left.uid === right.uid
    && left.gid === right.gid
    && left.planFingerprint === right.planFingerprint
    && left.createdAt === right.createdAt;
}
