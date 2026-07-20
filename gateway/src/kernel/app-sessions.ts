import {
  buildAppClientRpcBase,
  isLegacyAppSessionId,
  parseRoutedAppSessionId,
  type AppClientSessionContext,
  type AppSessionClientContext,
  type AppSessionContext,
  type AppSessionState,
  type IssuedAppClientSession,
} from "../protocol/app-session";
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
  created_at: number;
  last_used_at: number | null;
  expires_at: number;
  closed_at: number | null;
};

type AppSessionClientRow = {
  session_id: string;
  client_id: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number;
  closed_at: number | null;
};

type AppSessionClientKeyRow = {
  key_id: string;
  session_id: string;
  client_id: string;
  secret_hash: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
};

type VerifiedSecret =
  | {
      ok: true;
      session: AppSessionRow;
      client: AppSessionClientRow;
      key: AppSessionClientKeyRow;
    }
  | { ok: false };

export type AppSessionIdFactory = (input: {
  uid: number;
  username: string;
}) => Promise<string>;

export class AppSessionStore {
  constructor(
    private readonly sql: SqlStorage,
    private readonly createSessionId: AppSessionIdFactory = async () => crypto.randomUUID(),
  ) {}

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
    const sessionId = await this.createSessionId({
      uid: input.uid,
      username: input.username,
    });
    if (!isLegacyAppSessionId(sessionId) && !parseRoutedAppSessionId(sessionId)) {
      throw new Error("Invalid app session id");
    }
    const expiresAt = Math.min(
      now + input.ttlMs,
      routeExpiryLimit(sessionId) ?? Number.MAX_SAFE_INTEGER,
    );
    if (expiresAt <= now) {
      throw new Error("App session route expired before issuance");
    }

    this.sql.exec(
      `INSERT INTO app_sessions (
        session_id, uid, username, package_id, package_name, entrypoint_name,
        route_base, created_at, last_used_at, expires_at, closed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      sessionId,
      input.uid,
      input.username,
      input.packageId,
      input.packageName,
      input.entrypointName,
      input.routeBase,
      now,
      null,
      expiresAt,
      null,
    );

    this.insertClient(sessionId, input.clientId, now, expiresAt);
    const secret = await this.insertClientKey(sessionId, input.clientId, now, expiresAt);

    return {
      ...toClientContext({
        session: {
          session_id: sessionId,
          uid: input.uid,
          username: input.username,
          package_id: input.packageId,
          package_name: input.packageName,
          entrypoint_name: input.entrypointName,
          route_base: input.routeBase,
          created_at: now,
          last_used_at: null,
          expires_at: expiresAt,
          closed_at: null,
        },
        client: {
          session_id: sessionId,
          client_id: input.clientId,
          created_at: now,
          last_used_at: null,
          expires_at: expiresAt,
          closed_at: null,
        },
      }),
      secret,
    };
  }

  async attach(input: {
    uid: number;
    sessionId: string;
    clientId: string;
    ttlMs: number;
  }): Promise<IssuedAppClientSession | null> {
    this.pruneExpired();
    const session = this.getSessionRow(input.sessionId);
    if (!this.isActiveSessionForUid(session, input.uid)) {
      return null;
    }

    const now = Date.now();
    const expiresAt = Math.min(
      now + input.ttlMs,
      routeExpiryLimit(input.sessionId) ?? Number.MAX_SAFE_INTEGER,
    );
    if (expiresAt <= now) {
      return null;
    }
    this.insertClient(input.sessionId, input.clientId, now, expiresAt);
    const secret = await this.insertClientKey(input.sessionId, input.clientId, now, expiresAt);
    this.touchSession(input.sessionId, now, expiresAt);

    return {
      ...toClientContext({
        session: {
          ...session,
          last_used_at: now,
          expires_at: Math.max(session.expires_at, expiresAt),
        },
        client: {
          session_id: input.sessionId,
          client_id: input.clientId,
          created_at: now,
          last_used_at: null,
          expires_at: expiresAt,
          closed_at: null,
        },
      }),
      secret,
    };
  }

  async resolve(
    sessionId: string,
    secret: string,
    assertCurrent?: () => void,
  ): Promise<AppClientSessionContext | null> {
    this.pruneExpired();
    const verified = await this.verifySecret(sessionId, secret);
    if (!verified.ok) {
      return null;
    }
    assertCurrent?.();

    const lastUsedAt = Date.now();
    this.sql.exec(
      "UPDATE app_sessions SET last_used_at = ? WHERE session_id = ?",
      lastUsedAt,
      sessionId,
    );
    this.sql.exec(
      "UPDATE app_session_clients SET last_used_at = ? WHERE session_id = ? AND client_id = ?",
      lastUsedAt,
      sessionId,
      verified.client.client_id,
    );

    return toClientContext({
      session: {
        ...verified.session,
        last_used_at: lastUsedAt,
      },
      client: {
        ...verified.client,
        last_used_at: lastUsedAt,
      },
    });
  }

  async refresh(
    sessionId: string,
    secret: string,
    ttlMs: number,
    assertCurrent?: () => void,
  ): Promise<AppClientSessionContext | null> {
    this.pruneExpired();
    const verified = await this.verifySecret(sessionId, secret);
    if (!verified.ok) {
      return null;
    }
    assertCurrent?.();

    const now = Date.now();
    const expiresAt = Math.min(
      now + ttlMs,
      routeExpiryLimit(sessionId) ?? Number.MAX_SAFE_INTEGER,
    );
    if (expiresAt <= now) {
      return null;
    }
    this.sql.exec(
      "UPDATE app_sessions SET last_used_at = ?, expires_at = MAX(expires_at, ?) WHERE session_id = ?",
      now,
      expiresAt,
      sessionId,
    );
    this.sql.exec(
      "UPDATE app_session_clients SET last_used_at = ?, expires_at = ? WHERE session_id = ? AND client_id = ?",
      now,
      expiresAt,
      sessionId,
      verified.client.client_id,
    );
    this.sql.exec(
      "UPDATE app_session_client_keys SET expires_at = ? WHERE key_id = ?",
      expiresAt,
      verified.key.key_id,
    );

    return toClientContext({
      session: {
        ...verified.session,
        last_used_at: now,
        expires_at: Math.max(verified.session.expires_at, expiresAt),
      },
      client: {
        ...verified.client,
        last_used_at: now,
        expires_at: expiresAt,
      },
    });
  }

  list(uid: number): AppSessionContext[] {
    this.pruneExpired();
    return this.sql.exec<AppSessionRow>(
      `SELECT * FROM app_sessions
       WHERE uid = ? AND closed_at IS NULL AND expires_at > ?
       ORDER BY last_used_at DESC, created_at DESC`,
      uid,
      Date.now(),
    ).toArray().map((row) => this.toSessionContext(row));
  }

  getActiveForUid(uid: number, sessionId: string): AppSessionContext | null {
    this.pruneExpired();
    const row = this.getSessionRow(sessionId);
    if (!this.isActiveSessionForUid(row, uid)) {
      return null;
    }
    return this.toSessionContext(row);
  }

  getActiveRoute(sessionId: string): {
    uid: number;
    username: string;
    expiresAt: number;
  } | null {
    this.pruneExpired();
    const row = this.getSessionRow(sessionId);
    if (!row || row.closed_at != null || row.expires_at <= Date.now()) {
      return null;
    }
    return {
      uid: row.uid,
      username: row.username,
      expiresAt: row.expires_at,
    };
  }

  detach(uid: number, sessionId: string, clientId: string): AppClientSessionContext | null {
    this.pruneExpired();
    const session = this.getSessionRow(sessionId);
    if (!this.isActiveSessionForUid(session, uid)) {
      return null;
    }

    const client = this.getClientRow(sessionId, clientId);
    if (!client || client.closed_at != null || client.expires_at <= Date.now()) {
      return null;
    }

    const now = Date.now();
    this.sql.exec(
      "UPDATE app_sessions SET last_used_at = ? WHERE session_id = ?",
      now,
      sessionId,
    );
    this.sql.exec(
      "UPDATE app_session_clients SET closed_at = ? WHERE session_id = ? AND client_id = ? AND closed_at IS NULL",
      now,
      sessionId,
      clientId,
    );
    this.sql.exec(
      "UPDATE app_session_client_keys SET revoked_at = ? WHERE session_id = ? AND client_id = ? AND revoked_at IS NULL",
      now,
      sessionId,
      clientId,
    );

    return toClientContext({
      session: {
        ...session,
        last_used_at: now,
      },
      client,
    });
  }

  close(uid: number, sessionId: string): AppSessionContext | null {
    this.pruneExpired();
    const session = this.getActiveForUid(uid, sessionId);
    if (!session) {
      return null;
    }

    const now = Date.now();
    this.sql.exec(
      "UPDATE app_sessions SET closed_at = ? WHERE session_id = ?",
      now,
      sessionId,
    );
    this.sql.exec(
      "UPDATE app_session_clients SET closed_at = ? WHERE session_id = ? AND closed_at IS NULL",
      now,
      sessionId,
    );
    this.sql.exec(
      "UPDATE app_session_client_keys SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL",
      now,
      sessionId,
    );
    return {
      ...session,
      state: "closed",
    };
  }

  private getSessionRow(sessionId: string): AppSessionRow | null {
    const rows = [...this.sql.exec<AppSessionRow>(
      "SELECT * FROM app_sessions WHERE session_id = ? LIMIT 1",
      sessionId,
    )];
    return rows[0] ?? null;
  }

  private getActiveClientRows(sessionId: string): AppSessionClientRow[] {
    return this.sql.exec<AppSessionClientRow>(
      `SELECT * FROM app_session_clients
       WHERE session_id = ? AND closed_at IS NULL AND expires_at > ?
       ORDER BY last_used_at DESC, created_at DESC`,
      sessionId,
      Date.now(),
    ).toArray();
  }

  private getClientRow(sessionId: string, clientId: string): AppSessionClientRow | null {
    const rows = [...this.sql.exec<AppSessionClientRow>(
      `SELECT * FROM app_session_clients
       WHERE session_id = ? AND client_id = ? LIMIT 1`,
      sessionId,
      clientId,
    )];
    return rows[0] ?? null;
  }

  private getKeyRows(sessionId: string): AppSessionClientKeyRow[] {
    return this.sql.exec<AppSessionClientKeyRow>(
      `SELECT * FROM app_session_client_keys
       WHERE session_id = ? AND revoked_at IS NULL AND expires_at > ?`,
      sessionId,
      Date.now(),
    ).toArray();
  }

  private insertClient(sessionId: string, clientId: string, now: number, expiresAt: number): void {
    this.sql.exec(
      `INSERT INTO app_session_clients (
        session_id, client_id, created_at, last_used_at, expires_at, closed_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, client_id) DO UPDATE SET
        last_used_at = excluded.last_used_at,
        expires_at = excluded.expires_at,
        closed_at = NULL`,
      sessionId,
      clientId,
      now,
      null,
      expiresAt,
      null,
    );
  }

  private async insertClientKey(
    sessionId: string,
    clientId: string,
    now: number,
    expiresAt: number,
  ): Promise<string> {
    const keyId = crypto.randomUUID();
    const secret = crypto.randomUUID();
    const secretHash = await hashToken(secret);
    this.sql.exec(
      `INSERT INTO app_session_client_keys (
        key_id, session_id, client_id, secret_hash, created_at, expires_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      keyId,
      sessionId,
      clientId,
      secretHash,
      now,
      expiresAt,
      null,
    );
    return secret;
  }

  private touchSession(sessionId: string, lastUsedAt: number, expiresAt: number): void {
    this.sql.exec(
      "UPDATE app_sessions SET last_used_at = ?, expires_at = MAX(expires_at, ?) WHERE session_id = ?",
      lastUsedAt,
      expiresAt,
      sessionId,
    );
  }

  private async verifySecret(sessionId: string, secret: string): Promise<VerifiedSecret> {
    const session = this.getSessionRow(sessionId);
    if (!session || session.closed_at != null || session.expires_at <= Date.now()) {
      return { ok: false };
    }

    for (const key of this.getKeyRows(sessionId)) {
      if (!(await verify(secret, key.secret_hash))) {
        continue;
      }
      const client = this.getClientRow(sessionId, key.client_id);
      if (!client || client.closed_at != null || client.expires_at <= Date.now()) {
        return { ok: false };
      }
      return {
        ok: true,
        session,
        client,
        key,
      };
    }

    return { ok: false };
  }

  private isActiveSessionForUid(row: AppSessionRow | null, uid: number): row is AppSessionRow {
    return Boolean(
      row &&
      row.uid === uid &&
      row.closed_at == null &&
      row.expires_at > Date.now(),
    );
  }

  private toSessionContext(row: AppSessionRow): AppSessionContext {
    const clients = this.getActiveClientRows(row.session_id)
      .map((client) => toClientContext({ session: row, client }));
    return {
      sessionId: row.session_id,
      uid: row.uid,
      username: row.username,
      packageId: row.package_id,
      packageName: row.package_name,
      entrypointName: row.entrypoint_name,
      routeBase: row.route_base,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastUsedAt: row.last_used_at,
      state: sessionState(row, clients),
      clients,
    };
  }

  private pruneExpired(): void {
    const now = Date.now();
    this.sql.exec(
      "DELETE FROM app_session_client_keys WHERE expires_at <= ? OR revoked_at IS NOT NULL",
      now,
    );
    this.sql.exec(
      "DELETE FROM app_session_clients WHERE expires_at <= ? OR closed_at IS NOT NULL",
      now,
    );
    this.sql.exec(
      "DELETE FROM app_sessions WHERE expires_at <= ? OR closed_at IS NOT NULL",
      now,
    );
    this.sql.exec(
      "DELETE FROM app_session_client_keys WHERE session_id NOT IN (SELECT session_id FROM app_sessions)",
    );
    this.sql.exec(
      "DELETE FROM app_session_clients WHERE session_id NOT IN (SELECT session_id FROM app_sessions)",
    );
  }
}

function toClientContext(input: {
  session: AppSessionRow;
  client: AppSessionClientRow;
}): AppSessionClientContext {
  return {
    sessionId: input.session.session_id,
    clientId: input.client.client_id,
    uid: input.session.uid,
    username: input.session.username,
    packageId: input.session.package_id,
    packageName: input.session.package_name,
    entrypointName: input.session.entrypoint_name,
    routeBase: input.session.route_base,
    rpcBase: buildAppClientRpcBase(input.session.session_id, input.client.client_id),
    createdAt: input.client.created_at,
    expiresAt: input.client.expires_at,
    lastUsedAt: input.client.last_used_at,
  };
}

function sessionState(row: AppSessionRow, clients: AppClientSessionContext[]): AppSessionState {
  if (row.closed_at != null) {
    return "closed";
  }
  if (row.expires_at <= Date.now()) {
    return "expired";
  }
  return clients.length > 0 ? "active" : "detached";
}

function routeExpiryLimit(sessionId: string): number | null {
  return parseRoutedAppSessionId(sessionId)?.expiresAt ?? null;
}
