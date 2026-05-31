import type { IssuedAppClientSession, AppClientSessionContext } from "../protocol/app-session";
import { hashToken, verify } from "../auth/shadow";

export const APP_CLIENT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

type AppSessionRow = {
  session_id: string;
  uid: number;
  username: string;
  package_id: string;
  package_name: string;
  entrypoint_name: string;
  route_base: string;
  client_id: string;
  secret_hash: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number;
  revoked_at: number | null;
};

type AppSessionKeyRow = {
  key_id: string;
  session_id: string;
  secret_hash: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
};

type VerifiedSecret =
  | { ok: true; keyId: string | null }
  | { ok: false };

export class AppSessionStore {
  constructor(private readonly sql: SqlStorage) {}

  init(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS app_client_sessions (
        session_id TEXT PRIMARY KEY,
        uid INTEGER NOT NULL,
        username TEXT NOT NULL,
        package_id TEXT NOT NULL,
        package_name TEXT NOT NULL,
        entrypoint_name TEXT NOT NULL,
        route_base TEXT NOT NULL,
        client_id TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      )
    `);
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_app_client_sessions_uid_pkg ON app_client_sessions (uid, package_id, created_at DESC)",
    );
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_app_client_sessions_expires ON app_client_sessions (expires_at)",
    );
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS app_client_session_keys (
        key_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      )
    `);
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_app_client_session_keys_session ON app_client_session_keys (session_id, expires_at)",
    );
  }

  async issue(input: {
    uid: number;
    username: string;
    packageId: string;
    packageName: string;
    entrypointName: string;
    routeBase: string;
    clientId: string;
    ttlMs: number;
  }): Promise<IssuedAppClientSession> {
    this.pruneExpired();
    const now = Date.now();
    const sessionId = crypto.randomUUID();
    const secret = crypto.randomUUID();
    const expiresAt = now + input.ttlMs;
    const secretHash = await hashToken(secret);

    this.sql.exec(
      `INSERT INTO app_client_sessions (
        session_id, uid, username, package_id, package_name, entrypoint_name,
        route_base, client_id, secret_hash, created_at, last_used_at,
        expires_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      sessionId,
      input.uid,
      input.username,
      input.packageId,
      input.packageName,
      input.entrypointName,
      input.routeBase,
      input.clientId,
      secretHash,
      now,
      null,
      expiresAt,
      null,
    );

    return {
      sessionId,
      secret,
      clientId: input.clientId,
      uid: input.uid,
      username: input.username,
      packageId: input.packageId,
      packageName: input.packageName,
      entrypointName: input.entrypointName,
      routeBase: input.routeBase,
      rpcBase: buildAppRpcBase(sessionId),
      createdAt: now,
      expiresAt,
      lastUsedAt: null,
    };
  }

  async resolve(
    sessionId: string,
    secret: string,
  ): Promise<AppClientSessionContext | null> {
    this.pruneExpired();
    const row = this.getRow(sessionId);
    if (!row) {
      return null;
    }
    if (row.revoked_at != null || row.expires_at <= Date.now()) {
      return null;
    }
    const verified = await this.verifySecret(row, secret);
    if (!verified.ok) {
      return null;
    }
    const lastUsedAt = Date.now();
    this.sql.exec(
      "UPDATE app_client_sessions SET last_used_at = ? WHERE session_id = ?",
      lastUsedAt,
      sessionId,
    );
    return toContext({
      ...row,
      last_used_at: lastUsedAt,
    });
  }

  async refresh(
    sessionId: string,
    secret: string,
    ttlMs: number,
  ): Promise<AppClientSessionContext | null> {
    this.pruneExpired();
    const row = this.getRow(sessionId);
    if (!row) {
      return null;
    }
    if (row.revoked_at != null || row.expires_at <= Date.now()) {
      return null;
    }
    const verified = await this.verifySecret(row, secret);
    if (!verified.ok) {
      return null;
    }
    const now = Date.now();
    const expiresAt = now + ttlMs;
    this.sql.exec(
      "UPDATE app_client_sessions SET last_used_at = ?, expires_at = ? WHERE session_id = ?",
      now,
      expiresAt,
      sessionId,
    );
    if (verified.keyId) {
      this.sql.exec(
        "UPDATE app_client_session_keys SET expires_at = ? WHERE key_id = ?",
        expiresAt,
        verified.keyId,
      );
    }
    return toContext({
      ...row,
      last_used_at: now,
      expires_at: expiresAt,
    });
  }

  list(uid: number): AppClientSessionContext[] {
    this.pruneExpired();
    return this.sql.exec<AppSessionRow>(
      `SELECT * FROM app_client_sessions
       WHERE uid = ? AND revoked_at IS NULL AND expires_at > ?
       ORDER BY last_used_at DESC, created_at DESC`,
      uid,
      Date.now(),
    ).toArray().map(toContext);
  }

  getActiveForUid(uid: number, sessionId: string): AppClientSessionContext | null {
    this.pruneExpired();
    const row = this.getRow(sessionId);
    if (!row || row.uid !== uid || row.revoked_at != null || row.expires_at <= Date.now()) {
      return null;
    }
    return toContext(row);
  }

  async mintSecret(uid: number, sessionId: string, ttlMs: number): Promise<IssuedAppClientSession | null> {
    this.pruneExpired();
    const row = this.getRow(sessionId);
    if (!row || row.uid !== uid || row.revoked_at != null || row.expires_at <= Date.now()) {
      return null;
    }

    const now = Date.now();
    const keyId = crypto.randomUUID();
    const secret = crypto.randomUUID();
    const expiresAt = now + ttlMs;
    const secretHash = await hashToken(secret);

    this.sql.exec(
      `INSERT INTO app_client_session_keys (
        key_id, session_id, secret_hash, created_at, expires_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      keyId,
      sessionId,
      secretHash,
      now,
      expiresAt,
      null,
    );
    this.sql.exec(
      "UPDATE app_client_sessions SET last_used_at = ?, expires_at = ? WHERE session_id = ?",
      now,
      expiresAt,
      sessionId,
    );

    return {
      ...toContext({
        ...row,
        last_used_at: now,
        expires_at: expiresAt,
      }),
      secret,
    };
  }

  close(uid: number, sessionId: string): boolean {
    this.pruneExpired();
    const row = this.getRow(sessionId);
    if (!row || row.uid !== uid || row.revoked_at != null || row.expires_at <= Date.now()) {
      return false;
    }

    const now = Date.now();
    this.sql.exec(
      "UPDATE app_client_sessions SET revoked_at = ? WHERE session_id = ?",
      now,
      sessionId,
    );
    this.sql.exec(
      "UPDATE app_client_session_keys SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL",
      now,
      sessionId,
    );
    return true;
  }

  private getRow(sessionId: string): AppSessionRow | null {
    const rows = [...this.sql.exec<AppSessionRow>(
      "SELECT * FROM app_client_sessions WHERE session_id = ? LIMIT 1",
      sessionId,
    )];
    return rows[0] ?? null;
  }

  private getKeyRows(sessionId: string): AppSessionKeyRow[] {
    return this.sql.exec<AppSessionKeyRow>(
      `SELECT * FROM app_client_session_keys
       WHERE session_id = ? AND revoked_at IS NULL AND expires_at > ?`,
      sessionId,
      Date.now(),
    ).toArray();
  }

  private async verifySecret(row: AppSessionRow, secret: string): Promise<VerifiedSecret> {
    if (await verify(secret, row.secret_hash)) {
      return { ok: true, keyId: null };
    }

    for (const key of this.getKeyRows(row.session_id)) {
      if (await verify(secret, key.secret_hash)) {
        return { ok: true, keyId: key.key_id };
      }
    }

    return { ok: false };
  }

  private pruneExpired(): void {
    this.sql.exec(
      "DELETE FROM app_client_sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL",
      Date.now(),
    );
    this.sql.exec(
      "DELETE FROM app_client_session_keys WHERE expires_at <= ? OR revoked_at IS NOT NULL",
      Date.now(),
    );
  }
}

function toContext(row: AppSessionRow): AppClientSessionContext {
  return {
    sessionId: row.session_id,
    clientId: row.client_id,
    uid: row.uid,
    username: row.username,
    packageId: row.package_id,
    packageName: row.package_name,
    entrypointName: row.entrypoint_name,
    routeBase: row.route_base,
    rpcBase: buildAppRpcBase(row.session_id),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
  };
}

function buildAppRpcBase(sessionId: string): string {
  return `/apps/sessions/${encodeURIComponent(sessionId)}/socket`;
}
