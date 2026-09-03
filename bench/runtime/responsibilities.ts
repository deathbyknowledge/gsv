import type {
  JsonObject,
  ResponsibilityCreateResult,
  ResponsibilityListResult,
  ResponsibilityPatch,
  ResponsibilityPriority,
  ResponsibilityRecord,
  ResponsibilityTransition,
} from "@humansandmachines/gsv/protocol";
import { responsibilityRequiresAction } from "@humansandmachines/gsv/protocol";
import type {
  SyntheticProcessSpec,
  SyntheticResponsibilityLedgerSnapshot,
} from "./schema";

type TransitionRecorder = (transition: ResponsibilityTransition) => void;
type ComparableResponsibilityValue =
  | ResponsibilityRecord["details"]
  | ResponsibilityRecord["audience"]
  | ResponsibilityRecord["assignee"]
  | null;

export class SyntheticResponsibilityLedger {
  private readonly records = new Map<string, ResponsibilityRecord>();
  private readonly transitions: ResponsibilityTransition[] = [];
  private readonly revisions = new Map<number, number>();
  private readonly recordTransition: TransitionRecorder;
  private nextId = 1;

  constructor(recordTransition: TransitionRecorder) {
    this.recordTransition = recordTransition;
  }

  create(input: {
    process: SyntheticProcessSpec;
    title: string;
    details?: JsonObject;
    priority?: ResponsibilityPriority;
    dedupeKey?: string;
  }, now: number): ResponsibilityCreateResult {
    const ownerUid = processOwnerUid(input.process);
    if (input.dedupeKey) {
      const existing = [...this.records.values()].find((record) => (
        record.ownerUid === ownerUid && record.dedupeKey === input.dedupeKey
      ));
      if (existing) {
        return {
          responsibility: structuredClone(existing),
          created: false,
          revision: this.revision(ownerUid),
        };
      }
    }
    const revision = this.nextRevision(ownerUid);
    const record: ResponsibilityRecord = {
      id: responsibilityId(this.nextId),
      ownerUid,
      title: input.title,
      source: { kind: "process", processId: input.process.id },
      assignee: input.process.role === "ship"
        ? { kind: "ship" }
        : { kind: "process", processId: input.process.id },
      state: "open",
      priority: input.priority ?? "normal",
      revision,
      createdAtMs: now,
      updatedAtMs: now,
    };
    this.nextId += 1;
    if (input.details !== undefined) record.details = structuredClone(input.details);
    if (input.dedupeKey !== undefined) record.dedupeKey = input.dedupeKey;
    this.records.set(record.id, record);
    this.appendTransition({
      revision,
      responsibilityId: record.id,
      kind: "created",
      afterState: record.state,
      changedFields: ["created"],
      actor: { kind: "process", processId: input.process.id },
      record: structuredClone(record),
      createdAtMs: now,
    });
    return {
      responsibility: structuredClone(record),
      created: true,
      revision,
    };
  }

  update(input: {
    process: SyntheticProcessSpec;
    id: string;
    patch: ResponsibilityPatch;
  }, now: number): ResponsibilityRecord {
    const current = this.records.get(input.id);
    const ownerUid = processOwnerUid(input.process);
    if (!current || current.ownerUid !== ownerUid) {
      throw new Error("Responsibility not found: " + input.id);
    }
    if (!this.isVisibleToProcess(current, input.process)) {
      throw new Error("Responsibility not found: " + input.id);
    }
    if (
      input.process.role === "worker"
      && input.patch.assignee?.kind === "process"
      && input.patch.assignee.processId !== input.process.id
    ) {
      throw new Error("A child process cannot assign responsibility to another child");
    }
    const before = structuredClone(current);
    const changedFields = applyPatch(current, input.patch);
    if (changedFields.length === 0) return structuredClone(current);
    const revision = this.nextRevision(ownerUid);
    current.revision = revision;
    current.updatedAtMs = now;
    if (current.state === "resolved" || current.state === "cancelled") {
      current.resolvedAtMs = now;
    } else {
      delete current.resolvedAtMs;
    }
    const kind = current.state === "resolved"
      ? "resolved"
      : current.state === "cancelled"
        ? "cancelled"
        : "updated";
    this.appendTransition({
      revision,
      responsibilityId: current.id,
      kind,
      beforeState: before.state,
      afterState: current.state,
      changedFields,
      actor: { kind: "process", processId: input.process.id },
      record: structuredClone(current),
      createdAtMs: now,
    });
    return structuredClone(current);
  }

  get(process: SyntheticProcessSpec, id: string): ResponsibilityRecord {
    const record = this.records.get(id);
    if (!record || !this.isVisibleToProcess(record, process)) {
      throw new Error("Responsibility not found: " + id);
    }
    return structuredClone(record);
  }

  list(
    process: SyntheticProcessSpec,
    includeTerminal = false,
  ): ResponsibilityListResult {
    const ownerUid = processOwnerUid(process);
    const responsibilities = [...this.records.values()]
      .filter((record) => record.ownerUid === ownerUid)
      .filter((record) => includeTerminal || !isTerminal(record))
      .filter((record) => this.isVisibleToProcess(record, process))
      .sort(compareResponsibilities)
      .map((record) => structuredClone(record));
    return {
      responsibilities,
      count: responsibilities.length,
      revision: this.revision(ownerUid),
    };
  }

  changes(
    process: SyntheticProcessSpec,
    afterRevision: number,
  ): ResponsibilityTransition[] {
    const ownerUid = processOwnerUid(process);
    return this.transitions
      .filter((transition) => transition.revision > afterRevision)
      .filter((transition) => transition.record.ownerUid === ownerUid)
      .filter((transition) => (
        process.role === "ship"
        || this.isVisibleToProcess(transition.record, process)
      ))
      .map((transition) => structuredClone(transition));
  }

  unhandled(
    process: SyntheticProcessSpec,
    ids: readonly string[],
    now: number,
  ): string[] {
    const visible = new Map(
      this.list(process, true).responsibilities.map((record) => [record.id, record]),
    );
    return [...new Set(ids)].filter((id) => {
      const responsibility = visible.get(id);
      return !responsibility || responsibilityRequiresAction(responsibility, now);
    });
  }

  revision(ownerUid: number): number {
    return this.revisions.get(ownerUid) ?? 0;
  }

  snapshot(): SyntheticResponsibilityLedgerSnapshot {
    const records = Object.fromEntries(
      [...this.records.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([id, record]) => [id, structuredClone(record)]),
    );
    return {
      revision: Math.max(0, ...this.revisions.values()),
      records,
    };
  }

  private isVisibleToProcess(
    record: ResponsibilityRecord,
    process: SyntheticProcessSpec,
  ): boolean {
    if (record.ownerUid !== processOwnerUid(process)) return false;
    if (process.role === "ship") return true;
    if (
      record.assignee.kind === "process"
      && record.assignee.processId === process.id
    ) {
      return true;
    }
    let child = [...this.records.values()].find((candidate) => (
      candidate.ownerUid === record.ownerUid
      && candidate.assignee.kind === "process"
      && candidate.assignee.processId === process.id
    ));
    while (child?.parentId) {
      if (child.parentId === record.id) return true;
      child = this.records.get(child.parentId);
    }
    return false;
  }

  private nextRevision(ownerUid: number): number {
    const revision = this.revision(ownerUid) + 1;
    this.revisions.set(ownerUid, revision);
    return revision;
  }

  private appendTransition(transition: ResponsibilityTransition): void {
    this.transitions.push(transition);
    this.recordTransition(structuredClone(transition));
  }
}

export function processOwnerUid(process: SyntheticProcessSpec): number {
  return process.ownerUid ?? process.uid;
}

function responsibilityId(index: number): string {
  return "r12y:00000000-0000-4000-8000-" + index.toString(16).padStart(12, "0");
}

function applyPatch(
  record: ResponsibilityRecord,
  patch: ResponsibilityPatch,
): string[] {
  const changed: string[] = [];
  if (patch.title !== undefined && record.title !== patch.title) {
    record.title = patch.title;
    changed.push("title");
  }
  if (patch.details !== undefined && valuesDiffer(record.details, patch.details)) {
    if (patch.details === null) delete record.details;
    else record.details = structuredClone(patch.details);
    changed.push("details");
  }
  if (patch.parentId !== undefined && record.parentId !== patch.parentId) {
    if (patch.parentId === null) delete record.parentId;
    else record.parentId = patch.parentId;
    changed.push("parentId");
  }
  if (patch.audience !== undefined && valuesDiffer(record.audience, patch.audience)) {
    if (patch.audience === null) delete record.audience;
    else record.audience = structuredClone(patch.audience);
    changed.push("audience");
  }
  if (patch.assignee !== undefined && valuesDiffer(record.assignee, patch.assignee)) {
    record.assignee = structuredClone(patch.assignee);
    changed.push("assignee");
  }
  if (patch.state !== undefined && record.state !== patch.state) {
    record.state = patch.state;
    changed.push("state");
  }
  if (patch.priority !== undefined && record.priority !== patch.priority) {
    record.priority = patch.priority;
    changed.push("priority");
  }
  if (patch.dueAtMs !== undefined && record.dueAtMs !== patch.dueAtMs) {
    if (patch.dueAtMs === null) delete record.dueAtMs;
    else record.dueAtMs = patch.dueAtMs;
    changed.push("dueAtMs");
  }
  if (
    patch.nextCheckAtMs !== undefined
    && record.nextCheckAtMs !== patch.nextCheckAtMs
  ) {
    if (patch.nextCheckAtMs === null) delete record.nextCheckAtMs;
    else record.nextCheckAtMs = patch.nextCheckAtMs;
    changed.push("nextCheckAtMs");
  }
  if (patch.blocker !== undefined && record.blocker !== patch.blocker) {
    if (patch.blocker === null) delete record.blocker;
    else record.blocker = patch.blocker;
    changed.push("blocker");
  }
  if (
    patch.leaseExpiresAtMs !== undefined
    && record.leaseExpiresAtMs !== patch.leaseExpiresAtMs
  ) {
    if (patch.leaseExpiresAtMs === null) delete record.leaseExpiresAtMs;
    else record.leaseExpiresAtMs = patch.leaseExpiresAtMs;
    changed.push("leaseExpiresAtMs");
  }
  if (
    patch.resolution !== undefined
    && valuesDiffer(record.resolution, patch.resolution)
  ) {
    if (patch.resolution === null) delete record.resolution;
    else record.resolution = structuredClone(patch.resolution);
    changed.push("resolution");
  }
  return changed;
}

function valuesDiffer(
  left: ComparableResponsibilityValue,
  right: ComparableResponsibilityValue,
): boolean {
  return JSON.stringify(left) !== JSON.stringify(right);
}

function isTerminal(record: ResponsibilityRecord): boolean {
  return record.state === "resolved" || record.state === "cancelled";
}

function compareResponsibilities(
  left: ResponsibilityRecord,
  right: ResponsibilityRecord,
): number {
  const priority = { critical: 0, high: 1, normal: 2, low: 3 };
  return priority[left.priority] - priority[right.priority]
    || right.updatedAtMs - left.updatedAtMs
    || left.id.localeCompare(right.id);
}
