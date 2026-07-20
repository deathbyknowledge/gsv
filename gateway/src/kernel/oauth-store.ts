export type OAuthConnectionKind = "ai-provider" | "mcp-server" | "generic";

export type OAuthFlowRecord = {
  flowId: string;
  uid: number;
  /** Human Kernel owner that admitted the flow; null only for pre-v23 states. */
  kernelOwnerUid: number | null;
  kind: OAuthConnectionKind;
  provider: string;
  accountKey: string;
  label: string | null;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  redirectUri: string;
  scope: string | null;
  resource: string | null;
  extraAuthParams: Record<string, string>;
  codeVerifier: string;
  createdAt: number;
  expiresAt: number;
};

export type OAuthFlowCreateInput = Omit<OAuthFlowRecord, "flowId" | "kernelOwnerUid"> & {
  flowId?: string;
  stateHash: string;
  kernelOwnerUid: number;
};

export type OAuthAccountRecord = {
  accountId: string;
  uid: number;
  kind: OAuthConnectionKind;
  provider: string;
  accountKey: string;
  label: string | null;
  scope: string | null;
  resource: string | null;
  clientId: string;
  tokenType: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  metadata: Record<string, unknown>;
};

export type OAuthAccountUpsertInput = Omit<
  OAuthAccountRecord,
  "accountId" | "createdAt" | "updatedAt" | "lastUsedAt"
> & {
  accountId?: string;
  metadata?: Record<string, unknown>;
};

type OAuthFlowRow = {
  flow_id: string;
  uid: number;
  kernel_owner_uid: number | null;
  kind: string;
  provider: string;
  account_key: string;
  label: string | null;
  authorization_endpoint: string;
  token_endpoint: string;
  client_id: string;
  redirect_uri: string;
  scope: string | null;
  resource: string | null;
  extra_auth_params_json: string | null;
  code_verifier: string;
  created_at: number;
  expires_at: number;
};

type OAuthAccountRow = {
  account_id: string;
  uid: number;
  kind: string;
  provider: string;
  account_key: string;
  label: string | null;
  scope: string | null;
  resource: string | null;
  client_id: string;
  token_type: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
  metadata_json: string | null;
};

export class OAuthStore {
  constructor(private readonly sql: SqlStorage) {}

  createFlow(input: OAuthFlowCreateInput): OAuthFlowRecord {
    if (!Number.isSafeInteger(input.kernelOwnerUid) || input.kernelOwnerUid < 0) {
      throw new Error("OAuth flow Kernel owner uid is invalid");
    }
    const flowId = input.flowId ?? crypto.randomUUID();
    this.sql.exec(
      `INSERT INTO oauth_flows (
        flow_id, state_hash, uid, kernel_owner_uid, kind, provider, account_key, label,
        authorization_endpoint, token_endpoint, client_id, redirect_uri,
        scope, resource, extra_auth_params_json, code_verifier,
        created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      flowId,
      input.stateHash,
      input.uid,
      input.kernelOwnerUid,
      input.kind,
      input.provider,
      input.accountKey,
      input.label,
      input.authorizationEndpoint,
      input.tokenEndpoint,
      input.clientId,
      input.redirectUri,
      input.scope,
      input.resource,
      JSON.stringify(input.extraAuthParams),
      input.codeVerifier,
      input.createdAt,
      input.expiresAt,
    );
    return {
      flowId,
      uid: input.uid,
      kernelOwnerUid: input.kernelOwnerUid,
      kind: input.kind,
      provider: input.provider,
      accountKey: input.accountKey,
      label: input.label,
      authorizationEndpoint: input.authorizationEndpoint,
      tokenEndpoint: input.tokenEndpoint,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      scope: input.scope,
      resource: input.resource,
      extraAuthParams: input.extraAuthParams,
      codeVerifier: input.codeVerifier,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
    };
  }

  getFlowByStateHash(stateHash: string, now = Date.now()): OAuthFlowRecord | null {
    const rows = this.sql.exec<OAuthFlowRow>(
      "SELECT * FROM oauth_flows WHERE state_hash = ?",
      stateHash,
    ).toArray();
    const row = rows[0];
    if (!row) return null;
    if (row.expires_at <= now) {
      this.deleteFlow(row.flow_id);
      return null;
    }
    return flowFromRow(row);
  }

  /** Atomically claim a callback flow before any external token exchange. */
  consumeFlowByStateHash(stateHash: string, now = Date.now()): OAuthFlowRecord | null {
    const row = this.sql.exec<OAuthFlowRow>(
      "DELETE FROM oauth_flows WHERE state_hash = ? RETURNING *",
      stateHash,
    ).toArray()[0];
    if (!row || row.expires_at <= now) {
      return null;
    }
    return flowFromRow(row);
  }

  getFlow(flowId: string, uid?: number, now = Date.now()): OAuthFlowRecord | null {
    const rows = uid === undefined
      ? this.sql.exec<OAuthFlowRow>(
        "SELECT * FROM oauth_flows WHERE flow_id = ?",
        flowId,
      ).toArray()
      : this.sql.exec<OAuthFlowRow>(
        "SELECT * FROM oauth_flows WHERE flow_id = ? AND uid = ?",
        flowId,
        uid,
      ).toArray();
    const row = rows[0];
    if (!row) return null;
    if (row.expires_at <= now) {
      this.deleteFlow(row.flow_id);
      return null;
    }
    return flowFromRow(row);
  }

  listFlows(uid?: number, now = Date.now()): OAuthFlowRecord[] {
    this.cleanupExpiredFlows(now);
    const rows = uid === undefined
      ? this.sql.exec<OAuthFlowRow>(
        "SELECT * FROM oauth_flows ORDER BY created_at DESC",
      ).toArray()
      : this.sql.exec<OAuthFlowRow>(
        "SELECT * FROM oauth_flows WHERE uid = ? ORDER BY created_at DESC",
        uid,
      ).toArray();
    return rows.map(flowFromRow);
  }

  deleteFlow(flowId: string): boolean {
    const existing = this.sql.exec<{ flow_id: string }>(
      "SELECT flow_id FROM oauth_flows WHERE flow_id = ?",
      flowId,
    ).toArray()[0];
    if (!existing) return false;
    this.sql.exec("DELETE FROM oauth_flows WHERE flow_id = ?", flowId);
    return true;
  }

  cleanupExpiredFlows(now = Date.now()): void {
    this.sql.exec("DELETE FROM oauth_flows WHERE expires_at <= ?", now);
  }

  upsertAccount(input: OAuthAccountUpsertInput): OAuthAccountRecord {
    const now = Date.now();
    const existing = this.findAccountByIdentity(
      input.uid,
      input.kind,
      input.provider,
      input.accountKey,
    );
    const accountId = existing?.accountId ?? input.accountId ?? crypto.randomUUID();
    const createdAt = existing?.createdAt ?? now;
    const metadata = input.metadata ?? {};

    this.sql.exec(
      `INSERT OR REPLACE INTO oauth_accounts (
        account_id, uid, kind, provider, account_key, label, scope, resource,
        client_id, token_type, access_token, refresh_token, expires_at,
        created_at, updated_at, last_used_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      accountId,
      input.uid,
      input.kind,
      input.provider,
      input.accountKey,
      input.label,
      input.scope,
      input.resource,
      input.clientId,
      input.tokenType,
      input.accessToken,
      input.refreshToken,
      input.expiresAt,
      createdAt,
      now,
      existing?.lastUsedAt ?? null,
      JSON.stringify(metadata),
    );

    return {
      accountId,
      uid: input.uid,
      kind: input.kind,
      provider: input.provider,
      accountKey: input.accountKey,
      label: input.label,
      scope: input.scope,
      resource: input.resource,
      clientId: input.clientId,
      tokenType: input.tokenType,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      expiresAt: input.expiresAt,
      createdAt,
      updatedAt: now,
      lastUsedAt: existing?.lastUsedAt ?? null,
      metadata,
    };
  }

  getAccount(accountId: string, uid?: number): OAuthAccountRecord | null {
    const rows = uid === undefined
      ? this.sql.exec<OAuthAccountRow>(
        "SELECT * FROM oauth_accounts WHERE account_id = ?",
        accountId,
      ).toArray()
      : this.sql.exec<OAuthAccountRow>(
        "SELECT * FROM oauth_accounts WHERE account_id = ? AND uid = ?",
        accountId,
        uid,
      ).toArray();
    return rows[0] ? accountFromRow(rows[0]) : null;
  }

  findAccountByIdentity(
    uid: number,
    kind: OAuthConnectionKind,
    provider: string,
    accountKey: string,
  ): OAuthAccountRecord | null {
    const rows = this.sql.exec<OAuthAccountRow>(
      "SELECT * FROM oauth_accounts WHERE uid = ? AND kind = ? AND provider = ? AND account_key = ?",
      uid,
      kind,
      provider,
      accountKey,
    ).toArray();
    return rows[0] ? accountFromRow(rows[0]) : null;
  }

  listAccounts(uid?: number): OAuthAccountRecord[] {
    const rows = uid === undefined
      ? this.sql.exec<OAuthAccountRow>(
        "SELECT * FROM oauth_accounts ORDER BY updated_at DESC",
      ).toArray()
      : this.sql.exec<OAuthAccountRow>(
        "SELECT * FROM oauth_accounts WHERE uid = ? ORDER BY updated_at DESC",
        uid,
      ).toArray();
    return rows.map(accountFromRow);
  }

  deleteAccount(accountId: string, uid?: number): boolean {
    const existing = this.getAccount(accountId, uid);
    if (!existing) return false;
    if (uid === undefined) {
      this.sql.exec("DELETE FROM oauth_accounts WHERE account_id = ?", accountId);
    } else {
      this.sql.exec(
        "DELETE FROM oauth_accounts WHERE account_id = ? AND uid = ?",
        accountId,
        uid,
      );
    }
    return true;
  }

  markAccountUsed(accountId: string, uid?: number, now = Date.now()): boolean {
    const existing = this.getAccount(accountId, uid);
    if (!existing) return false;
    this.sql.exec(
      "UPDATE oauth_accounts SET last_used_at = ? WHERE account_id = ?",
      now,
      accountId,
    );
    return true;
  }
}

function flowFromRow(row: OAuthFlowRow): OAuthFlowRecord {
  return {
    flowId: row.flow_id,
    uid: row.uid,
    kernelOwnerUid: row.kernel_owner_uid,
    kind: row.kind as OAuthConnectionKind,
    provider: row.provider,
    accountKey: row.account_key,
    label: row.label,
    authorizationEndpoint: row.authorization_endpoint,
    tokenEndpoint: row.token_endpoint,
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    scope: row.scope,
    resource: row.resource,
    extraAuthParams: parseJsonObject(row.extra_auth_params_json) as Record<string, string>,
    codeVerifier: row.code_verifier,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function accountFromRow(row: OAuthAccountRow): OAuthAccountRecord {
  return {
    accountId: row.account_id,
    uid: row.uid,
    kind: row.kind as OAuthConnectionKind,
    provider: row.provider,
    accountKey: row.account_key,
    label: row.label,
    scope: row.scope,
    resource: row.resource,
    clientId: row.client_id,
    tokenType: row.token_type,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    metadata: parseJsonObject(row.metadata_json),
  };
}

function parseJsonObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
