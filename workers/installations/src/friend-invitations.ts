import { z } from "zod";
import type { SpaceInvitationAllowance, SpaceInvitationScope, SpaceInvitationsService } from "@humansandmachines/gsv/services/invitations";
import { sha256Hex } from "./tokens";

const installation = z.strictObject({ version: z.literal(1), installationId: z.string().min(1).max(128) });
const scope = installation.extend({ contactInviteId: z.string().min(1).max(128) });
const policySchema = z.strictObject({ total: z.number().int().min(0).max(10_000), policyRef: z.string().min(1).max(128) });
export type FriendInvitationPolicy = z.infer<typeof policySchema>;
type Reservation = { id: string; expires_at: number; released_at: number | null; consumed_at: number | null; recipient_origin: string | null };

/** Accounts owns signup places; the Kernel still owns contact pairing and its generation fences. */
export class FriendInvitations implements SpaceInvitationsService {
  constructor(private readonly db: D1Database, private readonly policy: (installationId: string) => Promise<FriendInvitationPolicy>) {}

  async getAllowance(value: { version: 1; installationId: string }): Promise<SpaceInvitationAllowance> {
    const { installationId } = installation.parse(value);
    const { total } = await this.allowance(installationId);
    const row = await this.db.prepare(`SELECT
      COALESCE(SUM(consumed_at IS NOT NULL), 0) AS used,
      COALESCE(SUM(consumed_at IS NULL AND released_at IS NULL AND expires_at > ?), 0) AS reserved
      FROM friend_invitations WHERE sponsor_installation_id = ?`)
      .bind(Date.now(), installationId).first<{ used: number; reserved: number }>();
    const used = row?.used ?? 0, reserved = row?.reserved ?? 0;
    return { total, used, reserved, available: Math.max(0, total - used - reserved) };
  }

  async reserve(value: SpaceInvitationScope & { code: string; expiresAt: number }): Promise<void> {
    const input = scope.extend({ code: z.string().regex(/^invite_[A-Za-z0-9_-]{43}$/), expiresAt: z.number().int().positive() }).parse(value);
    const now = Date.now();
    if (input.expiresAt <= now || input.expiresAt > now + 7 * 86_400_000) throw new Error("Invitation expiry is invalid");
    const policy = await this.allowance(input.installationId);
    const id = `invite_${crypto.randomUUID()}`;
    const hash = await sha256Hex(input.code);
    await this.db.batch([
      this.db.prepare(`INSERT INTO friend_invitations (id, sponsor_installation_id, contact_invite_id, expires_at)
        SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM installations WHERE id = ? AND state = 'active')
        AND (SELECT COUNT(*) FROM friend_invitations WHERE sponsor_installation_id = ?
          AND (consumed_at IS NOT NULL OR (released_at IS NULL AND expires_at > ?))) < ?
        ON CONFLICT(sponsor_installation_id, contact_invite_id) DO NOTHING`)
        .bind(id, input.installationId, input.contactInviteId, input.expiresAt, input.installationId, input.installationId, now, policy.total),
      this.db.prepare(`INSERT INTO installation_creation_invites
        (id, token_hash, token_prefix, policy_ref, note, created_at, expires_at, updated_at)
        SELECT id, ?, ?, ?, '', ?, expires_at, ? FROM friend_invitations WHERE id = ?`)
        .bind(hash, input.code.slice(0, 16), policy.policyRef, now, now, id),
    ]);
    const row = await this.db.prepare(`SELECT f.*, c.token_hash FROM friend_invitations f
      LEFT JOIN installation_creation_invites c ON c.id = f.id WHERE f.sponsor_installation_id = ? AND f.contact_invite_id = ?`)
      .bind(input.installationId, input.contactInviteId).first<Reservation & { token_hash: string | null }>();
    if (!row) throw new Error("All invitation places are in use");
    if (row.token_hash !== hash || row.expires_at !== input.expiresAt || row.released_at !== null || row.consumed_at !== null) {
      throw new Error("Invitation reservation has changed");
    }
  }

  async cancel(value: SpaceInvitationScope): Promise<void> {
    const input = scope.parse(value);
    const now = Date.now();
    await this.db.batch([
      // Retain cancellation even if a delayed reserve has not reached D1 yet.
      this.db.prepare(`INSERT INTO friend_invitations (id, sponsor_installation_id, contact_invite_id, expires_at, released_at)
        SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM installations WHERE id = ?)
        ON CONFLICT(sponsor_installation_id, contact_invite_id) DO UPDATE
        SET released_at = COALESCE(friend_invitations.released_at, excluded.released_at)
        WHERE friend_invitations.consumed_at IS NULL`)
        .bind(`invite_${crypto.randomUUID()}`, input.installationId, input.contactInviteId, now, now, input.installationId),
      this.db.prepare(`UPDATE installation_creation_invites SET revoked_at = COALESCE(revoked_at, ?), updated_at = ?
        WHERE installation_id IS NULL AND id IN (SELECT id FROM friend_invitations
          WHERE sponsor_installation_id = ? AND contact_invite_id = ? AND released_at IS NOT NULL)`)
        .bind(Date.now(), Date.now(), input.installationId, input.contactInviteId),
    ]);
  }

  async accept(value: SpaceInvitationScope & { recipientOrigin: string }): Promise<void> {
    const input = scope.extend({ recipientOrigin: z.url().refine((value) => new URL(value).origin === value) }).parse(value);
    // One statement arbitrates accepting with an existing Space against starting a new one.
    await this.db.prepare(`UPDATE friend_invitations SET recipient_origin = ?, released_at = ?
      WHERE sponsor_installation_id = ? AND contact_invite_id = ? AND consumed_at IS NULL
      AND released_at IS NULL AND expires_at > ?`)
      .bind(input.recipientOrigin, Date.now(), input.installationId, input.contactInviteId, Date.now()).run();
    const row = await this.db.prepare(`SELECT f.*, i.canonical_origin FROM friend_invitations f
      LEFT JOIN installation_creation_invites c ON c.id = f.id LEFT JOIN installations i ON i.id = c.installation_id
      WHERE f.sponsor_installation_id = ? AND f.contact_invite_id = ?`)
      .bind(input.installationId, input.contactInviteId).first<Reservation & { canonical_origin: string | null }>();
    if (!row) return; // An ordinary contact invitation does not reserve a signup place.
    const recipient = row.consumed_at === null ? row.recipient_origin : row.canonical_origin;
    if (recipient !== input.recipientOrigin) throw new Error("Invitation belongs to a different Space or is no longer available");
  }

  private async allowance(installationId: string): Promise<FriendInvitationPolicy> {
    if (!await this.db.prepare("SELECT 1 FROM installations WHERE id = ? AND state = 'active'").bind(installationId).first()) {
      throw new Error("Space is unavailable");
    }
    return policySchema.parse(await this.policy(installationId));
  }
}
