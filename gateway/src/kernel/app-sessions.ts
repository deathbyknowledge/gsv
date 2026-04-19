import type { IssuedAppClientSession, AppClientSessionContext } from "../protocol/app-session";
import { hashToken, verify } from "../auth/shadow";

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
      rpcBase: buildAppRpcBase(input.packageName, sessionId),
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
    const ok = await verify(secret, row.secret_hash);
    if (!ok) {
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

  private getRow(sessionId: string): AppSessionRow | null {
    const rows = [...this.sql.exec<AppSessionRow>(
      "SELECT * FROM app_client_sessions WHERE session_id = ? LIMIT 1",
      sessionId,
    )];
    return rows[0] ?? null;
  }

  private pruneExpired(): void {
    this.sql.exec(
      "DELETE FROM app_client_sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL",
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
    rpcBase: buildAppRpcBase(row.package_name, row.session_id),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
  };
}

export function buildAppRpcBase(packageName: string, sessionId: string): string {
  return `/app-rpc/${packageName}/sessions/${sessionId}`;
}
