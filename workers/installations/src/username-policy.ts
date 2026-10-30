export type UsernamePolicyLists = { reserved: string[]; blocked: string[] };
export type UsernamePolicyInput = { reserved: string; blocked: string };

/** Policy comparison only: never use this as the stored handle or uniqueness key. */
export function normalizeUsernamePolicy(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/[-_.\s]/g, "");
}

/** Operator policy for new allocations; existing identities keep their handles. */
export class UsernamePolicy {
  constructor(private readonly db: D1Database) {}

  async list(): Promise<UsernamePolicyLists> {
    const rows = await this.db.prepare("SELECT kind, entry FROM username_policy ORDER BY normalized_handle")
      .all<{ kind: keyof UsernamePolicyLists; entry: string }>();
    const lists: UsernamePolicyLists = { reserved: [], blocked: [] };
    for (const row of rows.results) lists[row.kind].push(row.entry);
    return lists;
  }

  async replace(input: UsernamePolicyInput): Promise<void> {
    const rows: { kind: keyof UsernamePolicyLists; key: string; entry: string }[] = [];
    for (const kind of ["reserved", "blocked"] as const) {
      const entries = input[kind].split(/[\r\n,]+/).map((entry) => entry.trim()).filter(Boolean);
      if (entries.length > 500) throw new Error("handle lists must contain at most 500 entries each");
      const seen = new Set<string>();
      for (const entry of entries) {
        const key = normalizeUsernamePolicy(entry);
        if (!/^[a-z0-9]{1,63}$/.test(key) || entry.length > 200) throw new Error("handle list contains an invalid username");
        if (!seen.has(key)) rows.push({ kind, key, entry });
        seen.add(key);
      }
    }
    await this.db.batch([
      this.db.prepare("DELETE FROM username_policy"),
      this.db.prepare(`INSERT INTO username_policy (kind, normalized_handle, entry)
        SELECT json_extract(value, '$.kind'), json_extract(value, '$.key'), json_extract(value, '$.entry') FROM json_each(?)`)
        .bind(JSON.stringify(rows)),
    ]);
  }
}
