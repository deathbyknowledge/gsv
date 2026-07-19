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
import {
  parseShadow,
  serializeShadow,
  isLocked,
  makeShadowEntry,
  hashToken,
  isValidPasswordHash,
  verify,
} from "../auth/shadow";
import type { GroupEntry } from "../auth/group";
import { parseGroup, serializeGroup, resolveGids } from "../auth/group";
import {
  LoginAttemptStore,
  type LoginCredentialKind,
} from "./login-attempts";
import { loginCredentialWork } from "../auth/login";
import type { LoginSourceScope } from "./login-source";

export const AUTHENTICATION_FAILED_MESSAGE = "Authentication failed";

// A real PBKDF2-SHA-512 record used only to equalize password-verification
// work for missing, locked, and non-password accounts. Its plaintext is not a
// credential and a successful comparison never authenticates an absent user.
export const AUTH_DUMMY_PASSWORD_HASH =
  "$pbkdf2-sha512$100000$1S8PKrGDbhC/gvi5AK3lqg==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

export type AuthIdentity = {
  uid: number;
  gid: number;
  gids: number[];
  username: string;
  home: string;
};

export type AuthResult =
  | { ok: true; identity: AuthIdentity }
  | { ok: false; error: string; retryAfterMs?: number };

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
  private readonly loginAttempts: LoginAttemptStore;

  constructor(private readonly sql: SqlStorage) {
    this.loginAttempts = new LoginAttemptStore(sql);
  }

  getPersonalAgentUid(ownerUid: number): number | null {
    const rows = this.sql.exec<{ agent_uid: number }>(
      "SELECT agent_uid FROM personal_agents WHERE owner_uid = ?",
      ownerUid,
    ).toArray();
    return rows[0]?.agent_uid ?? null;
  }

  setPersonalAgent(ownerUid: number, agentUid: number): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO personal_agents (owner_uid, agent_uid) VALUES (?, ?)",
      ownerUid,
      agentUid,
    );
  }

  /** Whether the given uid is itself a personal agent account (not a human owner). */
  isPersonalAgentUid(uid: number): boolean {
    const rows = this.sql.exec<{ c: number }>(
      "SELECT COUNT(*) as c FROM personal_agents WHERE agent_uid = ?",
      uid,
    ).toArray();
    return (rows[0]?.c ?? 0) > 0;
  }

  // ---------------------------------------------------------------------------
  // Bootstrap — seed default entries if tables are empty
  // ---------------------------------------------------------------------------

  isBootstrapped(): boolean {
    const rows = this.sql.exec<{ c: number }>("SELECT COUNT(*) as c FROM passwd").toArray();
    return rows[0].c > 0;
  }

  async bootstrap(): Promise<boolean> {
    if (this.isBootstrapped()) return false;

    this.addUser({
      username: "root", uid: 0, gid: 0,
      gecos: "root", home: "/root", shell: "/bin/init",
    });

    this.setShadow(makeShadowEntry("root", "!"));

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
    this.observeUnixId(Math.max(entry.uid, entry.gid));
    this.sql.exec(
      "INSERT INTO passwd (username, uid, gid, gecos, home, shell) VALUES (?, ?, ?, ?, ?, ?)",
      entry.username, entry.uid, entry.gid, entry.gecos, entry.home, entry.shell,
    );
  }

  updateUser(username: string, fields: Partial<Omit<PasswdEntry, "username">>): boolean {
    const existing = this.getPasswdByUsername(username);
    if (!existing) return false;

    this.observeUnixId(Math.max(fields.uid ?? existing.uid, fields.gid ?? existing.gid));

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

  /** Reserve a never-reused id for a user and its User Private Group. */
  allocateUid(): number {
    return this.reserveUnixId(1000);
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
    if (!isLocked(root)) return false;

    // Setup mode ends once at least one non-root user exists.
    const passwd = this.getPasswdEntries();
    return !passwd.some((entry) => entry.uid >= 1000);
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
    this.observeUnixId(entry.gid);
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

  /** Reserve a never-reused id for a standalone group. */
  allocateGid(): number {
    return this.reserveUnixId(100);
  }

  /**
   * Atomically reserve from the shared UID/GID number space. Reservations are
   * intentionally permanent: R2 file metadata can outlive passwd/group rows,
   * so reusing an id could transfer ownership of orphaned files.
   */
  private reserveUnixId(minimum: number): number {
    const rows = this.sql.exec<{ high_water: number }>(
      `UPDATE unix_id_allocator
       SET high_water = MAX(high_water + 1, ?)
       WHERE singleton = 1
       RETURNING high_water`,
      minimum,
    ).toArray();
    const allocated = rows[0]?.high_water;
    if (!Number.isSafeInteger(allocated) || allocated < minimum) {
      throw new Error("Unix id allocator is unavailable");
    }
    return allocated;
  }

  /** Keep root-authored passwd/group imports from moving past the allocator. */
  private observeUnixId(id: number): void {
    if (!Number.isSafeInteger(id) || id < 0) {
      throw new Error(`Invalid Unix id: ${id}`);
    }
    this.sql.exec(
      `UPDATE unix_id_allocator
       SET high_water = MAX(high_water, ?)
       WHERE singleton = 1`,
      id,
    );
  }

  // ---------------------------------------------------------------------------
  // Resolve all gids for a user (primary + supplementary from group membership)
  // ---------------------------------------------------------------------------

  resolveGids(username: string, primaryGid: number): number[] {
    const groups = this.getGroupEntries();
    return resolveGids(groups, username, primaryGid);
  }

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  async authenticate(
    username: string,
    credential: string,
    sourceScope: LoginSourceScope,
  ): Promise<AuthResult> {
    return this.authenticateWithLoginLimit(
      username,
      credential,
      "password",
      sourceScope,
      (canonicalUsername, boundedCredential) => (
        this.verifyPasswordIdentity(canonicalUsername, boundedCredential)
      ),
    );
  }

  /**
   * Verify an opaque machine/user token issued by this kernel.
   * Optional role/device constraints are enforced against token bindings.
   */
  async authenticateToken(
    username: string,
    token: string,
    sourceScope: LoginSourceScope,
    options: TokenAuthOptions = {},
  ): Promise<AuthResult> {
    return this.authenticateWithLoginLimit(
      username,
      token,
      "token",
      sourceScope,
      (canonicalUsername, boundedToken) => (
        this.verifyTokenIdentity(canonicalUsername, boundedToken, options)
      ),
    );
  }

  /**
   * Authenticate Git Basic auth, whose single credential may be a password or
   * a user token, under one limiter reservation. Password verification runs
   * first so missing and locked accounts receive the same PBKDF2 work.
   */
  async authenticatePasswordOrToken(
    username: string,
    credential: string,
    sourceScope: LoginSourceScope,
    options: TokenAuthOptions = { role: "user" },
  ): Promise<AuthResult> {
    return this.authenticateWithLoginLimit(username, credential, "password", sourceScope, async (
      canonicalUsername,
      boundedCredential,
    ) => {
      const passwordIdentity = await this.verifyPasswordIdentity(
        canonicalUsername,
        boundedCredential,
      );
      return passwordIdentity
        ?? this.verifyTokenIdentity(canonicalUsername, boundedCredential, options);
    });
  }

  private async authenticateWithLoginLimit(
    username: string,
    credential: string,
    credentialKind: LoginCredentialKind,
    sourceScope: LoginSourceScope,
    verifier: (
      canonicalUsername: string,
      boundedCredential: string,
    ) => Promise<AuthIdentity | null>,
  ): Promise<AuthResult> {
    const reservation = await this.loginAttempts.reserve(
      username,
      credentialKind,
      sourceScope,
    );
    if (!reservation.allowed) {
      return authenticationFailure(reservation.retryAfterMs);
    }
    const credentialWork = loginCredentialWork(credential);
    const canonicalUsername = reservation.canonicalUsername ?? "";

    let identity: AuthIdentity | null;
    try {
      identity = await verifier(canonicalUsername, credentialWork.value);
    } catch (error) {
      this.loginAttempts.complete(reservation, false);
      throw error;
    }

    const success = reservation.canonicalUsername !== null
      && credentialWork.valid
      && identity !== null;
    this.loginAttempts.complete(reservation, success);
    return success ? { ok: true, identity: identity! } : authenticationFailure();
  }

  private async verifyPasswordIdentity(
    username: string,
    credential: string,
  ): Promise<AuthIdentity | null> {
    const user = this.getPasswdByUsername(username);
    const shadow = this.getShadowByUsername(username);
    const hasPasswordHash = Boolean(
      user && shadow && isValidPasswordHash(shadow.hash),
    );
    const verificationHash = hasPasswordHash
      ? shadow!.hash
      : AUTH_DUMMY_PASSWORD_HASH;

    let valid = false;
    try {
      valid = await verify(credential, verificationHash);
    } catch {
      // Corrupt credential state fails closed with the same external result.
      valid = false;
    }

    if (!user || !hasPasswordHash || !valid) return null;
    return this.authIdentity(user);
  }

  private async verifyTokenIdentity(
    username: string,
    token: string,
    options: TokenAuthOptions,
  ): Promise<AuthIdentity | null> {
    const user = this.getPasswdByUsername(username);

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
      user?.uid ?? -1,
      tokenHash,
    ).toArray();

    if (!user || rows.length === 0) return null;

    const tokenRow = rows[0];
    const now = Date.now();
    if (tokenRow.revoked_at !== null) return null;
    if (tokenRow.expires_at !== null && tokenRow.expires_at <= now) return null;
    if (options.role && tokenRow.allowed_role && tokenRow.allowed_role !== options.role) return null;
    if (options.role === "driver") {
      if (!options.deviceId || !tokenRow.allowed_device_id) return null;
      if (tokenRow.allowed_device_id !== options.deviceId) return null;
    } else if (
      options.deviceId &&
      tokenRow.allowed_device_id &&
      tokenRow.allowed_device_id !== options.deviceId
    ) {
      return null;
    }

    this.sql.exec(
      "UPDATE auth_tokens SET last_used_at = ? WHERE token_id = ?",
      now,
      tokenRow.token_id,
    );

    return this.authIdentity(user);
  }

  private authIdentity(user: PasswdEntry): AuthIdentity {
    return {
      uid: user.uid,
      gid: user.gid,
      gids: this.resolveGids(user.username, user.gid),
      username: user.username,
      home: user.home,
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
    if (allowedRole === "driver" && !input.allowedDeviceId) {
      throw new Error("allowedDeviceId is required for driver-bound tokens");
    }

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

function authenticationFailure(retryAfterMs?: number): AuthResult {
  return {
    ok: false,
    error: AUTHENTICATION_FAILED_MESSAGE,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
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
