import { t } from "../../../i18n/locale";

export type McpHeaderDraft = { id: string; name: string; value: string };

export function parseMcpHeaders(rows: readonly McpHeaderDraft[]):
  | { ok: true; headers: Record<string, string> }
  | { ok: false; error: string } {
  const entries: [string, string][] = [];
  const names = new Set<string>();
  for (const row of rows) {
    const name = row.name.trim();
    if (!name && !row.value) continue;
    if (!name) return { ok: false, error: t("settings.mcp.headerNameRequired") };
    if (!row.value.trim()) return { ok: false, error: t("settings.mcp.headerValueRequired") };
    if (names.has(name.toLowerCase())) return { ok: false, error: t("settings.mcp.headerUnique") };
    if (/[\r\n]/.test(row.value)) return { ok: false, error: t("settings.mcp.headerInvalid") };
    try {
      new Headers([[name, row.value]]);
    } catch {
      return { ok: false, error: t("settings.mcp.headerInvalid") };
    }
    names.add(name.toLowerCase());
    entries.push([name, row.value]);
  }
  return { ok: true, headers: Object.fromEntries(entries) };
}
