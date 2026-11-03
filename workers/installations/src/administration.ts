import type { InstallationState } from "@humansandmachines/gsv/services/directory";
import { parseOpaqueId } from "./domain";
import type { InstallationDataDeletionState } from "./store";

export const ADMIN_INSTALLATIONS_PAGE_SIZE = 50;

export const ADMIN_VISIBLE_INSTALLATION_STATES = [
  "reserved",
  "provisioning",
  "active",
  "restricted",
  "retained",
  "deleting",
] as const satisfies readonly InstallationState[];

export type AdminVisibleInstallationState =
  typeof ADMIN_VISIBLE_INSTALLATION_STATES[number];

type AdminOperationState =
  | "reserved"
  | "provisioning"
  | "complete"
  | "failed";

/** How a Ship's owner arrived: another Ship's invitation, a website link, or neither. */
export type AdminInstallationOrigin = "invite" | "website" | "direct";

// A reset keeps a Ship's lineage under a fresh installation ID. Signup facts
// stay on the original create operation, so every lookup walks the chain:
// back from a Ship to its first installation, forward from an old ID to the
// Ship it is today.
const LINEAGE = `lineage(id) AS (
  SELECT ?
  UNION SELECT r.previous_installation_id FROM installation_reset_operations r
  JOIN lineage l ON r.replacement_installation_id = l.id
)`;

export type AdminInstallationSummary = {
  installationId: string;
  handle: string;
  state: InstallationState;
  operationState: AdminOperationState;
  origin: AdminInstallationOrigin;
  createdAt: number;
};

export type AdminInstallationListQuery = {
  query: string;
  state: AdminVisibleInstallationState | null;
  page: number;
};

export type AdminInstallationList = AdminInstallationListQuery & {
  installations: AdminInstallationSummary[];
  pageSize: number;
  total: number;
  totalPages: number;
};

export type AdminInstallation = {
  installationId: string;
  handle: string;
  canonicalOrigin: string;
  state: InstallationState;
  operationState: AdminOperationState;
  onboardingExpiresAt: number | null;
  createdAt: number;
  activatedAt: number | null;
  reset: {
    previousInstallationId: string;
    dataDeletionState: InstallationDataDeletionState;
  } | null;
  invitedBy: { installationId: string; handle: string } | null;
  invitations: { total: number; active: number };
};

type AdminInstallationRow = {
  id: string;
  handle: string;
  canonical_origin: string;
  state: InstallationState;
  operation_state: AdminInstallation["operationState"];
  onboarding_expires_at: number | null;
  created_at: number;
  activated_at: number | null;
  previous_installation_id?: string | null;
  data_deletion_state?: InstallationDataDeletionState | null;
  inviter_installation_id?: string | null;
  inviter_handle?: string | null;
  invitations_total?: number;
  invitations_active?: number;
};

type AdminInstallationSummaryRow = Pick<
  AdminInstallationRow,
  | "id"
  | "handle"
  | "state"
  | "operation_state"
  | "created_at"
> & { origin: AdminInstallationOrigin };

export class InstallationAdminStore {
  constructor(private readonly db: D1Database) {}

  async listInstallations(
    input: AdminInstallationListQuery,
  ): Promise<AdminInstallationList> {
    const query = input.query.trim().toLowerCase();
    if (query.length > 100) throw new Error("query is too long");
    if (
      input.state !== null
      && !ADMIN_VISIBLE_INSTALLATION_STATES.includes(input.state)
    ) {
      throw new Error("state is invalid");
    }
    if (!Number.isSafeInteger(input.page) || input.page < 1) {
      throw new Error("page is invalid");
    }

    const predicates = [
      "i.state != 'deleted'",
      `NOT EXISTS (
        SELECT 1 FROM installation_reset_operations r
        WHERE r.previous_installation_id = i.id
      )`,
    ];
    const bindings: Array<string | number> = [];
    if (query) {
      predicates.push("(instr(i.handle, ?) > 0 OR instr(i.id, ?) > 0)");
      bindings.push(query, query);
    }
    if (input.state !== null) {
      predicates.push("i.state = ?");
      bindings.push(input.state);
    }
    const where = predicates.join(" AND ");
    const offset = (input.page - 1) * ADMIN_INSTALLATIONS_PAGE_SIZE;
    if (!Number.isSafeInteger(offset)) throw new Error("page is invalid");

    const [count, rows] = await Promise.all([
      this.db.prepare(
        `SELECT COUNT(*) AS total
         FROM installations i
         WHERE ${where}`,
      ).bind(...bindings).first<{ total: number }>(),
      this.db.prepare(
        `WITH RECURSIVE page AS (
           SELECT
             i.id, i.handle, i.state,
             (
               SELECT p.state
               FROM provisioning_operations p
               WHERE p.installation_id = i.id AND p.kind = 'create'
               ORDER BY p.updated_at DESC
               LIMIT 1
             ) AS operation_state,
             i.created_at
           FROM installations i
           WHERE ${where}
           ORDER BY i.created_at DESC, i.id DESC
           LIMIT ? OFFSET ?
         ), lineage(ship, id) AS (
           SELECT id, id FROM page
           UNION SELECT l.ship, r.previous_installation_id FROM installation_reset_operations r
           JOIN lineage l ON r.replacement_installation_id = l.id
         )
         SELECT page.*, (
           SELECT CASE
             WHEN MAX(p.inviter_installation_id IS NOT NULL) THEN 'invite'
             WHEN MAX(p.attribution_json IS NOT NULL) THEN 'website'
             ELSE 'direct' END
           FROM lineage l
           JOIN provisioning_operations p ON p.installation_id = l.id AND p.kind = 'create'
           WHERE l.ship = page.id
         ) AS origin
         FROM page
         ORDER BY page.created_at DESC, page.id DESC`,
      ).bind(
        ...bindings,
        ADMIN_INSTALLATIONS_PAGE_SIZE,
        offset,
      ).all<AdminInstallationSummaryRow>(),
    ]);
    const total = count?.total ?? 0;
    return {
      query,
      state: input.state,
      page: input.page,
      pageSize: ADMIN_INSTALLATIONS_PAGE_SIZE,
      total,
      totalPages: Math.max(
        1,
        Math.ceil(total / ADMIN_INSTALLATIONS_PAGE_SIZE),
      ),
      installations: rows.results.map(adminInstallationSummaryFromRow),
    };
  }

  async setInstallationState(
    installationIdValue: string,
    state: "active" | "restricted",
  ): Promise<void> {
    const installationId = parseOpaqueId(
      installationIdValue,
      "installationId",
    );
    const expectedState = state === "active" ? "restricted" : "active";
    const result = await this.db.prepare(
      `UPDATE installations
       SET state = ?
       WHERE id = ? AND state = ?`,
    ).bind(state, installationId, expectedState).run();
    if ((result.meta.changes ?? 0) === 1) return;

    const current = await this.db.prepare(
      `SELECT state
       FROM installations
       WHERE id = ? AND state != 'deleted'
       LIMIT 1`,
    ).bind(installationId).first<{ state: InstallationState }>();
    if (!current) throw new Error("installation is unavailable");
    if (current.state === state) return;
    throw new Error(
      `installation cannot transition from ${current.state} to ${state}`,
    );
  }

  async getInstallation(installationIdValue: string): Promise<AdminInstallation | null> {
    const installationId = parseOpaqueId(installationIdValue, "installationId");
    const row = await this.db.prepare(
      `WITH RECURSIVE ${LINEAGE}, inviter(id) AS (
         SELECT p.inviter_installation_id FROM provisioning_operations p
         JOIN lineage l ON p.installation_id = l.id
         WHERE p.kind = 'create' AND p.inviter_installation_id IS NOT NULL
         UNION SELECT r.replacement_installation_id FROM installation_reset_operations r
         JOIN inviter ON r.previous_installation_id = inviter.id
       ), current_inviter AS (
         SELECT i.id, i.handle FROM inviter JOIN installations i ON i.id = inviter.id
         WHERE NOT EXISTS (SELECT 1 FROM installation_reset_operations r WHERE r.previous_installation_id = i.id)
         LIMIT 1
       ), invitee(first, id) AS (
         SELECT p.installation_id, p.installation_id FROM provisioning_operations p
         WHERE p.kind = 'create' AND p.inviter_installation_id IN (SELECT id FROM lineage)
         UNION SELECT invitee.first, r.replacement_installation_id FROM installation_reset_operations r
         JOIN invitee ON r.previous_installation_id = invitee.id
       )
       SELECT i.id, i.handle, i.canonical_origin, i.state,
         (SELECT p.state FROM provisioning_operations p
          WHERE p.installation_id = i.id AND p.kind = 'create'
          ORDER BY p.updated_at DESC LIMIT 1) AS operation_state,
         c.expires_at AS onboarding_expires_at, i.created_at, i.activated_at,
         reset.previous_installation_id, reset.data_deletion_state,
         (SELECT id FROM current_inviter) AS inviter_installation_id,
         (SELECT handle FROM current_inviter) AS inviter_handle,
         (SELECT COUNT(DISTINCT first) FROM invitee) AS invitations_total,
         (SELECT COUNT(DISTINCT invitee.first) FROM invitee
          JOIN installations invited ON invited.id = invitee.id AND invited.state = 'active') AS invitations_active
       FROM installations i
       LEFT JOIN installation_onboarding_claims c ON c.installation_id = i.id
       LEFT JOIN installation_reset_operations reset ON reset.replacement_installation_id = i.id
       WHERE i.id = ? AND i.state != 'deleted' LIMIT 1`,
    ).bind(installationId, installationId).first<AdminInstallationRow>();
    return row ? adminInstallationFromRow(row) : null;
  }
}

function adminInstallationSummaryFromRow(
  row: AdminInstallationSummaryRow,
): AdminInstallationSummary {
  return {
    installationId: row.id,
    handle: row.handle,
    state: row.state,
    operationState: row.operation_state,
    origin: row.origin,
    createdAt: row.created_at,
  };
}

function adminInstallationFromRow(
  row: AdminInstallationRow,
): AdminInstallation {
  return {
    installationId: row.id,
    handle: row.handle,
    canonicalOrigin: row.canonical_origin,
    state: row.state,
    operationState: row.operation_state,
    onboardingExpiresAt: row.onboarding_expires_at,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    reset: row.previous_installation_id && row.data_deletion_state
      ? {
          previousInstallationId: row.previous_installation_id,
          dataDeletionState: row.data_deletion_state,
        }
      : null,
    invitedBy: row.inviter_installation_id && row.inviter_handle
      ? { installationId: row.inviter_installation_id, handle: row.inviter_handle }
      : null,
    invitations: { total: row.invitations_total ?? 0, active: row.invitations_active ?? 0 },
  };
}
