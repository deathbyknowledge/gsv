import type { RepoSummary } from "@humansandmachines/gsv/protocol";
import type { PackageStorageBinding } from "@humansandmachines/gsv/sdk/context";

const WIKI_CACHE_MIGRATIONS_TABLE = "wiki_schema_migrations";
const WIKI_REPO_CACHE_TABLE = "wiki_repo_cache";

type WikiCacheMigration = {
  id: number;
  name: string;
  statements: readonly string[];
};

const WIKI_CACHE_MIGRATIONS: readonly WikiCacheMigration[] = [
  {
    id: 1,
    name: "repo_discovery_cache",
    statements: [
      `
        CREATE TABLE IF NOT EXISTS ${WIKI_REPO_CACHE_TABLE} (
          repo            TEXT PRIMARY KEY,
          repo_updated_at INTEGER,
          is_wiki         INTEGER NOT NULL DEFAULT 0,
          wiki_id         TEXT,
          title           TEXT,
          last_checked_at INTEGER NOT NULL
        )
      `,
      `
        CREATE INDEX IF NOT EXISTS idx_wiki_repo_cache_is_wiki
        ON ${WIKI_REPO_CACHE_TABLE} (is_wiki, repo)
      `,
    ],
  },
];

export type WikiCacheManifest = {
  id?: string;
  title?: string;
};

export type WikiRepoCacheEntry = {
  repo: string;
  repoUpdatedAt: number | null;
  isWiki: boolean;
  wikiId?: string;
  title?: string;
};

export class WikiRepoDiscoveryCache {
  private schemaReady = false;

  constructor(private readonly storage?: PackageStorageBinding) {}

  async readAll(): Promise<Map<string, WikiRepoCacheEntry> | null> {
    if (!await this.ensureSchema()) {
      return null;
    }
    const rows = await this.storage!.sql.exec<Record<string, unknown>>(
      `SELECT repo, repo_updated_at, is_wiki, wiki_id, title
       FROM ${WIKI_REPO_CACHE_TABLE}`,
    );
    const entries: Array<[string, WikiRepoCacheEntry]> = [];
    for (const row of rows) {
      const repo = String(row.repo ?? "");
      if (!repo) {
        continue;
      }
      entries.push([repo, {
        repo,
        repoUpdatedAt: typeof row.repo_updated_at === "number" ? row.repo_updated_at : null,
        isWiki: row.is_wiki === 1 || row.is_wiki === true,
        wikiId: typeof row.wiki_id === "string" && row.wiki_id.trim() ? row.wiki_id.trim() : undefined,
        title: typeof row.title === "string" && row.title.trim() ? row.title.trim() : undefined,
      }]);
    }
    return new Map(entries);
  }

  async write(repo: RepoSummary, manifest: WikiCacheManifest | null): Promise<void> {
    if (!await this.ensureSchema()) {
      return;
    }
    await this.storage!.sql.exec(
      `INSERT INTO ${WIKI_REPO_CACHE_TABLE}
        (repo, repo_updated_at, is_wiki, wiki_id, title, last_checked_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo) DO UPDATE SET
        repo_updated_at = excluded.repo_updated_at,
        is_wiki = excluded.is_wiki,
        wiki_id = excluded.wiki_id,
        title = excluded.title,
        last_checked_at = excluded.last_checked_at`,
      repo.repo,
      repoUpdatedAt(repo),
      manifest ? 1 : 0,
      manifest?.id ?? null,
      manifest?.title ?? null,
      Date.now(),
    );
  }

  private async ensureSchema(): Promise<boolean> {
    if (!this.storage) {
      return false;
    }
    if (this.schemaReady) {
      return true;
    }
    await this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${WIKI_CACHE_MIGRATIONS_TABLE} (
        id         INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      )`,
    );
    const rows = await this.storage.sql.exec<Record<string, unknown>>(
      `SELECT id, name
       FROM ${WIKI_CACHE_MIGRATIONS_TABLE}
       ORDER BY id`,
    );
    const applied = new Map(rows.map((row) => [
      typeof row.id === "number" ? row.id : Number(row.id),
      String(row.name ?? ""),
    ]));
    for (const migration of WIKI_CACHE_MIGRATIONS) {
      const existing = applied.get(migration.id);
      if (existing) {
        if (existing !== migration.name) {
          throw new Error(`Wiki cache migration ${migration.id} name changed after being applied`);
        }
        continue;
      }
      for (const statement of migration.statements) {
        await this.storage.sql.exec(statement);
      }
      await this.storage.sql.exec(
        `INSERT INTO ${WIKI_CACHE_MIGRATIONS_TABLE} (id, name, applied_at)
         VALUES (?, ?, ?)`,
        migration.id,
        migration.name,
        Date.now(),
      );
    }
    this.schemaReady = true;
    return true;
  }
}

export function repoCacheEntryMatchesRepo(entry: WikiRepoCacheEntry, repo: RepoSummary): boolean {
  return entry.repoUpdatedAt === repoUpdatedAt(repo);
}

export function manifestFromRepoCacheEntry(entry: WikiRepoCacheEntry): WikiCacheManifest | null {
  if (!entry.isWiki) {
    return null;
  }
  return {
    id: entry.wikiId,
    title: entry.title,
  };
}

function repoUpdatedAt(repo: RepoSummary): number | null {
  return Number.isFinite(repo.updatedAt) ? repo.updatedAt ?? null : null;
}
