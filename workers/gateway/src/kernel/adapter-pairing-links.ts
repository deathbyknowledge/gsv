export const ADAPTER_PAIRING_LINK_TTL_MS = 10 * 60 * 1000;
/** Unused codes an owner may hold per messenger; making another retires the oldest. */
const MAX_PENDING_PER_OWNER = 5;
/** A used code is kept this long so a retried delivery of its message can be answered. */
const RETENTION_MS = 24 * 60 * 60 * 1000;

type LinkRow = {
  owner_uid: number;
  credential_epoch: number;
  expires_at: number;
  cancelled_at: number | null;
  redeemed_at: number | null;
};

export type AdapterPairingLinkRecord = {
  ownerUid: number;
  credentialEpoch: number;
  expiresAt: number;
  cancelled: boolean;
  redeemed: boolean;
};

/**
 * Single-use messenger link codes, kept by hash. A code connects at most one account,
 * and connecting one retires its owner's other unused codes for that messenger.
 */
export class AdapterPairingLinkStore {
  constructor(private readonly sql: SqlStorage) {}

  create(input: { adapter: string; ownerUid: number; credentialEpoch: number; codeHash: string; now: number }) {
    const { adapter, ownerUid, credentialEpoch, codeHash, now } = input;
    this.sql.exec("DELETE FROM adapter_pairing_links WHERE created_at < ?", now - RETENTION_MS);
    const pending = this.sql.exec<{ code_hash: string }>(
      `SELECT code_hash FROM adapter_pairing_links
       WHERE owner_uid = ? AND adapter = ? AND cancelled_at IS NULL AND redeemed_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC`,
      ownerUid, adapter, now,
    ).toArray();
    for (const row of pending.slice(MAX_PENDING_PER_OWNER - 1)) this.cancel(row.code_hash, now);
    const expiresAt = now + ADAPTER_PAIRING_LINK_TTL_MS;
    this.sql.exec(
      `INSERT INTO adapter_pairing_links (code_hash, adapter, owner_uid, credential_epoch, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      codeHash, adapter, ownerUid, credentialEpoch, now, expiresAt,
    );
    return { createdAt: now, expiresAt };
  }

  get(adapter: string, codeHash: string): AdapterPairingLinkRecord | null {
    const row = this.sql.exec<LinkRow>(
      "SELECT owner_uid, credential_epoch, expires_at, cancelled_at, redeemed_at FROM adapter_pairing_links WHERE code_hash = ? AND adapter = ?",
      codeHash, adapter,
    ).toArray()[0];
    if (!row) return null;
    return {
      ownerUid: row.owner_uid,
      credentialEpoch: row.credential_epoch,
      expiresAt: row.expires_at,
      cancelled: row.cancelled_at !== null,
      redeemed: row.redeemed_at !== null,
    };
  }

  cancel(codeHash: string, now: number): void {
    this.sql.exec(
      "UPDATE adapter_pairing_links SET cancelled_at = ? WHERE code_hash = ? AND cancelled_at IS NULL AND redeemed_at IS NULL",
      now, codeHash,
    );
  }

  /**
   * Records that the code connected an account and retires its owner's other unused codes
   * for the messenger. A code retired while it connected (a sibling connected first, or a
   * newer code pushed it out) still connected, so it is recorded as used, not retired.
   */
  redeemed(adapter: string, codeHash: string, now: number): void {
    const record = this.get(adapter, codeHash);
    if (!record || record.redeemed) return;
    this.sql.exec("UPDATE adapter_pairing_links SET redeemed_at = ?, cancelled_at = NULL WHERE code_hash = ?", now, codeHash);
    this.sql.exec(
      `UPDATE adapter_pairing_links SET cancelled_at = ?
       WHERE owner_uid = ? AND adapter = ? AND code_hash != ? AND cancelled_at IS NULL AND redeemed_at IS NULL`,
      now, record.ownerUid, adapter, codeHash,
    );
  }
}
