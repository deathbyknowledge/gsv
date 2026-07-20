import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { SELF, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import gateway, {
  DiscordGatewayEntrypoint,
  GatewayEntrypoint,
  buildUserKernelWebSocketRequest,
  isRetiredCliDownloadPath,
  matchPackageAppSessionPath,
  packageAppClientResponseHeaders,
  packageWorkerPath,
  trustedLoginSourceAddress,
} from "./index";
import { buildRoutedAppSessionId } from "./protocol/app-session";
import { APP_PLACEMENT_VERIFICATION_KEY_OBJECT } from "./shared/app-placement-certificate";
import { AuthStore } from "./kernel/auth-store";
import { hashPassword } from "./auth/shadow";
import type { Kernel } from "./kernel/do";
import { SHIP_KERNEL_NAME } from "./shared/utils";
import {
  USER_KERNEL_GENERATION_HEADER,
  USER_KERNEL_LOGIN_SOURCE_HEADER,
} from "./shared/kernel-names";

const adapterFrame = {
  type: "req" as const,
  id: "adapter-request-1",
  call: "adapter.inbound" as const,
  args: {
    adapter: "discord",
    accountId: "primary",
    message: {
      messageId: "external-message-1",
      surface: { kind: "dm" as const, id: "dm-1" },
      actor: { id: "actor-1", name: "Private Person" },
      text: "closest private device secret",
      media: [{
        type: "image" as const,
        mimeType: "image/png",
        data: "private-base64-payload",
      }],
    },
  },
};

const APP_LAUNCH_TOKEN = "01234567-89ab-4def-8abc-0123456789ab";
const APP_PLACEMENT_CERTIFICATE =
  "KfWFW2CEKnR0tdXxEO2urttEvaP0sHkJ5EScvHrVSvu-VvxF8sm6Uw74-WCk0YN7sBY_LX6Qntv9pkvgtoU9uQ";
const APP_PLACEMENT_VERIFICATION_KEY = JSON.stringify({
  version: 1,
  algorithm: "ECDSA-P256-SHA256",
  publicKeySpki:
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2_0F87q_2jkiMchP21FoZF-hrz-CyXjr61LpE5epMhjYdTvESv9GhqcYPJx8mAtV3f33ffFMVE1K10kNrIedJg",
});

function buildAppLaunchHarness(
  sessionId: string,
  options: {
    routeAuthorized?: boolean;
    masterRoute?:
      | { ok: false }
      | { ok: true; kernelName: string; lifecycle: "legacy" };
  } = {},
) {
  const resolvedSession = (input: { sessionId: string; secret: string }) => {
    const now = Date.now();
    return {
      ok: true as const,
      packageId: "pkg-chat",
      packageName: "chat",
      routeBase: "/apps/chat",
      artifact: { hash: "sha256:test", mainModule: "index.ts", modulePaths: [] },
      appFrame: {
        uid: 1000,
        username: "alice",
        kernelOwnerUid: 1000,
        kernelUsername: "alice",
        ...(!input.sessionId.startsWith("gsv1b~") ? {} : { kernelGeneration: 3 }),
        sessionId: input.sessionId,
        clientId: "window-1",
        packageId: "pkg-chat",
        packageName: "chat",
        packageUpdatedAt: 1_700_000_000_000,
        packageArtifactHash: "sha256:test",
        entrypointName: "Chat",
        routeBase: "/apps/chat",
        issuedAt: now,
        expiresAt: now + 60_000,
      },
      clientSession: {
        sessionId: input.sessionId,
        clientId: "window-1",
        packageId: "pkg-chat",
        packageName: "chat",
        routeBase: "/apps/chat",
        rpcBase: `/apps/sessions/${encodeURIComponent(input.sessionId)}/clients/window-1/socket`,
        createdAt: now,
        expiresAt: now + 60_000,
      },
      hasRpc: true,
      auth: { uid: 1000, username: "alice", capabilities: [] },
    };
  };
  const master = {
    setName: vi.fn(async () => undefined),
    resolveAppSessionKernel: vi.fn(async () => options.masterRoute ?? { ok: false as const }),
    resolvePackageAppRpcSession: vi.fn(async (input: {
      sessionId: string;
      secret: string;
    }) => resolvedSession(input)),
    refreshPackageAppRpcSession: vi.fn(async (input: {
      sessionId: string;
      secret: string;
    }) => resolvedSession(input)),
  };
  const target = {
    setName: vi.fn(async () => undefined),
    authorizeAppSessionRoute: vi.fn(async () => options.routeAuthorized ?? true),
    resolvePackageAppRpcSession: vi.fn(async (input: {
      sessionId: string;
      secret: string;
    }) => resolvedSession(input)),
    refreshPackageAppRpcSession: vi.fn(async (input: {
      sessionId: string;
      secret: string;
    }) => resolvedSession(input)),
  };
  const runner = {
    gsvFetch: vi.fn(async () => new Response("package asset", {
      headers: { "content-type": "text/javascript" },
    })),
    fetch: vi.fn(async () => new Response("socket accepted")),
  };
  const namespace = {
    idFromName: vi.fn((name: string) => name),
    get: vi.fn((id: string) => id === SHIP_KERNEL_NAME ? master : target),
  };
  const storage = {
    get: vi.fn(async (key: string) => key === APP_PLACEMENT_VERIFICATION_KEY_OBJECT
      ? {
          size: APP_PLACEMENT_VERIFICATION_KEY.length,
          text: async () => APP_PLACEMENT_VERIFICATION_KEY,
        }
      : null),
  };
  return {
    env: { KERNEL: namespace, STORAGE: storage } as unknown as Env,
    master,
    namespace,
    runner,
    storage,
    target,
    ctx: {
      exports: {
        AppRunner: {
          getByName: vi.fn(() => runner),
        },
      },
    } as unknown as ExecutionContext,
    url: `https://gsv.test/apps/sessions/${encodeURIComponent(sessionId)}/launch`,
    clientUrl: `https://gsv.test/apps/sessions/${encodeURIComponent(sessionId)}/clients/window-1/assets/app.js`,
    socketUrl: `https://gsv.test/apps/sessions/${encodeURIComponent(sessionId)}/clients/window-1/socket`,
    cookie: `${`gsv_app_session_${sessionId}_window-1`.replace(/[^A-Za-z0-9_]/g, "_")}=${APP_LAUNCH_TOKEN}`,
  };
}

function buildDiscordEntrypoint(route: unknown) {
  const events: string[] = [];
  const master = {
    setName: vi.fn(async () => undefined),
    issueAdapterInboundRoute: vi.fn(async () => {
      events.push("master-route");
      return route;
    }),
    serviceFrame: vi.fn(async () => {
      events.push("master-frame");
      return { type: "res", id: adapterFrame.id, ok: true, data: { ok: true } };
    }),
  };
  const target = {
    setName: vi.fn(async () => undefined),
    serviceLinkedAdapterFrame: vi.fn(async () => {
      events.push("target-frame");
      return { type: "res", id: adapterFrame.id, ok: true, data: { ok: true } };
    }),
  };
  const namespace = {
    idFromName: vi.fn((name: string) => name),
    get: vi.fn((id: string) => id === SHIP_KERNEL_NAME ? master : target),
  };
  const entrypoint = new DiscordGatewayEntrypoint(
    {} as any,
    { KERNEL: namespace } as any,
  );
  return { entrypoint, events, master, namespace, target };
}

describe("gateway public routes", () => {
  it("rejects unscoped adapter service frames and cancels their bodies", async () => {
    const cancel = vi.fn();
    const entrypoint = new GatewayEntrypoint({} as any, {} as any);

    await expect(entrypoint.serviceFrame({
      type: "req",
      id: "unscoped-adapter",
      call: "adapter.inbound",
      args: {
        adapter: "discord",
        accountId: "bot",
        message: {},
      },
      body: {
        stream: new ReadableStream<Uint8Array>({ cancel }),
        length: 1,
      },
    } as any)).resolves.toMatchObject({
      type: "res",
      id: "unscoped-adapter",
      ok: false,
      error: { code: 403 },
    });

    expect(cancel).toHaveBeenCalledOnce();
  });

  it("retires only the old CLI mirror path", () => {
    expect(isRetiredCliDownloadPath("/public/gsv/downloads/cli/install.sh")).toBe(true);
    expect(isRetiredCliDownloadPath("/public/gsv/downloads/cli-old/install.sh")).toBe(false);
    expect(isRetiredCliDownloadPath("/public/gsv/assets/app.js")).toBe(false);
  });

  it("reads login source only from Cloudflare's edge-authored header", () => {
    const request = new Request("https://gsv.test/git/root/repo.git/info/refs", {
      headers: {
        "CF-Connecting-IP": "203.0.113.8",
        "X-GSV-Login-Source": "attacker-controlled",
      },
    });

    expect(trustedLoginSourceAddress(request)).toBe("203.0.113.8");
  });

  it("strips raw source metadata before entering a user Kernel", () => {
    const request = new Request("https://gsv.test/ws/alice", {
      headers: {
        "CF-Connecting-IP": "203.0.113.8",
        [USER_KERNEL_LOGIN_SOURCE_HEADER]: `source:1:${"b".repeat(64)}`,
        [USER_KERNEL_GENERATION_HEADER]: "999",
        upgrade: "websocket",
      },
    });
    const scope = `source:2:${"a".repeat(64)}` as const;

    const routed = buildUserKernelWebSocketRequest(request, scope, 7);

    expect(routed.url).toBe(request.url);
    expect(routed.headers.get("CF-Connecting-IP")).toBeNull();
    expect(routed.headers.get(USER_KERNEL_LOGIN_SOURCE_HEADER)).toBe(scope);
    expect(routed.headers.get(USER_KERNEL_GENERATION_HEADER)).toBe("7");
    expect(routed.headers.get("upgrade")).toBe("websocket");
  });

  it("rejects invalid user Kernel generations before routing", () => {
    const request = new Request("https://gsv.test/ws/alice");
    expect(() => buildUserKernelWebSocketRequest(
      request,
      `source:2:${"a".repeat(64)}`,
      0,
    )).toThrow("Invalid user Kernel generation");
  });

  it("forwards distinct Git request sources into pseudonymous limiter scopes", async () => {
    const kernel = await getAgentByName(env.KERNEL, SHIP_KERNEL_NAME);
    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      const auth = new AuthStore(state.storage.sql);
      await auth.bootstrap();
    });

    const authorization = `Basic ${btoa("root:wrong-credential")}`;
    for (const source of ["203.0.113.8", "203.0.113.9"]) {
      const response = await SELF.fetch(
        "https://gsv.test/git/root/private.git/git-receive-pack",
        {
          method: "POST",
          headers: {
            authorization,
            "CF-Connecting-IP": source,
          },
        },
      );
      expect(response.status).toBe(401);
    }

    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      const scopes = state.storage.sql.exec<{ scope: string }>(
        "SELECT scope FROM auth_login_attempts WHERE scope LIKE 'target:%' ORDER BY scope",
      ).toArray().map((row) => row.scope);
      expect(scopes).toHaveLength(2);
      expect(scopes[0]).not.toBe(scopes[1]);
      expect(scopes.join(" ")).not.toContain("203.0.113");
    });
  });

  it("rejects an oversized Git Authorization header before Basic decoding", async () => {
    const kernel = await getAgentByName(env.KERNEL, SHIP_KERNEL_NAME);
    const before = await runInDurableObject(kernel, async (_instance: Kernel, state) => (
      state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) as count FROM auth_login_attempts",
      ).one().count
    ));
    const response = await SELF.fetch(
      "https://gsv.test/git/root/private.git/git-receive-pack",
      {
        method: "POST",
        headers: {
          authorization: `Basic ${"A".repeat(5_000)}`,
          "CF-Connecting-IP": "203.0.113.8",
        },
      },
    );
    expect(response.status).toBe(401);

    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) as count FROM auth_login_attempts",
      ).one().count).toBe(before);
    });
  });

  it("never invokes RIPGIT after lifecycle authorization is denied", async () => {
    const kernel = await getAgentByName(env.KERNEL, SHIP_KERNEL_NAME);
    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      const auth = new AuthStore(state.storage.sql);
      await auth.bootstrap();
      await auth.setPassword("root", await hashPassword("correct-password"));
      const now = Date.now();
      state.storage.sql.exec(
        `INSERT INTO user_kernels (
           username, uid, lifecycle, generation, created_at, updated_at, retired_at
         ) VALUES ('root', 0, 'suspended', 2, ?, ?, NULL)`,
        now,
        now,
      );
    });
    const ripgitFetch = vi.fn(async () => new Response("must not run"));
    const testEnv = {
      KERNEL: env.KERNEL,
      RIPGIT: { fetch: ripgitFetch },
    } as unknown as Env;

    const response = await gateway.fetch(
      new Request("https://gsv.test/git/root/private.git/git-receive-pack", {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa("root:correct-password")}`,
        },
      }),
      testEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Basic realm="gsv"');
    await expect(response.text()).resolves.toBe("Authentication failed");
    expect(ripgitFetch).not.toHaveBeenCalled();
  });
});

describe("gateway adapter routing", () => {
  it("sends an active user's full frame directly to the scoped user Kernel", async () => {
    const harness = buildDiscordEntrypoint({
      kind: "active",
      authorization: "one-shot-1",
      targetKernelName: "user:alice",
      username: "alice",
      ownerUid: 1000,
      generation: 7,
      linkGeneration: 3,
    });

    await expect(harness.entrypoint.serviceFrame(adapterFrame)).resolves.toMatchObject({
      type: "res",
      id: adapterFrame.id,
      ok: true,
    });

    expect(harness.master.issueAdapterInboundRoute).toHaveBeenCalledWith({
      adapter: "discord",
      accountId: "primary",
      actorId: "actor-1",
      frameId: adapterFrame.id,
      surfaceKind: "dm",
      surfaceId: "dm-1",
    });
    expect(harness.master.serviceFrame).not.toHaveBeenCalled();
    expect(harness.target.serviceLinkedAdapterFrame).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "scoped-adapter-entrypoint",
        authorization: "one-shot-1",
        frame: adapterFrame,
      }),
    );
    expect(harness.events).toEqual(["master-route", "target-frame"]);
  });

  it("keeps unknown-user text and media out of the Master challenge request", async () => {
    const harness = buildDiscordEntrypoint({
      kind: "response",
      data: {
        ok: true,
        challenge: {
          code: "ABCD-2345",
          prompt: "Identify yourself",
          expiresAt: 20_000,
        },
      },
    });

    await expect(harness.entrypoint.serviceFrame(adapterFrame)).resolves.toMatchObject({
      type: "res",
      id: adapterFrame.id,
      ok: true,
      data: { challenge: { code: "ABCD-2345" } },
    });

    const masterInput = harness.master.issueAdapterInboundRoute.mock.calls[0]?.[0];
    expect(JSON.stringify(masterInput)).not.toContain("closest private device secret");
    expect(JSON.stringify(masterInput)).not.toContain("private-base64-payload");
    expect(masterInput).not.toHaveProperty("message");
    expect(masterInput).not.toHaveProperty("frame");
    expect(harness.master.serviceFrame).not.toHaveBeenCalled();
    expect(harness.target.serviceLinkedAdapterFrame).not.toHaveBeenCalled();
  });

  it("forwards the full frame to singleton only for an explicit legacy route", async () => {
    const harness = buildDiscordEntrypoint({ kind: "legacy" });

    await expect(harness.entrypoint.serviceFrame(adapterFrame)).resolves.toMatchObject({
      ok: true,
    });

    expect(harness.master.serviceFrame).toHaveBeenCalledWith(adapterFrame);
    expect(harness.target.serviceLinkedAdapterFrame).not.toHaveBeenCalled();
    expect(harness.events).toEqual(["master-route", "master-frame"]);
  });

  it("rejects scoped request bodies before consulting Master", async () => {
    const harness = buildDiscordEntrypoint({ kind: "legacy" });
    const cancel = vi.fn();

    await expect(harness.entrypoint.serviceFrame({
      ...adapterFrame,
      body: {
        stream: new ReadableStream<Uint8Array>({ cancel }),
        length: 1,
      },
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 400 },
    });

    expect(cancel).toHaveBeenCalledOnce();
    expect(harness.master.issueAdapterInboundRoute).not.toHaveBeenCalled();
    expect(harness.master.serviceFrame).not.toHaveBeenCalled();
    expect(harness.target.serviceLinkedAdapterFrame).not.toHaveBeenCalled();
  });

  it("rejects oversized route metadata before consulting Master", async () => {
    const harness = buildDiscordEntrypoint({ kind: "legacy" });

    await expect(harness.entrypoint.serviceFrame({
      ...adapterFrame,
      args: {
        ...adapterFrame.args,
        message: {
          ...adapterFrame.args.message,
          actor: { id: "a".repeat(513) },
        },
      },
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 400 },
    });

    expect(harness.master.issueAdapterInboundRoute).not.toHaveBeenCalled();
    expect(harness.master.serviceFrame).not.toHaveBeenCalled();
    expect(harness.target.serviceLinkedAdapterFrame).not.toHaveBeenCalled();
  });
});

describe("gateway app session routing", () => {
  function routedSessionId(): string {
    return buildRoutedAppSessionId({
      username: "alice",
      uid: 1000,
      generation: 3,
      expiresAt: Date.now() + 60_000,
      nonce: "4f57c735-a614-4e0f-a36a-e5c60b94db15",
      placementCertificate: APP_PLACEMENT_CERTIFICATE,
    }, "A".repeat(43));
  }

  it("extracts a routed user Kernel locator from the session path", () => {
    const sessionId = buildRoutedAppSessionId({
      username: "alice",
      uid: 1000,
      generation: 3,
      expiresAt: 2_000_000_000_000,
      nonce: "4f57c735-a614-4e0f-a36a-e5c60b94db15",
      placementCertificate: APP_PLACEMENT_CERTIFICATE,
    }, "A".repeat(43));

    expect(matchPackageAppSessionPath(
      `/apps/sessions/${encodeURIComponent(sessionId)}/clients/window-1/assets/app.js`,
    )).toEqual({
      sessionId,
      clientId: "window-1",
      suffix: "/assets/app.js",
    });
  });

  it("rejects malformed app session route handles", () => {
    expect(matchPackageAppSessionPath(
      `/apps/sessions/gsv1b~Alice~1000~3~2000000000000~bad~${"A".repeat(86)}~${"A".repeat(43)}/clients/window-1/`,
    )).toBeNull();
    expect(matchPackageAppSessionPath(
      `/apps/sessions/${encodeURIComponent(` ${routedSessionId()}`)}/clients/window-1/`,
    )).toBeNull();
    expect(matchPackageAppSessionPath(
      `/apps/sessions/${"A".repeat(769)}/clients/window-1/`,
    )).toBeNull();
  });

  it("preserves the package app root slash when proxying app sessions", () => {
    expect(packageWorkerPath("/apps/chat", "/")).toBe("/apps/chat/");
    expect(packageWorkerPath("/apps/chat", "")).toBe("/apps/chat/");
  });

  it("keeps nested app session paths under the package route", () => {
    expect(packageWorkerPath("/apps/chat", "/assets/main.js")).toBe("/apps/chat/assets/main.js");
  });

  it("strips package-controlled cookie headers from app session responses", () => {
    const headers = packageAppClientResponseHeaders(new Response("ok", {
      headers: {
        "content-length": "2",
        "set-cookie": "gsv_session=bad",
        "set-cookie2": "gsv_legacy=bad",
        "x-package": "ok",
      },
    }));

    expect(headers.get("content-length")).toBeNull();
    expect(headers.get("set-cookie")).toBeNull();
    expect(headers.get("set-cookie2")).toBeNull();
    expect(headers.get("x-package")).toBe("ok");
  });

  it("rejects a forged active signature before reading or forwarding a launch body", async () => {
    const validSessionId = routedSessionId();
    const parts = validSessionId.split("~");
    parts[7] = `B${parts[7]!.slice(1)}`;
    const sessionId = parts.join("~");
    const harness = buildAppLaunchHarness(sessionId, { routeAuthorized: false });
    const pull = vi.fn();
    const cancel = vi.fn();
    const request = new Request(harness.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({ pull, cancel }, {
        highWaterMark: 0,
      }),
    });

    const response = await gateway.fetch(
      request,
      harness.env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(404);
    expect(harness.target.authorizeAppSessionRoute).toHaveBeenCalledWith(sessionId);
    expect(harness.target.resolvePackageAppRpcSession).not.toHaveBeenCalled();
    expect(harness.master.resolveAppSessionKernel).not.toHaveBeenCalled();
    expect(harness.namespace.idFromName).not.toHaveBeenCalledWith(SHIP_KERNEL_NAME);
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects a forged placement certificate before selecting its user Kernel", async () => {
    const sessionId = routedSessionId().replace(
      APP_PLACEMENT_CERTIFICATE,
      `L${APP_PLACEMENT_CERTIFICATE.slice(1)}`,
    );
    const harness = buildAppLaunchHarness(sessionId);
    const pull = vi.fn();
    const cancel = vi.fn();
    const response = await gateway.fetch(
      new Request(harness.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: new ReadableStream<Uint8Array>({ pull, cancel }, {
          highWaterMark: 0,
        }),
      }),
      harness.env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(404);
    expect(harness.storage.get).toHaveBeenCalledWith(
      APP_PLACEMENT_VERIFICATION_KEY_OBJECT,
    );
    expect(harness.namespace.idFromName).not.toHaveBeenCalled();
    expect(harness.namespace.get).not.toHaveBeenCalled();
    expect(harness.target.authorizeAppSessionRoute).not.toHaveBeenCalled();
    expect(harness.target.resolvePackageAppRpcSession).not.toHaveBeenCalled();
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("launches an active app directly through its user Kernel", async () => {
    const sessionId = routedSessionId();
    const harness = buildAppLaunchHarness(sessionId);
    const response = await gateway.fetch(
      new Request(harness.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: APP_LAUNCH_TOKEN }),
      }),
      harness.env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(harness.target.resolvePackageAppRpcSession).toHaveBeenCalledWith({
      sessionId,
      secret: APP_LAUNCH_TOKEN,
    });
    expect(response.headers.get("set-cookie")).toContain("gsv_app_");
    expect(harness.target.authorizeAppSessionRoute.mock.invocationCallOrder[0])
      .toBeLessThan(harness.target.resolvePackageAppRpcSession.mock.invocationCallOrder[0]);
    expect(harness.master.resolveAppSessionKernel).not.toHaveBeenCalled();
    expect(harness.namespace.idFromName).not.toHaveBeenCalledWith(SHIP_KERNEL_NAME);
  });

  it("caches the public verifier while replay still reauthorizes the genuine target", async () => {
    const sessionId = routedSessionId();
    const harness = buildAppLaunchHarness(sessionId);
    for (let index = 0; index < 2; index += 1) {
      const response = await gateway.fetch(
        new Request(harness.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: APP_LAUNCH_TOKEN }),
        }),
        harness.env,
        {} as ExecutionContext,
      );
      expect(response.status).toBe(200);
    }

    expect(harness.storage.get).toHaveBeenCalledOnce();
    expect(harness.target.authorizeAppSessionRoute).toHaveBeenCalledTimes(2);
    expect(harness.target.resolvePackageAppRpcSession).toHaveBeenCalledTimes(2);
    expect(harness.master.resolveAppSessionKernel).not.toHaveBeenCalled();
  });

  it("rejects an oversized launch body before consulting the target Kernel", async () => {
    const sessionId = routedSessionId();
    const harness = buildAppLaunchHarness(sessionId);
    const response = await gateway.fetch(
      new Request(harness.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "129",
        },
        body: "{}",
      }),
      harness.env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(413);
    expect(harness.target.authorizeAppSessionRoute).toHaveBeenCalledOnce();
    expect(harness.target.resolvePackageAppRpcSession).not.toHaveBeenCalled();
    expect(harness.master.resolveAppSessionKernel).not.toHaveBeenCalled();
  });

  it("serves an active app asset without consulting the Master", async () => {
    const sessionId = routedSessionId();
    const harness = buildAppLaunchHarness(sessionId);
    const response = await gateway.fetch(
      new Request(harness.clientUrl, {
        headers: { cookie: harness.cookie },
      }),
      harness.env,
      harness.ctx,
    );

    expect(response.status).toBe(200);
    expect(harness.target.authorizeAppSessionRoute).toHaveBeenCalledWith(sessionId);
    expect(harness.target.resolvePackageAppRpcSession).toHaveBeenCalledWith({
      sessionId,
      secret: APP_LAUNCH_TOKEN,
    });
    expect(harness.runner.gsvFetch).toHaveBeenCalledOnce();
    expect(harness.master.resolveAppSessionKernel).not.toHaveBeenCalled();
    expect(harness.namespace.idFromName).not.toHaveBeenCalledWith(SHIP_KERNEL_NAME);
  });

  it("opens an active app socket without consulting the Master", async () => {
    const sessionId = routedSessionId();
    const harness = buildAppLaunchHarness(sessionId);
    const response = await gateway.fetch(
      new Request(harness.socketUrl, {
        headers: {
          cookie: harness.cookie,
          upgrade: "websocket",
        },
      }),
      harness.env,
      harness.ctx,
    );

    expect(response.status).toBe(200);
    expect(harness.target.authorizeAppSessionRoute).toHaveBeenCalledWith(sessionId);
    expect(harness.target.resolvePackageAppRpcSession).toHaveBeenCalledWith({
      sessionId,
      secret: APP_LAUNCH_TOKEN,
    });
    expect(harness.runner.fetch).toHaveBeenCalledOnce();
    expect(harness.master.resolveAppSessionKernel).not.toHaveBeenCalled();
    expect(harness.namespace.idFromName).not.toHaveBeenCalledWith(SHIP_KERNEL_NAME);
  });

  it("retains Master routing only for an explicit legacy app session", async () => {
    const sessionId = "4f57c735-a614-4e0f-a36a-e5c60b94db15";
    const harness = buildAppLaunchHarness(sessionId, {
      masterRoute: {
        ok: true,
        kernelName: SHIP_KERNEL_NAME,
        lifecycle: "legacy",
      },
    });
    const response = await gateway.fetch(
      new Request(harness.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: APP_LAUNCH_TOKEN }),
      }),
      harness.env,
      harness.ctx,
    );

    expect(response.status).toBe(200);
    expect(harness.master.resolveAppSessionKernel).toHaveBeenCalledWith(sessionId);
    expect(harness.master.resolvePackageAppRpcSession).toHaveBeenCalledWith({
      sessionId,
      secret: APP_LAUNCH_TOKEN,
    });
    expect(harness.target.authorizeAppSessionRoute).not.toHaveBeenCalled();
    expect(harness.target.resolvePackageAppRpcSession).not.toHaveBeenCalled();
  });
});
