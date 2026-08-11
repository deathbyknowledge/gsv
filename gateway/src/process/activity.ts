import type {
  ProcActivityCategory,
  ProcActivitySummaryCategory,
  ProcActivitySummaryEntry,
  ProcActivityUnit,
  ProcToolResultOutcome,
} from "@humansandmachines/gsv/protocol";

type ActivityDefinition = {
  syscall: string;
  category: ProcActivitySummaryCategory;
  unit: ProcActivityUnit;
};

const ACTIVITY_DEFINITIONS: readonly ActivityDefinition[] = [
  { syscall: "fs.search", category: "searching_files", unit: "operations" },
  { syscall: "fs.read", category: "reading_files", unit: "reads" },
  { syscall: "fs.write", category: "writing_files", unit: "operations" },
  { syscall: "fs.edit", category: "editing_files", unit: "operations" },
  { syscall: "fs.delete", category: "deleting_files", unit: "operations" },
  { syscall: "shell.exec", category: "running_commands", unit: "commands" },
  { syscall: "codemode.exec", category: "running_code", unit: "runs" },
];

const ACTIVITY_BY_SYSCALL = new Map(
  ACTIVITY_DEFINITIONS.map((definition) => [definition.syscall, definition]),
);

const ACTIVITY_BY_CATEGORY = new Map(
  ACTIVITY_DEFINITIONS.map((definition) => [definition.category, definition]),
);

export function activityCategoryForSyscall(
  syscall: string,
): ProcActivityCategory | null {
  return ACTIVITY_BY_SYSCALL.get(syscall)?.category ?? null;
}

export function recordCompletedActivity(
  summary: ProcActivitySummaryEntry[] | undefined,
  syscall: string,
  outcome: ProcToolResultOutcome,
): ProcActivitySummaryEntry[] | undefined {
  if (outcome !== "completed") {
    return summary;
  }
  const definition = ACTIVITY_BY_SYSCALL.get(syscall);
  if (!definition) {
    return summary;
  }

  const counts = new Map(
    (summary ?? []).map((entry) => [entry.category, entry.count]),
  );
  counts.set(
    definition.category,
    Math.min(Number.MAX_SAFE_INTEGER, (counts.get(definition.category) ?? 0) + 1),
  );
  return ACTIVITY_DEFINITIONS.flatMap((entry) => {
    const count = counts.get(entry.category);
    return count === undefined
      ? []
      : [{ category: entry.category, count, unit: entry.unit }];
  });
}

export function normalizeActivitySummary(
  value: unknown,
): ProcActivitySummaryEntry[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const counts = new Map<ProcActivitySummaryCategory, number>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      continue;
    }
    const record = candidate as Record<string, unknown>;
    if (typeof record.category !== "string") {
      continue;
    }
    const definition = ACTIVITY_BY_CATEGORY.get(record.category as ProcActivitySummaryCategory);
    if (
      !definition
      || record.unit !== definition.unit
      || typeof record.count !== "number"
      || !Number.isSafeInteger(record.count)
      || record.count <= 0
    ) {
      continue;
    }
    const current = counts.get(definition.category) ?? 0;
    const next = current + record.count;
    counts.set(
      definition.category,
      Number.isSafeInteger(next) ? next : Number.MAX_SAFE_INTEGER,
    );
  }

  const normalized = ACTIVITY_DEFINITIONS.flatMap((definition) => {
    const count = counts.get(definition.category);
    return count === undefined
      ? []
      : [{ category: definition.category, count, unit: definition.unit }];
  });
  return normalized.length > 0 ? normalized : null;
}
