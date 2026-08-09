import type {
  AdapterGatewayRequestFrame,
  AdapterGatewayResponseFrame,
} from "@humansandmachines/gsv/protocol";
import type { TestHarness } from "wrangler";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createManagedGatewayTestHarness } from "./harness";

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

  it("returns 404 for an inactive installation", async () => {
    const response = await harness.getWorker("gsv-managed").fetch(
      "https://suspended.gsv.space/.well-known/oauth-client/gsv.json",
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
  });

  it("does not expose public storage for an unknown hostname", async () => {
    const response = await harness.getWorker("gsv-managed").fetch(
      "https://random.gsv.space/public/private-by-default.txt",
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
  });

  it("serves each installation's public storage namespace", async () => {
    const worker = harness.getWorker<{ STORAGE: R2Bucket }>("gsv-managed");
    const { STORAGE } = await worker.getEnv();
    await Promise.all([
      putPublicAsset(STORAGE, "inst_integration_first", "first"),
      putPublicAsset(STORAGE, "inst_integration_second", "second"),
    ]);

    const first = await worker.fetch("https://first.gsv.space/public/installation.txt");
    const second = await worker.fetch("https://second.gsv.space/public/installation.txt");

    expect(first.status).toBe(200);
    expect(await first.text()).toBe("first");
    expect(second.status).toBe(200);
    expect(await second.text()).toBe("second");
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

  it("retries accounts activation after setup completes locally", async () => {
    await beginProvisioning(harness, "first");
    await failNextOnboardingCompletion(harness, "first", "before-activation");
    const socket = await openManagedSocket(harness, "first");
    const args = {
      username: "first-owner",
      password: "first-owner-password",
      onboardingToken: "integration-onboarding-first",
    };

    await expect(
      managedRpc(socket, "setup-first-attempt", "sys.setup", args),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 503,
        message: "Installation setup could not be activated",
      },
    });
    await expectManagedRpcOk(socket, "setup-first-retry", "sys.setup", args);
    socket.close(1000, "test complete");
  });

  it("recovers when accounts activates before its response is lost", async () => {
    await beginProvisioning(harness, "second");
    await failNextOnboardingCompletion(harness, "second", "after-activation");
    const socket = await openManagedSocket(harness, "second");
    const args = {
      username: "second-owner",
      password: "second-owner-password",
      onboardingToken: "integration-onboarding-second",
    };

    await expect(
      managedRpc(socket, "setup-second-attempt", "sys.setup", args),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 503,
        message: "Installation setup could not be activated",
      },
    });
    await expectManagedRpcOk(socket, "setup-second-retry", "sys.setup", args);
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
    const worker = harness.getWorker("gsv-managed");
    for (const handle of ["first", "second"] as const) {
      const provisioning = await harness.getWorker("gsv-test-dependencies").fetch(
        `http://gsv-test-dependencies/__test/provisioning?handle=${handle}`,
        { method: "POST" },
      );
      expect(provisioning.status).toBe(204);
      const socketResponse = await worker.fetch(`https://${handle}.gsv.space/ws`, {
        headers: { Upgrade: "websocket" },
      });
      expect(socketResponse.status).toBe(101);
      const socket = socketResponse.webSocket;
      if (!socket) throw new Error(`No WebSocket for ${handle}`);
      socket.accept();

      const rootPassword = `root-${handle}-integration`;
      await expectManagedRpcOk(socket, `setup-${handle}`, "sys.setup", {
        username: `${handle}-owner`,
        password: `${handle}-owner-password`,
        rootPassword,
        agentName: `${handle}-agent`,
        timezone: "Europe/Amsterdam",
        onboardingToken: `integration-onboarding-${handle}`,
      });
      await expectManagedRpcOk(socket, `connect-${handle}`, "sys.connect", {
        protocol: 2,
        client: {
          id: `managed-${handle}`,
          version: "1.0.0",
          platform: "test",
          role: "user",
        },
        auth: { username: "root", password: rootPassword },
      });
      await expectManagedRpcOk(socket, `send-${handle}`, "adapter.send", {
        adapter: "telegram",
        accountId: "shared-account",
        deliveryId: "same-logical-delivery",
        surface: { kind: "dm", id: "same-provider-peer" },
        text: `from ${handle}`,
      });
      socket.close(1000, "test complete");
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
          deliveryId: "same-logical-delivery",
          text: `from ${handle}`,
        }),
      }]);
    }
  });
});

type ManagedRpcResponse = {
  type: "res";
  id: string;
  ok: boolean;
  data?: unknown;
  error?: { code?: number; message: string };
};

type HarnessWorker = ReturnType<TestHarness["getWorker"]>;
type HarnessResponse = Awaited<ReturnType<HarnessWorker["fetch"]>>;
type HarnessWebSocket = NonNullable<HarnessResponse["webSocket"]>;

async function expectManagedRpcOk(
  socket: HarnessWebSocket,
  id: string,
  call: string,
  args: unknown,
): Promise<ManagedRpcResponse> {
  const response = await managedRpc(socket, id, call, args);
  expect(response).toMatchObject({ type: "res", id, ok: true });
  return response;
}

async function managedRpc(
  socket: HarnessWebSocket,
  id: string,
  call: string,
  args: unknown,
): Promise<ManagedRpcResponse> {
  const eventSocket = socket as unknown as {
    addEventListener(
      type: "message",
      listener: (event: { data: unknown }) => void,
    ): void;
    removeEventListener(
      type: "message",
      listener: (event: { data: unknown }) => void,
    ): void;
  };
  const responsePromise = new Promise<ManagedRpcResponse>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    const onMessage = (event: { data: unknown }) => {
      if (typeof event.data !== "string") return;
      const frame = JSON.parse(event.data) as ManagedRpcResponse;
      if (frame.type !== "res" || frame.id !== id) return;
      eventSocket.removeEventListener("message", onMessage);
      clearTimeout(timeout);
      resolve(frame);
    };
    eventSocket.addEventListener("message", onMessage);
    timeout = setTimeout(() => {
      eventSocket.removeEventListener("message", onMessage);
      reject(new Error(`Timed out waiting for ${call}`));
    }, 5_000);
  });
  socket.send(JSON.stringify({ type: "req", id, call, args }));
  return await responsePromise;
}

async function beginProvisioning(
  harness: TestHarness,
  handle: "first" | "second",
): Promise<void> {
  const response = await harness.getWorker("gsv-test-dependencies").fetch(
    `http://gsv-test-dependencies/__test/provisioning?handle=${handle}`,
    { method: "POST" },
  );
  expect(response.status).toBe(204);
}

async function failNextOnboardingCompletion(
  harness: TestHarness,
  handle: "first" | "second",
  failure: "before-activation" | "after-activation",
): Promise<void> {
  const response = await harness.getWorker("gsv-test-dependencies").fetch(
    `http://gsv-test-dependencies/__test/onboarding-completion-failure?handle=${handle}&failure=${failure}`,
    { method: "POST" },
  );
  expect(response.status).toBe(204);
}

async function openManagedSocket(
  harness: TestHarness,
  handle: "first" | "second",
): Promise<HarnessWebSocket> {
  const response = await harness.getWorker("gsv-managed").fetch(
    `https://${handle}.gsv.space/ws`,
    { headers: { Upgrade: "websocket" } },
  );
  expect(response.status).toBe(101);
  if (!response.webSocket) throw new Error(`No WebSocket for ${handle}`);
  response.webSocket.accept();
  return response.webSocket;
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

async function putPublicAsset(
  storage: R2Bucket,
  installationId: string,
  content: string,
): Promise<void> {
  await storage.put(
    `installations/${installationId}/public/installation.txt`,
    content,
    {
      httpMetadata: { contentType: "text/plain" },
      customMetadata: { uid: "0", gid: "0", mode: "644" },
    },
  );
}
