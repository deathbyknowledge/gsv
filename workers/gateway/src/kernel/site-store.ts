import type { Site } from "@humansandmachines/gsv/protocol";

type SiteRow = { id: string; owner_uid: number; slug: string; origin: string | null; created_at: number };

export class SiteStore {
  constructor(private readonly sql: SqlStorage) {}

  reserve(ownerUid: number, slug: string): SiteRow {
    const existing = this.sql.exec<SiteRow>("SELECT * FROM sites WHERE slug = ?", slug).toArray()[0];
    if (existing) {
      if (existing.owner_uid !== ownerUid) throw new Error("Site slug is already reserved");
      return existing;
    }
    const id = `site-${crypto.randomUUID().replaceAll("-", "")}`;
    this.sql.exec("INSERT INTO sites (id, owner_uid, slug, created_at) VALUES (?, ?, ?, ?)", id, ownerUid, slug, Date.now());
    return this.sql.exec<SiteRow>("SELECT * FROM sites WHERE id = ?", id).one();
  }

  bindOrigin(id: string, origin: string): void {
    this.sql.exec("UPDATE sites SET origin = ? WHERE id = ? AND (origin IS NULL OR origin = ?)", origin, id, origin);
    if (this.sql.exec<SiteRow>("SELECT * FROM sites WHERE id = ?", id).one().origin !== origin) throw new Error("Site origin changed");
  }

  get(ownerUid: number, id: string): Site {
    const row = this.sql.exec<SiteRow>("SELECT * FROM sites WHERE id = ? AND owner_uid = ?", id, ownerUid).toArray()[0];
    if (!row?.origin) throw new Error("Site is unavailable");
    return site(row);
  }

  list(ownerUid: number): Site[] {
    return this.sql.exec<SiteRow>("SELECT * FROM sites WHERE owner_uid = ? AND origin IS NOT NULL ORDER BY slug", ownerUid).toArray().map(site);
  }
}

function site(row: SiteRow): Site {
  return { id: row.id, slug: row.slug, origin: row.origin!, createdAtMs: row.created_at };
}
