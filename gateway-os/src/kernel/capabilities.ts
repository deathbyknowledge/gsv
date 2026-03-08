/**
 * Group-based capability management backed by kernel DO SQLite.
 *
 * Table schema:
 *   group_capabilities (gid INTEGER, capability TEXT, PRIMARY KEY (gid, capability))
 *
 * Capability format:
 *   "*"           — unrestricted access
 *   "domain.*"    — all syscalls in a domain (e.g. "fs.*")
 *   "domain.name" — single syscall (e.g. "proc.exec")
 */


const CAPABILITY_PATTERN = /^(\*|[a-z][a-z0-9]*\.\*|[a-z][a-z0-9]*\.[a-z][a-z0-9]*)$/;

const DEFAULT_CAPABILITIES: [number, string[]][] = [
  [0,   ["*"]],                                // root
  [100, ["fs.*", "session.*", "proc.*"]],      // users
  [101, ["fs.*", "proc.*"]],                   // drivers
  [102, ["ipc.*"]],                            // services
];

export class CapabilityStore {
  private sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.sql = sql;
  }

  init(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS group_capabilities (
        gid        INTEGER NOT NULL,
        capability TEXT    NOT NULL,
        PRIMARY KEY (gid, capability)
      )
    `);
  }

  seed(): void {
    const existing = this.sql.exec<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM group_capabilities`,
    ).toArray();

    if (existing[0].cnt > 0) return;

    for (const [gid, caps] of DEFAULT_CAPABILITIES) {
      for (const cap of caps) {
        this.sql.exec(
          `INSERT INTO group_capabilities (gid, capability) VALUES (?, ?)`,
          gid,
          cap,
        );
      }
    }
  }

  resolve(gids: number[]): string[] {
    if (gids.length === 0) return [];

    const placeholders = gids.map(() => "?").join(", ");
    const rows = this.sql.exec<{ capability: string }>(
      `SELECT DISTINCT capability FROM group_capabilities WHERE gid IN (${placeholders})`,
      ...gids,
    ).toArray();

    return rows.map((r) => r.capability);
  }

  grant(gid: number, capability: string): { ok: boolean; error?: string } {
    if (!isValidCapability(capability)) {
      return { ok: false, error: `Invalid capability format: ${capability}` };
    }

    this.sql.exec(
      `INSERT OR IGNORE INTO group_capabilities (gid, capability) VALUES (?, ?)`,
      gid,
      capability,
    );

    return { ok: true };
  }

  revoke(gid: number, capability: string): { ok: boolean; error?: string } {
    this.sql.exec(
      `DELETE FROM group_capabilities WHERE gid = ? AND capability = ?`,
      gid,
      capability,
    );

    return { ok: true };
  }

  list(gid?: number): { gid: number; capability: string }[] {
    if (gid !== undefined) {
      return this.sql.exec<{ gid: number; capability: string }>(
        `SELECT gid, capability FROM group_capabilities WHERE gid = ? ORDER BY capability`,
        gid,
      ).toArray();
    }

    return this.sql.exec<{ gid: number; capability: string }>(
      `SELECT gid, capability FROM group_capabilities ORDER BY gid, capability`,
    ).toArray();
  }
}

/**
 * Check whether a set of capabilities allows a given syscall.
 *
 *   "*"           matches everything
 *   "fs.*"        matches any "fs.XXX"
 *   "proc.exec"   matches only "proc.exec"
 */
export function hasCapability(
  capabilities: string[],
  syscall: string,
): boolean {
  const domain = syscall.split(".")[0];

  for (const cap of capabilities) {
    if (cap === "*") return true;
    if (cap === `${domain}.*`) return true;
    if (cap === syscall) return true;
  }

  return false;
}

export function isValidCapability(cap: string): boolean {
  return CAPABILITY_PATTERN.test(cap);
}
