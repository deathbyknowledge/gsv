type UpstreamPullRecord = {
  repo?: string;
  ref?: string;
  trackingRef?: string;
  changed?: boolean;
  upstreamChanged?: boolean;
  localChanged?: boolean;
  diverged?: boolean;
};

export function describeUpstreamPull(
  value: unknown,
  options: {
    repo: string;
    ref?: string | null;
    success: string;
    unchanged?: string;
    divergedAction?: string;
  },
): string {
  const record = selectPullRecord(value);
  const repo = record?.repo || options.repo;
  const ref = record?.ref || options.ref || "main";
  if (record?.diverged === true) {
    const trackingRef = record.trackingRef || "the upstream tracking ref";
    const action = options.divergedAction ?? "Merge upstream before rebuilding.";
    return `Fetched upstream into ${trackingRef}. ${repo}#${ref} has local commits; local branch stayed put. ${action}`;
  }
  if (record && isUnchangedPullRecord(record)) {
    return options.unchanged ?? `No upstream changes for ${repo}.`;
  }
  return options.success;
}

function selectPullRecord(value: unknown): UpstreamPullRecord | null {
  const record = asRecord(value);
  const imports = Array.isArray(record?.imports) ? record.imports : Array.isArray(value) ? value : null;
  if (imports) {
    const records = imports
      .map(asRecord)
      .map(normalizePullRecord)
      .filter((item): item is UpstreamPullRecord => item !== null);
    return records.find((item) => item.diverged === true)
      ?? records.find(hasPullRecordChange)
      ?? records.find(isUnchangedPullRecord)
      ?? records[0]
      ?? null;
  }
  return normalizePullRecord(record);
}

function normalizePullRecord(record: Record<string, unknown> | null): UpstreamPullRecord | null {
  if (!record) return null;
  return {
    repo: asString(record.repo),
    ref: asString(record.ref),
    trackingRef: asString(record.trackingRef),
    changed: typeof record.changed === "boolean" ? record.changed : undefined,
    upstreamChanged: typeof record.upstreamChanged === "boolean" ? record.upstreamChanged : undefined,
    localChanged: typeof record.localChanged === "boolean" ? record.localChanged : undefined,
    diverged: typeof record.diverged === "boolean" ? record.diverged : undefined,
  };
}

function hasPullRecordChange(record: UpstreamPullRecord): boolean {
  return record.changed === true
    || record.upstreamChanged === true
    || record.localChanged === true;
}

function isUnchangedPullRecord(record: UpstreamPullRecord): boolean {
  if (hasPullRecordChange(record)) return false;
  return record.changed === false
    || (record.upstreamChanged === false && record.localChanged === false);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
