import type {
  ResponsibilityAssignee,
  ResponsibilityAudience,
  ResponsibilityPriority,
  ResponsibilityRecord,
  ResponsibilitySource,
  ResponsibilityState,
  ResponsibilityTransition,
} from "@humansandmachines/gsv/protocol";
import { responsibilityRequiresAction } from "@humansandmachines/gsv/protocol";
import type { JsonObject } from "@humansandmachines/gsv/protocol";

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
const DEFAULT_CHANGE_LIMIT = 100;
const MAX_CHANGE_LIMIT = 500;
const DEFAULT_WAKE_BATCH_LIMIT = 25;
const RESPONSIBILITY_WAKE_RETRY_MS = 5 * 60_000;

type ResponsibilityRow = {
  responsibility_id: string;
  owner_uid: number;
  parent_id: string | null;
  title: string;
  details_json: string | null;
  source_json: string;
  audience_json: string | null;
  assignee_kind: "ship" | "process";
  assignee_pid: string | null;
  state: ResponsibilityState;
  priority: ResponsibilityPriority;
  due_at: number | null;
  due_woken_at: number | null;
  next_check_at: number | null;
  check_woken_at: number | null;
  blocker: string | null;
  lease_expires_at: number | null;
  lease_woken_at: number | null;
  dedupe_key: string | null;
  resolution_json: string | null;
  change_pending: number;
  wake_retry_at: number | null;
  revision: number;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
};

type ResponsibilityTransitionRow = {
  revision: number;
  responsibility_id: string;
  kind: ResponsibilityTransition["kind"];
  before_state: ResponsibilityState | null;
  after_state: ResponsibilityState;
  assignee_pid: string | null;
  before_assignee_pid: string | null;
  changed_fields_json: string;
  actor_json: string;
  record_json: string;
  created_at: number;
};

type ResponsibilityLedgerRow = {
  owner_uid: number;
  revision: number;
  wake_generation: number;
  wake_task_id: string | null;
  wake_at: number | null;
};

type ResponsibilityWakeBatchRow = {
  batch_id: string;
  owner_uid: number;
  through_revision: number;
  responsibility_ids_json: string;
  event_id: string;
  attempt_count: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};

export type ResponsibilityWakeState = {
  ownerUid: number;
  generation: number;
  taskId: string | null;
  scheduledAtMs: number | null;
};

export type ResponsibilityWakeBatch = {
  id: string;
  ownerUid: number;
  throughRevision: number;
  eventId: string;
  responsibilities: ResponsibilityRecord[];
  attemptCount: number;
  createdAtMs: number;
};

export type ResponsibilityCreateInput = {
  ownerUid: number;
  parentId?: string;
  title: string;
  details?: JsonObject;
  source: ResponsibilitySource;
  audience?: ResponsibilityAudience;
  assignee: ResponsibilityAssignee;
  state: ResponsibilityState;
  priority: ResponsibilityPriority;
  dueAtMs?: number;
  nextCheckAtMs?: number;
  blocker?: string;
  leaseExpiresAtMs?: number;
  dedupeKey?: string;
  actor: ResponsibilitySource;
  observedByShip: boolean;
  now: number;
};

export type ResponsibilityUpdateInput = {
  ownerUid: number;
  id: string;
  expectedRevision?: number;
  patch: {
    title?: string;
    details?: JsonObject | null;
    parentId?: string | null;
    audience?: ResponsibilityAudience | null;
    assignee?: ResponsibilityAssignee;
    state?: ResponsibilityState;
    priority?: ResponsibilityPriority;
    dueAtMs?: number | null;
    nextCheckAtMs?: number | null;
    blocker?: string | null;
    leaseExpiresAtMs?: number | null;
    resolution?: JsonObject | null;
  };
  actor: ResponsibilitySource;
  observedByShip: boolean;
  now: number;
};

export type ResponsibilityCreateOutcome = {
  record: ResponsibilityRecord;
  created: boolean;
  revision: number;
};

export type ResponsibilityUpdateOutcome = {
  record: ResponsibilityRecord;
  revision: number;
  changed: boolean;
};

export type ResponsibilityListOutcome = {
  records: ResponsibilityRecord[];
  count: number;
  revision: number;
};

export type ResponsibilityChangesOutcome = {
  transitions: ResponsibilityTransition[];
  revision: number;
  hasMore: boolean;
};

export class ResponsibilityStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  get(ownerUid: number, id: string): ResponsibilityRecord | null {
    const row = this.getRow(ownerUid, id);
    return row ? recordFromRow(row) : null;
  }

  getByDedupeKey(ownerUid: number, dedupeKey: string): ResponsibilityRecord | null {
    const row = this.getDedupeRow(ownerUid, dedupeKey);
    return row ? recordFromRow(row) : null;
  }

  listActiveByDedupeKeyPrefix(
    ownerUid: number,
    dedupeKeyPrefix: string,
  ): ResponsibilityRecord[] {
    return this.storage.sql.exec<ResponsibilityRow>(
      `SELECT * FROM responsibilities
       WHERE owner_uid = ?
         AND state NOT IN ('resolved', 'cancelled')
         AND dedupe_key IS NOT NULL
         AND substr(dedupe_key, 1, length(?)) = ?
       ORDER BY created_at ASC, responsibility_id ASC`,
      ownerUid,
      dedupeKeyPrefix,
      dedupeKeyPrefix,
    ).toArray().map(recordFromRow);
  }

  list(input: {
    ownerUid: number;
    ids?: string[];
    states?: ResponsibilityState[];
    assigneeProcessId?: string;
    parentId?: string;
    includeTerminal?: boolean;
    limit?: number;
    offset?: number;
  }): ResponsibilityListOutcome {
    const clauses = ["owner_uid = ?"];
    const bindings: Array<string | number> = [input.ownerUid];
    if (input.ids && input.ids.length > 0) {
      clauses.push(`responsibility_id IN (${input.ids.map(() => "?").join(", ")})`);
      bindings.push(...input.ids);
    }
    if (input.states && input.states.length > 0) {
      clauses.push(`state IN (${input.states.map(() => "?").join(", ")})`);
      bindings.push(...input.states);
    } else if (!input.includeTerminal) {
      clauses.push("state NOT IN ('resolved', 'cancelled')");
    }
    if (input.assigneeProcessId) {
      clauses.push("assignee_kind = 'process' AND assignee_pid = ?");
      bindings.push(input.assigneeProcessId);
    }
    if (input.parentId) {
      clauses.push("parent_id = ?");
      bindings.push(input.parentId);
    }
    const where = clauses.join(" AND ");
    const limit = clampLimit(input.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const offset = clampOffset(input.offset);
    const count = this.storage.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM responsibilities WHERE ${where}`,
      ...bindings,
    ).toArray()[0]?.count ?? 0;
    const rows = this.storage.sql.exec<ResponsibilityRow>(
      `SELECT * FROM responsibilities
       WHERE ${where}
       ORDER BY
         CASE priority
           WHEN 'critical' THEN 0
           WHEN 'high' THEN 1
           WHEN 'normal' THEN 2
           ELSE 3
         END,
         CASE WHEN due_at IS NULL THEN 1 ELSE 0 END,
         due_at ASC,
         updated_at DESC,
         responsibility_id ASC
       LIMIT ? OFFSET ?`,
      ...bindings,
      limit,
      offset,
    ).toArray();
    return {
      records: rows.map(recordFromRow),
      count,
      revision: this.revision(input.ownerUid),
    };
  }

  changes(
    ownerUid: number,
    afterRevision: number,
    limit?: number,
    visibleToProcessId?: string,
  ): ResponsibilityChangesOutcome {
    const boundedLimit = clampLimit(limit, DEFAULT_CHANGE_LIMIT, MAX_CHANGE_LIMIT);
    const visibilityCte = visibleToProcessId
      ? `WITH RECURSIVE visible_responsibilities(responsibility_id, parent_id) AS (
           SELECT responsibility_id, parent_id
           FROM responsibilities
           WHERE owner_uid = ? AND assignee_kind = 'process' AND assignee_pid = ?
           UNION
           SELECT parent.responsibility_id, parent.parent_id
           FROM responsibilities parent
           JOIN visible_responsibilities child
             ON parent.responsibility_id = child.parent_id
           WHERE parent.owner_uid = ?
         )`
      : "";
    const visibilityClause = visibleToProcessId
      ? `AND (
           assignee_pid = ?
           OR before_assignee_pid = ?
           OR responsibility_id IN (
             SELECT responsibility_id FROM visible_responsibilities
           )
         )`
      : "";
    const bindings = visibleToProcessId
      ? [ownerUid, visibleToProcessId, ownerUid, ownerUid, afterRevision,
          visibleToProcessId, visibleToProcessId, boundedLimit + 1]
      : [ownerUid, afterRevision, boundedLimit + 1];
    const rows = this.storage.sql.exec<ResponsibilityTransitionRow>(
      `${visibilityCte}
       SELECT revision, responsibility_id, kind, before_state, after_state,
              assignee_pid, before_assignee_pid, changed_fields_json,
              actor_json, record_json, created_at
       FROM responsibility_transitions
       WHERE owner_uid = ? AND revision > ?
         ${visibilityClause}
       ORDER BY revision ASC
       LIMIT ?`,
      ...bindings,
    ).toArray();
    return {
      transitions: rows.slice(0, boundedLimit).map(transitionFromRow),
      revision: this.revision(ownerUid),
      hasMore: rows.length > boundedLimit,
    };
  }

  listVisibleToProcess(input: {
    ownerUid: number;
    processId: string;
    ids?: string[];
    states?: ResponsibilityState[];
    parentId?: string;
    includeTerminal?: boolean;
    limit?: number;
    offset?: number;
  }): ResponsibilityListOutcome {
    const clauses = ["1 = 1"];
    const filterBindings: Array<string | number> = [];
    if (input.ids && input.ids.length > 0) {
      clauses.push(`record.responsibility_id IN (${input.ids.map(() => "?").join(", ")})`);
      filterBindings.push(...input.ids);
    }
    if (input.states && input.states.length > 0) {
      clauses.push(`record.state IN (${input.states.map(() => "?").join(", ")})`);
      filterBindings.push(...input.states);
    } else if (!input.includeTerminal) {
      clauses.push("record.state NOT IN ('resolved', 'cancelled')");
    }
    if (input.parentId) {
      clauses.push("record.parent_id = ?");
      filterBindings.push(input.parentId);
    }
    const cte = `WITH RECURSIVE visible_responsibilities(responsibility_id, parent_id) AS (
      SELECT responsibility_id, parent_id
      FROM responsibilities
      WHERE owner_uid = ? AND assignee_kind = 'process' AND assignee_pid = ?
      UNION
      SELECT parent.responsibility_id, parent.parent_id
      FROM responsibilities parent
      JOIN visible_responsibilities child
        ON parent.responsibility_id = child.parent_id
      WHERE parent.owner_uid = ?
    )`;
    const from = `FROM responsibilities record
      JOIN visible_responsibilities visible
        ON visible.responsibility_id = record.responsibility_id
      WHERE ${clauses.join(" AND ")}`;
    const baseBindings: Array<string | number> = [
      input.ownerUid,
      input.processId,
      input.ownerUid,
      ...filterBindings,
    ];
    const count = this.storage.sql.exec<{ count: number }>(
      `${cte} SELECT COUNT(*) AS count ${from}`,
      ...baseBindings,
    ).toArray()[0]?.count ?? 0;
    const limit = clampLimit(input.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const offset = clampOffset(input.offset);
    const rows = this.storage.sql.exec<ResponsibilityRow>(
      `${cte}
       SELECT record.* ${from}
       ORDER BY record.updated_at DESC, record.responsibility_id ASC
       LIMIT ? OFFSET ?`,
      ...baseBindings,
      limit,
      offset,
    ).toArray();
    return {
      records: rows.map(recordFromRow),
      count,
      revision: this.revision(input.ownerUid),
    };
  }

  isVisibleToProcess(ownerUid: number, id: string, processId: string): boolean {
    return this.storage.sql.exec<{ found: number }>(
      `WITH RECURSIVE visible_responsibilities(responsibility_id, parent_id) AS (
         SELECT responsibility_id, parent_id
         FROM responsibilities
         WHERE owner_uid = ? AND assignee_kind = 'process' AND assignee_pid = ?
         UNION
         SELECT parent.responsibility_id, parent.parent_id
         FROM responsibilities parent
         JOIN visible_responsibilities child
           ON parent.responsibility_id = child.parent_id
         WHERE parent.owner_uid = ?
       )
       SELECT 1 AS found
       FROM visible_responsibilities
       WHERE responsibility_id = ?
       LIMIT 1`,
      ownerUid,
      processId,
      ownerUid,
      id,
    ).toArray()[0]?.found === 1;
  }

  revision(ownerUid: number): number {
    return this.getLedger(ownerUid)?.revision ?? 0;
  }

  create(input: ResponsibilityCreateInput): ResponsibilityCreateOutcome {
    let outcome: ResponsibilityCreateOutcome | undefined;
    this.storage.transactionSync(() => {
      this.ensureLedger(input.ownerUid, input.now);
      if (input.dedupeKey) {
        const existing = this.getDedupeRow(input.ownerUid, input.dedupeKey);
        if (existing) {
          outcome = {
            record: recordFromRow(existing),
            created: false,
            revision: this.revision(input.ownerUid),
          };
          return;
        }
      }
      this.assertParent(input.ownerUid, input.parentId);
      const revision = this.advanceLedger(input.ownerUid, input.now);
      const id = `r12y:${crypto.randomUUID()}`;
      const changePending = shouldMarkChangePending({
        assignee: input.assignee,
        state: input.state,
        blocker: input.blocker,
        dueAtMs: input.dueAtMs,
        nextCheckAtMs: input.nextCheckAtMs,
        leaseExpiresAtMs: input.leaseExpiresAtMs,
      }, input.observedByShip, input.now);
      this.storage.sql.exec(
        `INSERT INTO responsibilities (
          responsibility_id, owner_uid, parent_id, title, details_json, source_json,
          audience_json, assignee_kind, assignee_pid, state, priority, due_at,
          due_woken_at, next_check_at, check_woken_at, blocker, lease_expires_at,
          lease_woken_at, dedupe_key, resolution_json, change_pending, wake_retry_at,
          revision, created_at, updated_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, NULL, ?, NULL, ?, NULL, ?, ?, ?, NULL)`,
        id,
        input.ownerUid,
        input.parentId ?? null,
        input.title,
        input.details ? JSON.stringify(input.details) : null,
        JSON.stringify(input.source),
        input.audience ? JSON.stringify(input.audience) : null,
        input.assignee.kind,
        input.assignee.kind === "process" ? input.assignee.processId : null,
        input.state,
        input.priority,
        input.dueAtMs ?? null,
        input.nextCheckAtMs ?? null,
        input.blocker ?? null,
        input.leaseExpiresAtMs ?? null,
        input.dedupeKey ?? null,
        changePending,
        revision,
        input.now,
        input.now,
      );
      const row = this.requireRow(input.ownerUid, id);
      const record = recordFromRow(row);
      this.appendTransition({
        ownerUid: input.ownerUid,
        revision,
        id,
        kind: "created",
        afterState: input.state,
        changedFields: ["created"],
        actor: input.actor,
        record,
        now: input.now,
      });
      outcome = { record, created: true, revision };
    });
    if (!outcome) throw new Error("Responsibility creation did not produce a result");
    return outcome;
  }

  update(input: ResponsibilityUpdateInput): ResponsibilityUpdateOutcome {
    let outcome: ResponsibilityUpdateOutcome | undefined;
    this.storage.transactionSync(() => {
      const currentRow = this.getRow(input.ownerUid, input.id);
      if (!currentRow) throw new Error(`Responsibility not found: ${input.id}`);
      const current = recordFromRow(currentRow);
      if (
        input.expectedRevision !== undefined
        && input.expectedRevision !== current.revision
      ) {
        throw new Error(
          `Responsibility revision conflict: expected ${input.expectedRevision}, found ${current.revision}`,
        );
      }
      const next = applyPatch(current, input.patch, input.now);
      this.assertStateTransition(current.state, next.state);
      this.assertParent(input.ownerUid, next.parentId, input.id);
      const changedFields = changedResponsibilityFields(current, next);
      if (changedFields.length === 0) {
        outcome = {
          record: current,
          revision: this.revision(input.ownerUid),
          changed: false,
        };
        return;
      }

      const revision = this.advanceLedger(input.ownerUid, input.now);
      const dueChanged = changedFields.includes("dueAtMs");
      const checkChanged = changedFields.includes("nextCheckAtMs");
      const leaseChanged = changedFields.includes("leaseExpiresAtMs");
      const terminal = next.state === "resolved" || next.state === "cancelled";
      const changePending = shouldMarkChangePending(
        next,
        input.observedByShip,
        input.now,
      );
      this.storage.sql.exec(
        `UPDATE responsibilities SET
          parent_id = ?, title = ?, details_json = ?, audience_json = ?,
          assignee_kind = ?, assignee_pid = ?, state = ?, priority = ?,
          due_at = ?, due_woken_at = ?, next_check_at = ?, check_woken_at = ?,
          blocker = ?, lease_expires_at = ?, lease_woken_at = ?, resolution_json = ?,
          change_pending = ?, wake_retry_at = NULL, revision = ?, updated_at = ?, resolved_at = ?
         WHERE owner_uid = ? AND responsibility_id = ?`,
        next.parentId ?? null,
        next.title,
        next.details ? JSON.stringify(next.details) : null,
        next.audience ? JSON.stringify(next.audience) : null,
        next.assignee.kind,
        next.assignee.kind === "process" ? next.assignee.processId : null,
        next.state,
        next.priority,
        next.dueAtMs ?? null,
        dueChanged ? null : currentRow.due_woken_at,
        next.nextCheckAtMs ?? null,
        checkChanged ? null : currentRow.check_woken_at,
        next.blocker ?? null,
        next.leaseExpiresAtMs ?? null,
        leaseChanged ? null : currentRow.lease_woken_at,
        next.resolution ? JSON.stringify(next.resolution) : null,
        changePending,
        revision,
        input.now,
        terminal ? input.now : null,
        input.ownerUid,
        input.id,
      );
      const row = this.requireRow(input.ownerUid, input.id);
      const record = recordFromRow(row);
      const kind = record.state === "resolved"
        ? "resolved"
        : record.state === "cancelled"
          ? "cancelled"
          : "updated";
      this.appendTransition({
        ownerUid: input.ownerUid,
        revision,
        id: input.id,
        kind,
        beforeState: current.state,
        afterState: record.state,
        beforeAssigneeProcessId: current.assignee.kind === "process"
          ? current.assignee.processId
          : undefined,
        changedFields,
        actor: input.actor,
        record,
        now: input.now,
      });
      outcome = { record, revision, changed: true };
    });
    if (!outcome) throw new Error("Responsibility update did not produce a result");
    return outcome;
  }

  reclaimProcessAssignments(input: {
    ownerUid: number;
    processId: string;
    now: number;
  }): ResponsibilityRecord[] {
    const reclaimed: ResponsibilityRecord[] = [];
    this.storage.transactionSync(() => {
      const rows = this.storage.sql.exec<ResponsibilityRow>(
        `SELECT * FROM responsibilities
         WHERE owner_uid = ?
           AND assignee_kind = 'process'
           AND assignee_pid = ?
           AND state NOT IN ('resolved', 'cancelled')
         ORDER BY revision ASC, responsibility_id ASC`,
        input.ownerUid,
        input.processId,
      ).toArray();
      for (const row of rows) {
        const current = recordFromRow(row);
        const revision = this.advanceLedger(input.ownerUid, input.now);
        this.storage.sql.exec(
          `UPDATE responsibilities SET
             assignee_kind = 'ship', assignee_pid = NULL, state = 'open',
             lease_expires_at = NULL, lease_woken_at = NULL,
             change_pending = 1, wake_retry_at = NULL, revision = ?, updated_at = ?
           WHERE owner_uid = ? AND responsibility_id = ?`,
          revision,
          input.now,
          input.ownerUid,
          current.id,
        );
        const record = recordFromRow(this.requireRow(input.ownerUid, current.id));
        const changedFields = ["assignee"];
        if (current.state !== "open") changedFields.push("state");
        if (current.leaseExpiresAtMs !== undefined) {
          changedFields.push("leaseExpiresAtMs");
        }
        this.appendTransition({
          ownerUid: input.ownerUid,
          revision,
          id: current.id,
          kind: "updated",
          beforeState: current.state,
          afterState: record.state,
          beforeAssigneeProcessId: input.processId,
          changedFields,
          actor: { kind: "system", component: "process.lifecycle" },
          record,
          now: input.now,
        });
        reclaimed.push(record);
      }
    });
    return reclaimed;
  }

  nextWakeAt(ownerUid: number, now: number): number | null {
    const pending = this.getPendingBatchRow(ownerUid);
    if (pending) return now;
    const row = this.storage.sql.exec<{ wake_at: number | null }>(
      `SELECT MIN(wake_at) AS wake_at FROM (
         SELECT ? AS wake_at
         FROM responsibilities
         WHERE owner_uid = ? AND change_pending = 1
         UNION ALL
         SELECT wake_retry_at AS wake_at
         FROM responsibilities
         WHERE owner_uid = ?
           AND state NOT IN ('resolved', 'cancelled')
           AND wake_retry_at IS NOT NULL
         UNION ALL
         SELECT next_check_at AS wake_at
         FROM responsibilities
         WHERE owner_uid = ?
           AND state NOT IN ('resolved', 'cancelled')
           AND next_check_at IS NOT NULL
           AND (check_woken_at IS NULL OR check_woken_at != next_check_at)
         UNION ALL
         SELECT due_at AS wake_at
         FROM responsibilities
         WHERE owner_uid = ?
           AND state NOT IN ('resolved', 'cancelled')
           AND due_at IS NOT NULL
           AND (due_woken_at IS NULL OR due_woken_at != due_at)
         UNION ALL
         SELECT lease_expires_at AS wake_at
         FROM responsibilities
         WHERE owner_uid = ?
           AND state NOT IN ('resolved', 'cancelled')
           AND lease_expires_at IS NOT NULL
           AND (lease_woken_at IS NULL OR lease_woken_at != lease_expires_at)
       )`,
      now,
      ownerUid,
      ownerUid,
      ownerUid,
      ownerUid,
      ownerUid,
    ).toArray()[0];
    return row?.wake_at ?? null;
  }

  wakeState(ownerUid: number): ResponsibilityWakeState {
    const ledger = this.getLedger(ownerUid);
    return {
      ownerUid,
      generation: ledger?.wake_generation ?? 0,
      taskId: ledger?.wake_task_id ?? null,
      scheduledAtMs: ledger?.wake_at ?? null,
    };
  }

  setWakeTask(
    ownerUid: number,
    generation: number,
    taskId: string | null,
    wakeAtMs: number | null,
    now: number,
  ): boolean {
    const result = this.storage.sql.exec(
      `UPDATE responsibility_ledgers
       SET wake_task_id = ?, wake_at = ?, updated_at = ?
       WHERE owner_uid = ? AND wake_generation = ?`,
      taskId,
      wakeAtMs,
      now,
      ownerUid,
      generation,
    );
    return result.rowsWritten > 0;
  }

  ownersWithLedgers(): number[] {
    return this.storage.sql.exec<{ owner_uid: number }>(
      "SELECT owner_uid FROM responsibility_ledgers ORDER BY owner_uid",
    ).toArray().map((row) => row.owner_uid);
  }

  createReadyBatch(
    ownerUid: number,
    now: number,
    limit = DEFAULT_WAKE_BATCH_LIMIT,
  ): ResponsibilityWakeBatch | null {
    let batch: ResponsibilityWakeBatch | null = null;
    this.storage.transactionSync(() => {
      const existing = this.getPendingBatchRow(ownerUid);
      if (existing) {
        batch = batchFromRow(existing, this.recordsByIds(ownerUid, parseStringArray(existing.responsibility_ids_json)));
        return;
      }
      const rows = this.storage.sql.exec<ResponsibilityRow>(
        `SELECT * FROM responsibilities
         WHERE owner_uid = ? AND (
           change_pending = 1
           OR (
             state NOT IN ('resolved', 'cancelled')
             AND (
               (next_check_at IS NOT NULL AND next_check_at <= ?
                 AND (check_woken_at IS NULL OR check_woken_at != next_check_at))
               OR (due_at IS NOT NULL AND due_at <= ?
                 AND (due_woken_at IS NULL OR due_woken_at != due_at))
               OR (lease_expires_at IS NOT NULL AND lease_expires_at <= ?
                 AND (lease_woken_at IS NULL OR lease_woken_at != lease_expires_at))
               OR (wake_retry_at IS NOT NULL AND wake_retry_at <= ?)
             )
           )
         )
         ORDER BY
           CASE priority
             WHEN 'critical' THEN 0
             WHEN 'high' THEN 1
             WHEN 'normal' THEN 2
             ELSE 3
           END,
           revision ASC
         LIMIT ?`,
        ownerUid,
        now,
        now,
        now,
        now,
        Math.max(1, Math.min(100, Math.trunc(limit))),
      ).toArray();
      if (rows.length === 0) return;

      for (const row of rows) {
        this.storage.sql.exec(
          `UPDATE responsibilities SET
             change_pending = 0,
             check_woken_at = CASE
               WHEN next_check_at IS NOT NULL AND next_check_at <= ? THEN next_check_at
               ELSE check_woken_at
             END,
             due_woken_at = CASE
               WHEN due_at IS NOT NULL AND due_at <= ? THEN due_at
               ELSE due_woken_at
             END,
             lease_woken_at = CASE
               WHEN lease_expires_at IS NOT NULL AND lease_expires_at <= ? THEN lease_expires_at
               ELSE lease_woken_at
             END,
             wake_retry_at = ?
           WHERE owner_uid = ? AND responsibility_id = ?`,
          now,
          now,
          now,
          responsibilityRequiresAction(recordFromRow(row), now)
            ? now + RESPONSIBILITY_WAKE_RETRY_MS
            : null,
          ownerUid,
          row.responsibility_id,
        );
      }
      const id = `batch:${crypto.randomUUID()}`;
      const eventId = `r12y.ready:${id}`;
      const ids = rows.map((row) => row.responsibility_id);
      const throughRevision = this.revision(ownerUid);
      this.storage.sql.exec(
        `INSERT INTO responsibility_wake_batches (
          batch_id, owner_uid, through_revision, responsibility_ids_json,
          event_id, attempt_count, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
        id,
        ownerUid,
        throughRevision,
        JSON.stringify(ids),
        eventId,
        now,
        now,
      );
      const currentRecords = this.recordsByIds(ownerUid, ids);
      batch = {
        id,
        ownerUid,
        throughRevision,
        eventId,
        responsibilities: currentRecords,
        attemptCount: 0,
        createdAtMs: now,
      };
    });
    return batch;
  }

  pendingBatch(ownerUid: number): ResponsibilityWakeBatch | null {
    const row = this.getPendingBatchRow(ownerUid);
    if (!row) return null;
    return batchFromRow(
      row,
      this.recordsByIds(ownerUid, parseStringArray(row.responsibility_ids_json)),
    );
  }

  markBatchDelivered(batchId: string): void {
    this.storage.sql.exec(
      "DELETE FROM responsibility_wake_batches WHERE batch_id = ?",
      batchId,
    );
  }

  markBatchFailed(batchId: string, error: string, now: number): void {
    this.storage.sql.exec(
      `UPDATE responsibility_wake_batches
       SET attempt_count = attempt_count + 1, last_error = ?, updated_at = ?
       WHERE batch_id = ?`,
      error.slice(0, 1_000),
      now,
      batchId,
    );
  }

  private getRow(ownerUid: number, id: string): ResponsibilityRow | null {
    return this.storage.sql.exec<ResponsibilityRow>(
      "SELECT * FROM responsibilities WHERE owner_uid = ? AND responsibility_id = ? LIMIT 1",
      ownerUid,
      id,
    ).toArray()[0] ?? null;
  }

  private requireRow(ownerUid: number, id: string): ResponsibilityRow {
    const row = this.getRow(ownerUid, id);
    if (!row) throw new Error(`Responsibility not found after mutation: ${id}`);
    return row;
  }

  private getDedupeRow(ownerUid: number, dedupeKey: string): ResponsibilityRow | null {
    return this.storage.sql.exec<ResponsibilityRow>(
      "SELECT * FROM responsibilities WHERE owner_uid = ? AND dedupe_key = ? LIMIT 1",
      ownerUid,
      dedupeKey,
    ).toArray()[0] ?? null;
  }

  private ensureLedger(ownerUid: number, now: number): void {
    this.storage.sql.exec(
      `INSERT OR IGNORE INTO responsibility_ledgers (
        owner_uid, revision, wake_generation, wake_task_id, wake_at,
        created_at, updated_at
      ) VALUES (?, 0, 0, NULL, NULL, ?, ?)`,
      ownerUid,
      now,
      now,
    );
  }

  private advanceLedger(ownerUid: number, now: number): number {
    this.ensureLedger(ownerUid, now);
    this.storage.sql.exec(
      `UPDATE responsibility_ledgers
       SET revision = revision + 1,
           wake_generation = wake_generation + 1,
           updated_at = ?
       WHERE owner_uid = ?`,
      now,
      ownerUid,
    );
    return this.revision(ownerUid);
  }

  private getLedger(ownerUid: number): ResponsibilityLedgerRow | null {
    return this.storage.sql.exec<ResponsibilityLedgerRow>(
      `SELECT owner_uid, revision, wake_generation, wake_task_id, wake_at
       FROM responsibility_ledgers WHERE owner_uid = ? LIMIT 1`,
      ownerUid,
    ).toArray()[0] ?? null;
  }

  private assertParent(ownerUid: number, parentId?: string | null, selfId?: string): void {
    if (!parentId) return;
    if (parentId === selfId) throw new Error("A responsibility cannot be its own parent");
    const parent = this.getRow(ownerUid, parentId);
    if (!parent) throw new Error(`Parent responsibility not found: ${parentId}`);
    let current = parent;
    const seen = new Set<string>();
    while (current.parent_id) {
      if (current.parent_id === selfId) {
        throw new Error("Responsibility parent would create a cycle");
      }
      if (seen.has(current.parent_id)) {
        throw new Error("Responsibility hierarchy contains a cycle");
      }
      seen.add(current.parent_id);
      const next = this.getRow(ownerUid, current.parent_id);
      if (!next) break;
      current = next;
    }
  }

  private assertStateTransition(
    before: ResponsibilityState,
    after: ResponsibilityState,
  ): void {
    if (before === after) return;
    if (before === "resolved" || before === "cancelled") {
      throw new Error(`Terminal responsibility cannot transition from ${before} to ${after}`);
    }
  }

  private appendTransition(input: {
    ownerUid: number;
    revision: number;
    id: string;
    kind: ResponsibilityTransition["kind"];
    beforeState?: ResponsibilityState;
    afterState: ResponsibilityState;
    beforeAssigneeProcessId?: string;
    changedFields: string[];
    actor: ResponsibilitySource;
    record: ResponsibilityRecord;
    now: number;
  }): void {
    this.storage.sql.exec(
      `INSERT INTO responsibility_transitions (
        owner_uid, revision, responsibility_id, kind, before_state,
        after_state, assignee_pid, before_assignee_pid, changed_fields_json,
        actor_json, record_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.ownerUid,
      input.revision,
      input.id,
      input.kind,
      input.beforeState ?? null,
      input.afterState,
      input.record.assignee.kind === "process" ? input.record.assignee.processId : null,
      input.beforeAssigneeProcessId ?? null,
      JSON.stringify(input.changedFields),
      JSON.stringify(input.actor),
      JSON.stringify(input.record),
      input.now,
    );
  }

  private getPendingBatchRow(ownerUid: number): ResponsibilityWakeBatchRow | null {
    return this.storage.sql.exec<ResponsibilityWakeBatchRow>(
      `SELECT * FROM responsibility_wake_batches
       WHERE owner_uid = ?
       LIMIT 1`,
      ownerUid,
    ).toArray()[0] ?? null;
  }

  private recordsByIds(ownerUid: number, ids: string[]): ResponsibilityRecord[] {
    const records: ResponsibilityRecord[] = [];
    for (const id of ids) {
      const row = this.getRow(ownerUid, id);
      if (row) records.push(recordFromRow(row));
    }
    return records;
  }
}

function applyPatch(
  current: ResponsibilityRecord,
  patch: ResponsibilityUpdateInput["patch"],
  now: number,
): ResponsibilityRecord {
  const next: ResponsibilityRecord = {
    ...current,
    title: patch.title ?? current.title,
    assignee: patch.assignee ?? current.assignee,
    state: patch.state ?? current.state,
    priority: patch.priority ?? current.priority,
    revision: current.revision,
    updatedAtMs: now,
  };
  assignNullable(next, "details", patch.details);
  assignNullable(next, "parentId", patch.parentId);
  assignNullable(next, "audience", patch.audience);
  assignNullable(next, "dueAtMs", patch.dueAtMs);
  assignNullable(next, "nextCheckAtMs", patch.nextCheckAtMs);
  assignNullable(next, "blocker", patch.blocker);
  assignNullable(next, "leaseExpiresAtMs", patch.leaseExpiresAtMs);
  assignNullable(next, "resolution", patch.resolution);
  return next;
}

function shouldMarkChangePending(
  responsibility: Pick<
    ResponsibilityRecord,
    | "assignee"
    | "state"
    | "blocker"
    | "dueAtMs"
    | "nextCheckAtMs"
    | "leaseExpiresAtMs"
  >,
  observedByShip: boolean,
  now: number,
): 0 | 1 {
  if (!observedByShip) return 1;
  return responsibilityRequiresAction(responsibility, now) ? 1 : 0;
}

function assignNullable<
  Key extends "details" | "parentId" | "audience" | "dueAtMs" | "nextCheckAtMs" | "blocker" | "leaseExpiresAtMs" | "resolution",
>(
  target: ResponsibilityRecord,
  key: Key,
  value: ResponsibilityUpdateInput["patch"][Key],
): void {
  if (value === undefined) return;
  if (value === null) {
    delete target[key];
    return;
  }
  // SAFETY: each key is paired with its exact ResponsibilityPatch value above.
  target[key] = value as ResponsibilityRecord[Key];
}

function changedResponsibilityFields(
  before: ResponsibilityRecord,
  after: ResponsibilityRecord,
): string[] {
  const fields: Array<keyof ResponsibilityRecord> = [
    "parentId",
    "title",
    "details",
    "audience",
    "assignee",
    "state",
    "priority",
    "dueAtMs",
    "nextCheckAtMs",
    "blocker",
    "leaseExpiresAtMs",
    "resolution",
  ];
  return fields
    .filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]))
    .map(String);
}

function recordFromRow(row: ResponsibilityRow): ResponsibilityRecord {
  const assignee: ResponsibilityAssignee = row.assignee_kind === "process"
    ? { kind: "process", processId: row.assignee_pid! }
    : { kind: "ship" };
  const record: ResponsibilityRecord = {
    id: row.responsibility_id,
    ownerUid: row.owner_uid,
    title: row.title,
    source: parseStoredJson<ResponsibilitySource>(row.source_json),
    assignee,
    state: row.state,
    priority: row.priority,
    revision: row.revision,
    createdAtMs: row.created_at,
    updatedAtMs: row.updated_at,
  };
  if (row.parent_id) record.parentId = row.parent_id;
  if (row.details_json) record.details = parseStoredJson<JsonObject>(row.details_json);
  if (row.audience_json) {
    record.audience = parseStoredJson<ResponsibilityAudience>(row.audience_json);
  }
  if (row.due_at !== null) record.dueAtMs = row.due_at;
  if (row.next_check_at !== null) record.nextCheckAtMs = row.next_check_at;
  if (row.blocker) record.blocker = row.blocker;
  if (row.lease_expires_at !== null) record.leaseExpiresAtMs = row.lease_expires_at;
  if (row.dedupe_key) record.dedupeKey = row.dedupe_key;
  if (row.resolution_json) {
    record.resolution = parseStoredJson<JsonObject>(row.resolution_json);
  }
  if (row.resolved_at !== null) record.resolvedAtMs = row.resolved_at;
  return record;
}

function transitionFromRow(row: ResponsibilityTransitionRow): ResponsibilityTransition {
  const transition: ResponsibilityTransition = {
    revision: row.revision,
    responsibilityId: row.responsibility_id,
    kind: row.kind,
    afterState: row.after_state,
    changedFields: parseStoredJson<string[]>(row.changed_fields_json),
    actor: parseStoredJson<ResponsibilitySource>(row.actor_json),
    record: parseStoredJson<ResponsibilityRecord>(row.record_json),
    createdAtMs: row.created_at,
  };
  if (row.before_state) transition.beforeState = row.before_state;
  return transition;
}

function batchFromRow(
  row: ResponsibilityWakeBatchRow,
  records: ResponsibilityRecord[],
): ResponsibilityWakeBatch {
  return {
    id: row.batch_id,
    ownerUid: row.owner_uid,
    throughRevision: row.through_revision,
    eventId: row.event_id,
    responsibilities: records,
    attemptCount: row.attempt_count,
    createdAtMs: row.created_at,
  };
}

function parseStringArray(value: string): string[] {
  return parseStoredJson<string[]>(value);
}

function parseStoredJson<Value>(value: string): Value {
  // SAFETY: these values are written only by ResponsibilityStore from typed domain records.
  return JSON.parse(value) as Value;
}

function clampLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.trunc(value!)));
}

function clampOffset(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value!));
}
