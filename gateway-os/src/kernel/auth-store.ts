/**
 * AuthStore — kernel SQLite-backed storage for /etc/passwd, /etc/shadow, /etc/group.
 *
 * Replaces R2 storage for auth files. Benefits:
 * - No R2 round-trips during sys.connect
 * - No credentials stored in an object store
 * - Files still accessible at /etc/passwd etc. via GsvFs virtual path routing
 * - Atomic read/write with SQLite transactions
 *
 * The three tables mirror the classic flat-file formats. The parsers/serializers
 * in auth/ are reused: writes parse the flat format into rows, reads serialize
 * rows back into flat format strings.
 */

import type { PasswdEntry } from "../auth/passwd";
import { parsePasswd, serializePasswd } from "../auth/passwd";
import type { ShadowEntry } from "../auth/shadow";
import { parseShadow, serializeShadow, isLocked, makeShadowEntry, hashToken, verify } from "../auth/shadow";
import type { GroupEntry } from "../auth/group";
import { parseGroup, serializeGroup, resolveGids } from "../auth/group";

export type AuthIdentity = {
  uid: number;
  gid: number;
  gids: number[];
  username: string;
  home: string;
};

export type AuthResult =
  | { ok: true; identity: AuthIdentity }
  | { ok: false; error: string };

export class AuthStore {
  constructor(private readonly sql: SqlStorage) {}

  init(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS passwd (
        username TEXT PRIMARY KEY,
        uid      INTEGER NOT NULL UNIQUE,
        gid      INTEGER NOT NULL,
        gecos    TEXT NOT NULL DEFAULT '',
        home     TEXT NOT NULL,
        shell    TEXT NOT NULL DEFAULT '/bin/init'
      )
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS shadow (
        username    TEXT PRIMARY KEY,
        hash        TEXT NOT NULL DEFAULT '!',
        lastchanged TEXT NOT NULL DEFAULT '',
        min         TEXT NOT NULL DEFAULT '0',
        max         TEXT NOT NULL DEFAULT '99999',
        warn        TEXT NOT NULL DEFAULT '7',
        inactive    TEXT NOT NULL DEFAULT '',
        expire      TEXT NOT NULL DEFAULT '',
        reserved    TEXT NOT NULL DEFAULT ''
      )
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS groups (
        name    TEXT PRIMARY KEY,
        gid     INTEGER NOT NULL UNIQUE,
        members TEXT NOT NULL DEFAULT ''
      )
    `);
  }

  // ---------------------------------------------------------------------------
  // Bootstrap — seed default entries if tables are empty
  // ---------------------------------------------------------------------------

  isBootstrapped(): boolean {
    const rows = this.sql.exec<{ c: number }>("SELECT COUNT(*) as c FROM passwd").toArray();
    return rows[0].c > 0;
  }

  async bootstrap(rootToken?: string): Promise<boolean> {
    if (this.isBootstrapped()) return false;

    this.addUser({
      username: "root", uid: 0, gid: 0,
      gecos: "root", home: "/root", shell: "/bin/init",
    });

    const hash = rootToken ? await hashToken(rootToken) : "!";
    this.setShadow(makeShadowEntry("root", hash));

    this.addGroup({ name: "root", gid: 0, members: ["root"] });
    this.addGroup({ name: "users", gid: 100, members: [] });
    this.addGroup({ name: "drivers", gid: 101, members: [] });
    this.addGroup({ name: "services", gid: 102, members: [] });

    return true;
  }

  // ---------------------------------------------------------------------------
  // passwd
  // ---------------------------------------------------------------------------

  getPasswdEntries(): PasswdEntry[] {
    return this.sql.exec<PasswdEntry>(
      "SELECT username, uid, gid, gecos, home, shell FROM passwd ORDER BY uid",
    ).toArray();
  }

  getPasswdByUsername(username: string): PasswdEntry | null {
    const rows = this.sql.exec<PasswdEntry>(
      "SELECT username, uid, gid, gecos, home, shell FROM passwd WHERE username = ?",
      username,
    ).toArray();
    return rows[0] ?? null;
  }

  getPasswdByUid(uid: number): PasswdEntry | null {
    const rows = this.sql.exec<PasswdEntry>(
      "SELECT username, uid, gid, gecos, home, shell FROM passwd WHERE uid = ?",
      uid,
    ).toArray();
    return rows[0] ?? null;
  }

  addUser(entry: PasswdEntry): void {
    this.sql.exec(
      "INSERT INTO passwd (username, uid, gid, gecos, home, shell) VALUES (?, ?, ?, ?, ?, ?)",
      entry.username, entry.uid, entry.gid, entry.gecos, entry.home, entry.shell,
    );
  }

  updateUser(username: string, fields: Partial<Omit<PasswdEntry, "username">>): boolean {
    const existing = this.getPasswdByUsername(username);
    if (!existing) return false;

    this.sql.exec(
      "UPDATE passwd SET uid = ?, gid = ?, gecos = ?, home = ?, shell = ? WHERE username = ?",
      fields.uid ?? existing.uid,
      fields.gid ?? existing.gid,
      fields.gecos ?? existing.gecos,
      fields.home ?? existing.home,
      fields.shell ?? existing.shell,
      username,
    );
    return true;
  }

  removeUser(username: string): boolean {
    const existing = this.getPasswdByUsername(username);
    if (!existing) return false;
    this.sql.exec("DELETE FROM passwd WHERE username = ?", username);
    this.sql.exec("DELETE FROM shadow WHERE username = ?", username);
    return true;
  }

  nextUid(): number {
    const rows = this.sql.exec<{ m: number | null }>("SELECT MAX(uid) as m FROM passwd").toArray();
    const max = rows[0].m ?? 0;
    return max < 1000 ? 1000 : max + 1;
  }

  // ---------------------------------------------------------------------------
  // shadow
  // ---------------------------------------------------------------------------

  getShadowEntries(): ShadowEntry[] {
    return this.sql.exec<ShadowEntry>(
      "SELECT username, hash, lastchanged, min, max, warn, inactive, expire, reserved FROM shadow ORDER BY username",
    ).toArray();
  }

  getShadowByUsername(username: string): ShadowEntry | null {
    const rows = this.sql.exec<ShadowEntry>(
      "SELECT username, hash, lastchanged, min, max, warn, inactive, expire, reserved FROM shadow WHERE username = ?",
      username,
    ).toArray();
    return rows[0] ?? null;
  }

  setShadow(entry: ShadowEntry): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO shadow
        (username, hash, lastchanged, min, max, warn, inactive, expire, reserved)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.username, entry.hash, entry.lastchanged,
      entry.min, entry.max, entry.warn,
      entry.inactive, entry.expire, entry.reserved,
    );
  }

  async setPassword(username: string, hash: string): Promise<boolean> {
    const existing = this.getShadowByUsername(username);
    if (!existing) return false;

    const daysSinceEpoch = Math.floor(Date.now() / 86_400_000).toString();
    this.sql.exec(
      "UPDATE shadow SET hash = ?, lastchanged = ? WHERE username = ?",
      hash, daysSinceEpoch, username,
    );
    return true;
  }

  isSetupMode(): boolean {
    const root = this.getShadowByUsername("root");
    if (!root) return true;
    return isLocked(root);
  }

  // ---------------------------------------------------------------------------
  // groups
  // ---------------------------------------------------------------------------

  getGroupEntries(): GroupEntry[] {
    return this.sql.exec<{ name: string; gid: number; members: string }>(
      "SELECT name, gid, members FROM groups ORDER BY gid",
    ).toArray().map(r => ({
      name: r.name,
      gid: r.gid,
      members: r.members ? r.members.split(",") : [],
    }));
  }

  getGroupByName(name: string): GroupEntry | null {
    const rows = this.sql.exec<{ name: string; gid: number; members: string }>(
      "SELECT name, gid, members FROM groups WHERE name = ?",
      name,
    ).toArray();
    if (rows.length === 0) return null;
    const r = rows[0];
    return { name: r.name, gid: r.gid, members: r.members ? r.members.split(",") : [] };
  }

  getGroupByGid(gid: number): GroupEntry | null {
    const rows = this.sql.exec<{ name: string; gid: number; members: string }>(
      "SELECT name, gid, members FROM groups WHERE gid = ?",
      gid,
    ).toArray();
    if (rows.length === 0) return null;
    const r = rows[0];
    return { name: r.name, gid: r.gid, members: r.members ? r.members.split(",") : [] };
  }

  addGroup(entry: GroupEntry): void {
    this.sql.exec(
      "INSERT INTO groups (name, gid, members) VALUES (?, ?, ?)",
      entry.name, entry.gid, entry.members.join(","),
    );
  }

  updateGroupMembers(name: string, members: string[]): boolean {
    const existing = this.getGroupByName(name);
    if (!existing) return false;
    this.sql.exec(
      "UPDATE groups SET members = ? WHERE name = ?",
      members.join(","), name,
    );
    return true;
  }

  removeGroup(name: string): boolean {
    const existing = this.getGroupByName(name);
    if (!existing) return false;
    this.sql.exec("DELETE FROM groups WHERE name = ?", name);
    return true;
  }

  nextGid(): number {
    const rows = this.sql.exec<{ m: number | null }>("SELECT MAX(gid) as m FROM groups").toArray();
    const max = rows[0].m ?? 0;
    return max < 100 ? 100 : max + 1;
  }

  // ---------------------------------------------------------------------------
  // Resolve all gids for a user (primary + supplementary from group membership)
  // ---------------------------------------------------------------------------

  resolveGids(username: string, primaryGid: number): number[] {
    const groups = this.getGroupEntries();
    return resolveGids(groups, username, primaryGid);
  }

  // ---------------------------------------------------------------------------
  // Authentication — same as auth/index.ts but reads from SQLite
  // ---------------------------------------------------------------------------

  async authenticate(username: string, credential: string): Promise<AuthResult> {
    const user = this.getPasswdByUsername(username);
    if (!user) return { ok: false, error: "Unknown user" };

    const shadow = this.getShadowByUsername(username);
    if (!shadow) return { ok: false, error: "No credentials found" };

    const valid = await verify(credential, shadow.hash);
    if (!valid) return { ok: false, error: "Authentication failed" };

    const gids = this.resolveGids(username, user.gid);

    return {
      ok: true,
      identity: {
        uid: user.uid, gid: user.gid, gids,
        username: user.username, home: user.home,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Serialization — produce classic flat-file format for virtual FS reads
  // ---------------------------------------------------------------------------

  serializePasswd(): string {
    return serializePasswd(this.getPasswdEntries());
  }

  serializeShadow(): string {
    return serializeShadow(this.getShadowEntries());
  }

  serializeGroup(): string {
    return serializeGroup(this.getGroupEntries());
  }

  // ---------------------------------------------------------------------------
  // Deserialization — parse flat-file format from virtual FS writes
  // ---------------------------------------------------------------------------

  importPasswd(raw: string): void {
    const entries = parsePasswd(raw);
    this.sql.exec("DELETE FROM passwd");
    for (const e of entries) this.addUser(e);
  }

  importShadow(raw: string): void {
    const entries = parseShadow(raw);
    this.sql.exec("DELETE FROM shadow");
    for (const e of entries) this.setShadow(e);
  }

  importGroup(raw: string): void {
    const entries = parseGroup(raw);
    this.sql.exec("DELETE FROM groups");
    for (const e of entries) this.addGroup(e);
  }

  // ---------------------------------------------------------------------------
  // UID/GID name resolution — used by ls, stat, etc.
  // ---------------------------------------------------------------------------

  uidToName(uid: number): string {
    const entry = this.getPasswdByUid(uid);
    return entry?.username ?? String(uid);
  }

  gidToName(gid: number): string {
    const entry = this.getGroupByGid(gid);
    return entry?.name ?? String(gid);
  }
}
