import {
  GSV_INFERENCE_FEATURE,
  type AdapterGatewayRequestFrame,
  type AdapterGatewayResponseFrame,
  type JsonObject,
} from "@humansandmachines/gsv/protocol";
import type { IntegrationState } from "./fixtures/dependencies";
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
    // SAFETY: The OAuth metadata endpoint returns this exact discovery contract.
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

  it("derives managed inference identity behind the private service binding", async () => {
    await beginProvisioning(harness, "first");
    const socket = await openManagedSocket(harness, "first");
    await expectManagedRpcOk(socket, "setup-inference", "sys.setup", {
      username: "inference-owner",
      password: "inference-owner-password",
      onboardingToken: "integration-onboarding-first",
    });
    const connect = await expectManagedRpcOk(socket, "connect-inference", "sys.connect", {
      protocol: 3,
      peer: {
        id: "managed-inference-test",
        version: "1.0.0",
        platform: "test",
      },
      auth: {
        username: "inference-owner",
        password: "inference-owner-password",
      },
    });
    expect(connect.data).toMatchObject({
      server: { features: [GSV_INFERENCE_FEATURE] },
    });

    const response = await managedRpc(socket, "generate-managed", "ai.text.generate", {
      messages: [{ role: "user", content: "ping" }],
      config: {
        overrides: {
          "config/ai/provider": "gsv",
          "config/ai/model": "default",
          "config/ai/api_key": "",
        },
      },
      options: { maxTokens: 128, reasoning: "low", timeoutMs: 5_000 },
    });

    expect(response).toMatchObject({
      ok: true,
      data: {
        provider: "gsv",
        model: "gsv/default",
        text: "managed:inst_integration_first:uid:1000:pid:none:run:none",
      },
    });
    socket.close(1000, "test complete");
  });

  it("runs a managed agent turn through the included default provider", async () => {
    await beginProvisioning(harness, "first");
    const socket = await openManagedSocket(harness, "first");
    await expectManagedRpcOk(socket, "setup-process-inference", "sys.setup", {
      username: "process-owner",
      password: "process-owner-password",
      onboardingToken: "integration-onboarding-first",
    });
    await expectManagedRpcOk(socket, "connect-process-inference", "sys.connect", {
      protocol: 3,
      peer: {
        id: "managed-process-inference-test",
        version: "1.0.0",
        platform: "test",
      },
      auth: {
        username: "process-owner",
        password: "process-owner-password",
      },
    });
    const spawned = await expectManagedRpcOk(
      socket,
      "spawn-process-inference",
      "proc.spawn",
      { label: "managed inference", interactive: true },
    );
    // SAFETY: proc.spawn success responses contain a process id.
    const pid = (spawned.data as { pid: string }).pid;
    const finished = nextManagedSignal(socket, "proc.run.finished");
    const committed = nextManagedSignal(socket, "message.committed");
    const sent = await expectManagedRpcOk(socket, "send-process-inference", "proc.send", {
      pid,
      message: "run managed inference",
    });
    // SAFETY: proc.send success responses contain the created run id.
    const runId = (sent.data as { runId: string }).runId;

    await expect(finished).resolves.toMatchObject({
      type: "sig",
      signal: "proc.run.finished",
      payload: {
        pid,
        runId,
        status: "ok",
        reason: "run.yielded",
        result: {
          text: expect.stringMatching(
            `^managed:inst_integration_first:uid:[0-9]+:pid:${pid}:run:${runId}$`,
          ),
        },
        delivery: {
          kind: "message",
          conversationId: expect.any(String),
          messageId: expect.any(String),
        },
      },
    });
    await expect(committed).resolves.toMatchObject({
      type: "sig",
      signal: "message.committed",
      payload: {
        directed: true,
        message: {
          processId: pid,
          runId,
          text: expect.stringMatching(
            `^managed:inst_integration_first:uid:[0-9]+:pid:${pid}:run:${runId}$`,
          ),
        },
      },
    });
    socket.close(1000, "test complete");
  });

  it("propagates a scoped abort capability across the inference binding", async () => {
    const response = await harness.getWorker("gsv-managed-inference-probe").fetch(
      "http://gsv-managed-inference-probe/cancel",
    );
    expect(response.status).toBe(204);

    const dependencies = harness.getWorker<{
      INTEGRATION_STATE: DurableObjectNamespace<IntegrationState>;
    }>("gsv-test-dependencies");
    const { INTEGRATION_STATE } = await dependencies.getEnv();
    const state = INTEGRATION_STATE.get(
      INTEGRATION_STATE.idFromName("singleton"),
    );
    await waitForManagedInferenceCancellation(state, "inst_integration_first");
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

  it("enforces suspension across hostname, existing socket, and adapter ingress", async () => {
    await beginProvisioning(harness, "first");
    const socket = await openManagedSocket(harness, "first");
    await expectManagedRpcOk(socket, "setup-lifecycle", "sys.setup", {
      username: "lifecycle-owner",
      password: "lifecycle-owner-password",
      onboardingToken: "integration-onboarding-first",
    });
    await expectManagedRpcOk(socket, "connect-lifecycle", "sys.connect", {
      protocol: 3,
      peer: {
        id: "managed-lifecycle-test",
        version: "1.0.0",
        platform: "test",
      },
      auth: {
        username: "lifecycle-owner",
        password: "lifecycle-owner-password",
      },
    });

    await setInstallationState(harness, "first", "restricted");

    const hostname = await harness.getWorker("gsv-managed").fetch(
      "https://first.gsv.space/.well-known/oauth-client/gsv.json",
    );
    expect(hostname.status).toBe(404);
    await expect(
      managedRpc(socket, "restricted-existing-socket", "proc.list", {}),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 423,
        message: "Managed installation is suspended",
      },
    });
    await expect(sendAdapterServiceFrame(
      harness,
      "inst_integration_first",
      {
        type: "req",
        id: "restricted-adapter",
        call: "adapter.inbound",
        args: {},
      },
    )).resolves.toMatchObject({
      type: "res",
      id: "restricted-adapter",
      ok: false,
      error: {
        code: 423,
        message: "Managed installation is suspended",
      },
    });

    await setInstallationState(harness, "first", "active");
    await expectManagedRpcOk(
      socket,
      "reactivated-existing-socket",
      "proc.list",
      {},
    );
    socket.close(1000, "test complete");
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
        protocol: 3,
        peer: {
          id: `managed-${handle}`,
          version: "1.0.0",
          platform: "test",
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

type ManagedSignalFrame = {
  type: "sig";
  signal: string;
  payload?: unknown;
};

type HarnessWorker = ReturnType<TestHarness["getWorker"]>;
type HarnessResponse = Awaited<ReturnType<HarnessWorker["fetch"]>>;
type HarnessWebSocket = NonNullable<HarnessResponse["webSocket"]>;
type ManagedRpcArgs = JsonObject;

async function expectManagedRpcOk(
  socket: HarnessWebSocket,
  id: string,
  call: string,
  args: ManagedRpcArgs,
): Promise<ManagedRpcResponse> {
  const response = await managedRpc(socket, id, call, args);
  expect(response).toMatchObject({ type: "res", id, ok: true });
  return response;
}

async function managedRpc(
  socket: HarnessWebSocket,
  id: string,
  call: string,
  args: ManagedRpcArgs,
): Promise<ManagedRpcResponse> {
  // SAFETY: Wrangler's WebSocket proxy implements the standard event-listener surface used here.
  const eventSocket = socket as {
    addEventListener(
      type: "message",
      listener: (event: { data: string }) => void,
    ): void;
    removeEventListener(
      type: "message",
      listener: (event: { data: string }) => void,
    ): void;
  };
  const responsePromise = new Promise<ManagedRpcResponse>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    const onMessage = (event: { data: string }) => {
      // SAFETY: This listener receives only managed RPC response frames for the pending request.
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

function nextManagedSignal(
  socket: HarnessWebSocket,
  signal: string,
): Promise<ManagedSignalFrame> {
  // SAFETY: Wrangler's WebSocket proxy implements the standard event-listener surface used here.
  const eventSocket = socket as {
    addEventListener(
      type: "message",
      listener: (event: { data: string }) => void,
    ): void;
    removeEventListener(
      type: "message",
      listener: (event: { data: string }) => void,
    ): void;
  };
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    const onMessage = (event: { data: string }) => {
      // SAFETY: This listener receives only managed signal frames from the integration socket.
      const frame = JSON.parse(event.data) as ManagedSignalFrame;
      if (frame.type !== "sig" || frame.signal !== signal) return;
      eventSocket.removeEventListener("message", onMessage);
      clearTimeout(timeout);
      resolve(frame);
    };
    eventSocket.addEventListener("message", onMessage);
    timeout = setTimeout(() => {
      eventSocket.removeEventListener("message", onMessage);
      reject(new Error(`Timed out waiting for ${signal}`));
    }, 5_000);
  });
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

async function setInstallationState(
  harness: TestHarness,
  handle: "first" | "second",
  state: "active" | "restricted",
): Promise<void> {
  const response = await harness.getWorker("gsv-test-dependencies").fetch(
    `http://gsv-test-dependencies/__test/installation-state?handle=${handle}&state=${state}`,
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
    "http://gsv-test-dependencies/__test/service-frame/telegram",
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
  // SAFETY: The test dependency worker returns the adapter gateway response contract.
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

async function waitForManagedInferenceCancellation(
  state: DurableObjectStub<IntegrationState>,
  installationId: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await state.wasManagedInferenceCancelled(installationId)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for managed inference cancellation");
}
