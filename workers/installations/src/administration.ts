import { AdminMonitoring, SEGMENT_SQL, userSegment, type ActivitySummary, type Outreach, type OutreachEvent, type UserSegment } from "./admin/monitoring";
import { userQuerySchema, CHANNEL_SQL, MONITORING_JOINS, MONITORING_SELECT, type UserQuery } from "./admin/user-query";
import type { InstallationState } from "@humansandmachines/gsv/services/directory";
import { parseOpaqueId } from "./domain";
import { signupContextSchema, type SignupContext } from "./signup-context";
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

export type AdminInstallationSummary = {
  installationId: string;
  handle: string;
  state: InstallationState;
  operationState: AdminOperationState;
  createdAt: number;
  signedUpAt?: number;
  ownerEmail?: string | null;
  signup?: SignupContext | null;
  activity?: ActivitySummary;
  segment?: UserSegment;
  outreach?: Outreach;
};

export type AdminInstallationListQuery = UserQuery & {
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
  signedUpAt?: number;
  activatedAt: number | null;
  signup?: SignupContext | null;
  activity?: ActivitySummary;
  segment?: UserSegment;
  outreach?: Outreach;
  outreachHistory?: OutreachEvent[];
  reset: {
    previousInstallationId: string;
    dataDeletionState: InstallationDataDeletionState;
  } | null;

};

type MonitoringRow = {
  captured_at: number | null; tracked_from: number | null; first_active_at: number | null; last_active_at: number | null;
  messages: number | null; tasks: number | null; successful_tasks: number | null; failed_tasks: number | null; availability: string | null;
  outreach_status: Outreach["status"] | null; notes: string | null; last_contacted_at: number | null; outreach_revision: number | null;
};
type AdminInstallationRow = MonitoringRow & {
  id: string;
  handle: string;
  canonical_origin: string;
  state: InstallationState;
  operation_state: AdminInstallation["operationState"];
  onboarding_expires_at: number | null;
  created_at: number;
  activated_at: number | null;
  signup_context_json: string | null;
  signup_at: number | null;
  previous_installation_id?: string | null;
  data_deletion_state?: InstallationDataDeletionState | null;
};

type AdminInstallationSummaryRow = Pick<
  AdminInstallationRow,
  | "id"
  | "handle"
  | "state"
  | "operation_state"
  | "created_at"
  | "signup_context_json"
  | "signup_at"
> & MonitoringRow & { owner_email: string | null };

// Match the Ship detail page: the active owner wins; an unfinished signup uses its verified owner.
const OWNER_JOIN = `LEFT JOIN principals owner ON owner.id = COALESCE((
  SELECT m.principal_id FROM memberships m
  WHERE m.installation_id = i.id AND m.role = 'owner' AND m.state = 'active'
  ORDER BY m.created_at LIMIT 1), CASE WHEN i.owner_setup = 1 THEN i.owner_principal_id END)`;

export class InstallationAdminStore {
  constructor(private readonly db: D1Database) {}

  async listInstallations(
    input: AdminInstallationListQuery,
  ): Promise<AdminInstallationList> {
    const filters = userQuerySchema.parse(input);
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
      predicates.push(`(instr(i.handle, ?) > 0 OR instr(i.id, ?) > 0 OR instr(lower(owner.primary_email), ?) > 0
        OR instr(lower(outreach.notes), ?) > 0 OR instr(lower(${CHANNEL_SQL}), ?) > 0)`);
      bindings.push(query, query, query, query, query);
    }
    if (input.state !== null) {
      predicates.push("i.state = ?");
      bindings.push(input.state);
    }
    if (filters.segment) { predicates.push(`(${SEGMENT_SQL}) = ?`); bindings.push(filters.segment); }
    if (filters.outreach) { predicates.push("COALESCE(outreach.status, 'not_contacted') = ?"); bindings.push(filters.outreach); }
    if (filters.channel) { predicates.push(`${CHANNEL_SQL} = ?`); bindings.push(filters.channel); }
    if (filters.country) { predicates.push("json_extract(i.signup_context_json, '$.country') = ?"); bindings.push(filters.country); }
    for (const [value, column, operator, offset] of [
      [filters.signupFrom, "COALESCE(i.signup_at, i.created_at)", ">=", 0], [filters.signupTo, "COALESCE(i.signup_at, i.created_at)", "<", 86400000],
      [filters.activeFrom, "a.last_active_at", ">=", 0], [filters.activeTo, "a.last_active_at", "<", 86400000],
      [filters.contactFrom, "outreach.last_contacted_at", ">=", 0], [filters.contactTo, "outreach.last_contacted_at", "<", 86400000],
    ] as const) {
      if (value) { predicates.push(`${column} ${operator} ?`); bindings.push(Date.parse(value) + offset); }
    }
    for (const [value, column] of [[filters.minMessages, "a.messages"], [filters.minTasks, "a.tasks"], [filters.minSuccessfulTasks, "a.successful_tasks"]] as const) {
      if (value !== undefined) { predicates.push(`${column} >= ?`); bindings.push(value); }
    }
    const sortColumns = { signup: "COALESCE(i.signup_at, i.created_at)", last_active: "a.last_active_at", messages: "a.messages", tasks: "a.tasks",
      successful_tasks: "a.successful_tasks", last_contacted: "outreach.last_contacted_at", handle: "i.handle", segment: `(${SEGMENT_SQL})`,
      outreach: "COALESCE(outreach.status, 'not_contacted')", channel: CHANNEL_SQL, country: "json_extract(i.signup_context_json, '$.country')" };
    const sortColumn = sortColumns[filters.sort ?? "signup"];
    const direction = filters.direction === "asc" ? "ASC" : "DESC";
    const where = predicates.join(" AND ");
    const offset = (input.page - 1) * ADMIN_INSTALLATIONS_PAGE_SIZE;
    if (!Number.isSafeInteger(offset)) throw new Error("page is invalid");

    const [count, rows] = await Promise.all([
      this.db.prepare(
        `SELECT COUNT(*) AS total
         FROM installations i
         ${OWNER_JOIN}
         ${MONITORING_JOINS}
         WHERE ${where}`,
      ).bind(...bindings).first<{ total: number }>(),
      this.db.prepare(
        `SELECT
           i.id, i.handle, i.state,
           (
             SELECT p.state
             FROM provisioning_operations p
             WHERE p.installation_id = i.id AND p.kind = 'create'
             ORDER BY p.updated_at DESC
             LIMIT 1
           ) AS operation_state,
           i.created_at, i.signup_at, i.signup_context_json, owner.primary_email AS owner_email, ${MONITORING_SELECT}
         FROM installations i
         ${OWNER_JOIN}
         ${MONITORING_JOINS}
         WHERE ${where}
         ORDER BY ${sortColumn} IS NULL, ${sortColumn} ${direction}, i.id DESC
         LIMIT ? OFFSET ?`,
      ).bind(
        ...bindings,
        ADMIN_INSTALLATIONS_PAGE_SIZE,
        offset,
      ).all<AdminInstallationSummaryRow>(),
    ]);
    const total = count?.total ?? 0;
    return {
      ...filters,
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
      `SELECT i.id, i.handle, i.canonical_origin, i.state,
         (SELECT p.state FROM provisioning_operations p
          WHERE p.installation_id = i.id AND p.kind = 'create'
          ORDER BY p.updated_at DESC LIMIT 1) AS operation_state,
         c.expires_at AS onboarding_expires_at, i.created_at, i.signup_at, i.activated_at, i.signup_context_json,
         reset.previous_installation_id, reset.data_deletion_state, ${MONITORING_SELECT}
       FROM installations i
       ${MONITORING_JOINS}
       LEFT JOIN installation_onboarding_claims c ON c.installation_id = i.id
       LEFT JOIN installation_reset_operations reset ON reset.replacement_installation_id = i.id
       WHERE i.id = ? AND i.state != 'deleted' LIMIT 1`,
    ).bind(installationId).first<AdminInstallationRow>();
    return row ? { ...adminInstallationFromRow(row), outreachHistory: await new AdminMonitoring(this.db).history(installationId) } : null;
  }
}

function adminInstallationSummaryFromRow(
  row: AdminInstallationSummaryRow,
): AdminInstallationSummary {
  return {
    ...monitoringFromRow(row),
    installationId: row.id,
    handle: row.handle,
    state: row.state,
    operationState: row.operation_state,
    createdAt: row.created_at,
    signedUpAt: row.signup_at ?? row.created_at,
    ownerEmail: row.owner_email,
    signup: row.signup_context_json ? signupContextSchema.parse(JSON.parse(row.signup_context_json)) : null,
  };
}

function adminInstallationFromRow(
  row: AdminInstallationRow,
): AdminInstallation {
  return {
    ...monitoringFromRow(row),
    installationId: row.id,
    handle: row.handle,
    canonicalOrigin: row.canonical_origin,
    state: row.state,
    operationState: row.operation_state,
    onboardingExpiresAt: row.onboarding_expires_at,
    createdAt: row.created_at,
    signedUpAt: row.signup_at ?? row.created_at,
    activatedAt: row.activated_at,
    signup: row.signup_context_json ? signupContextSchema.parse(JSON.parse(row.signup_context_json)) : null,
    reset: row.previous_installation_id && row.data_deletion_state
      ? {
          previousInstallationId: row.previous_installation_id,
          dataDeletionState: row.data_deletion_state,
        }
      : null,
  };
}

function monitoringFromRow(row: MonitoringRow & { created_at: number; signup_at: number | null }) {
  const activity: ActivitySummary = { capturedAt: row.captured_at, trackedFrom: row.tracked_from, firstActiveAt: row.first_active_at,
    lastActiveAt: row.last_active_at, messages: row.messages, tasks: row.tasks, successfulTasks: row.successful_tasks,
    failedTasks: row.failed_tasks, availability: row.availability ?? "unknown" };
  const outreach: Outreach = { status: row.outreach_status ?? "not_contacted", notes: row.notes ?? "",
    lastContactedAt: row.last_contacted_at, revision: row.outreach_revision ?? 0 };
  return { activity, outreach, segment: userSegment(row.signup_at ?? row.created_at, activity) };
}
