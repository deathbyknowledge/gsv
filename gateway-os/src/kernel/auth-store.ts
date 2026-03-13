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

export type AuthTokenKind = "node" | "service" | "user";
export type AuthTokenRole = "driver" | "service" | "user";

export type AuthTokenIssueInput = {
  uid: number;
  kind: AuthTokenKind;
  label?: string;
  allowedRole?: AuthTokenRole;
  allowedDeviceId?: string;
  expiresAt?: number;
};

export type IssuedAuthToken = {
  tokenId: string;
  token: string;
  tokenPrefix: string;
  uid: number;
  kind: AuthTokenKind;
  label: string | null;
  allowedRole: AuthTokenRole | null;
  allowedDeviceId: string | null;
  createdAt: number;
  expiresAt: number | null;
};

export type AuthTokenRecord = {
  tokenId: string;
  uid: number;
  kind: AuthTokenKind;
  label: string | null;
  tokenPrefix: string;
  allowedRole: AuthTokenRole | null;
  allowedDeviceId: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
  revokedReason: string | null;
};

type TokenAuthOptions = {
  role?: AuthTokenRole;
  deviceId?: string;
};

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

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS auth_tokens (
        token_id           TEXT PRIMARY KEY,
        uid                INTEGER NOT NULL,
        kind               TEXT NOT NULL,
        label              TEXT,
        token_hash         TEXT NOT NULL UNIQUE,
        token_prefix       TEXT NOT NULL,
        allowed_role       TEXT,
        allowed_device_id  TEXT,
        created_at         INTEGER NOT NULL,
        last_used_at       INTEGER,
        expires_at         INTEGER,
        revoked_at         INTEGER,
        revoked_reason     TEXT
      )
    `);

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_auth_tokens_uid
      ON auth_tokens(uid)
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

  /**
   * Verify an opaque machine/user token issued by this kernel.
   * Optional role/device constraints are enforced against token bindings.
   */
  async authenticateToken(
    username: string,
    token: string,
    options: TokenAuthOptions = {},
  ): Promise<AuthResult> {
    const user = this.getPasswdByUsername(username);
    if (!user) return { ok: false, error: "Unknown user" };

    const tokenHash = await hashToken(token);
    const rows = this.sql.exec<{
      token_id: string;
      allowed_role: AuthTokenRole | null;
      allowed_device_id: string | null;
      expires_at: number | null;
      revoked_at: number | null;
    }>(
      `SELECT token_id, allowed_role, allowed_device_id, expires_at, revoked_at
       FROM auth_tokens
       WHERE uid = ? AND token_hash = ?
       LIMIT 1`,
      user.uid,
      tokenHash,
    ).toArray();

    if (rows.length === 0) {
      return { ok: false, error: "Authentication failed" };
    }

    const tokenRow = rows[0];
    const now = Date.now();
    if (tokenRow.revoked_at !== null) {
      return { ok: false, error: "Authentication failed" };
    }
    if (tokenRow.expires_at !== null && tokenRow.expires_at <= now) {
      return { ok: false, error: "Authentication failed" };
    }
    if (options.role && tokenRow.allowed_role && tokenRow.allowed_role !== options.role) {
      return { ok: false, error: "Authentication failed" };
    }
    if (
      options.deviceId &&
      tokenRow.allowed_device_id &&
      tokenRow.allowed_device_id !== options.deviceId
    ) {
      return { ok: false, error: "Authentication failed" };
    }

    this.sql.exec(
      "UPDATE auth_tokens SET last_used_at = ? WHERE token_id = ?",
      now,
      tokenRow.token_id,
    );

    const gids = this.resolveGids(username, user.gid);
    return {
      ok: true,
      identity: {
        uid: user.uid,
        gid: user.gid,
        gids,
        username: user.username,
        home: user.home,
      },
    };
  }

  async issueToken(input: AuthTokenIssueInput): Promise<IssuedAuthToken> {
    const user = this.getPasswdByUid(input.uid);
    if (!user) {
      throw new Error(`Unknown uid: ${input.uid}`);
    }

    const now = Date.now();
    const tokenId = crypto.randomUUID();
    const rawToken = this.generateTokenValue(input.kind);
    const tokenPrefix = rawToken.slice(0, 16);
    const tokenHash = await hashToken(rawToken);
    const allowedRole = input.allowedRole ?? defaultRoleForKind(input.kind);

    this.sql.exec(
      `INSERT INTO auth_tokens
        (token_id, uid, kind, label, token_hash, token_prefix, allowed_role, allowed_device_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      tokenId,
      input.uid,
      input.kind,
      input.label ?? null,
      tokenHash,
      tokenPrefix,
      allowedRole,
      input.allowedDeviceId ?? null,
      now,
      input.expiresAt ?? null,
    );

    return {
      tokenId,
      token: rawToken,
      tokenPrefix,
      uid: input.uid,
      kind: input.kind,
      label: input.label ?? null,
      allowedRole,
      allowedDeviceId: input.allowedDeviceId ?? null,
      createdAt: now,
      expiresAt: input.expiresAt ?? null,
    };
  }

  listTokens(uid?: number): AuthTokenRecord[] {
    if (typeof uid === "number") {
      return this.sql.exec<{
        token_id: string;
        uid: number;
        kind: AuthTokenKind;
        label: string | null;
        token_prefix: string;
        allowed_role: AuthTokenRole | null;
        allowed_device_id: string | null;
        created_at: number;
        last_used_at: number | null;
        expires_at: number | null;
        revoked_at: number | null;
        revoked_reason: string | null;
      }>(
        `SELECT token_id, uid, kind, label, token_prefix, allowed_role, allowed_device_id,
                created_at, last_used_at, expires_at, revoked_at, revoked_reason
         FROM auth_tokens
         WHERE uid = ?
         ORDER BY created_at DESC`,
        uid,
      ).toArray().map(mapTokenRow);
    }

    return this.sql.exec<{
      token_id: string;
      uid: number;
      kind: AuthTokenKind;
      label: string | null;
      token_prefix: string;
      allowed_role: AuthTokenRole | null;
      allowed_device_id: string | null;
      created_at: number;
      last_used_at: number | null;
      expires_at: number | null;
      revoked_at: number | null;
      revoked_reason: string | null;
    }>(
      `SELECT token_id, uid, kind, label, token_prefix, allowed_role, allowed_device_id,
              created_at, last_used_at, expires_at, revoked_at, revoked_reason
       FROM auth_tokens
       ORDER BY created_at DESC`,
    ).toArray().map(mapTokenRow);
  }

  revokeToken(tokenId: string, reason?: string, uid?: number): boolean {
    const rows = typeof uid === "number"
      ? this.sql.exec<{ token_id: string }>(
          "SELECT token_id FROM auth_tokens WHERE token_id = ? AND uid = ? LIMIT 1",
          tokenId,
          uid,
        ).toArray()
      : this.sql.exec<{ token_id: string }>(
          "SELECT token_id FROM auth_tokens WHERE token_id = ? LIMIT 1",
          tokenId,
        ).toArray();

    if (rows.length === 0) return false;

    const now = Date.now();
    if (typeof uid === "number") {
      this.sql.exec(
        "UPDATE auth_tokens SET revoked_at = ?, revoked_reason = ? WHERE token_id = ? AND uid = ?",
        now,
        reason ?? null,
        tokenId,
        uid,
      );
    } else {
      this.sql.exec(
        "UPDATE auth_tokens SET revoked_at = ?, revoked_reason = ? WHERE token_id = ?",
        now,
        reason ?? null,
        tokenId,
      );
    }
    return true;
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

  private generateTokenValue(kind: AuthTokenKind): string {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const base64 = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    return `gsv_${kind}_${base64}`;
  }
}

function defaultRoleForKind(kind: AuthTokenKind): AuthTokenRole {
  switch (kind) {
    case "node":
      return "driver";
    case "service":
      return "service";
    case "user":
      return "user";
  }
}

function mapTokenRow(row: {
  token_id: string;
  uid: number;
  kind: AuthTokenKind;
  label: string | null;
  token_prefix: string;
  allowed_role: AuthTokenRole | null;
  allowed_device_id: string | null;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
  revoked_reason: string | null;
}): AuthTokenRecord {
  return {
    tokenId: row.token_id,
    uid: row.uid,
    kind: row.kind,
    label: row.label,
    tokenPrefix: row.token_prefix,
    allowedRole: row.allowed_role,
    allowedDeviceId: row.allowed_device_id,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
  };
}
