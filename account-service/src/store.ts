import type {
  InstallationDirectoryResult,
  ManagedInstallationIdentity,
  ManagedInstallationState,
  ProvisionInstallationResult,
} from "@humansandmachines/gsv/protocol";
import {
  hostnameForHandle,
  installationIdentity,
  nowMs,
  parseBaseDomain,
  parseHandle,
  parseOpaqueId,
} from "./domain";

const RESERVATION_TTL_MS = 30 * 60 * 1000;

export type PrincipalRecord = {
  id: string;
  email: string;
  state: "pending" | "active" | "recovery" | "disabled";
  emailVerifiedAt: number | null;
};

export type InstallationReservation = ManagedInstallationIdentity & {
  ownerPrincipalId: string;
  state: ManagedInstallationState;
  provisionVersion: number;
  reservationExpiresAt: number | null;
  operationId: string;
  operationState: "reserved" | "provisioning" | "complete" | "failed";
};

type InstallationRow = {
  id: string;
  owner_principal_id: string;
  handle: string;
  canonical_origin: string;
  state: ManagedInstallationState;
  provision_version: number;
  reservation_expires_at: number | null;
};

export class AccountStore {
  constructor(
    private readonly db: D1Database,
    private readonly baseDomain: string,
  ) {
    parseBaseDomain(baseDomain);
  }

  async createPrincipal(input: {
    principalId?: string;
    email: string;
    displayName: string;
    verified?: boolean;
  }): Promise<PrincipalRecord> {
    const principalId = input.principalId
      ? parseOpaqueId(input.principalId, "principalId")
      : `principal_${crypto.randomUUID()}`;
    const email = normalizeEmail(input.email);
    const displayName = input.displayName.trim();
    if (!displayName || displayName.length > 100) {
      throw new Error("displayName is invalid");
    }
    const now = nowMs();
    const verifiedAt = input.verified ? now : null;
    await this.db.prepare(
      `INSERT INTO principals (
         id, primary_email, primary_email_normalized, display_name,
         email_verified_at, state, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      principalId,
      input.email.trim(),
      email,
      displayName,
      verifiedAt,
      input.verified ? "active" : "pending",
      now,
      now,
    ).run();
    return {
      id: principalId,
      email: input.email.trim(),
      state: input.verified ? "active" : "pending",
      emailVerifiedAt: verifiedAt,
    };
  }

  async reserveInstallation(input: {
    principalId: string;
    operationId: string;
    handle: string;
    provisionVersion?: number;
  }): Promise<InstallationReservation> {
    const principalId = parseOpaqueId(input.principalId, "principalId");
    const operationId = parseOpaqueId(input.operationId, "operationId");
    const handle = parseHandle(input.handle);
    const existing = await this.getReservationByOperation(operationId);
    if (existing) {
      if (existing.ownerPrincipalId !== principalId || existing.handle !== handle) {
        throw new Error("operationId was already used for a different reservation");
      }
      return existing;
    }

    const identity = installationIdentity(handle, this.baseDomain);
    const hostname = hostnameForHandle(handle, this.baseDomain);
    const now = nowMs();
    const reservationExpiresAt = now + RESERVATION_TTL_MS;
    const provisionVersion = parseProvisionVersion(input.provisionVersion ?? 1);

    try {
      await this.db.batch([
        this.db.prepare(
          `INSERT INTO installations (
             id, owner_principal_id, handle, canonical_origin, state,
             provision_version, reservation_expires_at, created_at
           )
           SELECT ?, id, ?, ?, 'reserved', ?, ?, ?
           FROM principals
           WHERE id = ? AND state = 'active' AND email_verified_at IS NOT NULL`,
        ).bind(
          identity.installationId,
          identity.handle,
          identity.canonicalOrigin,
          provisionVersion,
          reservationExpiresAt,
          now,
          principalId,
        ),
        this.db.prepare(
          `INSERT INTO hostnames (
             normalized_hostname, installation_id, kind, state, created_at
           ) VALUES (?, ?, 'canonical', 'reserved', ?)`,
        ).bind(hostname, identity.installationId, now),
        this.db.prepare(
          `INSERT INTO memberships (
             installation_id, principal_id, local_uid, role, state, created_at
           ) VALUES (?, ?, NULL, 'owner', 'pending', ?)`,
        ).bind(identity.installationId, principalId, now),
        this.db.prepare(
          `INSERT INTO provisioning_operations (
             operation_id, installation_id, principal_id, kind, state,
             attempt, last_error, updated_at
           ) VALUES (?, ?, ?, 'create', 'reserved', 0, NULL, ?)`,
        ).bind(operationId, identity.installationId, principalId, now),
      ]);
    } catch (error) {
      const replay = await this.getReservationByOperation(operationId);
      if (replay) {
        if (replay.ownerPrincipalId !== principalId || replay.handle !== handle) {
          throw new Error("operationId was already used for a different reservation");
        }
        return replay;
      }
      const claimed = await this.db.prepare(
        "SELECT id FROM installations WHERE handle = ? OR canonical_origin = ? LIMIT 1",
      ).bind(handle, identity.canonicalOrigin).first<{ id: string }>();
      if (claimed) {
        throw new Error("handle is unavailable");
      }
      const principal = await this.getPrincipal(principalId);
      if (!principal || principal.state !== "active" || principal.emailVerifiedAt === null) {
        throw new Error("verified active principal is required");
      }
      throw error;
    }

    const reservation = await this.getReservationByOperation(operationId);
    if (!reservation) {
      throw new Error("installation reservation was not committed");
    }
    return reservation;
  }

  async beginProvisioning(operationIdValue: string, principalIdValue: string): Promise<InstallationReservation> {
    const operationId = parseOpaqueId(operationIdValue, "operationId");
    const principalId = parseOpaqueId(principalIdValue, "principalId");
    const reservation = await this.requireOwnedReservation(operationId, principalId);
    if (reservation.operationState === "complete") {
      return reservation;
    }
    if (
      reservation.reservationExpiresAt !== null
      && reservation.reservationExpiresAt <= nowMs()
      && reservation.operationState === "reserved"
    ) {
      throw new Error("installation reservation expired");
    }
    const now = nowMs();
    await this.db.batch([
      this.db.prepare(
        `UPDATE installations
         SET state = 'provisioning'
         WHERE id = ? AND state IN ('reserved', 'provisioning')`,
      ).bind(reservation.installationId),
      this.db.prepare(
        `UPDATE hostnames
         SET state = 'provisioning'
         WHERE installation_id = ? AND state IN ('reserved', 'provisioning')`,
      ).bind(reservation.installationId),
      this.db.prepare(
        `UPDATE provisioning_operations
         SET state = 'provisioning', attempt = attempt + 1, last_error = NULL, updated_at = ?
         WHERE operation_id = ? AND principal_id = ? AND state != 'complete'`,
      ).bind(now, operationId, principalId),
    ]);
    return await this.requireOwnedReservation(operationId, principalId);
  }

  async completeProvisioning(
    operationIdValue: string,
    principalIdValue: string,
    expectedUsername: string,
    result: ProvisionInstallationResult,
  ): Promise<InstallationReservation> {
    const operationId = parseOpaqueId(operationIdValue, "operationId");
    const principalId = parseOpaqueId(principalIdValue, "principalId");
    const reservation = await this.requireOwnedReservation(operationId, principalId);
    if (
      result.state !== "active"
      || result.installationId !== reservation.installationId
      || result.principalId !== principalId
      || result.provisionVersion !== reservation.provisionVersion
      || result.username !== expectedUsername
      || !Number.isSafeInteger(result.localUid)
      || result.localUid < 1000
    ) {
      throw new Error("Gateway returned a mismatched provisioning result");
    }
    const now = nowMs();
    await this.db.batch([
      this.db.prepare(
        `UPDATE memberships
         SET local_uid = ?, state = 'active'
         WHERE installation_id = ? AND principal_id = ? AND role = 'owner'`,
      ).bind(result.localUid, reservation.installationId, principalId),
      this.db.prepare(
        `UPDATE installations
         SET state = 'active', reservation_expires_at = NULL,
             activated_at = COALESCE(activated_at, ?)
         WHERE id = ? AND owner_principal_id = ?`,
      ).bind(now, reservation.installationId, principalId),
      this.db.prepare(
        `UPDATE hostnames
         SET state = 'active'
         WHERE installation_id = ? AND kind = 'canonical'`,
      ).bind(reservation.installationId),
      this.db.prepare(
        `UPDATE provisioning_operations
         SET state = 'complete', last_error = NULL, updated_at = ?
         WHERE operation_id = ? AND principal_id = ?`,
      ).bind(now, operationId, principalId),
    ]);
    return await this.requireOwnedReservation(operationId, principalId);
  }

  async failProvisioning(operationIdValue: string, category: string): Promise<void> {
    const operationId = parseOpaqueId(operationIdValue, "operationId");
    await this.db.prepare(
      `UPDATE provisioning_operations
       SET state = 'failed', last_error = ?, updated_at = ?
       WHERE operation_id = ? AND state != 'complete'`,
    ).bind(category.slice(0, 100), nowMs(), operationId).run();
  }

  async resolveHostname(hostnameValue: string): Promise<InstallationDirectoryResult> {
    const hostname = hostnameValue.trim().toLowerCase().replace(/\.$/, "");
    if (!hostname || hostname.length > 253) {
      return { found: false };
    }
    const row = await this.db.prepare(
      `SELECT i.id, i.handle, i.canonical_origin, i.state
       FROM hostnames h
       JOIN installations i ON i.id = h.installation_id
       WHERE h.normalized_hostname = ? AND h.state != 'retired'
       LIMIT 1`,
    ).bind(hostname).first<{
      id: string;
      handle: string;
      canonical_origin: string;
      state: ManagedInstallationState;
    }>();
    if (!row) return { found: false };
    return {
      found: true,
      installationId: row.id,
      handle: row.handle,
      canonicalOrigin: row.canonical_origin,
      state: row.state,
    };
  }

  async getPrincipal(principalIdValue: string): Promise<PrincipalRecord | null> {
    const principalId = parseOpaqueId(principalIdValue, "principalId");
    const row = await this.db.prepare(
      `SELECT id, primary_email, state, email_verified_at
       FROM principals WHERE id = ? LIMIT 1`,
    ).bind(principalId).first<{
      id: string;
      primary_email: string;
      state: PrincipalRecord["state"];
      email_verified_at: number | null;
    }>();
    return row ? {
      id: row.id,
      email: row.primary_email,
      state: row.state,
      emailVerifiedAt: row.email_verified_at,
    } : null;
  }

  async getReservationByOperation(operationIdValue: string): Promise<InstallationReservation | null> {
    const operationId = parseOpaqueId(operationIdValue, "operationId");
    const row = await this.db.prepare(
      `SELECT
         i.id, i.owner_principal_id, i.handle, i.canonical_origin, i.state,
         i.provision_version, i.reservation_expires_at,
         p.operation_id, p.state AS operation_state
       FROM provisioning_operations p
       JOIN installations i ON i.id = p.installation_id
       WHERE p.operation_id = ?
       LIMIT 1`,
    ).bind(operationId).first<InstallationRow & {
      operation_id: string;
      operation_state: InstallationReservation["operationState"];
    }>();
    return row ? reservationFromRow(row) : null;
  }

  private async requireOwnedReservation(
    operationId: string,
    principalId: string,
  ): Promise<InstallationReservation> {
    const reservation = await this.getReservationByOperation(operationId);
    if (!reservation || reservation.ownerPrincipalId !== principalId) {
      throw new Error("provisioning operation is unavailable");
    }
    return reservation;
  }
}

function reservationFromRow(
  row: InstallationRow & {
    operation_id: string;
    operation_state: InstallationReservation["operationState"];
  },
): InstallationReservation {
  return {
    installationId: row.id,
    ownerPrincipalId: row.owner_principal_id,
    handle: row.handle,
    canonicalOrigin: row.canonical_origin,
    state: row.state,
    provisionVersion: row.provision_version,
    reservationExpiresAt: row.reservation_expires_at,
    operationId: row.operation_id,
    operationState: row.operation_state,
  };
}

function parseProvisionVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("provisionVersion is invalid");
  }
  return value;
}

function normalizeEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length < 3
    || normalized.length > 254
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
  ) {
    throw new Error("email is invalid");
  }
  return normalized;
}
