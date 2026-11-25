import type { AuthorizeRootRecoveryInput } from "@humansandmachines/gsv/services/ownership";
import type { ArgsOf, ResultOf } from "@humansandmachines/gsv/protocol";
import { SESSION_CREDENTIAL_PATTERN } from "@humansandmachines/gsv/protocol/pairing";
import { exceptionDiagnostics } from "@humansandmachines/gsv/telemetry";
import { hashPassword, hashToken, isPasswordUnset, makeShadowEntry } from "../auth/shadow";
import { MultiplePersonalAccountsError, type AuthStore } from "./auth-store";
import { principalOf, type KernelContext } from "./context";
import { emailSignInConfigured } from "../installation/lifecycle";
import { z } from "zod";

const passwordResetSchema = z.strictObject({ uid: z.number().int().min(1000).optional(), password: z.string().min(8).max(1024) });

/** Email sign-in opens a session as long as the one the web app keeps for a password sign-in. */
export const EMAIL_SIGN_IN_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
export const signInSessionSchema = z.strictObject({
  id: z.uuid(), secret: z.string().regex(/^[a-f0-9]{64}$/), code: z.string().regex(/^\d{6}$/),
  credential: z.string().regex(SESSION_CREDENTIAL_PATTERN), label: z.string().trim().min(1).max(64).optional(),
});
type SignInSession = z.infer<typeof signInSessionSchema>;

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
type RedeemedRecovery = { username: string; uid: number; administratorChanged?: true };

/** The verified owner holds a valid claim, but this Ship has no personal account that may be reset. */
export class PersonalAccountUnavailableError extends Error {
  constructor() { super("Personal account is unavailable"); }
}

/**
 * Public navigation to the operator's owner page, and whether this Ship takes email sign-in. Neither carries
 * authority or says anything about who owns the Ship.
 */
export function ownerRecoveryOptions(ctx: { env: { GSV_OWNER_SIGNUP_URL?: string; INSTALLATION_OWNERSHIP?: unknown }; installationIdentity?: { handle?: string } | null }): ResultOf<"account.recovery.options"> {
  const handle = ctx.installationIdentity?.handle;
  if (!ctx.env.GSV_OWNER_SIGNUP_URL || !handle) return {};
  const url = new URL("/owner/recover", ctx.env.GSV_OWNER_SIGNUP_URL);
  url.searchParams.set("handle", handle);
  return { emailUrl: url.href, ...(emailSignInConfigured(ctx.env) ? { emailSignIn: true as const } : undefined) };
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

  /**
   * The signed-in person chooses a first password. With none before it, no credential was ever issued against a
   * password, so nothing is revoked and this session stays signed in. Root keeps whatever it has.
   */
  async setFirstPassword(input: { uid?: number; password: string }, ctx: KernelContext): Promise<{ updated: true }> {
    const uid = requirePersonalHuman(ctx);
    const args = passwordResetSchema.parse(input);
    if (args.uid !== undefined && args.uid !== uid) throw new Error("Personal account is unavailable");
    const epoch = this.auth.credentialEpoch(uid);
    const passwordHash = await hashPassword(args.password);
    this.storage.transactionSync(() => {
      const user = this.auth.getHumanAccount();
      const shadow = user && this.auth.getShadowByUsername(user.username);
      if (!user || user.uid !== uid || !shadow || this.auth.credentialEpoch(uid) !== epoch) throw new Error("Account credentials changed; sign in again");
      if (!isPasswordUnset(shadow)) throw new Error("This account already has a password; reset it by email instead");
      this.auth.setShadow(makeShadowEntry(user.username, passwordHash));
    });
    return { updated: true };
  }

  passwordStatus(ctx: KernelContext): ResultOf<"account.password.status"> {
    const principal = principalOf(ctx);
    if (principal?.kind !== "human") throw new Error("Password status requires a signed-in person");
    const shadow = this.auth.getShadowByUsername(principal.account.username);
    return { set: Boolean(shadow) && !isPasswordUnset(shadow!) };
  }

  /** A client retrying a sign-in whose answer it lost: the session its credential already opened. */
  async signedInSession(input: SignInSession): Promise<ResultOf<"account.signin.redeem"> | null> {
    const [secretHash, redemptionHash] = await Promise.all([sha256(input.secret), sessionRedemptionHash(input.credential)]);
    const claim = this.claim(input.id);
    if (!claim || claim.secret_hash !== secretHash || claim.redeemed_at === null) return null;
    if (claim.redemption_hash !== redemptionHash) throw new Error("Sign-in code was already used");
    return this.session(claim, input.credential);
  }

  /**
   * Spends a claim Accounts just authorized on one session for the personal account, from the credential the client
   * kept. The claim fences the personal account's generation, so a reset since the code was sent wins.
   */
  async openSession(claimInput: AuthorizeRootRecoveryInput, input: SignInSession): Promise<ResultOf<"account.signin.redeem">> {
    this.authorize(claimInput);
    const human = this.personalAccountForClaim();
    if (!human) throw new PersonalAccountUnavailableError();
    const [secretHash, redemptionHash] = await Promise.all([sha256(input.secret), sessionRedemptionHash(input.credential)]);
    const prepared = await this.auth.prepareToken({ uid: human.uid, kind: "human", label: input.label ?? "gsv-ui-session",
      expiresAt: Date.now() + EMAIL_SIGN_IN_SESSION_MS }, input.credential);
    const opened = this.storage.transactionSync(() => {
      const claim = this.claim(input.id);
      if (!claim || claim.secret_hash !== secretHash) throw new Error("Sign-in claim is unavailable");
      if (claim.redeemed_at !== null) {
        if (claim.redemption_hash !== redemptionHash) throw new Error("Sign-in code was already used");
        return null;
      }
      if (claim.expires_at <= Date.now()) throw new Error("Sign-in claim expired");
      if (claim.personal_uid !== human.uid || this.auth.getHumanAccount()?.uid !== human.uid
        || claim.personal_credential_epoch !== this.auth.credentialEpoch(human.uid)) throw new Error("Sign-in claim was superseded");
      const issued = this.auth.storePreparedToken(prepared);
      this.storage.sql.exec("UPDATE account_recovery_claims SET redeemed_at = ?, redemption_hash = ? WHERE id = ?", Date.now(), redemptionHash, input.id);
      return { username: human.username, tokenId: issued.tokenId, expiresAt: issued.expiresAt ?? 0 };
    });
    // An identical request already spent the claim while this one waited on Accounts.
    return opened ?? this.session(this.claim(input.id)!, input.credential);
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
      const personal = account === "personal" ? this.replacePersonal(claim, passwordHash) : null;
      const uid = personal ? personal.uid : this.replaceRoot(claim, passwordHash);
      this.storage.sql.exec("UPDATE account_recovery_claims SET redeemed_at = ?, redemption_hash = ? WHERE id = ?", Date.now(), redemptionHash, input.id);
      return { ...this.redeemed(uid), ...(personal?.administratorChanged ? { administratorChanged: true as const } : undefined) };
    });
  }

  /** A Ship whose accounts break the one-person invariant must still reach administrator recovery. */
  private personalAccountForClaim(): ReturnType<AuthStore["getHumanAccount"]> {
    try {
      return this.auth.getHumanAccount();
    } catch (error) {
      if (!(error instanceof MultiplePersonalAccountsError)) throw error;
      console.error("[Kernel] Personal recovery unavailable:", exceptionDiagnostics(error));
      return null;
    }
  }

  private replaceRoot(claim: RecoveryClaim, passwordHash: string): number {
    if (claim.credential_epoch !== this.auth.credentialEpoch(0)) throw new Error("Recovery claim was superseded");
    this.auth.replaceHumanPassword(0, passwordHash, "owner recovery");
    return 0;
  }

  private replacePersonal(claim: RecoveryClaim, passwordHash: string) {
    const uid = claim.personal_uid;
    if (uid === null || this.auth.getHumanAccount()?.uid !== uid) throw new PersonalAccountUnavailableError();
    if (claim.personal_credential_epoch !== this.auth.credentialEpoch(uid)) throw new Error("Recovery claim was superseded");
    return { uid, administratorChanged: this.auth.replacePersonalPassword(uid, passwordHash, "owner email recovery") };
  }

  private redeemed(uid: number | null): RedeemedRecovery {
    const user = uid === null ? null : this.auth.getPasswdByUid(uid);
    if (!user) throw new Error("Recovered account is unavailable");
    return { username: user.username, uid: user.uid };
  }

  private async session(claim: RecoveryClaim, credential: string): Promise<ResultOf<"account.signin.redeem">> {
    const session = await this.auth.humanSession(credential);
    const user = session && session.uid === claim.personal_uid ? this.auth.getPasswdByUid(session.uid) : null;
    if (!session || !user) throw new Error("Sign-in session is no longer valid");
    return { username: user.username, tokenId: session.tokenId, expiresAt: session.expiresAt ?? 0 };
  }

  private claim(id: string): RecoveryClaim | undefined {
    return this.storage.sql.exec<RecoveryClaim>("SELECT * FROM account_recovery_claims WHERE id = ?", id).toArray()[0];
  }
}

/** A recovery redemption hashes a password; a sign-in hashes the session credential, in its own domain. */
function sessionRedemptionHash(credential: string): Promise<string> {
  return hashToken(JSON.stringify(["session", credential]));
}

/** The person themself, not a Process acting as them. */
function requirePersonalHuman(ctx: KernelContext): number {
  const principal = principalOf(ctx);
  if (principal?.kind !== "human" || principal.account.uid < 1000 || ctx.peer?.provenance.kind !== "credential") throw new Error("Setting a password requires a signed-in person");
  const uid = principal.account.uid;
  if (ctx.auth.isAccountDisabled(uid) || (ctx.connection && (ctx.connection.state.step !== "connected" || (ctx.connection.state.credentialEpoch ?? 0) !== ctx.auth.credentialEpoch(uid)))) throw new Error("Account credentials changed; sign in again");
  return uid;
}

export async function sha256(secret: string): Promise<string> {
  return (await hashToken(secret)).slice("$token-sha256$".length);
}
