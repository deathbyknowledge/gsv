export type McpHeaderDraft = { id: string; name: string; value: string };

export function parseMcpHeaders(rows: readonly McpHeaderDraft[]):
  | { ok: true; headers: Record<string, string> }
  | { ok: false; error: string } {
  const entries: [string, string][] = [];
  const names = new Set<string>();
  for (const row of rows) {
    const name = row.name.trim();
    if (!name && !row.value) continue;
    if (!name) return { ok: false, error: "Each header needs a name." };
    if (!row.value.trim()) return { ok: false, error: "Each header needs a value." };
    if (names.has(name.toLowerCase())) return { ok: false, error: "Header names must be unique regardless of letter case." };
    if (/[\r\n]/.test(row.value)) return { ok: false, error: "Use valid HTTP header names and values without line breaks." };
    try {
      new Headers([[name, row.value]]);
    } catch {
      return { ok: false, error: "Use valid HTTP header names and values without line breaks." };
    }
    names.add(name.toLowerCase());
    entries.push([name, row.value]);
  }
  return { ok: true, headers: Object.fromEntries(entries) };
}
