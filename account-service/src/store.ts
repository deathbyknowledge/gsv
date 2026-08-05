import type {
  InstallationDirectoryResult,
  ManagedInstallationIdentity,
  ManagedInstallationState,
  ProvisionInstallationResult,
} from "@humansandmachines/gsv/protocol";
import {
  hostnameForHandle,
  installationIdentity,
  normalizeEmail,
  nowMs,
  parseBaseDomain,
  parseHandle,
  parseOpaqueId,
  parseTimezone,
  parseUsername,
} from "./domain";
import { EntitlementStore } from "./entitlements/store";

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
  ownerUsername: string | null;
  agentName: string | null;
  timezone: string | null;
};

export type ActiveInstallationMembership = ManagedInstallationIdentity & {
  state: ManagedInstallationState;
  localUid: number;
  role: "owner" | "admin" | "member";
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
    private readonly canonicalOriginTemplate?: string,
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
    ownerUsername?: string;
    agentName?: string;
    timezone?: string;
  }): Promise<InstallationReservation> {
    const principalId = parseOpaqueId(input.principalId, "principalId");
    const operationId = parseOpaqueId(input.operationId, "operationId");
    const handle = parseHandle(input.handle);
    const ownerUsername = input.ownerUsername === undefined
      ? null
      : parseUsername(input.ownerUsername, "ownerUsername");
    const agentName = input.agentName === undefined
      ? null
      : parseUsername(input.agentName, "agentName");
    if (agentName !== null && agentName === ownerUsername) {
      throw new Error("agentName must be different from ownerUsername");
    }
    const timezone = input.timezone === undefined ? null : parseTimezone(input.timezone);
    const existing = await this.getReservationByOperation(operationId);
    if (existing) {
      if (
        existing.ownerPrincipalId !== principalId
        || existing.handle !== handle
        || existing.ownerUsername !== ownerUsername
        || existing.agentName !== agentName
        || existing.timezone !== timezone
      ) {
        throw new Error("operationId was already used for a different reservation");
      }
      return existing;
    }

    const identity = installationIdentity(
      handle,
      this.baseDomain,
      this.canonicalOriginTemplate,
    );
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
             attempt, last_error, updated_at, owner_username, agent_name, timezone
           ) VALUES (?, ?, ?, 'create', 'reserved', 0, NULL, ?, ?, ?, ?)`,
        ).bind(
          operationId,
          identity.installationId,
          principalId,
          now,
          ownerUsername,
          agentName,
          timezone,
        ),
        this.db.prepare(
          `INSERT INTO audit_events (
             id, principal_id, installation_id, action, outcome, created_at, metadata_json
           )
           SELECT ?, ?, id, 'installation.reserved', 'succeeded', ?, '{}'
           FROM installations
           WHERE id = ? AND owner_principal_id = ?`,
        ).bind(
          `audit_${crypto.randomUUID()}`,
          principalId,
          now,
          identity.installationId,
          principalId,
        ),
      ]);
    } catch (error) {
      const replay = await this.getReservationByOperation(operationId);
      if (replay) {
        if (
          replay.ownerPrincipalId !== principalId
          || replay.handle !== handle
          || replay.ownerUsername !== ownerUsername
          || replay.agentName !== agentName
          || replay.timezone !== timezone
        ) {
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
    await new EntitlementStore(this.db).requireProvisioningAllowed(
      reservation.installationId,
    );
    if (
      reservation.reservationExpiresAt !== null
      && reservation.reservationExpiresAt <= nowMs()
      && reservation.operationState === "reserved"
    ) {
      throw new Error("installation reservation expired");
    }
    const now = nowMs();
    const results = await this.db.batch([
      this.db.prepare(
        `UPDATE installations
         SET state = 'provisioning'
         WHERE id = ? AND state IN ('reserved', 'provisioning')
           AND EXISTS (
             SELECT 1 FROM entitlements e
             WHERE e.installation_id = installations.id
               AND e.state IN ('trialing', 'active') AND e.effective_at <= ?
           )`,
      ).bind(reservation.installationId, now),
      this.db.prepare(
        `UPDATE hostnames
         SET state = 'provisioning'
         WHERE installation_id = ? AND state IN ('reserved', 'provisioning')
           AND EXISTS (
             SELECT 1 FROM entitlements e
             WHERE e.installation_id = hostnames.installation_id
               AND e.state IN ('trialing', 'active') AND e.effective_at <= ?
           )`,
      ).bind(reservation.installationId, now),
      this.db.prepare(
        `UPDATE provisioning_operations
         SET state = 'provisioning', attempt = attempt + 1, last_error = NULL, updated_at = ?
         WHERE operation_id = ? AND principal_id = ? AND state != 'complete'
           AND EXISTS (
             SELECT 1 FROM entitlements e
             WHERE e.installation_id = provisioning_operations.installation_id
               AND e.state IN ('trialing', 'active') AND e.effective_at <= ?
           )`,
      ).bind(now, operationId, principalId, now),
      this.db.prepare(
        `INSERT INTO audit_events (
           id, principal_id, installation_id, action, outcome, created_at, metadata_json
         )
         SELECT ?, principal_id, installation_id,
                'installation.provisioning_started', 'succeeded', ?, '{}'
         FROM provisioning_operations
         WHERE operation_id = ? AND principal_id = ?
           AND state = 'provisioning' AND updated_at = ?`,
      ).bind(
        `audit_${crypto.randomUUID()}`,
        now,
        operationId,
        principalId,
        now,
      ),
    ]);
    if ((results[2]?.meta.changes ?? 0) !== 1) {
      throw new Error("provisioning entitlement is required");
    }
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
    const results = await this.db.batch([
      this.db.prepare(
        `UPDATE memberships
         SET local_uid = ?, state = 'active'
         WHERE installation_id = ? AND principal_id = ? AND role = 'owner'
           AND EXISTS (
             SELECT 1 FROM entitlements e
             WHERE e.installation_id = memberships.installation_id
               AND e.effective_at <= ?
           )`,
      ).bind(result.localUid, reservation.installationId, principalId, now),
      this.db.prepare(
        `UPDATE installations
         SET state = (
               SELECT e.state FROM entitlements e
               WHERE e.installation_id = installations.id AND e.effective_at <= ?
             ),
             reservation_expires_at = NULL,
             activated_at = COALESCE(activated_at, ?)
         WHERE id = ? AND owner_principal_id = ?
           AND EXISTS (
             SELECT 1 FROM entitlements e
             WHERE e.installation_id = installations.id AND e.effective_at <= ?
           )`,
      ).bind(now, now, reservation.installationId, principalId, now),
      this.db.prepare(
        `UPDATE hostnames
         SET state = 'active'
         WHERE installation_id = ? AND kind = 'canonical'
           AND EXISTS (
             SELECT 1 FROM entitlements e
             WHERE e.installation_id = hostnames.installation_id
               AND e.effective_at <= ?
           )`,
      ).bind(reservation.installationId, now),
      this.db.prepare(
        `UPDATE provisioning_operations
         SET state = 'complete', last_error = NULL, updated_at = ?
         WHERE operation_id = ? AND principal_id = ?
           AND EXISTS (
             SELECT 1 FROM entitlements e
             WHERE e.installation_id = provisioning_operations.installation_id
               AND e.effective_at <= ?
           )`,
      ).bind(now, operationId, principalId, now),
      this.db.prepare(
        `INSERT INTO audit_events (
           id, principal_id, installation_id, action, outcome, created_at, metadata_json
         )
         SELECT ?, principal_id, installation_id,
                'installation.provisioned', 'succeeded', ?, '{}'
         FROM provisioning_operations
         WHERE operation_id = ? AND principal_id = ?
           AND state = 'complete' AND updated_at = ?`,
      ).bind(
        `audit_${crypto.randomUUID()}`,
        now,
        operationId,
        principalId,
        now,
      ),
    ]);
    if (results.slice(0, 4).some((statement) => (statement.meta.changes ?? 0) !== 1)) {
      throw new Error("provisioning entitlement is unavailable");
    }
    return await this.requireOwnedReservation(operationId, principalId);
  }

  async failProvisioning(operationIdValue: string, category: string): Promise<void> {
    const operationId = parseOpaqueId(operationIdValue, "operationId");
    const now = nowMs();
    await this.db.batch([
      this.db.prepare(
        `UPDATE provisioning_operations
         SET state = 'failed', last_error = ?, updated_at = ?
         WHERE operation_id = ? AND state != 'complete'`,
      ).bind(category.slice(0, 100), now, operationId),
      this.db.prepare(
        `INSERT INTO audit_events (
           id, principal_id, installation_id, action, outcome, created_at, metadata_json
         )
         SELECT ?, principal_id, installation_id,
                'installation.provisioning_failed', 'failed', ?, '{}'
         FROM provisioning_operations
         WHERE operation_id = ? AND state = 'failed' AND updated_at = ?`,
      ).bind(`audit_${crypto.randomUUID()}`, now, operationId, now),
    ]);
  }

  async expireReservations(now = nowMs()): Promise<number> {
    const results = await this.db.batch([
      this.db.prepare(
        `INSERT OR IGNORE INTO audit_events (
           id, principal_id, installation_id, action, outcome, created_at, metadata_json
         )
         SELECT 'audit_reservation_expired_' || id, owner_principal_id, id,
                'installation.reservation_expired', 'succeeded', ?, '{}'
         FROM installations
         WHERE state = 'reserved' AND reservation_expires_at <= ?`,
      ).bind(now, now),
      this.db.prepare(
        `DELETE FROM installations
         WHERE state = 'reserved' AND reservation_expires_at <= ?`,
      ).bind(now),
    ]);
    return results[0]?.meta.changes ?? 0;
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
         p.operation_id, p.state AS operation_state,
         p.owner_username, p.agent_name, p.timezone
       FROM provisioning_operations p
       JOIN installations i ON i.id = p.installation_id
       WHERE p.operation_id = ?
       LIMIT 1`,
    ).bind(operationId).first<InstallationRow & {
      operation_id: string;
      operation_state: InstallationReservation["operationState"];
      owner_username: string | null;
      agent_name: string | null;
      timezone: string | null;
    }>();
    return row ? reservationFromRow(row) : null;
  }

  async getOwnedInstallation(
    installationIdValue: string,
    principalIdValue: string,
  ): Promise<InstallationReservation | null> {
    const installationId = parseOpaqueId(installationIdValue, "installationId");
    const principalId = parseOpaqueId(principalIdValue, "principalId");
    const row = await this.db.prepare(
      `SELECT
         i.id, i.owner_principal_id, i.handle, i.canonical_origin, i.state,
         i.provision_version, i.reservation_expires_at,
         p.operation_id, p.state AS operation_state,
         p.owner_username, p.agent_name, p.timezone
       FROM installations i
       JOIN provisioning_operations p
         ON p.installation_id = i.id AND p.kind = 'create'
       WHERE i.id = ? AND i.owner_principal_id = ? AND i.state != 'deleted'
       LIMIT 1`,
    ).bind(installationId, principalId).first<InstallationRow & {
      operation_id: string;
      operation_state: InstallationReservation["operationState"];
      owner_username: string | null;
      agent_name: string | null;
      timezone: string | null;
    }>();
    return row ? reservationFromRow(row) : null;
  }

  async listInstallationsForPrincipal(
    principalIdValue: string,
  ): Promise<InstallationReservation[]> {
    const principalId = parseOpaqueId(principalIdValue, "principalId");
    const rows = await this.db.prepare(
      `SELECT
         i.id, i.owner_principal_id, i.handle, i.canonical_origin, i.state,
         i.provision_version, i.reservation_expires_at,
         p.operation_id, p.state AS operation_state,
         p.owner_username, p.agent_name, p.timezone
       FROM memberships m
       JOIN installations i ON i.id = m.installation_id
       JOIN provisioning_operations p
         ON p.installation_id = i.id AND p.kind = 'create'
       WHERE m.principal_id = ? AND m.state != 'revoked' AND i.state != 'deleted'
       ORDER BY i.created_at DESC`,
    ).bind(principalId).all<InstallationRow & {
      operation_id: string;
      operation_state: InstallationReservation["operationState"];
      owner_username: string | null;
      agent_name: string | null;
      timezone: string | null;
    }>();
    return rows.results.map(reservationFromRow);
  }

  async recordInstallationExportRequested(input: {
    principalId: string;
    installationId: string;
    now?: number;
  }): Promise<void> {
    const principalId = parseOpaqueId(input.principalId, "principalId");
    const installationId = parseOpaqueId(input.installationId, "installationId");
    const now = input.now ?? nowMs();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error("export timestamp is invalid");
    }
    const result = await this.db.prepare(
      `INSERT INTO audit_events (
         id, principal_id, installation_id, action, outcome,
         created_at, metadata_json
       )
       SELECT ?, ?, id, 'installation.export_requested', 'succeeded', ?, '{}'
       FROM installations
       WHERE id = ? AND owner_principal_id = ? AND state != 'deleted'`,
    ).bind(
      `audit_${crypto.randomUUID()}`,
      principalId,
      now,
      installationId,
      principalId,
    ).run();
    if ((result.meta.changes ?? 0) !== 1) {
      throw new Error("installation is unavailable");
    }
  }

  async listActiveInstallationMemberships(
    principalIdValue: string,
  ): Promise<ActiveInstallationMembership[]> {
    const principalId = parseOpaqueId(principalIdValue, "principalId");
    const rows = await this.db.prepare(
      `SELECT
         i.id, i.handle, i.canonical_origin, i.state, m.local_uid, m.role
       FROM memberships m
       JOIN installations i ON i.id = m.installation_id
       WHERE m.principal_id = ? AND m.state = 'active'
         AND m.local_uid IS NOT NULL
         AND i.state IN (
           'trialing', 'active', 'past_due', 'restricted',
           'cancelled', 'retained'
         )
       ORDER BY i.created_at DESC`,
    ).bind(principalId).all<{
      id: string;
      handle: string;
      canonical_origin: string;
      state: ManagedInstallationState;
      local_uid: number;
      role: ActiveInstallationMembership["role"];
    }>();
    return rows.results.map((row) => ({
      installationId: row.id,
      handle: row.handle,
      canonicalOrigin: row.canonical_origin,
      state: row.state,
      localUid: row.local_uid,
      role: row.role,
    }));
  }

  async getActiveInstallationMembership(
    principalIdValue: string,
    installationIdValue: string,
  ): Promise<ActiveInstallationMembership | null> {
    const principalId = parseOpaqueId(principalIdValue, "principalId");
    const installationId = parseOpaqueId(
      installationIdValue,
      "installationId",
    );
    const row = await this.db.prepare(
      `SELECT
         i.id, i.handle, i.canonical_origin, i.state, m.local_uid, m.role
       FROM memberships m
       JOIN installations i ON i.id = m.installation_id
       WHERE m.principal_id = ? AND m.installation_id = ?
         AND m.state = 'active' AND m.local_uid IS NOT NULL
         AND i.state IN (
           'trialing', 'active', 'past_due', 'restricted',
           'cancelled', 'retained'
         )
       LIMIT 1`,
    ).bind(principalId, installationId).first<{
      id: string;
      handle: string;
      canonical_origin: string;
      state: ManagedInstallationState;
      local_uid: number;
      role: ActiveInstallationMembership["role"];
    }>();
    return row ? {
      installationId: row.id,
      handle: row.handle,
      canonicalOrigin: row.canonical_origin,
      state: row.state,
      localUid: row.local_uid,
      role: row.role,
    } : null;
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
    owner_username: string | null;
    agent_name: string | null;
    timezone: string | null;
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
    ownerUsername: row.owner_username,
    agentName: row.agent_name,
    timezone: row.timezone,
  };
}

function parseProvisionVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("provisionVersion is invalid");
  }
  return value;
}
