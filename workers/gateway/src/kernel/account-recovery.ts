import type { AuthorizeRootRecoveryInput } from "@humansandmachines/gsv/services/ownership";
import { hashPassword, hashToken } from "../auth/shadow";
import type { AuthStore } from "./auth-store";

type RecoveryClaim = { id: string; secret_hash: string; credential_epoch: number; expires_at: number; redeemed_at: number | null; redemption_hash: string | null };

/** Kernel alone owns credential changes. Accounts can grant only a bounded root-reset claim. */
export class AccountRecoveryStore {
  constructor(private readonly storage: DurableObjectStorage, private readonly auth: AuthStore, private readonly installationId: string) {}

  beginOwnerLink(id: string, secretHash: string, epoch: number): void {
    if (this.auth.credentialEpoch(0) !== epoch || this.auth.isAccountDisabled(0)) throw new Error("Root authorization changed");
    this.storage.sql.exec(`INSERT INTO account_owner_links (id, secret_hash, credential_epoch, expires_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING`, id, secretHash, epoch, Date.now() + 10 * 60 * 1000);
    const row = this.storage.sql.exec<{ secret_hash: string; credential_epoch: number }>("SELECT secret_hash, credential_epoch FROM account_owner_links WHERE id = ?", id).toArray()[0];
    if (row.secret_hash !== secretHash || row.credential_epoch !== epoch) throw new Error("Owner link attempt already exists");
    this.confirmOwnerLink(id);
  }

  confirmOwnerLink(id: string): void {
    const row = this.storage.sql.exec<{ credential_epoch: number; expires_at: number }>("SELECT credential_epoch, expires_at FROM account_owner_links WHERE id = ?", id).toArray()[0];
    if (!row || row.expires_at <= Date.now() || row.credential_epoch !== this.auth.credentialEpoch(0) || this.auth.isAccountDisabled(0)) throw new Error("Root authorization expired or was revoked");
  }

  authorize(input: AuthorizeRootRecoveryInput): void {
    if (input.installationId !== this.installationId || input.purpose !== "root-password-reset"
      || !/^[a-f0-9-]{36}$/.test(input.attemptId) || !/^[a-f0-9]{64}$/.test(input.secretHash)
      || input.expiresAt <= Date.now() || input.expiresAt > Date.now() + 10 * 60 * 1000) throw new Error("Root recovery authorization is invalid");
    if (!this.auth.getPasswdByUid(0) || this.auth.isSetupMode()) throw new Error("Root recovery is unavailable");
    this.storage.transactionSync(() => {
      const existing = this.claim(input.attemptId);
      if (existing) {
        if (existing.secret_hash !== input.secretHash || existing.expires_at !== input.expiresAt) throw new Error("Root recovery attempt already exists");
        return;
      }
      this.storage.sql.exec(`INSERT INTO account_recovery_claims (id, purpose, secret_hash, credential_epoch, expires_at)
        VALUES (?, 'root-password-reset', ?, ?, ?)`, input.attemptId, input.secretHash, this.auth.credentialEpoch(0), input.expiresAt);
    });
  }

  async redeem(input: { id: string; secret: string; proof: string; password: string }): Promise<{ username: "root" }> {
    if (!/^[a-f0-9-]{36}$/.test(input.id) || input.secret.length < 32 || input.secret.length > 256
      || input.proof.length < 32 || input.proof.length > 256 || input.password.length < 8 || input.password.length > 1024) throw new Error("Invalid root recovery request");
    const [secretHash, redemptionHash, passwordHash] = await Promise.all([
      sha256(input.secret), hashToken(JSON.stringify([input.proof, input.password])), hashPassword(input.password),
    ]);
    return this.storage.transactionSync(() => {
      const claim = this.claim(input.id);
      if (!claim || claim.secret_hash !== secretHash) throw new Error("Root recovery claim is unavailable");
      if (claim.redeemed_at !== null) {
        if (claim.redemption_hash !== redemptionHash) throw new Error("Root recovery claim was already used");
        return { username: "root" };
      }
      if (claim.expires_at <= Date.now() || claim.credential_epoch !== this.auth.credentialEpoch(0)) throw new Error("Root recovery claim expired or was superseded");
      this.auth.replaceHumanPassword(0, passwordHash, "owner recovery");
      this.storage.sql.exec("UPDATE account_recovery_claims SET redeemed_at = ?, redemption_hash = ? WHERE id = ?", Date.now(), redemptionHash, input.id);
      return { username: "root" };
    });
  }

  private claim(id: string): RecoveryClaim | undefined {
    return this.storage.sql.exec<RecoveryClaim>("SELECT * FROM account_recovery_claims WHERE id = ?", id).toArray()[0];
  }
}

export async function sha256(secret: string): Promise<string> {
  return (await hashToken(secret)).slice("$token-sha256$".length);
}
