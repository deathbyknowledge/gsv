import type { DevicePairing, SysPairCreateArgs, SysPairRedeemArgs, SysPairRedeemResult } from "@humansandmachines/gsv/protocol";
import { hashToken } from "../auth/shadow";
import type { AuthStore } from "./auth-store";
import type { TargetRegistry } from "./target-registry";

export const DEVICE_PAIRING_TTL_MS = 10 * 60 * 1000;
const RECEIPT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PENDING_PER_USER = 10;

export class DevicePairingError extends Error {
  constructor(readonly reason: "unavailable" | "used" | "cancelled" | "expired", message: string) { super(message); }
}

export class DevicePairingCreateError extends Error {}

type PairingRow = {
  id: string;
  owner_uid: number;
  target_id: string;
  label: string;
  replaces_target: number;
  secret_hash: string;
  created_at: number;
  expires_at: number;
  cancelled_at: number | null;
  redeemed_at: number | null;
  redemption_hash: string | null;
  token_id: string | null;
};

/** The invitation owns enrollment, but never owns revocation of the resulting device. */
export class DevicePairingStore {
  private readonly sql: SqlStorage;

  constructor(private readonly storage: DurableObjectStorage, private readonly auth: AuthStore, private readonly targets: TargetRegistry) {
    this.sql = storage.sql;
  }

  async create(ownerUid: number, args: SysPairCreateArgs): Promise<DevicePairing> {
    const secretHash = await hashToken(args.secret);
    return this.storage.transactionSync(() => {
      this.prune();
      const existing = this.row(args.id);
      if (existing) {
        if (existing.owner_uid !== ownerUid || existing.secret_hash !== secretHash || existing.target_id !== args.targetId || existing.label !== args.label || Boolean(existing.replaces_target) !== Boolean(args.replace)) {
          throw new DevicePairingCreateError("Pairing identity already exists");
        }
        return this.summary(existing);
      }
      const pending = this.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM device_pairings WHERE owner_uid = ? AND cancelled_at IS NULL AND redeemed_at IS NULL AND expires_at > ?",
        ownerUid, Date.now(),
      ).toArray()[0].count;
      if (pending >= MAX_PENDING_PER_USER) throw new DevicePairingCreateError("Cancel an unused invitation before creating another");
      this.requireTarget(ownerUid, args.targetId, args.replace ?? false);
      if (this.sql.exec("SELECT id FROM device_pairings WHERE target_id = ? AND cancelled_at IS NULL AND redeemed_at IS NULL", args.targetId).toArray().length) {
        throw new DevicePairingCreateError("Target ID already has a pending invitation");
      }
      const now = Date.now();
      this.sql.exec("INSERT INTO device_pairings (id, owner_uid, target_id, label, replaces_target, secret_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        args.id, ownerUid, args.targetId, args.label, args.replace ? 1 : 0, secretHash, now, now + DEVICE_PAIRING_TTL_MS);
      return this.summary(this.row(args.id)!);
    });
  }

  list(ownerUid: number): DevicePairing[] {
    this.prune();
    return this.sql.exec<PairingRow>("SELECT * FROM device_pairings WHERE owner_uid = ? ORDER BY created_at DESC LIMIT 100", ownerUid)
      .toArray().map((row) => this.summary(row));
  }

  cancel(ownerUid: number, id: string): DevicePairing {
    return this.storage.transactionSync(() => {
      const row = this.row(id);
      if (!row || row.owner_uid !== ownerUid) throw new Error("Pairing invitation not found");
      if (row.redeemed_at === null && row.cancelled_at === null) {
        this.sql.exec("UPDATE device_pairings SET cancelled_at = ? WHERE id = ?", Date.now(), id);
      }
      return this.summary(this.row(id)!);
    });
  }

  async redeem(args: SysPairRedeemArgs): Promise<SysPairRedeemResult> {
    const [secretHash, credentialHash] = await Promise.all([hashToken(args.secret), hashToken(args.credential)]);
    const row = this.row(args.id);
    if (!row || row.secret_hash !== secretHash) throw new DevicePairingError("unavailable", "Invalid or unavailable pairing invitation");
    const token = await this.auth.prepareToken({ uid: row.owner_uid, kind: "machine", peerId: row.target_id, label: row.label }, args.credential);
    return this.storage.transactionSync(() => {
      const current = this.row(args.id);
      if (!current || current.secret_hash !== secretHash) throw new DevicePairingError("unavailable", "Invalid or unavailable pairing invitation");
      if (current.redeemed_at !== null) {
        if (current.redemption_hash !== credentialHash || !current.token_id) throw new DevicePairingError("used", "Pairing invitation was already used");
        return { pairing: this.summary(current), tokenId: current.token_id };
      }
      if (current.expires_at <= Date.now()) throw new DevicePairingError("expired", "Pairing invitation expired. Create a new invitation in GSV.");
      if (current.cancelled_at !== null) throw new DevicePairingError("cancelled", "Pairing invitation was cancelled. Create a new invitation in GSV.");
      try {
        this.requireTarget(current.owner_uid, current.target_id, Boolean(current.replaces_target));
      } catch (error) {
        if (error instanceof DevicePairingCreateError) throw new DevicePairingError("unavailable", error.message);
        throw error;
      }
      this.auth.storePreparedToken(token);
      this.sql.exec("UPDATE device_pairings SET redeemed_at = ?, redemption_hash = ?, token_id = ? WHERE id = ?",
        Date.now(), credentialHash, token.issued.tokenId, current.id);
      return { pairing: this.summary(this.row(current.id)!), tokenId: token.issued.tokenId };
    });
  }

  private row(id: string): PairingRow | undefined {
    return this.sql.exec<PairingRow>("SELECT * FROM device_pairings WHERE id = ?", id).toArray()[0];
  }

  private summary(row: PairingRow): DevicePairing {
    const owner = this.auth.getPasswdByUid(row.owner_uid);
    if (!owner) throw new Error("Pairing account is unavailable");
    return { id: row.id, username: owner.username, targetId: row.target_id, label: row.label,
      createdAt: row.created_at, expiresAt: row.expires_at,
      state: row.redeemed_at !== null ? "paired" : row.expires_at <= Date.now() ? "expired" : row.cancelled_at !== null ? "cancelled" : "pending" };
  }

  private requireTarget(ownerUid: number, targetId: string, replace: boolean): void {
    if (replace) {
      if (this.targets.get(targetId)?.owner_uid !== ownerUid) throw new DevicePairingCreateError("Only an owned existing place can be paired again");
      return;
    }
    if (targetId === "gsv" || this.targets.get(targetId) || this.sql.exec(
      "SELECT token_id FROM auth_tokens WHERE kind = 'machine' AND peer_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) LIMIT 1",
      targetId, Date.now(),
    ).toArray().length) throw new DevicePairingCreateError("Target ID is already in use");
  }

  cancelForTarget(ownerUid: number, targetId: string): void {
    this.sql.exec("UPDATE device_pairings SET cancelled_at = ? WHERE owner_uid = ? AND target_id = ? AND cancelled_at IS NULL AND redeemed_at IS NULL", Date.now(), ownerUid, targetId);
  }

  private prune(): void {
    const now = Date.now();
    this.sql.exec("UPDATE device_pairings SET cancelled_at = ? WHERE redeemed_at IS NULL AND cancelled_at IS NULL AND expires_at <= ?", now, now);
    this.sql.exec("DELETE FROM device_pairings WHERE expires_at < ?", now - RECEIPT_TTL_MS);
  }
}
