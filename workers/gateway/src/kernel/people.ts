import { z } from "zod";
import type { HumanInvitation, ResultOf } from "@humansandmachines/gsv/protocol";
import { hashPassword, hashToken, isLocked } from "../auth/shadow";
import type { AuthStore } from "./auth-store";
import { accountIdentity, ACCOUNT_USERNAME_RE, commitAccount, isUsernameAvailable, prepareAccount, prepareAccountHome } from "./accounts";
import { principalOf, type KernelContext } from "./context";

const inviteCreateSchema = z.strictObject({ id: z.uuid(), secret: z.string().regex(/^[a-f0-9]{64}$/), username: z.string().regex(ACCOUNT_USERNAME_RE) });
const inviteRedeemSchema = z.strictObject({ id: z.uuid(), secret: z.string().regex(/^[a-f0-9]{64}$/), proof: z.string().regex(/^[a-f0-9]{64}$/), password: z.string().min(8).max(1024) });
const passwordSchema = z.strictObject({ uid: z.number().int().min(1000), password: z.string().min(8).max(1024) });
const inviteLifetime = 10 * 60 * 1000;
const receiptLifetime = 30 * 24 * 60 * 60 * 1000;
type InvitationRow = { id: string; issuer_uid: number; issuer_epoch: number; username: string; secret_hash: string; created_at: number; expires_at: number; cancelled_at: number | null; redeemed_at: number | null; redemption_hash: string | null; enrolled_uid: number | null };

/** Credential provenance excludes Processes, which may also act as a human-shaped principal. */
export function requireRootHuman(ctx: KernelContext): number {
  const principal = principalOf(ctx);
  if (principal?.kind !== "human" || principal.account.uid !== 0 || ctx.peer?.provenance.kind !== "credential") throw new Error("People administration requires a signed-in root human");
  const epoch = ctx.auth.credentialEpoch(0);
  if (ctx.auth.isAccountDisabled(0) || (ctx.connection && (ctx.connection.state.step !== "connected" || (ctx.connection.state.credentialEpoch ?? 0) !== epoch))) throw new Error("Root credentials changed; sign in again");
  return epoch;
}

/** One Kernel owns the invitation, local account, credential and consumption receipt. */
export class PeopleStore {
  constructor(private readonly storage: DurableObjectStorage, private readonly auth: AuthStore) {}

  async invite(input: { id: string; secret: string; username: string }, ctx: KernelContext): Promise<HumanInvitation> {
    const epoch = requireRootHuman(ctx);
    const args = inviteCreateSchema.parse(input);
    const secretHash = await hashToken(args.secret);
    return this.storage.transactionSync(() => {
      this.assertRootEpoch(epoch);
      const existing = this.invitation(args.id);
      if (existing) {
        if (existing.secret_hash !== secretHash || existing.username !== args.username || existing.issuer_epoch !== epoch) throw new Error("Invitation id already exists");
        return this.describe(existing);
      }
      const now = Date.now();
      this.storage.sql.exec("DELETE FROM human_invitations WHERE expires_at < ?", now - receiptLifetime);
      if (!isUsernameAvailable(this.auth, args.username)) throw new Error("Username is unavailable");
      const pending = this.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM human_invitations WHERE issuer_uid = 0 AND redeemed_at IS NULL AND cancelled_at IS NULL AND expires_at > ?", now).one().count;
      if (pending >= 10) throw new Error("Cancel an outstanding invitation before creating another");
      this.storage.sql.exec(`INSERT INTO human_invitations (id, purpose, issuer_uid, issuer_epoch, username, secret_hash, created_at, expires_at)
        VALUES (?, 'human-account', 0, ?, ?, ?, ?, ?)`, args.id, epoch, args.username, secretHash, now, now + inviteLifetime);
      return this.describe(this.invitation(args.id)!);
    });
  }

  invitations(ctx: KernelContext): ResultOf<"account.invite.list"> {
    requireRootHuman(ctx);
    const rows = this.storage.sql.exec<InvitationRow>("SELECT * FROM human_invitations WHERE expires_at > ? ORDER BY created_at DESC", Date.now() - receiptLifetime).toArray();
    return { invitations: rows.map((row) => this.describe(row)) };
  }

  cancel(id: string, ctx: KernelContext): HumanInvitation {
    requireRootHuman(ctx);
    const row = this.invitation(z.uuid().parse(id));
    if (!row) throw new Error("Invitation is unavailable");
    this.storage.sql.exec("UPDATE human_invitations SET cancelled_at = ? WHERE id = ? AND redeemed_at IS NULL AND cancelled_at IS NULL", Date.now(), id);
    return this.describe(this.invitation(id)!);
  }

  async redeem(input: { id: string; secret: string; proof: string; password: string }, ctx: KernelContext): Promise<{ uid: number; username: string }> {
    const args = inviteRedeemSchema.parse(input);
    const initial = this.invitation(args.id);
    if (!initial) throw new Error("Human invitation is unavailable");
    const [secretHash, redemptionHash, prepared] = await Promise.all([
      hashToken(args.secret), hashToken(JSON.stringify([args.proof, args.password])),
      prepareAccount({ kind: "human", username: initial.username, password: args.password }),
    ]);
    const identity = this.storage.transactionSync(() => {
      const row = this.invitation(args.id);
      if (!row || row.secret_hash !== secretHash) throw new Error("Human invitation is unavailable");
      if (row.redeemed_at !== null) {
        if (row.redemption_hash !== redemptionHash || row.enrolled_uid === null) throw new Error("Human invitation was already used");
        const enrolled = this.auth.getPasswdByUid(row.enrolled_uid);
        if (!enrolled) throw new Error("Enrolled account is unavailable");
        return accountIdentity(this.auth, enrolled);
      }
      if (row.cancelled_at !== null || row.expires_at <= Date.now()) throw new Error("Human invitation expired or was cancelled");
      this.assertRootEpoch(row.issuer_epoch);
      const created = commitAccount(ctx, prepared);
      this.storage.sql.exec("UPDATE human_invitations SET redeemed_at = ?, redemption_hash = ?, enrolled_uid = ? WHERE id = ?", Date.now(), redemptionHash, created.identity.uid, row.id);
      return created.identity;
    });
    if (!this.auth.isAccountDisabled(identity.uid)) await prepareAccountHome(ctx.env, prepared.input, identity);
    return { uid: identity.uid, username: identity.username };
  }

  people(ctx: KernelContext): ResultOf<"account.people.list"> {
    requireRootHuman(ctx);
    return { people: this.auth.getPasswdEntries().filter((entry) => {
      const shadow = this.auth.getShadowByUsername(entry.username);
      return (entry.uid === 0 || entry.uid >= 1000) && shadow !== null && !isLocked(shadow);
    }).map((entry) => ({
      uid: entry.uid, username: entry.username, displayName: entry.gecos || entry.username, disabled: this.auth.isAccountDisabled(entry.uid),
    })) };
  }

  async setPassword(input: { uid: number; password: string }, ctx: KernelContext): Promise<{ updated: true }> {
    const rootEpoch = requireRootHuman(ctx);
    const args = passwordSchema.parse(input);
    const member = this.member(args.uid);
    const memberEpoch = this.auth.credentialEpoch(member.uid);
    const passwordHash = await hashPassword(args.password);
    this.storage.transactionSync(() => {
      this.assertRootEpoch(rootEpoch);
      this.member(args.uid);
      if (this.auth.credentialEpoch(member.uid) !== memberEpoch) throw new Error("Account credentials changed; try again");
      this.auth.replaceHumanPassword(member.uid, passwordHash, "root password reset");
    });
    ctx.invalidateAccountConnections(member.uid);
    return { updated: true };
  }

  remove(uid: number, ctx: KernelContext): ResultOf<"account.remove"> {
    requireRootHuman(ctx);
    z.number().int().min(1000).parse(uid);
    const member = this.member(uid, true);
    this.storage.transactionSync(() => {
      if (this.auth.isAccountDisabled(member.uid)) return;
      this.auth.invalidateCredentials(member.uid, "account removed");
      this.storage.sql.exec("UPDATE account_access SET disabled_at = ? WHERE uid = ?", Date.now(), member.uid);
      this.storage.sql.exec("DELETE FROM identity_links WHERE uid = ?", member.uid);
    });
    ctx.invalidateAccountConnections(member.uid);
    return { removed: true };
  }

  private member(uid: number, includeDisabled = false) {
    const entry = this.auth.getPasswdByUid(uid);
    const shadow = entry && this.auth.getShadowByUsername(entry.username);
    if (!entry || !shadow || isLocked(shadow) || (!includeDisabled && this.auth.isAccountDisabled(uid))) throw new Error("Local human account is unavailable");
    return entry;
  }

  private assertRootEpoch(epoch: number): void {
    if (this.auth.isSetupMode() || this.auth.isAccountDisabled(0) || this.auth.credentialEpoch(0) !== epoch) throw new Error("Root authorization expired or was revoked");
  }

  private invitation(id: string): InvitationRow | undefined {
    return this.storage.sql.exec<InvitationRow>("SELECT * FROM human_invitations WHERE id = ?", id).toArray()[0];
  }

  private describe(row: InvitationRow): HumanInvitation {
    return { id: row.id, username: row.username, createdAt: row.created_at, expiresAt: row.expires_at,
      status: row.redeemed_at !== null ? "redeemed" : row.cancelled_at !== null || row.issuer_epoch !== this.auth.credentialEpoch(0) ? "cancelled" : row.expires_at <= Date.now() ? "expired" : "pending" };
  }
}
