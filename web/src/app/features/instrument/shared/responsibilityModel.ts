import type { ResponsibilityRecord } from "@humansandmachines/gsv/protocol";

/** Preserve hierarchy while putting blockers and active promises ahead of waiting follow-ups. */
export function responsibilityGroups(records: readonly ResponsibilityRecord[]) {
  const ids = new Set(records.map((record) => record.id));
  const priority = { critical: 0, high: 1, normal: 2, low: 3 };
  const order = (a: ResponsibilityRecord, b: ResponsibilityRecord) =>
    Number(!a.blocker) - Number(!b.blocker)
    || Number(a.state !== "active") - Number(b.state !== "active")
    || priority[a.priority] - priority[b.priority]
    || (a.dueAtMs ?? Infinity) - (b.dueAtMs ?? Infinity)
    || a.createdAtMs - b.createdAtMs;
  return {
    roots: records.filter((record) => !record.parentId || !ids.has(record.parentId)).sort(order),
    children: (id: string) => records.filter((record) => record.parentId === id).sort(order),
  };
}
