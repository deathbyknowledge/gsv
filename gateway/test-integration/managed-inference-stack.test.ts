import type { TestHarness } from "wrangler";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createManagedInferenceStackTestHarness } from "./harness";
import type { JsonObject } from "@humansandmachines/gsv/protocol";

const ACCOUNTS_WORKER = "gsv-accounts-test";
const GATEWAY_WORKER = "gsv-managed-inference-stack";
const INFERENCE_WORKER = "gsv-inference-test";
const HANDLE = "managed-inference-stack";

describe("managed inference stack integration", () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = createManagedInferenceStackTestHarness();
    await harness.listen();
    await harness.getWorker(ACCOUNTS_WORKER).applyD1Migrations("ACCOUNT_DB");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await harness.close();
  });

  it("settles a Gateway generation through inference into Accounts", async () => {
    const accounts = harness.getWorker<{ ACCOUNT_DB: D1Database }>(
      ACCOUNTS_WORKER,
    );
    const createdResponse = await accounts.fetch(
      "http://localhost/admin/api/installations",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost",
        },
        body: JSON.stringify({
          operationId: "operation_managed_inference_stack",
          handle: HANDLE,
        }),
      },
    );
    expect(createdResponse.status).toBe(201);
    // SAFETY: The accounts worker returns this installation creation contract.
    const created = await createdResponse.json() as {
      installation: { installationId: string };
      onboarding: { onboardingUrl: string };
    };
    const installationId = created.installation.installationId;
    const onboardingToken = new URL(created.onboarding.onboardingUrl).hash.slice(1);
    await setInferenceControl(accounts, true);
    await setInstallationInferencePolicy(accounts, installationId, 1_500_000);

    const socketResponse = await harness.getWorker(GATEWAY_WORKER).fetch(
      `https://${HANDLE}.gsv.space/ws`,
      { headers: { Upgrade: "websocket" } },
    );
    expect(socketResponse.status).toBe(101);
    if (!socketResponse.webSocket) throw new Error("Managed WebSocket is unavailable");
    const socket = socketResponse.webSocket;
    socket.accept();

    try {
      await expectRpcOk(socket, "setup", "sys.setup", {
        username: "inference-owner",
        password: "inference-owner-password",
        onboardingToken,
      });
      await expectRpcOk(socket, "connect", "sys.connect", {
        protocol: 2,
        client: {
          id: "managed-inference-stack-test",
          version: "1.0.0",
          platform: "test",
          role: "user",
        },
        auth: {
          username: "inference-owner",
          password: "inference-owner-password",
        },
      });

      const providerFetch = vi.spyOn(globalThis, "fetch").mockImplementation(
        async (input) => {
          const url = input instanceof Request ? input.url : String(input);
          expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
          return openRouterCompletion();
        },
      );
      const generated = await expectRpcOk(
        socket,
        "generate",
        "ai.text.generate",
        {
          messages: [{ role: "user", content: "ping" }],
          options: { maxTokens: 128, reasoning: "low", timeoutMs: 5_000 },
        },
      );

      expect(generated.data).toMatchObject({
        provider: "gsv",
        model: "gsv/default",
        text: "managed stack pong",
      });
      expect(providerFetch).toHaveBeenCalledTimes(1);

      await setInferenceControl(accounts, false);
      const blocked = await expectRpcOk(
        socket,
        "generate-disabled",
        "ai.text.generate",
        {
          messages: [{ role: "user", content: "ping again" }],
          options: { maxTokens: 128, reasoning: "low", timeoutMs: 5_000 },
        },
      );
      expect(blocked.data).toMatchObject({
        message: {
          stopReason: "error",
          errorMessage: "GSV inference is unavailable",
        },
      });
      expect(providerFetch).toHaveBeenCalledTimes(1);

      await setInstallationState(accounts, installationId, "restricted");
      await expect(
        rpc(socket, "suspended", "proc.list", {}),
      ).resolves.toMatchObject({
        ok: false,
        error: {
          code: 423,
          message: "Managed installation is suspended",
        },
      });
      const suspendedHostname = await harness.getWorker(GATEWAY_WORKER).fetch(
        `https://${HANDLE}.gsv.space/.well-known/oauth-client/gsv.json`,
      );
      expect(suspendedHostname.status).toBe(404);

      await setInstallationState(accounts, installationId, "active");
      await expectRpcOk(socket, "reactivated", "proc.list", {});
    } finally {
      socket.close(1000, "test complete");
    }

    const inference = harness.getWorker(INFERENCE_WORKER);
    const inferenceStorage = await inference.getDurableObjectStorage(
      "INFERENCE_INSTALLATIONS",
      { name: installationId },
    );
    await expect(inferenceStorage.exec(
      `SELECT state, total_tokens, cost_nano_usd
       FROM inference_requests`,
    )).resolves.toEqual([{
      state: "completed",
      total_tokens: 3,
      cost_nano_usd: 340,
    }]);

    const usage = await waitForAccountsUsage(accounts, installationId);
    expect(usage).toMatchObject({
      total_tokens: 3,
      cost_nano_usd: 340,
      outcome: "completed",
      provider_response_id: "generation_managed_stack",
    });
    await expect(inferenceStorage.exec(
      `SELECT exported_at IS NOT NULL AS exported
       FROM inference_requests`,
    )).resolves.toEqual([{ exported: 1 }]);

    const adminResponse = await accounts.fetch(
      `http://localhost/admin/api/installations/${installationId}`,
    );
    expect(adminResponse.status).toBe(200);
    // SAFETY: The accounts admin endpoint returns this installation summary contract.
    const admin = await adminResponse.json() as {
      installationId: string;
      inference: {
        requests: number;
        tokens: number;
        costNanoUsd: number;
      };
    };
    expect(admin).toMatchObject({
      installationId,
      inference: {
        requests: 1,
        tokens: 3,
        costNanoUsd: 340,
      },
    });

    const registryResponse = await accounts.fetch(
      `http://localhost/admin/installations?q=${HANDLE}`,
    );
    expect(registryResponse.status).toBe(200);
    expect(await registryResponse.text()).toContain(
      `/admin/installations/${installationId}`,
    );

    const detailResponse = await accounts.fetch(
      `http://localhost/admin/installations/${installationId}`,
    );
    expect(detailResponse.status).toBe(200);
    const detail = await detailResponse.text();
    expect(detail).toContain(HANDLE);
    expect(detail).toContain("$0.00000034");

    const inferenceResponse = await accounts.fetch(
      "http://localhost/admin/inference",
    );
    expect(inferenceResponse.status).toBe(200);
    expect(await inferenceResponse.text()).toContain("$0.00000034");
  });
});

type RpcResponse = {
  type: "res";
  id: string;
  ok: boolean;
  data?: JsonObject;
  error?: { code?: number; message: string };
};

type HarnessWorker = ReturnType<TestHarness["getWorker"]>;
type HarnessResponse = Awaited<ReturnType<HarnessWorker["fetch"]>>;
type HarnessWebSocket = NonNullable<HarnessResponse["webSocket"]>;
type AdminWorker = {
  fetch(
    input: string,
    init: {
      method: "POST";
      headers: Record<string, string>;
      body: string;
    },
  ): Promise<{ status: number }>;
};
type RpcArgs = JsonObject;
type UsageRow = { total_tokens: number; cost_nano_usd: number; outcome: string; provider_response_id: string };

async function expectRpcOk(
  socket: HarnessWebSocket,
  id: string,
  call: string,
  args: RpcArgs,
): Promise<RpcResponse> {
  const response = await rpc(socket, id, call, args);
  expect(response).toMatchObject({ type: "res", id, ok: true });
  return response;
}

async function rpc(
  socket: HarnessWebSocket,
  id: string,
  call: string,
  args: RpcArgs,
): Promise<RpcResponse> {
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
  const response = new Promise<RpcResponse>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    const onMessage = (event: { data: string }) => {
      // SAFETY: The test WebSocket only receives protocol response frames for this request.
      const frame = JSON.parse(event.data) as RpcResponse;
      if (frame.type !== "res" || frame.id !== id) return;
      eventSocket.removeEventListener("message", onMessage);
      clearTimeout(timeout);
      resolve(frame);
    };
    eventSocket.addEventListener("message", onMessage);
    timeout = setTimeout(() => {
      eventSocket.removeEventListener("message", onMessage);
      reject(new Error(`Timed out waiting for ${call}`));
    }, 10_000);
  });
  socket.send(JSON.stringify({ type: "req", id, call, args }));
  return await response;
}

async function waitForAccountsUsage(
  accounts: { getEnv(): Promise<{ ACCOUNT_DB: D1Database }> },
  installationId: string,
): Promise<UsageRow> {
  const { ACCOUNT_DB } = await accounts.getEnv();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const row = await ACCOUNT_DB.prepare(
      `SELECT total_tokens, cost_nano_usd, outcome, provider_response_id
       FROM managed_inference_usage_events
       WHERE installation_id = ?`,
    ).bind(installationId).first<UsageRow>();
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for managed inference usage export");
}

async function setInferenceControl(
  accounts: AdminWorker,
  enabled: boolean,
): Promise<void> {
  const response = await accounts.fetch("http://localhost/admin/api/inference", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost",
    },
    body: JSON.stringify({ enabled }),
  });
  expect(response.status).toBe(200);
}

async function setInstallationInferencePolicy(
  accounts: AdminWorker,
  installationId: string,
  monthlyLimitNanoUsd: number,
): Promise<void> {
  const response = await accounts.fetch(
    `http://localhost/admin/api/installations/${installationId}/inference`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost",
      },
      body: JSON.stringify({ enabled: true, monthlyLimitNanoUsd }),
    },
  );
  expect(response.status).toBe(200);
}

async function setInstallationState(
  accounts: AdminWorker,
  installationId: string,
  state: "active" | "restricted",
): Promise<void> {
  const response = await accounts.fetch(
    `http://localhost/admin/api/installations/${installationId}/lifecycle`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost",
      },
      body: JSON.stringify({ state }),
    },
  );
  expect(response.status).toBe(200);
}

function openRouterCompletion(): Response {
  return new Response([
    sse({
      id: "generation_managed_stack",
      model: "deepseek/deepseek-v4-flash-0731",
      choices: [{ index: 0, delta: { content: "managed stack pong" } }],
    }),
    sse({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 2,
        completion_tokens: 1,
        total_tokens: 3,
      },
    }),
    "data: [DONE]\n\n",
  ].join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function sse(payload: JsonObject): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}
