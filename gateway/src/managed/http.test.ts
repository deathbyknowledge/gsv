import { getAgentByName } from "agents";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleManagedRequest, isManagedRoute } from "./http";
import {
  DATA_FRAME_STREAM_MEDIA_TYPE,
  decodeDataFrameStream,
  encodeDataFrameStream,
  encodeManagedRestoreControl,
} from "@humansandmachines/gsv/protocol/data-frame-stream";

vi.mock("agents", () => ({ getAgentByName: vi.fn() }));

const mockedGetAgentByName = vi.mocked(getAgentByName);

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function envWithToken(token = "admin-token"): Promise<Env> {
  return {
    GSV_MANAGED_ADMIN_TOKEN_HASH: await sha256Hex(token),
    RIPGIT: managedRipgit([]),
  } as unknown as Env;
}

function context(): ExecutionContext {
  return {} as ExecutionContext;
}

describe("managed HTTP boundary", () => {
  beforeEach(() => {
    mockedGetAgentByName.mockReset();
  });

  it("reserves only the versioned managed prefix", () => {
    expect(isManagedRoute("/__gsv/managed/v1/health")).toBe(true);
    expect(isManagedRoute("/__gsv/managed/v1-old/health")).toBe(false);
  });

  it("keeps every managed route unpublished for self-hosted deployments", async () => {
    const response = await handleManagedRequest(
      new Request("https://gateway.test/__gsv/managed/v1/health"),
      {} as Env,
      context(),
    );
    expect(response.status).toBe(404);
  });

  it("authenticates before health or route dispatch", async () => {
    const env = await envWithToken();
    for (const path of ["health", "unknown"]) {
      const response = await handleManagedRequest(
        new Request(`https://gateway.test/__gsv/managed/v1/${path}`, {
          headers: { authorization: "Bearer wrong" },
        }),
        env,
        context(),
      );
      expect(response.status).toBe(403);
      await expect(response.text()).resolves.toBe("Forbidden");
    }
  });

  it("serves authenticated health with no-store headers", async () => {
    const response = await handleManagedRequest(
      new Request("https://gateway.test/__gsv/managed/v1/health", {
        headers: { authorization: "Bearer admin-token" },
      }),
      await envWithToken(),
      context(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ status: "healthy" });
  });

  it.each(["health", "status", "export"])(
    "cancels an unexpected body on authenticated GET /%s",
    async (route) => {
      const cancel = vi.fn();
      mockedGetAgentByName.mockResolvedValue({
        managedStatus: vi.fn(async () => ({
          setupMode: true,
          processes: 0,
          appRunners: 0,
          adapters: { whatsapp: 0, discord: 0, telegram: 0 },
          lifecycle: "active",
        })),
      } as never);
      const request = {
        url: `https://gateway.test/__gsv/managed/v1/${route}`,
        method: "GET",
        headers: new Headers({ authorization: "Bearer admin-token" }),
        body: new ReadableStream({ cancel }),
      } as Request;

      const response = await handleManagedRequest(
        request,
        { ...await envWithToken(), KERNEL: {} } as unknown as Env,
        context(),
      );

      expect(response.status).toBe(route === "export" ? 501 : 200);
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("acknowledges the exact setup-token policy persisted by the Kernel", async () => {
    const policy = {
      version: 3,
      hash: "c".repeat(64),
      expiresAt: 2_000_000_001_000,
    };
    const installManagedSetupTokenPolicy = vi.fn(() => ({
      ok: true as const,
      disposition: "installed" as const,
      policy,
    }));
    mockedGetAgentByName.mockResolvedValue({ installManagedSetupTokenPolicy } as never);
    const env = { ...await envWithToken(), KERNEL: {} } as unknown as Env;

    const response = await handleManagedRequest(new Request(
      "https://gateway.test/__gsv/managed/v1/setup-token-policy",
      {
        method: "POST",
        headers: {
          authorization: "Bearer admin-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(policy),
      },
    ), env, context());

    expect(response.status).toBe(200);
    expect(installManagedSetupTokenPolicy).toHaveBeenCalledWith(policy);
    await expect(response.json()).resolves.toEqual({
      status: "installed",
      policy,
    });
  });

  it("returns 409 for a stale policy without reporting an acknowledgement", async () => {
    mockedGetAgentByName.mockResolvedValue({
      installManagedSetupTokenPolicy: vi.fn(() => ({
        ok: false,
        reason: "stale_version",
        currentVersion: 3,
      })),
    } as never);
    const env = { ...await envWithToken(), KERNEL: {} } as unknown as Env;

    const response = await handleManagedRequest(new Request(
      "https://gateway.test/__gsv/managed/v1/setup-token-policy",
      {
        method: "POST",
        headers: {
          authorization: "Bearer admin-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          version: 2,
          hash: "b".repeat(64),
          expiresAt: 2_000_000_000_000,
        }),
      },
    ), env, context());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "stale_version",
      currentVersion: 3,
    });
  });

  it("rejects malformed setup-token policy bodies at the private boundary", async () => {
    const response = await handleManagedRequest(new Request(
      "https://gateway.test/__gsv/managed/v1/setup-token-policy",
      {
        method: "POST",
        headers: {
          authorization: "Bearer admin-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ version: 1, hash: "not-a-hash", expiresAt: 1 }),
      },
    ), await envWithToken(), context());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_setup_token_policy" });
    expect(mockedGetAgentByName).not.toHaveBeenCalled();
  });

  it("cancels rejected restore bodies instead of leaking their stream", async () => {
    const cancel = vi.fn();
    const request = new Request("https://gateway.test/__gsv/managed/v1/restore", {
      method: "POST",
      headers: { authorization: "Bearer admin-token" },
      body: new ReadableStream({ cancel }),
      duplex: "half",
    } as RequestInit);
    const response = await handleManagedRequest(request, await envWithToken(), context());
    expect(response.status).toBe(501);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("keeps snapshot identity in a bounded POST body and streams raw records", async () => {
    const providerId = "2".repeat(64);
    const logicalName = "private-process-name";
    const record = {
      kind: "do.kv",
      objectId: "archive-process-1",
      part: 0,
      bodyMediaType: "application/json",
      body: new TextEncoder().encode("{}"),
    };
    const managedSnapshot = vi.fn(async () => encodeDataFrameStream([record]));
    mockedGetAgentByName.mockResolvedValue({ managedSnapshot } as never);
    const namespace = {
      idFromName: vi.fn(() => ({ toString: () => providerId })),
      idFromString: vi.fn(() => ({ toString: () => providerId })),
    };
    const env = {
      ...await envWithToken(),
      PROCESS: namespace,
    } as unknown as Env;
    const input = {
      component: "gateway",
      kind: "process",
      providerId,
      logicalName,
      objectId: record.objectId,
      fenceEpoch: 3,
    };

    const response = await handleManagedRequest(new Request(
      "https://gateway.test/__gsv/managed/v1/objects/snapshot",
      {
        method: "POST",
        headers: {
          authorization: "Bearer admin-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      },
    ), env, context());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(DATA_FRAME_STREAM_MEDIA_TYPE);
    expect(managedSnapshot).toHaveBeenCalledWith(input);
    const records = [];
    for await (const value of decodeDataFrameStream(response.body!)) records.push(value);
    expect(records).toEqual([record]);
  });

  it("strips and validates restore control before transferring archive data", async () => {
    const providerId = "3".repeat(64);
    const control = {
      component: "gateway" as const,
      kind: "process" as const,
      logicalName: "restored-private-process",
      objectId: "archive-process-2",
      restoreId: "restore-process-2",
      fenceEpoch: 1,
      frameCount: "1",
      bodyBytes: "2",
      semanticSha256: "A".repeat(43),
    };
    const data = {
      kind: "do.kv",
      objectId: control.objectId,
      part: 0,
      bodyMediaType: "application/json",
      body: new TextEncoder().encode("{}"),
    };
    const managedRestore = vi.fn(async (_control, stream: ReadableStream<Uint8Array>) => {
      const records = [];
      for await (const value of decodeDataFrameStream(stream)) records.push(value);
      expect(records).toEqual([data]);
      return {
        status: "applied",
        providerId,
        frameCount: control.frameCount,
        bodyBytes: control.bodyBytes,
        semanticSha256: control.semanticSha256,
      };
    });
    mockedGetAgentByName.mockResolvedValue({ managedRestore } as never);
    const env = {
      ...await envWithToken(),
      PROCESS: {
        idFromName: () => ({ toString: () => providerId }),
      },
    } as unknown as Env;

    const response = await handleManagedRequest(new Request(
      "https://gateway.test/__gsv/managed/v1/objects/restore",
      {
        method: "POST",
        headers: {
          authorization: "Bearer admin-token",
          "content-type": DATA_FRAME_STREAM_MEDIA_TYPE,
        },
        body: encodeDataFrameStream([encodeManagedRestoreControl(control), data]),
        duplex: "half",
      } as RequestInit,
    ), env, context());

    expect(response.status).toBe(200);
    expect(managedRestore).toHaveBeenCalledOnce();
    expect(managedRestore.mock.calls[0]?.[0]).toEqual(control);
    await expect(response.json()).resolves.toEqual({
      status: "applied",
      providerId,
      frameCount: "1",
      bodyBytes: "2",
      semanticSha256: "A".repeat(43),
    });
  });

  it("rejects logged URL metadata and infrastructure snapshot kinds", async () => {
    const env = await envWithToken();
    const withQuery = await handleManagedRequest(new Request(
      "https://gateway.test/__gsv/managed/v1/objects/snapshot?logicalName=private",
      {
        method: "POST",
        headers: {
          authorization: "Bearer admin-token",
          "content-type": "application/json",
        },
        body: "{}",
      },
    ), env, context());
    expect(withQuery.status).toBe(400);
    await expect(withQuery.json()).resolves.toEqual({
      error: "managed_metadata_must_not_be_in_url",
    });

    const infrastructure = await handleManagedRequest(new Request(
      "https://gateway.test/__gsv/managed/v1/objects/snapshot",
      {
        method: "POST",
        headers: {
          authorization: "Bearer admin-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          component: "telegram",
          kind: "adapter_admission",
          providerId: "4".repeat(64),
          logicalName: "singleton",
          objectId: "gate",
          fenceEpoch: 1,
        }),
      },
    ), env, context());
    expect(infrastructure.status).toBe(400);
    await expect(infrastructure.json()).resolves.toEqual({ error: "invalid_snapshot_request" });
  });

  it("describes every requested provider ID including uninitialized objects", async () => {
    const providerId = "a".repeat(64);
    const id = { toString: () => providerId };
    const processNamespace = {
      idFromString: vi.fn(() => id),
      idFromName: vi.fn(),
      get: vi.fn(() => ({
        managedDescriptor: async () => ({
          schemaVersion: 1,
          kind: "process",
          providerId,
          logicalName: null,
          classification: "uninitialized",
          lifecycle: { status: "uninitialized", epoch: 0 },
        }),
      })),
    };
    const env = {
      ...await envWithToken(),
      PROCESS: processNamespace,
    } as unknown as Env;

    const response = await handleManagedRequest(new Request(
      "https://gateway.test/__gsv/managed/v1/objects/describe",
      {
        method: "POST",
        headers: {
          authorization: "Bearer admin-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          component: "gateway",
          kind: "process",
          providerIds: [providerId],
        }),
      },
    ), env, context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      schemaVersion: 1,
      kind: "process",
      objects: [{
        schemaVersion: 1,
        kind: "process",
        providerId,
        logicalName: null,
        classification: "uninitialized",
        lifecycle: { status: "uninitialized", epoch: 0 },
      }],
    });
    expect(processNamespace.idFromName).not.toHaveBeenCalled();
  });

  it("fails closed when a descriptor logical name does not reproduce its provider ID", async () => {
    const providerId = "b".repeat(64);
    const env = {
      ...await envWithToken(),
      PROCESS: {
        idFromString: () => ({ toString: () => providerId }),
        idFromName: () => ({ toString: () => "c".repeat(64) }),
        get: () => ({
          managedDescriptor: async () => ({
            schemaVersion: 1,
            kind: "process",
            providerId,
            logicalName: "process-1",
            classification: "initialized",
            lifecycle: { status: "active", epoch: 0 },
          }),
        }),
      },
    } as unknown as Env;

    const response = await handleManagedRequest(new Request(
      "https://gateway.test/__gsv/managed/v1/objects/describe",
      {
        method: "POST",
        headers: {
          authorization: "Bearer admin-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          component: "gateway",
          kind: "process",
          providerIds: [providerId],
        }),
      },
    ), env, context());

    expect(response.status).toBe(500);
  });

  it("routes adapter provider inventory through its static service binding", async () => {
    const providerId = "d".repeat(64);
    const managedDescribeObjects = vi.fn(async () => ({
      schemaVersion: 1 as const,
      kind: "adapter_admission" as const,
      objects: [{
        schemaVersion: 1 as const,
        kind: "adapter_admission" as const,
        providerId,
        logicalName: "singleton",
        classification: "initialized" as const,
        lifecycle: { status: "active" as const, epoch: 2 },
      }],
    }));
    const env = {
      ...await envWithToken(),
      CHANNEL_TELEGRAM: { managedDescribeObjects },
    } as unknown as Env;

    const response = await handleManagedRequest(new Request(
      "https://gateway.test/__gsv/managed/v1/objects/describe",
      {
        method: "POST",
        headers: {
          authorization: "Bearer admin-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          component: "telegram",
          kind: "adapter_admission",
          providerIds: [providerId],
        }),
      },
    ), env, context());

    expect(response.status).toBe(200);
    expect(managedDescribeObjects).toHaveBeenCalledWith({
      kind: "adapter_admission",
      providerIds: [providerId],
    });
    await expect(response.json()).resolves.toMatchObject({
      kind: "adapter_admission",
      objects: [{ providerId, logicalName: "singleton" }],
    });
  });

  it("rejects an adapter descriptor batch that omits or substitutes a provider ID", async () => {
    const providerId = "e".repeat(64);
    const env = {
      ...await envWithToken(),
      CHANNEL_DISCORD: {
        managedDescribeObjects: async () => ({
          schemaVersion: 1,
          kind: "adapter_account",
          objects: [{
            schemaVersion: 1,
            kind: "adapter_account",
            providerId: "f".repeat(64),
            logicalName: null,
            classification: "uninitialized",
            lifecycle: { status: "uninitialized", epoch: 0 },
          }],
        }),
      },
    } as unknown as Env;

    const response = await handleManagedRequest(new Request(
      "https://gateway.test/__gsv/managed/v1/objects/describe",
      {
        method: "POST",
        headers: {
          authorization: "Bearer admin-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          component: "discord",
          kind: "adapter_account",
          providerIds: [providerId],
        }),
      },
    ), env, context());

    expect(response.status).toBe(500);
  });

  it("forwards ripgit inventory with managed authorization and revalidates it", async () => {
    const providerId = "1".repeat(64);
    const fetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe(
        "/__gsv/managed/v1/ripgit/objects/describe",
      );
      expect(request.headers.get("authorization")).toBe("Bearer admin-token");
      await expect(request.json()).resolves.toEqual({
        kind: "repository",
        providerIds: [providerId],
      });
      return Response.json({
        schemaVersion: 1,
        kind: "repository",
        objects: [{
          schemaVersion: 1,
          kind: "repository",
          providerId,
          logicalName: "1000/notes",
          classification: "initialized",
          lifecycle: { status: "active", epoch: 0 },
        }],
      });
    });
    const env = {
      ...await envWithToken(),
      RIPGIT: { fetch },
    } as unknown as Env;

    const response = await handleManagedRequest(new Request(
      "https://gateway.test/__gsv/managed/v1/objects/describe",
      {
        method: "POST",
        headers: {
          authorization: "Bearer admin-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          component: "ripgit",
          kind: "repository",
          providerIds: [providerId],
        }),
      },
    ), env, context());

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
    await expect(response.json()).resolves.toMatchObject({
      kind: "repository",
      objects: [{ providerId, logicalName: "1000/notes" }],
    });
  });

  it("does not fence the Kernel when an adapter gate cannot drain", async () => {
    const failedGate = {
      ...managedAdapter("whatsapp", []),
      managedFenceAll: async () => ({
        status: "fenced" as const,
        epoch: 1,
        drained: false,
      }),
    };
    const env = {
      ...await envWithToken(),
      KERNEL: {},
      CHANNEL_WHATSAPP: failedGate,
      CHANNEL_DISCORD: managedAdapter("discord", []),
      CHANNEL_TELEGRAM: managedAdapter("telegram", []),
    } as unknown as Env;

    const response = await handleManagedRequest(new Request(
      "https://gateway.test/__gsv/managed/v1/update/fence",
      { method: "POST", headers: { authorization: "Bearer admin-token" } },
    ), env, context());

    expect(response.status).toBe(500);
    expect(mockedGetAgentByName).not.toHaveBeenCalled();
  });

  it("cancels a failed ripgit fence response before touching the Kernel", async () => {
    const cancel = vi.fn();
    const env = {
      ...await envWithToken(),
      KERNEL: {},
      CHANNEL_WHATSAPP: managedAdapter("whatsapp", []),
      CHANNEL_DISCORD: managedAdapter("discord", []),
      CHANNEL_TELEGRAM: managedAdapter("telegram", []),
      RIPGIT: {
        async fetch() {
          return new Response(new ReadableStream({ cancel }), { status: 503 });
        },
      },
    } as unknown as Env;

    const response = await handleManagedRequest(new Request(
      "https://gateway.test/__gsv/managed/v1/update/fence",
      { method: "POST", headers: { authorization: "Bearer admin-token" } },
    ), env, context());

    expect(response.status).toBe(500);
    expect(cancel).toHaveBeenCalledOnce();
    expect(mockedGetAgentByName).not.toHaveBeenCalled();
  });

  it("fences the Kernel before pausing every registered runtime object", async () => {
    const calls: string[] = [];
    const kernel = {
      async managedPrepareUpdate() {
        calls.push("kernel:fence");
        return {
          processIds: ["proc-1"],
          appRunnerNames: ["app-1"],
          adapters: { whatsapp: ["wa-1"], discord: ["dc-1"], telegram: [] },
        };
      },
    };
    const process = { async managedPause() { calls.push("process:pause"); } };
    const runner = { async managedPause() { calls.push("app:pause"); } };
    const env = {
      ...await envWithToken(),
      KERNEL: {},
      PROCESS: {},
      APP_RUNNER: { getByName: () => runner },
      CHANNEL_WHATSAPP: managedAdapter("whatsapp", calls),
      CHANNEL_DISCORD: managedAdapter("discord", calls),
      CHANNEL_TELEGRAM: managedAdapter("telegram", calls),
      RIPGIT: managedRipgit(calls),
    } as unknown as Env;
    mockedGetAgentByName.mockImplementation(async (namespace) => (
      namespace === env.KERNEL ? kernel : process
    ) as never);
    const response = await handleManagedRequest(new Request(
      "https://gateway.test/__gsv/managed/v1/update/fence",
      { method: "POST", headers: { authorization: "Bearer admin-token" } },
    ), env, context());

    expect(response.status).toBe(200);
    expect(calls).toEqual([
      "whatsapp:gate:fence",
      "discord:gate:fence",
      "telegram:gate:fence",
      "ripgit:pause:null",
      "kernel:fence",
      "whatsapp:pause:wa-1",
      "discord:pause:dc-1",
      "telegram:pause:",
      "process:pause",
      "app:pause",
    ]);
    await expect(response.json()).resolves.toEqual({
      status: "fenced",
      processes: 1,
      appRunners: 1,
      adapters: { whatsapp: 1, discord: 1, telegram: 0 },
      ripgit: { status: "paused" },
    });
  });

  it("chunks large adapter inventories and reports the full deduplicated count", async () => {
    const accountIds = Array.from(
      { length: 2_005 },
      (_, index) => `wa-${String(2_004 - index).padStart(4, "0")}`,
    );
    const whatsappBatches: string[][] = [];
    const whatsapp = {
      ...managedAdapter("whatsapp", []),
      async managedPause(batch: string[]) {
        whatsappBatches.push(batch);
        return { accountIds: batch };
      },
    };
    const kernel = {
      async managedPrepareUpdate() {
        return {
          processIds: [],
          appRunnerNames: [],
          adapters: {
            whatsapp: [...accountIds, accountIds[0], accountIds[1]],
            discord: [],
            telegram: [],
          },
        };
      },
    };
    const env = {
      ...await envWithToken(),
      KERNEL: {},
      PROCESS: {},
      APP_RUNNER: { getByName: () => { throw new Error("unexpected app runner"); } },
      CHANNEL_WHATSAPP: whatsapp,
      CHANNEL_DISCORD: managedAdapter("discord", []),
      CHANNEL_TELEGRAM: managedAdapter("telegram", []),
    } as unknown as Env;
    mockedGetAgentByName.mockResolvedValue(kernel as never);

    const response = await handleManagedRequest(new Request(
      "https://gateway.test/__gsv/managed/v1/update/fence",
      { method: "POST", headers: { authorization: "Bearer admin-token" } },
    ), env, context());

    expect(response.status).toBe(200);
    expect(whatsappBatches.map((batch) => batch.length)).toEqual([1_000, 1_000, 5]);
    expect(whatsappBatches.flat()).toEqual([...new Set(accountIds)].sort());
    await expect(response.json()).resolves.toMatchObject({
      adapters: { whatsapp: 2_005, discord: 0, telegram: 0 },
    });
  });

  it("fails closed when any adapter lifecycle batch is not acknowledged exactly", async () => {
    const accountIds = Array.from(
      { length: 1_001 },
      (_, index) => `wa-${String(index).padStart(4, "0")}`,
    );
    const managedPause = vi.fn(async (batch: string[]) => ({
      accountIds: batch.length === 1_000 ? batch : [],
    }));
    const kernel = {
      async managedPrepareUpdate() {
        return {
          processIds: [],
          appRunnerNames: [],
          adapters: { whatsapp: accountIds, discord: [], telegram: [] },
        };
      },
    };
    const env = {
      ...await envWithToken(),
      KERNEL: {},
      PROCESS: {},
      APP_RUNNER: { getByName: () => { throw new Error("unexpected app runner"); } },
      CHANNEL_WHATSAPP: { ...managedAdapter("whatsapp", []), managedPause },
      CHANNEL_DISCORD: managedAdapter("discord", []),
      CHANNEL_TELEGRAM: managedAdapter("telegram", []),
    } as unknown as Env;
    mockedGetAgentByName.mockResolvedValue(kernel as never);

    const response = await handleManagedRequest(new Request(
      "https://gateway.test/__gsv/managed/v1/update/fence",
      { method: "POST", headers: { authorization: "Bearer admin-token" } },
    ), env, context());

    expect(response.status).toBe(500);
    expect(managedPause).toHaveBeenCalledTimes(2);
    await expect(response.text()).resolves.toBe("Managed request failed");
  });

  it("normalizes resume retries and activates Kernel work after child runtimes", async () => {
    const calls: string[] = [];
    const kernel = {
      async managedPrepareUpdate() {
        calls.push("kernel:fence");
        return {
          processIds: ["proc-1"],
          appRunnerNames: ["app-1"],
          adapters: { whatsapp: ["wa-1"], discord: ["dc-1"], telegram: [] },
        };
      },
      async managedResumeUpdate() { calls.push("kernel:resume"); },
      async managedActivate() { calls.push("kernel:activate"); },
    };
    const process = {
      async managedPause() { calls.push("process:pause"); },
      async managedResume() { calls.push("process:resume"); },
      async managedActivate() { calls.push("process:activate"); },
    };
    const runner = {
      async managedPause() { calls.push("app:pause"); },
      async managedResume() { calls.push("app:resume"); },
      async managedActivate() { calls.push("app:activate"); },
    };
    const env = {
      ...await envWithToken(),
      KERNEL: {},
      PROCESS: {},
      APP_RUNNER: { getByName: () => runner },
      CHANNEL_WHATSAPP: managedAdapter("whatsapp", calls),
      CHANNEL_DISCORD: managedAdapter("discord", calls),
      CHANNEL_TELEGRAM: managedAdapter("telegram", calls),
      RIPGIT: managedRipgit(calls),
    } as unknown as Env;
    mockedGetAgentByName.mockImplementation(async (namespace) => (
      namespace === env.KERNEL ? kernel : process
    ) as never);
    const response = await handleManagedRequest(new Request(
      "https://gateway.test/__gsv/managed/v1/update/resume",
      { method: "POST", headers: { authorization: "Bearer admin-token" } },
    ), env, context());

    expect(response.status).toBe(200);
    expect(calls).toEqual([
      "whatsapp:gate:fence",
      "discord:gate:fence",
      "telegram:gate:fence",
      "ripgit:pause:null",
      "kernel:fence",
      "process:pause",
      "app:pause",
      "whatsapp:pause:wa-1",
      "discord:pause:dc-1",
      "telegram:pause:",
      "process:resume",
      "app:resume",
      "kernel:resume",
      "process:activate",
      "app:activate",
      "ripgit:resume:null",
      "kernel:activate",
      "whatsapp:resume:wa-1",
      "discord:resume:dc-1",
      "telegram:resume:",
      "whatsapp:gate:resume",
      "discord:gate:resume",
      "telegram:gate:resume",
    ]);
    await expect(response.json()).resolves.toMatchObject({
      ripgit: { status: "active" },
    });
  });

  it("erases every paginated ripgit repository before terminal tenant teardown", async () => {
    const calls: string[] = [];
    const kernel = {
      async managedPrepareErase() {
        calls.push("kernel:fence-erase");
        return {
          processIds: ["proc-1"],
          appRunnerNames: ["app-1"],
          adapters: { whatsapp: ["wa-1"], discord: [], telegram: [] },
        };
      },
      async managedErase() { calls.push("kernel:erase"); },
    };
    const process = { async managedErase() { calls.push("process:erase"); } };
    const runner = { async managedErase() { calls.push("app:erase"); } };
    const cursor = "a".repeat(64);
    const ripgit = {
      async fetch(request: Request) {
        expect(request.headers.get("authorization")).toBe("Bearer admin-token");
        const body = await request.json() as { cursor: string | null; limit: number };
        calls.push(`ripgit:erase:${body.cursor ?? "null"}`);
        expect(body.limit).toBe(100);
        if (body.cursor === null) {
          return Response.json({
            gate: { status: "paused", epoch: 4 },
            erasure: { status: "erasing", epoch: 4 },
            erasedRepositories: [{ identity: { providerId: cursor } }],
            nextCursor: cursor,
            remainingRepositories: 1,
          });
        }
        expect(body.cursor).toBe(cursor);
        return Response.json({
          gate: { status: "paused", epoch: 4 },
          erasure: { status: "erased", epoch: 4 },
          erasedRepositories: [{ identity: { providerId: "b".repeat(64) } }],
          nextCursor: null,
          remainingRepositories: 0,
        });
      },
    };
    let r2Page = 0;
    const env = {
      ...await envWithToken(),
      KERNEL: {},
      PROCESS: {},
      APP_RUNNER: { getByName: () => runner },
      CHANNEL_WHATSAPP: managedAdapter("whatsapp", calls),
      CHANNEL_DISCORD: managedAdapter("discord", calls),
      CHANNEL_TELEGRAM: managedAdapter("telegram", calls),
      RIPGIT: ripgit,
      STORAGE: {
        async list() {
          r2Page += 1;
          return { objects: r2Page === 1 ? [{ key: "tenant/object" }] : [] };
        },
        async delete(keys: string[]) { calls.push(`r2:erase:${keys.join(",")}`); },
      },
    } as unknown as Env;
    mockedGetAgentByName.mockImplementation(async (namespace) => (
      namespace === env.KERNEL ? kernel : process
    ) as never);

    const response = await handleManagedRequest(new Request(
      "https://gateway.test/__gsv/managed/v1/erase",
      { method: "DELETE", headers: { authorization: "Bearer admin-token" } },
    ), env, context());

    expect(response.status).toBe(200);
    expect(calls).toEqual([
      "whatsapp:gate:fence",
      "discord:gate:fence",
      "telegram:gate:fence",
      "kernel:fence-erase",
      "ripgit:erase:null",
      `ripgit:erase:${cursor}`,
      "process:erase",
      "app:erase",
      "whatsapp:erase:wa-1",
      "discord:erase:",
      "telegram:erase:",
      "whatsapp:gate:erase",
      "discord:gate:erase",
      "telegram:gate:erase",
      "r2:erase:tenant/object",
      "kernel:erase",
    ]);
    await expect(response.json()).resolves.toEqual({
      status: "erased",
      processes: 1,
      appRunners: 1,
      adapters: { whatsapp: 1, discord: 0, telegram: 0 },
      ripgit: { status: "erased", repositories: 0 },
      objects: 1,
    });
  });
});

function managedAdapter(name: string, calls: string[]) {
  const run = async (operation: string, accountIds: string[]) => {
    calls.push(`${name}:${operation}:${accountIds.join(",")}`);
    return { accountIds };
  };
  return {
    managedPause: (accountIds: string[]) => run("pause", accountIds),
    managedResume: (accountIds: string[]) => run("resume", accountIds),
    managedErase: (accountIds: string[]) => run("erase", accountIds),
    managedFenceAll: async () => {
      calls.push(`${name}:gate:fence`);
      return { status: "fenced" as const, epoch: 1, drained: true };
    },
    managedResumeAll: async () => {
      calls.push(`${name}:gate:resume`);
      return { status: "active" as const, epoch: 2 };
    },
    managedEraseAll: async () => {
      calls.push(`${name}:gate:erase`);
      return { status: "erased" as const, epoch: 2, drained: true as const };
    },
  };
}

function managedRipgit(calls: string[]): Fetcher {
  return {
    async fetch(request: Request) {
      const operation = new URL(request.url).pathname.split("/").at(-1);
      const body = await request.json() as { cursor: string | null };
      calls.push(`ripgit:${operation}:${body.cursor ?? "null"}`);
      if (operation === "erase") {
        return Response.json({
          gate: { status: "paused", epoch: 1 },
          erasure: { status: "erased", epoch: 1 },
          erasedRepositories: [],
          nextCursor: null,
          remainingRepositories: 0,
        });
      }
      return Response.json({
        gate: { status: operation === "resume" ? "active" : "paused", epoch: 1 },
        erasure: { status: "ready", epoch: 0 },
        pendingRepositories: 0,
        repositories: [],
        nextCursor: null,
      });
    },
  } as Fetcher;
}
