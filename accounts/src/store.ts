import type {
  InstallationDirectoryResult,
  ManagedInstallationIdentity,
  ManagedInstallationState,
} from "@humansandmachines/gsv/protocol";
import {
  hostnameForHandle,
  installationIdentity,
  normalizeHostname,
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

export type InstallationDataDeletionState =
  | "pending"
  | "deleting"
  | "complete"
  | "failed";

export type InstallationResetReservation = InstallationReservation & {
  previousInstallationId: string;
  dataDeletionState: InstallationDataDeletionState;
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
    private readonly installationOriginTemplate?: string,
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
    const now = Date.now();
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

    const identity = installationIdentity(
      handle,
      this.baseDomain,
      this.installationOriginTemplate,
    );
    const hostname = hostnameForHandle(handle, this.baseDomain);
    const now = Date.now();
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

  async resetInstallation(input: {
    installationId: string;
    operationId: string;
    confirmHandle: string;
  }): Promise<InstallationResetReservation> {
    const previousInstallationId = parseOpaqueId(
      input.installationId,
      "installationId",
    );
    const operationId = parseOpaqueId(input.operationId, "operationId");
    const confirmHandle = parseHandle(input.confirmHandle);
    const replay = await this.getResetByOperation(operationId);
    if (replay) {
      if (
        replay.previousInstallationId !== previousInstallationId
        || replay.handle !== confirmHandle
      ) {
        throw new Error("operationId was already used for a different reset");
      }
      return replay;
    }

    const previous = await this.db.prepare(
      `SELECT handle, canonical_origin
       FROM installations
       WHERE id = ? AND state IN ('active', 'restricted')
       LIMIT 1`,
    ).bind(previousInstallationId).first<{
      handle: string;
      canonical_origin: string;
    }>();
    if (!previous) {
      throw new Error("installation cannot be reset from its current state");
    }
    if (previous.handle !== confirmHandle) {
      throw new Error("installation reset confirmation does not match handle");
    }

    const replacement = installationIdentity(
      previous.handle,
      this.baseDomain,
      this.installationOriginTemplate,
    );
    if (replacement.canonicalOrigin !== previous.canonical_origin) {
      throw new Error("installation canonical origin is inconsistent");
    }
    const retiredHandle = `reset-${crypto.randomUUID()}`;
    const retiredOrigin = `https://${retiredHandle}.invalid`;
    const canonicalHostname = hostnameForHandle(
      previous.handle,
      this.baseDomain,
    );
    const now = Date.now();
    const reservationExpiresAt = now + RESERVATION_TTL_MS;

    const results = await this.db.batch([
      this.db.prepare(
        `UPDATE installations
         SET handle = ?, canonical_origin = ?, state = 'retained',
             reservation_expires_at = NULL, retained_until = NULL
         WHERE id = ? AND handle = ? AND canonical_origin = ?
           AND state IN ('active', 'restricted')
           AND EXISTS (
             SELECT 1 FROM hostnames h
             WHERE h.installation_id = installations.id
               AND h.normalized_hostname = ?
               AND h.kind = 'canonical' AND h.state = 'active'
           )`,
      ).bind(
        retiredHandle,
        retiredOrigin,
        previousInstallationId,
        previous.handle,
        previous.canonical_origin,
        canonicalHostname,
      ),
      this.db.prepare(
        `INSERT INTO installation_reset_operations (
           operation_id, previous_installation_id,
           replacement_installation_id, handle, canonical_origin,
           canonical_hostname, data_deletion_state, last_error,
           created_at, updated_at, completed_at
         )
         SELECT ?, i.id, ?, ?, ?, h.normalized_hostname,
                'pending', NULL, ?, ?, NULL
         FROM installations i
         JOIN hostnames h
           ON h.installation_id = i.id
          AND h.kind = 'canonical'
          AND h.state = 'active'
         WHERE i.id = ? AND i.handle = ? AND i.canonical_origin = ?
           AND i.state = 'retained' AND h.normalized_hostname = ?`,
      ).bind(
        operationId,
        replacement.installationId,
        replacement.handle,
        replacement.canonicalOrigin,
        now,
        now,
        previousInstallationId,
        retiredHandle,
        retiredOrigin,
        canonicalHostname,
      ),
      this.db.prepare(
        `INSERT INTO installations (
           id, owner_principal_id, handle, canonical_origin, state,
           provision_version, reservation_expires_at, created_at
         )
         SELECT r.replacement_installation_id, i.owner_principal_id,
                r.handle, r.canonical_origin, 'reserved',
                i.provision_version, ?, ?
         FROM installation_reset_operations r
         JOIN installations i ON i.id = r.previous_installation_id
         WHERE r.operation_id = ? AND r.previous_installation_id = ?
           AND r.replacement_installation_id = ?`,
      ).bind(
        reservationExpiresAt,
        now,
        operationId,
        previousInstallationId,
        replacement.installationId,
      ),
      this.db.prepare(
        `UPDATE hostnames
         SET installation_id = ?, state = 'reserved', created_at = ?,
             retired_at = NULL
         WHERE normalized_hostname = ? AND installation_id = ?
           AND kind = 'canonical' AND state = 'active'
           AND EXISTS (
             SELECT 1 FROM installation_reset_operations
             WHERE operation_id = ? AND replacement_installation_id = ?
           )`,
      ).bind(
        replacement.installationId,
        now,
        canonicalHostname,
        previousInstallationId,
        operationId,
        replacement.installationId,
      ),
      this.db.prepare(
        `UPDATE hostnames
         SET state = 'retired', retired_at = ?
         WHERE installation_id = ? AND kind = 'alias' AND state != 'retired'
           AND EXISTS (
             SELECT 1 FROM installation_reset_operations
             WHERE operation_id = ? AND replacement_installation_id = ?
           )`,
      ).bind(
        now,
        previousInstallationId,
        operationId,
        replacement.installationId,
      ),
      this.db.prepare(
        `INSERT INTO memberships (
           installation_id, principal_id, local_uid, role, state, created_at
         )
         SELECT r.replacement_installation_id, i.owner_principal_id,
                NULL, 'owner', 'pending', ?
         FROM installation_reset_operations r
         JOIN installations i ON i.id = r.previous_installation_id
         WHERE r.operation_id = ? AND r.replacement_installation_id = ?`,
      ).bind(now, operationId, replacement.installationId),
      this.db.prepare(
        `INSERT INTO provisioning_operations (
           operation_id, installation_id, principal_id, kind, state,
           attempt, last_error, updated_at
         )
         SELECT r.operation_id, r.replacement_installation_id,
                i.owner_principal_id, 'create', 'reserved', 0, NULL, ?
         FROM installation_reset_operations r
         JOIN installations i ON i.id = r.previous_installation_id
         WHERE r.operation_id = ? AND r.replacement_installation_id = ?`,
      ).bind(now, operationId, replacement.installationId),
      this.db.prepare(
        `INSERT INTO managed_inference_policies (
           installation_id, enabled, monthly_limit_nano_usd, updated_at
         )
         SELECT ?, p.enabled, p.monthly_limit_nano_usd, ?
         FROM managed_inference_policies p
         WHERE p.installation_id = ?
           AND EXISTS (
             SELECT 1 FROM installation_reset_operations
             WHERE operation_id = ? AND replacement_installation_id = ?
           )`,
      ).bind(
        replacement.installationId,
        now,
        previousInstallationId,
        operationId,
        replacement.installationId,
      ),
      this.db.prepare(
        `UPDATE managed_inference_policies
         SET enabled = 0, updated_at = ?
         WHERE installation_id = ?
           AND EXISTS (
             SELECT 1 FROM installation_reset_operations
             WHERE operation_id = ? AND replacement_installation_id = ?
           )`,
      ).bind(
        now,
        previousInstallationId,
        operationId,
        replacement.installationId,
      ),
    ]);

    const committed = await this.getResetByOperation(operationId);
    if (committed) {
      if (
        committed.previousInstallationId !== previousInstallationId
        || committed.handle !== confirmHandle
      ) {
        throw new Error("operationId was already used for a different reset");
      }
      const requiredChanges = [0, 1, 2, 3, 5, 6];
      if (
        (results[1]?.meta.changes ?? 0) === 1
        && requiredChanges.some(
          (index) => (results[index]?.meta.changes ?? 0) !== 1,
        )
      ) {
        throw new Error("installation reset was not committed completely");
      }
      return committed;
    }
    throw new Error("installation cannot be reset from its current state");
  }

  async getResetByOperation(
    operationIdValue: string,
  ): Promise<InstallationResetReservation | null> {
    const operationId = parseOpaqueId(operationIdValue, "operationId");
    const row = await this.db.prepare(
      `SELECT
         i.id, i.owner_principal_id,
         r.handle AS handle, r.canonical_origin AS canonical_origin, i.state,
         i.provision_version, i.reservation_expires_at,
         p.operation_id, p.state AS operation_state,
         r.previous_installation_id, r.data_deletion_state
       FROM installation_reset_operations r
       JOIN installations i ON i.id = r.replacement_installation_id
       JOIN provisioning_operations p
         ON p.operation_id = r.operation_id
        AND p.installation_id = r.replacement_installation_id
       WHERE r.operation_id = ?
       LIMIT 1`,
    ).bind(operationId).first<InstallationRow & {
      operation_id: string;
      operation_state: InstallationReservation["operationState"];
      previous_installation_id: string;
      data_deletion_state: InstallationDataDeletionState;
    }>();
    if (!row) return null;
    return {
      ...reservationFromRow(row),
      previousInstallationId: row.previous_installation_id,
      dataDeletionState: row.data_deletion_state,
    };
  }

  async resolveHostname(hostnameValue: string): Promise<InstallationDirectoryResult> {
    const hostname = normalizeHostname(hostnameValue);
    if (!hostname) return { found: false };

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

  async resolveInstallation(
    installationIdValue: string,
  ): Promise<InstallationDirectoryResult> {
    let installationId: string;
    try {
      installationId = parseOpaqueId(installationIdValue, "installationId");
    } catch {
      return { found: false };
    }

    const row = await this.db.prepare(
      `SELECT id, handle, canonical_origin, state
       FROM installations
       WHERE id = ?
       LIMIT 1`,
    ).bind(installationId).first<{
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

  async beginProvisioning(
    operationIdValue: string,
    principalIdValue: string,
  ): Promise<InstallationReservation> {
    const operationId = parseOpaqueId(operationIdValue, "operationId");
    const principalId = parseOpaqueId(principalIdValue, "principalId");
    const reservation = await this.requireOwnedReservation(operationId, principalId);
    if (
      reservation.state === "provisioning"
      && reservation.operationState === "provisioning"
    ) {
      return reservation;
    }
    if (reservation.state !== "reserved" || reservation.operationState !== "reserved") {
      throw new Error("installation is not reserved");
    }

    const now = Date.now();
    const results = await this.db.batch([
      this.db.prepare(
        `UPDATE installations
         SET state = 'provisioning'
         WHERE id = ? AND owner_principal_id = ? AND state = 'reserved'`,
      ).bind(reservation.installationId, principalId),
      this.db.prepare(
        `UPDATE hostnames
         SET state = 'provisioning'
         WHERE installation_id = ? AND kind = 'canonical' AND state = 'reserved'`,
      ).bind(reservation.installationId),
      this.db.prepare(
        `UPDATE provisioning_operations
         SET state = 'provisioning', attempt = attempt + 1,
             last_error = NULL, updated_at = ?
         WHERE operation_id = ? AND principal_id = ? AND state = 'reserved'`,
      ).bind(now, operationId, principalId),
    ]);
    if (results.some((result) => (result.meta.changes ?? 0) !== 1)) {
      throw new Error("installation could not enter provisioning");
    }
    return await this.requireOwnedReservation(operationId, principalId);
  }

  async completeInstallationOnboarding(
    operationIdValue: string,
    principalIdValue: string,
    claimIdValue: string,
  ): Promise<InstallationReservation> {
    const operationId = parseOpaqueId(operationIdValue, "operationId");
    const principalId = parseOpaqueId(principalIdValue, "principalId");
    const claimId = parseOpaqueId(claimIdValue, "claimId");
    const reservation = await this.requireOwnedReservation(operationId, principalId);
    if (
      reservation.state !== "provisioning"
      || reservation.operationState !== "provisioning"
    ) {
      throw new Error("installation is not awaiting onboarding");
    }

    const now = Date.now();
    const results = await this.db.batch([
      this.db.prepare(
        `UPDATE installations
         SET state = 'active', reservation_expires_at = NULL,
             activated_at = COALESCE(activated_at, ?)
         WHERE id = ? AND owner_principal_id = ? AND state = 'provisioning'`,
      ).bind(now, reservation.installationId, principalId),
      this.db.prepare(
        `UPDATE hostnames
         SET state = 'active'
         WHERE installation_id = ? AND kind = 'canonical'
           AND state = 'provisioning'`,
      ).bind(reservation.installationId),
      this.db.prepare(
        `UPDATE provisioning_operations
         SET state = 'complete', last_error = NULL, updated_at = ?
         WHERE operation_id = ? AND principal_id = ? AND state = 'provisioning'`,
      ).bind(now, operationId, principalId),
      this.db.prepare(
        `UPDATE installation_onboarding_claims
         SET completed_at = ?
         WHERE id = ? AND installation_id = ?
           AND completed_at IS NULL AND revoked_at IS NULL`,
      ).bind(now, claimId, reservation.installationId),
    ]);
    if (results.some((result) => (result.meta.changes ?? 0) !== 1)) {
      throw new Error("installation onboarding could not be activated");
    }
    return await this.requireOwnedReservation(operationId, principalId);
  }

  async getReservationByOperation(
    operationIdValue: string,
  ): Promise<InstallationReservation | null> {
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
      throw new Error("installation reservation is unavailable");
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
