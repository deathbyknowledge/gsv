import { GSVClient } from "@humansandmachines/gsv";
import { jsonObjectSchema } from "@humansandmachines/gsv/protocol";
import type {
  JsonObject,
  ProcAiConfigSetResult,
  ProcSpawnResult,
} from "@humansandmachines/gsv/protocol";
import type { TestHarness } from "wrangler";
import { createGatewayTestHarness, webSocketUrl } from "./harness";
import { startOpenAiFixture, type OpenAiFixture } from "./openai-fixture";

const USERNAME = "process-runtime-user";
const PASSWORD = "process-runtime-password";

export type RunSignal = {
  signal: string;
  payload: SignalPayload;
};

type SignalPayload = JsonObject;

export type ProcessRuntimeHarness = {
  ai: OpenAiFixture;
  harness: TestHarness;
  client: GSVClient;
  signals: RunSignal[];
  spawn(label: string): Promise<Extract<ProcSpawnResult, { ok: true }>>;
  configureAi(pid: string): Promise<void>;
  waitFor(
    predicate: () => boolean | Promise<boolean>,
    description: string,
    timeoutMs?: number,
  ): Promise<void>;
  close(): Promise<void>;
};

export async function startProcessRuntimeHarness(): Promise<ProcessRuntimeHarness> {
  const ai = await startOpenAiFixture();
  let harness: TestHarness | undefined;
  let client: GSVClient | undefined;

  try {
    harness = createGatewayTestHarness();
    const { url } = await harness.listen();
    const setupClient = new GSVClient();
    await setupClient.requestOnce(webSocketUrl(url), "sys.setup", {
      username: USERNAME,
      password: PASSWORD,
      agentName: "process-runtime-agent",
      timezone: "Europe/Amsterdam",
    });

    client = new GSVClient({
      url: webSocketUrl(url),
      username: USERNAME,
      password: PASSWORD,
      client: {
        id: "process-runtime-integration",
        version: "1.0.0",
        platform: "node",
        role: "user",
      },
    });
    await client.connect();
  } catch (error) {
    client?.close();
    await Promise.allSettled([
      ai.close(),
      ...(harness ? [harness.close()] : []),
    ]);
    throw error;
  }

  if (!harness) {
    await ai.close();
    throw new Error("Gateway test harness was not initialized");
  }
  const connectedHarness = harness;
  const connectedClient = client;
  const signals: RunSignal[] = [];
  const spawnedPids = new Set<string>();
  const stopSignals = connectedClient.onSignal((signal, payload) => {
    const parsed = jsonObjectSchema.safeParse(payload);
    if (parsed.success) {
      signals.push({ signal, payload: parsed.data });
    }
  });

  return {
    ai,
    harness: connectedHarness,
    client: connectedClient,
    signals,
    spawn: async (label) => {
      const spawned = await connectedClient.proc.spawn({
        label,
        interactive: true,
      });
      if (!spawned.ok) throw new Error(spawned.error);
      spawnedPids.add(spawned.pid);
      return spawned;
    },
    configureAi: async (pid) => {
      const result = await connectedClient.call<ProcAiConfigSetResult>(
        "proc.ai.config.set",
        {
          pid,
          values: {
            "config/ai/provider": "custom",
            "config/ai/model": "integration-model",
            "config/ai/base_url": ai.baseUrl,
            "config/ai/provider_style": "openai-chat-completions",
            "config/ai/transport_target": "gsv",
            "config/ai/api_key": "fixture-only",
            "config/ai/reasoning": "off",
            "config/ai/generation/timeout_ms": "5000",
            "config/ai/fallback_model_profile": "integration-no-fallback",
          },
        },
      );
      if (!result.ok) throw new Error(result.error);
    },
    waitFor,
    close: async () => {
      stopSignals();
      for (const pid of [...spawnedPids].reverse()) {
        await connectedClient.proc.kill({ pid, archive: false }).catch(() => {});
      }
      connectedClient.close();
      await Promise.all([ai.close(), connectedHarness.close()]);
    },
  };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}
