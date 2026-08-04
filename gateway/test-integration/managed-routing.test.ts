import type {
  AdapterGatewayRequestFrame,
  AdapterGatewayResponseFrame,
} from "@humansandmachines/gsv/protocol";
import type { TestHarness } from "wrangler";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createManagedGatewayTestHarness } from "./harness";
import { expectManagedRpc, expectManagedRpcOk } from "./managed-rpc";

describe("managed installation routing integration", () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = createManagedGatewayTestHarness();
    await harness.listen();
  });

  afterEach(async () => {
    await harness.reset();
  });

  afterAll(async () => {
    await harness.close();
  });

  it("returns 404 for an unknown wildcard hostname", async () => {
    const response = await harness.getWorker("gsv-managed").fetch(
      "https://random.gsv.space/.well-known/oauth-client/gsv.json",
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
  });

  it("does not expose public installation storage for an unknown hostname", async () => {
    const response = await harness.getWorker("gsv-managed").fetch(
      "https://random.gsv.space/public/private-by-default.txt",
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
  });

  it("uses the directory's persisted canonical origin", async () => {
    const response = await harness.getWorker("gsv-managed").fetch(
      "https://first.gsv.space/.well-known/oauth-client/gsv.json",
    );
    const metadata = await response.json() as {
      client_id: string;
      redirect_uris: string[];
    };

    expect(response.status).toBe(200);
    expect(metadata.client_id).toBe(
      "https://first.gsv.space/.well-known/oauth-client/gsv.json",
    );
    expect(metadata.redirect_uris).toEqual([
      "https://first.gsv.space/oauth/callback",
    ]);
  });

  it("routes two accepted hostnames to independently initialized Kernels", async () => {
    for (const handle of ["first", "second"]) {
      const response = await harness.getWorker("gsv-managed").fetch(
        `https://${handle}.gsv.space/ws`,
        {
          headers: { Upgrade: "websocket" },
        },
      );
      expect(response.status).toBe(101);
      response.webSocket?.accept();
      response.webSocket?.close(1000, "test complete");
    }
  });

  it("rejects public setup for an uninitialized managed Kernel", async () => {
    const response = await harness.getWorker("gsv-managed").fetch(
      "https://first.gsv.space/ws",
      { headers: { Upgrade: "websocket" } },
    );
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new Error("No managed WebSocket");
    socket.accept();

    const setup = await expectManagedRpc(
      socket,
      "public-managed-setup",
      "sys.setup",
      { username: "attacker", password: "attacker-password" },
    );
    expect(setup).toMatchObject({
      ok: false,
      error: {
        code: 403,
        message: "Public setup is disabled for managed installations",
      },
    });
    socket.close(1000, "test complete");
  });

  it("exchanges a one-time host handoff for a managed browser session", async () => {
    await provisionManagedInstallation(harness, "first");
    const cookie = await exchangeManagedHandoff(harness, "first");

    const replay = await harness.getWorker("gsv-managed").fetch(
      "https://first.gsv.space/auth/handoff",
      {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://accounts.gsv.space",
        },
        body: new URLSearchParams({ token: "test-handoff:first" }).toString(),
      },
    );
    expect(replay.status).toBe(401);

    const socketResponse = await harness.getWorker("gsv-managed").fetch(
      "https://first.gsv.space/ws",
      {
        headers: {
          Upgrade: "websocket",
          Cookie: cookie,
        },
      },
    );
    expect(socketResponse.status).toBe(101);
    const socket = socketResponse.webSocket;
    if (!socket) throw new Error("No managed WebSocket");
    socket.accept();

    await expectManagedRpcOk(socket, "managed-session-connect", "sys.connect", {
      protocol: 2,
      client: {
        id: "managed-first",
        version: "1.0.0",
        platform: "test",
        role: "user",
      },
    });
    socket.close(1000, "test complete");
  });

  it("revokes a managed browser session on same-origin logout", async () => {
    await provisionManagedInstallation(harness, "first");
    const cookie = await exchangeManagedHandoff(harness, "first");
    const worker = harness.getWorker("gsv-managed");

    const logout = await worker.fetch("https://first.gsv.space/auth/logout", {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: "https://first.gsv.space",
      },
    });
    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");

    const socketResponse = await worker.fetch("https://first.gsv.space/ws", {
      headers: {
        Upgrade: "websocket",
        Cookie: cookie,
      },
    });
    expect(socketResponse.status).toBe(101);
    const socket = socketResponse.webSocket;
    if (!socket) throw new Error("No managed WebSocket");
    socket.accept();

    const connect = await expectManagedRpc(
      socket,
      "revoked-managed-session",
      "sys.connect",
      {
        protocol: 2,
        client: {
          id: "managed-first",
          version: "1.0.0",
          platform: "test",
          role: "user",
        },
      },
    );
    expect(connect).toMatchObject({
      ok: false,
      error: { code: 401, message: "Authentication required" },
    });
    socket.close(1000, "test complete");
  });

  it("routes trusted adapter RPC to its managed installation", async () => {
    const frame: AdapterGatewayRequestFrame = {
      type: "req",
      id: "managed-adapter-first",
      call: "adapter.inbound",
      args: {
        adapter: "telegram",
        accountId: "managed",
        deliveryId: "managed-adapter-first",
        message: {
          messageId: "managed-adapter-first",
          surface: { kind: "dm", id: "telegram:1" },
          actor: { id: "telegram:user:1" },
          text: "hello",
        },
      },
    };

    const response = await sendAdapterServiceFrame(
      harness,
      "inst_integration_first",
      frame,
    );

    expect(response).toMatchObject({
      type: "res",
      id: frame.id,
      ok: false,
      error: {
        code: 503,
        message: "Service identity is not configured",
      },
    });
  });

  it("rejects the standalone compatibility identity on the managed entrypoint", async () => {
    const response = await sendAdapterServiceFrame(harness, "singleton", {
      type: "req",
      id: "managed-adapter-singleton",
      call: "adapter.state.update",
      args: {},
    });

    expect(response).toBeNull();
  });

  it("carries installation identity through outbound adapter RPC", async () => {
    const deliveryId = "same-logical-delivery";
    for (const handle of ["first", "second"] as const) {
      await provisionManagedInstallation(harness, handle);
      const frame: AdapterGatewayRequestFrame = {
        type: "req",
        id: `send-${handle}`,
        call: "adapter.send",
        args: {
          adapter: "telegram",
          accountId: "shared-account",
          deliveryId,
          surface: { kind: "dm", id: "same-provider-peer" },
          text: `from ${handle}`,
        },
      };
      const response = await sendAdapterServiceFrame(
        harness,
        `inst_integration_${handle}`,
        frame,
      );
      expect(response).toMatchObject({
        type: "res",
        id: frame.id,
        ok: true,
        data: {
          ok: true,
          deliveryId,
          deliveryState: "sent",
        },
      });
    }

    for (const handle of ["first", "second"] as const) {
      const installationId = `inst_integration_${handle}`;
      const response = await harness.getWorker("gsv-test-dependencies").fetch(
        `http://gsv-test-dependencies/__test/outbound?installationId=${installationId}&accountId=shared-account`,
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual([{
        installationId,
        accountId: "shared-account",
        message: expect.objectContaining({
          deliveryId,
          text: `from ${handle}`,
        }),
      }]);
    }
  });
});

async function provisionManagedInstallation(
  harness: TestHarness,
  handle: "first" | "second",
): Promise<void> {
  const response = await harness.getWorker("gsv-test-dependencies").fetch(
    "http://gsv-test-dependencies/__test/provision",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operationId: `op_integration_${handle}`,
        installation: {
          installationId: `inst_integration_${handle}`,
          handle,
          canonicalOrigin: `https://${handle}.gsv.space`,
        },
        owner: {
          principalId: `principal_integration_${handle}`,
          username: `${handle}-owner`,
          agentName: `${handle}-agent`,
          timezone: "Europe/Amsterdam",
        },
        provisionVersion: 1,
      }),
    },
  );
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    state: "active",
    installationId: `inst_integration_${handle}`,
    principalId: `principal_integration_${handle}`,
    localUid: 1000,
  });
}

async function exchangeManagedHandoff(
  harness: TestHarness,
  handle: "first" | "second",
): Promise<string> {
  const response = await harness.getWorker("gsv-managed").fetch(
    `https://${handle}.gsv.space/auth/handoff`,
    {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://accounts.gsv.space",
      },
      body: new URLSearchParams({ token: `test-handoff:${handle}` }).toString(),
    },
  );
  expect(response.status, await response.clone().text()).toBe(303);
  expect(response.headers.get("location")).toBe("/");
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).toContain("__Host-gsv-session=");
  expect(setCookie).not.toContain("Domain=");
  if (!setCookie) throw new Error("Managed handoff did not set a cookie");
  return setCookie.split(";", 1)[0];
}

async function sendAdapterServiceFrame(
  harness: TestHarness,
  installationId: string,
  frame: AdapterGatewayRequestFrame,
): Promise<AdapterGatewayResponseFrame | null> {
  const response = await harness.getWorker("gsv-test-dependencies").fetch(
    "http://gsv-test-dependencies/__test/service-frame",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        installation: { installationId },
        frame,
      }),
    },
  );
  expect(response.status).toBe(200);
  return await response.json() as AdapterGatewayResponseFrame | null;
}
