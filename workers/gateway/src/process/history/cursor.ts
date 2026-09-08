export type HistoryCursor = {
  generation: number;
  revision: number;
};

/** Cursor contents are versioned implementation details, never caller authority. */
export function historyCursor(pid: string, generation: number, revision: number): string {
  return `h1:${encodeURIComponent(pid)}:${generation}:${revision}`;
}

export function parseHistoryCursor(
  value: string,
  pid: string,
): HistoryCursor | { error: string } {
  const parts = value.split(":");
  if (parts.length !== 4 || parts[0] !== "h1" ||
      !/^[1-9]\d*$/.test(parts[2]!) || !/^(0|[1-9]\d*)$/.test(parts[3]!)) {
    return { error: "proc.history since cursor is malformed or unsupported" };
  }
  if (parts[1] !== encodeURIComponent(pid)) {
    return { error: "proc.history since cursor belongs to another process" };
  }
  const generation = Number(parts[2]);
  const revision = Number(parts[3]);
  if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(revision)) {
    return { error: "proc.history since cursor is malformed or unsupported" };
  }
  return { generation, revision };
}
