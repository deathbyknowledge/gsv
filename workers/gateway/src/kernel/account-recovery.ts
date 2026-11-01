import type { AuthorizeRootRecoveryInput } from "@humansandmachines/gsv/services/ownership";
import type { ArgsOf, ResultOf } from "@humansandmachines/gsv/protocol";
import { hashPassword, hashToken } from "../auth/shadow";
import type { AuthStore } from "./auth-store";
import { principalOf, type KernelContext } from "./context";
import { z } from "zod";

const passwordResetSchema = z.strictObject({ uid: z.number().int().min(1000).optional(), password: z.string().min(8).max(1024) });

/** Credential provenance excludes Processes, which may also act as a human-shaped principal. */
function requireRootHuman(ctx: KernelContext): number {
  const principal = principalOf(ctx);
  if (principal?.kind !== "human" || principal.account.uid !== 0 || ctx.peer?.provenance.kind !== "credential") throw new Error("Password reset requires a signed-in root human");
  const epoch = ctx.auth.credentialEpoch(0);
  if (ctx.auth.isAccountDisabled(0) || (ctx.connection && (ctx.connection.state.step !== "connected" || (ctx.connection.state.credentialEpoch ?? 0) !== epoch))) throw new Error("Root credentials changed; sign in again");
  return epoch;
}

type RecoveryClaim = { id: string; secret_hash: string; credential_epoch: number; personal_uid: number | null; personal_credential_epoch: number | null; expires_at: number; redeemed_at: number | null; redemption_hash: string | null };
type RecoveryAccount = NonNullable<ArgsOf<"account.recovery.redeem">["account"]>;
type RedeemedRecovery = { username: string; uid: number };

/** The verified owner holds a valid claim, but this Ship has no personal account that may be reset. */
export class PersonalAccountUnavailableError extends Error {
  constructor() { super("Personal account is unavailable"); }
}

/** Public navigation to the operator's owner page. It carries no authority and proves nothing about ownership. */
export function ownerRecoveryOptions(ctx: { env: { GSV_OWNER_SIGNUP_URL?: string }; installationIdentity?: { handle?: string } | null }): ResultOf<"account.recovery.options"> {
  const handle = ctx.installationIdentity?.handle;
  if (!ctx.env.GSV_OWNER_SIGNUP_URL || !handle) return {};
  const url = new URL("/owner/recover", ctx.env.GSV_OWNER_SIGNUP_URL);
  url.searchParams.set("handle", handle);
  return { emailUrl: url.href };
}

/**
 * Kernel alone owns credential changes. Accounts grants one bounded claim for the verified
 * owner, who can reach both accounts of a one-person Ship: its receiver spends it on either.
 */
export class AccountRecoveryStore {
  constructor(private readonly storage: DurableObjectStorage, private readonly auth: AuthStore, private readonly installationId: string) {}

  async resetPersonalPassword(input: { uid?: number; password: string }, ctx: KernelContext): Promise<{ updated: true }> {
    const rootEpoch = requireRootHuman(ctx);
    const args = passwordResetSchema.parse(input);
    const human = this.auth.getHumanAccount();
    if (!human || (args.uid !== undefined && args.uid !== human.uid)) throw new Error("Personal account is unavailable");
    const epoch = this.auth.credentialEpoch(human.uid);
    const passwordHash = await hashPassword(args.password);
    this.storage.transactionSync(() => {
      if (requireRootHuman(ctx) !== rootEpoch || this.auth.getHumanAccount()?.uid !== human.uid
        || this.auth.credentialEpoch(human.uid) !== epoch) throw new Error("Account credentials changed; try again");
      this.auth.replaceHumanPassword(human.uid, passwordHash, "root password reset");
    });
    ctx.invalidateAccountConnections(human.uid);
    return { updated: true };
  }

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

  /** A claim records the current generation of both accounts, so either choice can be fenced at redemption. */
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
      const human = this.personalAccountForClaim();
      this.storage.sql.exec(`INSERT INTO account_recovery_claims (id, purpose, secret_hash, credential_epoch, personal_uid, personal_credential_epoch, expires_at)
        VALUES (?, 'root-password-reset', ?, ?, ?, ?, ?)`, input.attemptId, input.secretHash, this.auth.credentialEpoch(0),
      human?.uid ?? null, human ? this.auth.credentialEpoch(human.uid) : null, input.expiresAt);
    });
  }

  async redeem(input: { id: string; secret: string; proof: string; password: string; account?: RecoveryAccount }): Promise<RedeemedRecovery> {
    const account = input.account ?? "administrator";
    if (!/^[a-f0-9-]{36}$/.test(input.id) || input.secret.length < 32 || input.secret.length > 256 || (account !== "personal" && account !== "administrator")
      || input.proof.length < 32 || input.proof.length > 256 || input.password.length < 8 || input.password.length > 1024) throw new Error("Invalid recovery request");
    const [secretHash, redemptionHash, passwordHash] = await Promise.all([
      sha256(input.secret),
      hashToken(JSON.stringify(account === "personal" ? [input.proof, input.password, account] : [input.proof, input.password])),
      hashPassword(input.password),
    ]);
    return this.storage.transactionSync(() => {
      const claim = this.claim(input.id);
      if (!claim || claim.secret_hash !== secretHash) throw new Error("Recovery claim is unavailable");
      if (claim.redeemed_at !== null) {
        if (claim.redemption_hash !== redemptionHash) throw new Error("Recovery claim was already used");
        return this.redeemed(account === "personal" ? claim.personal_uid : 0);
      }
      if (claim.expires_at <= Date.now()) throw new Error("Recovery claim expired");
      const uid = account === "personal" ? this.replacePersonal(claim, passwordHash) : this.replaceRoot(claim, passwordHash);
      this.storage.sql.exec("UPDATE account_recovery_claims SET redeemed_at = ?, redemption_hash = ? WHERE id = ?", Date.now(), redemptionHash, input.id);
      return this.redeemed(uid);
    });
  }

  /** A Ship whose accounts break the one-person invariant must still reach administrator recovery. */
  private personalAccountForClaim(): ReturnType<AuthStore["getHumanAccount"]> {
    try { return this.auth.getHumanAccount(); } catch { return null; }
  }

  private replaceRoot(claim: RecoveryClaim, passwordHash: string): number {
    if (claim.credential_epoch !== this.auth.credentialEpoch(0)) throw new Error("Recovery claim was superseded");
    this.auth.replaceHumanPassword(0, passwordHash, "owner recovery");
    return 0;
  }

  private replacePersonal(claim: RecoveryClaim, passwordHash: string): number {
    const uid = claim.personal_uid;
    if (uid === null || this.auth.getHumanAccount()?.uid !== uid) throw new PersonalAccountUnavailableError();
    if (claim.personal_credential_epoch !== this.auth.credentialEpoch(uid)) throw new Error("Recovery claim was superseded");
    this.auth.replaceHumanPassword(uid, passwordHash, "owner email recovery");
    return uid;
  }

  private redeemed(uid: number | null): RedeemedRecovery {
    const user = uid === null ? null : this.auth.getPasswdByUid(uid);
    if (!user) throw new Error("Recovered account is unavailable");
    return { username: user.username, uid: user.uid };
  }

  private claim(id: string): RecoveryClaim | undefined {
    return this.storage.sql.exec<RecoveryClaim>("SELECT * FROM account_recovery_claims WHERE id = ?", id).toArray()[0];
  }
}

export async function sha256(secret: string): Promise<string> {
  return (await hashToken(secret)).slice("$token-sha256$".length);
}
