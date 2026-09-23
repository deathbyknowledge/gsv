import { z } from "zod";
import { AccountStore, type InstallationReservation } from "./store";
import { InstallationOnboardingStore } from "./onboarding";
import { createOpaqueToken, sha256Hex } from "./tokens";
import { parseOpaqueId } from "./domain";

export type CreationInvite = {
  id: string;
  prefix: string;
  policyRef: string | null;
  note: string;
  state: "issued" | "claimed" | "provisioning" | "active" | "revoked" | "expired";
  createdAt: number;
  expiresAt: number | null;
  claimedAt: number | null;
  principalId: string | null;
  installationId: string | null;
  handle: string | null;
  canonicalOrigin: string | null;
  lastError: "policy_unavailable" | "setup_unavailable" | null;
};
export type CreationPolicy = {
  prepare(input: { invitationId: string; installationId: string; policyRef: string }): Promise<void>;
};
type Row = {
  id: string; token_prefix: string; policy_ref: string | null; note: string; created_at: number; expires_at: number | null;
  revoked_at: number | null; principal_id: string | null; claimed_at: number | null; installation_id: string | null;
  last_error: CreationInvite["lastError"]; handle: string | null; canonical_origin: string | null; activated_at: number | null;
};
const projection = `SELECT c.*, i.handle, i.canonical_origin, i.activated_at FROM installation_creation_invites c
  LEFT JOIN installations i ON i.id = c.installation_id`;

/** A claimed invitation is durable authority to finish one space's first setup. */
export class InstallationCreationInvites {
  constructor(private readonly db: D1Database, private readonly accounts: AccountStore,
    private readonly onboarding: InstallationOnboardingStore, private readonly policy?: CreationPolicy) {}

  async create(value: { note?: string; expiresAt?: number | null; policyRef?: string | null }, now = Date.now()): Promise<{ invite: CreationInvite; code: string }> {
    const input = z.strictObject({ note: z.string().trim().max(160).optional(), expiresAt: z.number().int().positive().nullable().optional(),
      policyRef: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/).nullable().optional() }).parse(value);
    if (input.expiresAt !== undefined && input.expiresAt !== null && input.expiresAt <= now) throw new Error("Invite expiry must be in the future");
    const token = await createOpaqueToken("invite");
    const id = `invite_${crypto.randomUUID()}`;
    await this.db.prepare(`INSERT INTO installation_creation_invites
      (id, token_hash, token_prefix, policy_ref, note, created_at, expires_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, token.hash, token.prefix, input.policyRef ?? null, input.note ?? "", now, input.expiresAt ?? null, now).run();
    return { invite: await this.require(id), code: token.raw };
  }

  async list(): Promise<CreationInvite[]> {
    const rows = await this.db.prepare(`${projection} ORDER BY c.created_at DESC, c.id DESC LIMIT 200`).all<Row>();
    return rows.results.map((row) => fromRow(row));
  }

  async owned(principalIdValue: string): Promise<CreationInvite[]> {
    const principalId = parseOpaqueId(principalIdValue, "principalId");
    const rows = await this.db.prepare(`${projection} WHERE c.principal_id = ? ORDER BY c.created_at DESC LIMIT 100`).bind(principalId).all<Row>();
    return rows.results.map((row) => fromRow(row));
  }

  async claim(codeValue: string, principalIdValue: string, now = Date.now()): Promise<CreationInvite> {
    const code = z.string().trim().regex(/^invite_[A-Za-z0-9_-]{43}$/).parse(codeValue);
    const principalId = parseOpaqueId(principalIdValue, "principalId");
    const hash = await sha256Hex(code);
    await this.db.prepare(`UPDATE installation_creation_invites SET principal_id = ?, claimed_at = ?, updated_at = ?
      WHERE token_hash = ? AND principal_id IS NULL AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
      AND EXISTS (SELECT 1 FROM principals WHERE id = ? AND state = 'active' AND email_verified_at IS NOT NULL)`)
      .bind(principalId, now, now, hash, now, principalId).run();
    const row = await this.db.prepare(`${projection} WHERE c.token_hash = ? AND c.principal_id = ? AND c.revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM principals WHERE id = ? AND state = 'active' AND email_verified_at IS NOT NULL)`)
      .bind(hash, principalId, principalId).first<Row>();
    if (!row) throw new Error("Invite is unavailable or already claimed");
    return fromRow(row, now);
  }

  async revoke(idValue: string): Promise<void> {
    const id = parseOpaqueId(idValue, "invitationId");
    const result = await this.db.prepare(`UPDATE installation_creation_invites SET revoked_at = COALESCE(revoked_at, ?), updated_at = ?
      WHERE id = ? AND installation_id IS NULL`).bind(Date.now(), Date.now(), id).run();
    if (result.meta.changes !== 1) throw new Error("Invite is unavailable or has already created a space");
  }

  async available(handleValue: string): Promise<boolean> {
    const handle = this.accounts.validateHandle(handleValue);
    return !await this.db.prepare("SELECT 1 FROM installations WHERE handle = ?").bind(handle).first();
  }

  async prepare(idValue: string, principalIdValue: string, handle: string): Promise<{
    invite: CreationInvite; space: InstallationReservation; onboardingToken: string | null; expiresAt: number | null;
  }> {
    const id = parseOpaqueId(idValue, "invitationId");
    const principalId = parseOpaqueId(principalIdValue, "principalId");
    const invite = await this.require(id);
    if (invite.principalId !== principalId || invite.state === "revoked" || invite.state === "expired") throw new Error("Invite is unavailable");
    const principal = await this.accounts.getPrincipal(principalId);
    if (!principal || principal.state !== "active" || principal.emailVerifiedAt === null) throw new Error("Verified owner is required");
    const space = await this.accounts.reserveInstallation({ principalId, operationId: id, handle, creationInviteId: id });
    if (space.state === "active") return { invite: await this.require(id), space, onboardingToken: null, expiresAt: null };
    if (invite.policyRef) {
      try {
        if (!this.policy) throw new Error("Creation policy is unavailable");
        await this.policy.prepare({ invitationId: id, installationId: space.installationId, policyRef: invite.policyRef });
      } catch {
        await this.failed(id, "policy_unavailable");
        throw new Error("Space setup is temporarily unavailable. Retry shortly.");
      }
    }
    try {
      const issued = await this.onboarding.begin(space.installationId);
      await this.db.prepare("UPDATE installation_creation_invites SET last_error = NULL, updated_at = ? WHERE id = ?")
        .bind(Date.now(), id).run();
      return { invite: await this.require(id), space: { ...space, state: "provisioning", operationState: "provisioning" },
        onboardingToken: new URL(issued.onboardingUrl).hash.slice(1), expiresAt: issued.expiresAt };
    } catch {
      await this.failed(id, "setup_unavailable");
      throw new Error("Space setup is temporarily unavailable. Retry shortly.");
    }
  }

  private async require(id: string): Promise<CreationInvite> {
    const row = await this.db.prepare(`${projection} WHERE c.id = ?`).bind(id).first<Row>();
    if (!row) throw new Error("Invite is unavailable");
    return fromRow(row);
  }
  private async failed(id: string, reason: CreationInvite["lastError"]): Promise<void> {
    await this.db.prepare("UPDATE installation_creation_invites SET last_error = ?, updated_at = ? WHERE id = ?")
      .bind(reason, Date.now(), id).run();
  }
}

function fromRow(row: Row, now = Date.now()): CreationInvite {
  return { id: row.id, prefix: row.token_prefix, policyRef: row.policy_ref, note: row.note,
    state: row.activated_at !== null ? "active" : row.installation_id ? "provisioning" : row.revoked_at !== null ? "revoked"
      : row.principal_id ? "claimed" : row.expires_at !== null && row.expires_at <= now ? "expired" : "issued",
    createdAt: row.created_at, expiresAt: row.expires_at, claimedAt: row.claimed_at, principalId: row.principal_id,
    installationId: row.installation_id, handle: row.handle, canonicalOrigin: row.canonical_origin, lastError: row.last_error };
}
