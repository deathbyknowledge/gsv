import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelContext } from "../context";
import type { OAuthAccountRecord, OAuthFlowRecord } from "../oauth-store";
import {
  completeOAuthCallback,
  handleSysOAuthDevicePoll,
  handleSysOAuthDeviceStart,
  handleSysOAuthForget,
  handleSysOAuthList,
  handleSysOAuthStart,
} from "./oauth";
import {
  refreshOpenAICodexAccount,
} from "./openai-codex-oauth";

type FakeOAuth = {
  cleanupExpiredFlows: ReturnType<typeof vi.fn>;
  createFlow: ReturnType<typeof vi.fn>;
  listAccounts: ReturnType<typeof vi.fn>;
  listFlows: ReturnType<typeof vi.fn>;
  deleteAccount: ReturnType<typeof vi.fn>;
  getFlow: ReturnType<typeof vi.fn>;
  getFlowByStateHash: ReturnType<typeof vi.fn>;
  upsertAccount: ReturnType<typeof vi.fn>;
  deleteFlow: ReturnType<typeof vi.fn>;
};

function makeContext(uid: number, oauth: FakeOAuth): KernelContext {
  return {
    identity: {
      role: "user",
      process: {
        uid,
        gid: uid,
        gids: [uid],
        username: uid === 0 ? "root" : `user${uid}`,
        home: uid === 0 ? "/root" : `/home/user${uid}`,
        cwd: uid === 0 ? "/root" : `/home/user${uid}`,
      },
      capabilities: ["*"],
    },
    oauth,
  } as unknown as KernelContext;
}

function createFakeOAuth(): FakeOAuth {
  return {
    cleanupExpiredFlows: vi.fn(),
    createFlow: vi.fn((input) => {
      const { stateHash: _stateHash, ...flow } = input;
      return {
        flowId: "flow-1",
        ...flow,
      };
    }),
    listAccounts: vi.fn(() => []),
    listFlows: vi.fn(() => []),
    deleteAccount: vi.fn(() => true),
    getFlow: vi.fn(),
    getFlowByStateHash: vi.fn(),
    upsertAccount: vi.fn((input) => ({
      accountId: "acct-1",
      ...input,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      lastUsedAt: null,
      metadata: input.metadata ?? {},
    })),
    deleteFlow: vi.fn(() => true),
  };
}

const flow: OAuthFlowRecord = {
  flowId: "flow-1",
  uid: 1000,
  kind: "ai-provider",
  provider: "openai-codex",
  accountKey: "default",
  label: "Codex",
  authorizationEndpoint: "https://auth.example.com/oauth/authorize",
  tokenEndpoint: "https://auth.example.com/oauth/token",
  clientId: "client-123",
  redirectUri: "https://gsv.example.com/oauth/callback",
  scope: "openid profile",
  resource: null,
  extraAuthParams: {},
  codeVerifier: "pkce-verifier",
  createdAt: 1_700_000_000_000,
  expiresAt: 1_700_000_600_000,
};

function encodeBase64Url(value: string): string {
  return btoa(value)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fakeCodexAccessToken(accountId: string): string {
  return fakeJwtToken({
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
    },
  });
}

function fakeJwtToken(payload: Record<string, unknown>): string {
  return [
    encodeBase64Url("{}"),
    encodeBase64Url(JSON.stringify(payload)),
    "sig",
  ].join(".");
}

describe("sys.oauth handlers", () => {
  let oauth: FakeOAuth;

  beforeEach(() => {
    oauth = createFakeOAuth();
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  });

  it("starts a user-scoped PKCE authorization flow", async () => {
    const ctx = makeContext(1000, oauth);

    const result = await handleSysOAuthStart(
      {
        kind: "ai-provider",
        provider: "openai-codex",
        label: "Codex",
        authorizationEndpoint: "https://auth.example.com/oauth/authorize",
        tokenEndpoint: "https://auth.example.com/oauth/token",
        clientId: "client-123",
        redirectUri: "https://gsv.example.com/oauth/callback",
        scope: "openid profile",
        extraAuthParams: { prompt: "consent" },
      },
      ctx,
    );

    const url = new URL(result.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://auth.example.com/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe("https://gsv.example.com/oauth/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    const state = url.searchParams.get("state");
    expect(state).toBeTruthy();
    // MCP OAuth callbacks are claimed only for nonce.serverId states. Generic
    // OAuth state must stay opaque so shared /oauth/callback routing falls
    // through to sys.oauth instead of the MCP callback handler.
    expect(state).not.toContain(".");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(oauth.createFlow).toHaveBeenCalledWith(expect.objectContaining({
      uid: 1000,
      kind: "ai-provider",
      provider: "openai-codex",
      accountKey: "default",
      codeVerifier: expect.any(String),
    }));
    expect(result.flow).not.toHaveProperty("codeVerifier");
  });

  it("rejects non-root OAuth start for another uid", async () => {
    const ctx = makeContext(1000, oauth);

    await expect(handleSysOAuthStart(
      {
        uid: 1001,
        kind: "generic",
        provider: "example",
        authorizationEndpoint: "https://auth.example.com/oauth/authorize",
        tokenEndpoint: "https://auth.example.com/oauth/token",
        clientId: "client-123",
        redirectUri: "https://gsv.example.com/oauth/callback",
      },
      ctx,
    )).rejects.toThrow("Permission denied: cannot start OAuth for another user");
    expect(oauth.createFlow).not.toHaveBeenCalled();
  });

  it("rejects attempts to override reserved authorization parameters", async () => {
    const ctx = makeContext(1000, oauth);

    await expect(handleSysOAuthStart(
      {
        kind: "generic",
        provider: "example",
        authorizationEndpoint: "https://auth.example.com/oauth/authorize",
        tokenEndpoint: "https://auth.example.com/oauth/token",
        clientId: "client-123",
        redirectUri: "https://gsv.example.com/oauth/callback",
        extraAuthParams: { state: "spoofed" },
      },
      ctx,
    )).rejects.toThrow("extraAuthParams cannot override state");
    expect(oauth.createFlow).not.toHaveBeenCalled();
  });

  it("starts an OpenAI Codex device-code flow", async () => {
    const ctx = makeContext(1000, oauth);
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      device_auth_id: "device-auth-1",
      user_code: "ABCD-EFGH",
      interval: 5,
      expires_in: 900,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    const result = await handleSysOAuthDeviceStart({
      kind: "ai-provider",
      provider: "openai-codex",
    }, ctx, fetcher);

    expect(fetcher).toHaveBeenCalledWith("https://auth.openai.com/api/accounts/deviceauth/usercode", expect.objectContaining({
      method: "POST",
    }));
    expect(oauth.createFlow).toHaveBeenCalledWith(expect.objectContaining({
      uid: 1000,
      kind: "ai-provider",
      provider: "openai-codex",
      accountKey: "default",
      label: "OpenAI Codex",
      authorizationEndpoint: "https://auth.openai.com/codex/device",
      tokenEndpoint: "https://auth.openai.com/oauth/token",
      redirectUri: "https://auth.openai.com/deviceauth/callback",
      scope: "openid profile email offline_access",
      extraAuthParams: expect.objectContaining({
        device_auth_id: "device-auth-1",
        user_code: "ABCD-EFGH",
        interval_seconds: "5",
      }),
    }));
    expect(result).toMatchObject({
      provider: "openai-codex",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/codex/device",
      intervalSeconds: 5,
      expiresAt: 1_700_000_900_000,
    });
    expect(result.flow).not.toHaveProperty("extraAuthParams");
  });

  it("polls a pending OpenAI Codex device-code flow", async () => {
    const ctx = makeContext(1000, oauth);
    oauth.getFlow.mockReturnValue({
      ...flow,
      authorizationEndpoint: "https://auth.openai.com/codex/device",
      tokenEndpoint: "https://auth.openai.com/oauth/token",
      redirectUri: "https://auth.openai.com/deviceauth/callback",
      scope: "openid profile email offline_access",
      extraAuthParams: {
        device_auth_id: "device-auth-1",
        user_code: "ABCD-EFGH",
        interval_seconds: "5",
      },
    });
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      error: "deviceauth_authorization_pending",
    }), {
      status: 403,
      headers: { "content-type": "application/json" },
    }));

    const result = await handleSysOAuthDevicePoll({
      flowId: "flow-1",
    }, ctx, fetcher);

    expect(oauth.getFlow).toHaveBeenCalledWith("flow-1", 1000);
    expect(fetcher).toHaveBeenCalledWith("https://auth.openai.com/api/accounts/deviceauth/token", expect.objectContaining({
      method: "POST",
    }));
    expect(result).toMatchObject({
      status: "pending",
      intervalSeconds: 5,
      expiresAt: flow.expiresAt,
    });
    expect(oauth.upsertAccount).not.toHaveBeenCalled();
    expect(oauth.deleteFlow).not.toHaveBeenCalled();
  });

  it("completes an OpenAI Codex device-code flow and stores the OAuth token", async () => {
    const ctx = makeContext(1000, oauth);
    oauth.getFlow.mockReturnValue({
      ...flow,
      clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
      authorizationEndpoint: "https://auth.openai.com/codex/device",
      tokenEndpoint: "https://auth.openai.com/oauth/token",
      redirectUri: "https://auth.openai.com/deviceauth/callback",
      scope: "openid profile email offline_access",
      extraAuthParams: {
        device_auth_id: "device-auth-1",
        user_code: "ABCD-EFGH",
        interval_seconds: "5",
      },
    });
    const accessToken = fakeJwtToken({ sub: "user-1" });
    const idToken = fakeCodexAccessToken("chatgpt-account-1");
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://auth.openai.com/api/accounts/deviceauth/token") {
        return new Response(JSON.stringify({
          authorization_code: "authorization-code-1",
          code_verifier: "code-verifier-1",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const body = init?.body as URLSearchParams;
      expect(String(input)).toBe("https://auth.openai.com/oauth/token");
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("authorization-code-1");
      expect(body.get("code_verifier")).toBe("code-verifier-1");
      expect(body.get("redirect_uri")).toBe("https://auth.openai.com/deviceauth/callback");
      return new Response(JSON.stringify({
        access_token: accessToken,
        id_token: idToken,
        refresh_token: "refresh-token-1",
        token_type: "Bearer",
        expires_in: 3600,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await handleSysOAuthDevicePoll({
      flowId: "flow-1",
    }, ctx, fetcher);

    expect(result.status).toBe("complete");
    expect(oauth.upsertAccount).toHaveBeenCalledWith(expect.objectContaining({
      uid: 1000,
      kind: "ai-provider",
      provider: "openai-codex",
      accountKey: "default",
      accessToken,
      refreshToken: "refresh-token-1",
      expiresAt: 1_700_003_600_000,
      metadata: {
        authorizedAt: 1_700_000_000_000,
        chatgptAccountId: "chatgpt-account-1",
      },
    }));
    expect(oauth.deleteFlow).toHaveBeenCalledWith("flow-1");
    expect(JSON.stringify(result)).not.toContain(accessToken);
    expect(JSON.stringify(result)).not.toContain("refresh-token-1");
  });

  it("preserves an existing OpenAI Codex refresh token when refresh omits rotation", async () => {
    const accessToken = fakeCodexAccessToken("chatgpt-account-2");
    const account: OAuthAccountRecord = {
      accountId: "acct-codex",
      uid: 1000,
      kind: "ai-provider",
      provider: "openai-codex",
      accountKey: "default",
      label: "OpenAI Codex",
      scope: "openid profile email offline_access",
      resource: null,
      clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
      tokenType: "Bearer",
      accessToken: "old-access-token",
      refreshToken: "stored-refresh-token",
      expiresAt: 1_700_000_010_000,
      createdAt: 1_600_000_000_000,
      updatedAt: 1_600_000_000_000,
      lastUsedAt: null,
      metadata: { chatgptAccountId: "chatgpt-account-1" },
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body as URLSearchParams;
      expect(String(input)).toBe("https://auth.openai.com/oauth/token");
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("stored-refresh-token");
      return new Response(JSON.stringify({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 3600,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await refreshOpenAICodexAccount(oauth as any, account, fetcher);

    expect(result.refreshToken).toBe("stored-refresh-token");
    expect(oauth.upsertAccount).toHaveBeenCalledWith(expect.objectContaining({
      uid: 1000,
      provider: "openai-codex",
      accountKey: "default",
      accessToken,
      refreshToken: "stored-refresh-token",
      expiresAt: 1_700_003_600_000,
      metadata: {
        chatgptAccountId: "chatgpt-account-2",
        refreshedAt: 1_700_000_000_000,
      },
    }));
  });

  it("lists only caller accounts for non-root users", () => {
    const ctx = makeContext(1000, oauth);
    oauth.listAccounts.mockReturnValue([
      {
        accountId: "acct-1",
        uid: 1000,
        kind: "ai-provider",
        provider: "openai-codex",
        accountKey: "default",
        label: "Codex",
        scope: "openid",
        resource: null,
        clientId: "client-123",
        tokenType: "Bearer",
        accessToken: "hidden",
        refreshToken: "hidden",
        expiresAt: null,
        createdAt: 1,
        updatedAt: 2,
        lastUsedAt: null,
        metadata: {},
      },
    ]);

    const result = handleSysOAuthList({ includePending: true }, ctx);
    expect(oauth.listAccounts).toHaveBeenCalledWith(1000);
    expect(oauth.listFlows).toHaveBeenCalledWith(1000);
    expect(result.accounts[0]).not.toHaveProperty("accessToken");
    expect(result.accounts[0]).not.toHaveProperty("refreshToken");
  });

  it("scopes forget to caller uid for non-root users", () => {
    const ctx = makeContext(1000, oauth);
    const result = handleSysOAuthForget({ accountId: "acct-1" }, ctx);
    expect(result.forgotten).toBe(true);
    expect(oauth.deleteAccount).toHaveBeenCalledWith("acct-1", 1000);
  });

  it("exchanges an OAuth callback code and stores tokens behind the summary boundary", async () => {
    oauth.getFlowByStateHash.mockReturnValue(flow);
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body as URLSearchParams;
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("client_id")).toBe("client-123");
      expect(body.get("code")).toBe("auth-code");
      expect(body.get("redirect_uri")).toBe("https://gsv.example.com/oauth/callback");
      expect(body.get("code_verifier")).toBe("pkce-verifier");
      return new Response(JSON.stringify({
        access_token: "access-secret",
        refresh_token: "refresh-secret",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid profile email",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await completeOAuthCallback(
      { state: "state-value", code: "auth-code" },
      oauth as unknown as Parameters<typeof completeOAuthCallback>[1],
      fetcher,
    );

    expect(result.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledWith("https://auth.example.com/oauth/token", expect.any(Object));
    expect(oauth.upsertAccount).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      expiresAt: 1_700_003_600_000,
      scope: "openid profile email",
    }));
    expect(oauth.deleteFlow).toHaveBeenCalledWith("flow-1");
    expect(JSON.stringify(result)).not.toContain("access-secret");
    expect(JSON.stringify(result)).not.toContain("refresh-secret");
  });
});
