import type { AdapterMessageDestination, ArgsOf, ResultOf } from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import { hashPassword, hashToken, isLocked } from "../auth/shadow";
import { deliverAdapterDestination } from "./adapter-send";
import { identityLinkRouteGeneration } from "./adapter-destinations";
import type { AuthStore } from "./auth-store";
import type { KernelContext } from "./context";
import type { IdentityLinkRecord } from "./identity-links";

const startSchema = z.strictObject({ id: z.uuid(), username: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/), proof: z.string().regex(/^[a-f0-9]{64}$/) });
const redeemSchema = z.strictObject({ id: z.uuid(), proof: z.string().regex(/^[a-f0-9]{64}$/), code: z.string().regex(/^[a-fA-F0-9]{4}-?[a-fA-F0-9]{4}$/), password: z.string().min(8).max(1024) });
const confirmedLinkSchema = z.object({ managed: z.literal(true), surfaceKind: z.literal("dm"), surfaceId: z.string().min(1), routeGeneration: z.string().min(1) });
const codeLifetime = 5 * 60 * 1000;
const receiptLifetime = 30 * 24 * 60 * 60 * 1000;
type RecoveryClaim = { id: string; uid: number; proof_hash: string; code_hash: string; credential_epoch: number; adapter: string; account_id: string; actor_id: string; surface_id: string; route_generation: string; created_at: number; expires_at: number; failed_attempts: number; redeemed_at: number | null; redemption_hash: string | null };
type RecoveryDestination = { destination: AdapterMessageDestination; routeGeneration: string };

/** An existing human-confirmed messenger link can authorize only that local member's reset. */
export class MemberRecoveryStore {
  constructor(private readonly storage: DurableObjectStorage, private readonly auth: AuthStore) {}

  async start(input: ArgsOf<"account.recovery.code.start">, ctx: KernelContext): Promise<ResultOf<"account.recovery.code.start">> {
    const args = startSchema.parse(input);
    const response: ResultOf<"account.recovery.code.start"> = { accepted: true, expiresAt: Date.now() + codeLifetime };
    const user = this.auth.getPasswdByUsername(args.username);
    if (!user || !this.member(user.uid)) return response;
    const selected = this.destination(user.uid, ctx);
    if (!selected) return response;
    const epoch = this.auth.credentialEpoch(user.uid);
    const code = Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
    const [proofHash, codeHash] = await Promise.all([hashToken(args.proof), hashToken(`${args.id}:${code}`)]);
    const created = this.storage.transactionSync(() => {
      if (!this.member(user.uid) || this.auth.credentialEpoch(user.uid) !== epoch || !this.sameDestination(user.uid, selected, ctx)) return false;
      const existing = this.claim(args.id);
      if (existing) {
        if (existing.uid === user.uid && existing.proof_hash === proofHash) response.expiresAt = existing.expires_at;
        return false;
      }
      const now = Date.now();
      this.storage.sql.exec("DELETE FROM member_recovery_claims WHERE expires_at < ?", now - receiptLifetime);
      const latest = this.storage.sql.exec<{ created_at: number }>("SELECT created_at FROM member_recovery_claims WHERE uid = ? ORDER BY created_at DESC LIMIT 1", user.uid).toArray()[0];
      if (latest && latest.created_at > now - 60_000) return false;
      const destination = selected.destination;
      this.storage.sql.exec(`INSERT INTO member_recovery_claims (id, uid, proof_hash, code_hash, credential_epoch, adapter, account_id, actor_id, surface_id, route_generation, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, args.id, user.uid, proofHash, codeHash, epoch, destination.adapter, destination.accountId, destination.actorId, destination.surface.id, selected.routeGeneration, now, response.expiresAt);
      return true;
    });
    if (!created) return response;
    const origin = ctx.installationIdentity?.canonicalOrigin ?? (ctx.connection ? new URL(ctx.connection.uri).origin : "your GSV");
    // Delivery owns this one attempt. A lost reply can still redeem the persisted claim;
    // a lost delivery requires a new code after the cooldown, never a model wake.
    await deliverAdapterDestination(selected.destination, user.uid, {
      deliveryId: `member-recovery:${args.id}`, routeGeneration: selected.routeGeneration,
      text: `Your GSV recovery code is ${code.slice(0, 4)}-${code.slice(4)}. Enter it only in the browser where you requested recovery at ${origin}. It expires in five minutes. Never share this code. If you did not request it, ignore this message.`,
    }, ctx).catch(() => undefined);
    return response;
  }

  async redeem(input: ArgsOf<"account.recovery.code.redeem">, ctx: KernelContext): Promise<ResultOf<"account.recovery.code.redeem">> {
    const args = redeemSchema.parse(input);
    const code = args.code.replace("-", "").toUpperCase();
    const [proofHash, codeHash, redemptionHash] = await Promise.all([hashToken(args.proof), hashToken(`${args.id}:${code}`), hashToken(JSON.stringify([args.proof, code, args.password]))]);
    const claim = this.storage.transactionSync(() => {
      const row = this.claim(args.id);
      if (!row || row.proof_hash !== proofHash) return null;
      if (row.redeemed_at !== null) return row.code_hash === codeHash && row.redemption_hash === redemptionHash ? row : null;
      if (!this.current(row, ctx) || row.failed_attempts >= 5) return null;
      if (row.code_hash !== codeHash) {
        this.storage.sql.exec("UPDATE member_recovery_claims SET failed_attempts = failed_attempts + 1 WHERE id = ?", row.id);
        return null;
      }
      return row;
    });
    if (!claim) throw new Error("Recovery code is unavailable, expired or incorrect");
    if (claim.redeemed_at !== null) return this.result(claim.uid);
    const passwordHash = await hashPassword(args.password);
    const result = this.storage.transactionSync(() => {
      const current = this.claim(args.id)!;
      if (current.redeemed_at !== null) {
        if (current.redemption_hash !== redemptionHash) throw new Error("Recovery code was already used");
        return this.result(current.uid);
      }
      if (!this.current(current, ctx) || current.failed_attempts >= 5) throw new Error("Recovery authorization expired or was revoked");
      this.auth.replaceHumanPassword(current.uid, passwordHash, "messenger recovery");
      this.storage.sql.exec("UPDATE member_recovery_claims SET redeemed_at = ?, redemption_hash = ? WHERE id = ?", Date.now(), redemptionHash, current.id);
      return this.result(current.uid);
    });
    ctx.invalidateAccountConnections(claim.uid);
    return result;
  }

  private member(uid: number): boolean {
    const user = this.auth.getPasswdByUid(uid);
    const shadow = user && this.auth.getShadowByUsername(user.username);
    return uid >= 1000 && shadow !== null && !isLocked(shadow) && !this.auth.isAccountDisabled(uid);
  }

  private destination(uid: number, ctx: KernelContext): RecoveryDestination | null {
    const links = ctx.adapters.identityLinks.list(uid);
    const preferred = ctx.adapters.privateDestinations.get(uid)?.destination;
    if (preferred) {
      const linked = links.find((link) => link.adapter === preferred.adapter && link.accountId === preferred.accountId && link.actorId === preferred.actorId);
      const selected = linked && this.confirmed(linked, uid);
      if (selected?.destination.surface.id === preferred.surface.id) return selected;
    }
    for (const link of links) {
      const selected = this.confirmed(link, uid);
      if (selected) return selected;
    }
    return null;
  }

  private confirmed(link: IdentityLinkRecord, uid: number): RecoveryDestination | null {
    const metadata = confirmedLinkSchema.safeParse(link.metadata);
    if (link.uid !== uid || link.linkedByUid !== uid || !metadata.success) return null;
    const destination: AdapterMessageDestination = { kind: "adapter", adapter: link.adapter, accountId: link.accountId, actorId: link.actorId, surface: { kind: "dm", id: metadata.data.surfaceId } };
    const generation = identityLinkRouteGeneration(link, destination.surface);
    return generation ? { destination, routeGeneration: generation } : null;
  }

  private sameDestination(uid: number, selected: RecoveryDestination, ctx: KernelContext): boolean {
    const { destination } = selected;
    const link = ctx.adapters.identityLinks.get(destination.adapter, destination.accountId, destination.actorId);
    const current = link && this.confirmed(link, uid);
    return Boolean(current && current.destination.surface.id === destination.surface.id && current.routeGeneration === selected.routeGeneration);
  }

  private current(claim: RecoveryClaim, ctx: KernelContext): boolean {
    return claim.expires_at > Date.now() && this.member(claim.uid) && this.auth.credentialEpoch(claim.uid) === claim.credential_epoch
      && this.sameDestination(claim.uid, { destination: { kind: "adapter", adapter: claim.adapter, accountId: claim.account_id, actorId: claim.actor_id, surface: { kind: "dm", id: claim.surface_id } }, routeGeneration: claim.route_generation }, ctx);
  }

  private claim(id: string): RecoveryClaim | undefined { return this.storage.sql.exec<RecoveryClaim>("SELECT * FROM member_recovery_claims WHERE id = ?", id).toArray()[0]; }
  private result(uid: number): ResultOf<"account.recovery.code.redeem"> {
    const user = this.auth.getPasswdByUid(uid);
    if (!user) throw new Error("Recovered account is unavailable");
    return { username: user.username };
  }
}
