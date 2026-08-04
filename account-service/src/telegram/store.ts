import type {
  ManagedTelegramClaim,
  ManagedTelegramPeerRoute,
} from "@humansandmachines/gsv/protocol";
import { parseOpaqueId } from "../domain";
import type { ActiveInstallationMembership } from "../store";

export type ManagedTelegramLinkOperationState =
  | "created"
  | "route_suspended"
  | "old_kernel_unlinked"
  | "new_kernel_linked"
  | "complete";

export type ManagedTelegramLinkOperation = {
  operationId: string;
  claimId: string;
  claimTokenHash: string;
  principalId: string;
  actorId: string;
  surfaceId: string;
  target: ActiveInstallationMembership;
  previousRoute?: ManagedTelegramPeerRoute;
  state: ManagedTelegramLinkOperationState;
  attempt: number;
};

type OperationRow = {
  operation_id: string;
  claim_id: string;
  claim_token_hash: string;
  principal_id: string;
  actor_id: string;
  surface_id: string;
  target_installation_id: string;
  target_local_uid: number;
  target_canonical_origin: string;
  target_handle: string;
  target_state: ActiveInstallationMembership["state"];
  target_role: ActiveInstallationMembership["role"];
  previous_installation_id: string | null;
  previous_local_uid: number | null;
  previous_canonical_origin: string | null;
  state: ManagedTelegramLinkOperationState;
  attempt: number;
};

const STAGE_ORDER: Record<ManagedTelegramLinkOperationState, number> = {
  created: 0,
  route_suspended: 1,
  old_kernel_unlinked: 2,
  new_kernel_linked: 3,
  complete: 4,
};

export class ManagedTelegramLinkOperationStore {
  constructor(private readonly db: D1Database) {}

  async findByTokenHash(
    claimTokenHash: string,
  ): Promise<ManagedTelegramLinkOperation | null> {
    return await this.find("o.claim_token_hash = ?", parseHash(claimTokenHash));
  }

  async get(operationIdValue: string): Promise<ManagedTelegramLinkOperation | null> {
    return await this.find(
      "o.operation_id = ?",
      parseOpaqueId(operationIdValue, "operationId"),
    );
  }

  async findByClaimId(claimIdValue: string): Promise<ManagedTelegramLinkOperation | null> {
    return await this.find(
      "o.claim_id = ?",
      parseOpaqueId(claimIdValue, "claimId"),
    );
  }

  async begin(input: {
    operationId: string;
    claimTokenHash: string;
    principalId: string;
    claim: ManagedTelegramClaim;
    target: ActiveInstallationMembership;
  }): Promise<ManagedTelegramLinkOperation> {
    const operationId = parseOpaqueId(input.operationId, "operationId");
    const principalId = parseOpaqueId(input.principalId, "principalId");
    const claimId = parseOpaqueId(input.claim.claimId, "claimId");
    const actorId = parseTelegramId(input.claim.actorId, "actorId");
    const surfaceId = parseTelegramId(input.claim.surfaceId, "surfaceId");
    if (actorId !== surfaceId) {
      throw new Error("Managed Telegram supports direct messages only");
    }
    const tokenHash = parseHash(input.claimTokenHash);
    const now = Date.now();
    try {
      await this.db.prepare(
        `INSERT INTO managed_telegram_link_operations (
           operation_id, claim_id, claim_token_hash, principal_id,
           actor_id, surface_id, target_installation_id, target_local_uid,
           target_canonical_origin, state, attempt, last_error_code,
           created_at, updated_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', 0, NULL, ?, ?, NULL)`,
      ).bind(
        operationId,
        claimId,
        tokenHash,
        principalId,
        actorId,
        surfaceId,
        input.target.installationId,
        input.target.localUid,
        input.target.canonicalOrigin,
        now,
        now,
      ).run();
    } catch (error) {
      const existing = await this.findByTokenHash(tokenHash)
        ?? await this.findByClaimId(claimId)
        ?? await this.get(operationId);
      if (!existing) throw error;
      assertSameOperation(existing, {
        principalId,
        claimId,
        tokenHash,
        actorId,
        surfaceId,
        target: input.target,
      });
      return existing;
    }
    const operation = await this.get(operationId);
    if (!operation) throw new Error("Managed Telegram link operation was not committed");
    return operation;
  }

  async recordAttempt(operationId: string): Promise<void> {
    await this.db.prepare(
      `UPDATE managed_telegram_link_operations
       SET attempt = attempt + 1, last_error_code = NULL, updated_at = ?
       WHERE operation_id = ? AND state != 'complete'`,
    ).bind(Date.now(), parseOpaqueId(operationId, "operationId")).run();
  }

  async recordRouteSuspended(
    operationIdValue: string,
    previousRoute?: ManagedTelegramPeerRoute,
  ): Promise<ManagedTelegramLinkOperation> {
    const operationId = parseOpaqueId(operationIdValue, "operationId");
    const route = previousRoute ? parseRoute(previousRoute) : undefined;
    await this.db.prepare(
      `UPDATE managed_telegram_link_operations
       SET state = 'route_suspended',
           previous_installation_id = ?, previous_local_uid = ?,
           previous_canonical_origin = ?, updated_at = ?, last_error_code = NULL
       WHERE operation_id = ? AND state = 'created'`,
    ).bind(
      route?.installationId ?? null,
      route?.localUid ?? null,
      route?.canonicalOrigin ?? null,
      Date.now(),
      operationId,
    ).run();
    const operation = await this.require(operationId);
    if (STAGE_ORDER[operation.state] < STAGE_ORDER.route_suspended) {
      throw new Error("Managed Telegram route suspension was not committed");
    }
    if (!sameOptionalRoute(operation.previousRoute, route)) {
      throw new Error("Managed Telegram route suspension conflicts with stored state");
    }
    return operation;
  }

  async recordOldKernelUnlinked(
    operationId: string,
  ): Promise<ManagedTelegramLinkOperation> {
    return await this.advance(
      operationId,
      "route_suspended",
      "old_kernel_unlinked",
    );
  }

  async recordNewKernelLinked(
    operationId: string,
  ): Promise<ManagedTelegramLinkOperation> {
    return await this.advance(
      operationId,
      "old_kernel_unlinked",
      "new_kernel_linked",
    );
  }

  async complete(operationIdValue: string): Promise<ManagedTelegramLinkOperation> {
    const operationId = parseOpaqueId(operationIdValue, "operationId");
    const existing = await this.require(operationId);
    if (existing.state === "complete") return existing;
    const now = Date.now();
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO audit_events (
           id, principal_id, installation_id, action, outcome,
           created_at, metadata_json
         )
         SELECT ?, principal_id, target_installation_id,
                'telegram.managed_linked', 'succeeded', ?, '{}'
         FROM managed_telegram_link_operations
         WHERE operation_id = ? AND state = 'new_kernel_linked'`,
      ).bind(`audit_${crypto.randomUUID()}`, now, operationId),
      this.db.prepare(
        `UPDATE managed_telegram_link_operations
         SET state = 'complete', completed_at = ?, updated_at = ?, last_error_code = NULL
         WHERE operation_id = ? AND state = 'new_kernel_linked'`,
      ).bind(now, now, operationId),
    ]);
    const operation = await this.require(operationId);
    if (operation.state !== "complete") {
      throw new Error("Managed Telegram route activation was not committed");
    }
    return operation;
  }

  async recordFailure(
    operationIdValue: string,
    code: "telegram_unavailable" | "gateway_unavailable" | "membership_unavailable",
  ): Promise<void> {
    await this.db.prepare(
      `UPDATE managed_telegram_link_operations
       SET last_error_code = ?, updated_at = ?
       WHERE operation_id = ? AND state != 'complete'`,
    ).bind(
      code,
      Date.now(),
      parseOpaqueId(operationIdValue, "operationId"),
    ).run();
  }

  private async advance(
    operationIdValue: string,
    from: ManagedTelegramLinkOperationState,
    to: ManagedTelegramLinkOperationState,
  ): Promise<ManagedTelegramLinkOperation> {
    const operationId = parseOpaqueId(operationIdValue, "operationId");
    await this.db.prepare(
      `UPDATE managed_telegram_link_operations
       SET state = ?, updated_at = ?, last_error_code = NULL
       WHERE operation_id = ? AND state = ?`,
    ).bind(to, Date.now(), operationId, from).run();
    const operation = await this.require(operationId);
    if (STAGE_ORDER[operation.state] < STAGE_ORDER[to]) {
      throw new Error(`Managed Telegram ${to} state was not committed`);
    }
    return operation;
  }

  private async require(operationId: string): Promise<ManagedTelegramLinkOperation> {
    const operation = await this.get(operationId);
    if (!operation) throw new Error("Managed Telegram link operation is unavailable");
    return operation;
  }

  private async find(
    predicate: string,
    value: string,
  ): Promise<ManagedTelegramLinkOperation | null> {
    const row = await this.db.prepare(
      `SELECT
         o.operation_id, o.claim_id, o.claim_token_hash, o.principal_id,
         o.actor_id, o.surface_id, o.target_installation_id,
         o.target_local_uid, o.target_canonical_origin,
         o.previous_installation_id, o.previous_local_uid,
         o.previous_canonical_origin, o.state, o.attempt,
         i.handle AS target_handle, i.state AS target_state,
         m.role AS target_role
       FROM managed_telegram_link_operations o
       JOIN installations i ON i.id = o.target_installation_id
       JOIN memberships m
         ON m.installation_id = o.target_installation_id
        AND m.principal_id = o.principal_id
       WHERE ${predicate}
       LIMIT 1`,
    ).bind(value).first<OperationRow>();
    return row ? fromRow(row) : null;
  }
}

function fromRow(row: OperationRow): ManagedTelegramLinkOperation {
  const previousRoute = row.previous_installation_id === null
    ? undefined
    : {
        installationId: row.previous_installation_id,
        localUid: row.previous_local_uid!,
        canonicalOrigin: row.previous_canonical_origin!,
        linkedAt: 0,
      };
  return {
    operationId: row.operation_id,
    claimId: row.claim_id,
    claimTokenHash: row.claim_token_hash,
    principalId: row.principal_id,
    actorId: row.actor_id,
    surfaceId: row.surface_id,
    target: {
      installationId: row.target_installation_id,
      handle: row.target_handle,
      canonicalOrigin: row.target_canonical_origin,
      state: row.target_state,
      localUid: row.target_local_uid,
      role: row.target_role,
    },
    ...(previousRoute ? { previousRoute } : {}),
    state: row.state,
    attempt: row.attempt,
  };
}

function assertSameOperation(
  existing: ManagedTelegramLinkOperation,
  input: {
    principalId: string;
    claimId: string;
    tokenHash: string;
    actorId: string;
    surfaceId: string;
    target: ActiveInstallationMembership;
  },
): void {
  if (
    existing.principalId !== input.principalId
    || existing.claimId !== input.claimId
    || existing.claimTokenHash !== input.tokenHash
    || existing.actorId !== input.actorId
    || existing.surfaceId !== input.surfaceId
    || existing.target.installationId !== input.target.installationId
    || existing.target.localUid !== input.target.localUid
    || existing.target.canonicalOrigin !== input.target.canonicalOrigin
  ) {
    throw new Error("Managed Telegram claim is already owned by another link operation");
  }
}

function parseHash(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("claimTokenHash is invalid");
  }
  return value;
}

function parseTelegramId(value: string, field: string): string {
  if (!/^[1-9][0-9]{0,19}$/.test(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function parseRoute(route: ManagedTelegramPeerRoute): ManagedTelegramPeerRoute {
  if (
    !Number.isSafeInteger(route.localUid)
    || route.localUid < 0
    || !Number.isFinite(route.linkedAt)
    || route.linkedAt < 0
  ) {
    throw new Error("Managed Telegram route is invalid");
  }
  const canonicalOrigin = parseHttpsOrigin(route.canonicalOrigin);
  return {
    installationId: parseOpaqueId(route.installationId, "installationId"),
    localUid: route.localUid,
    canonicalOrigin,
    linkedAt: route.linkedAt,
  };
}

function parseHttpsOrigin(value: string): string {
  const normalized = value.trim();
  const url = new URL(normalized);
  if (
    url.protocol !== "https:"
    || url.origin !== normalized
    || url.pathname !== "/"
    || url.search
    || url.hash
    || url.username
    || url.password
  ) {
    throw new Error("Managed Telegram route origin is invalid");
  }
  return url.origin;
}

function sameOptionalRoute(
  left: ManagedTelegramPeerRoute | undefined,
  right: ManagedTelegramPeerRoute | undefined,
): boolean {
  return left === undefined && right === undefined
    || Boolean(left && right
      && left.installationId === right.installationId
      && left.localUid === right.localUid
      && left.canonicalOrigin === right.canonicalOrigin);
}
