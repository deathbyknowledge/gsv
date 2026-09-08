import { GSVClient } from "@humansandmachines/gsv";
import { jsonObjectSchema } from "@humansandmachines/gsv/protocol";
import type {
  AiModelEntry,
  JsonObject,
  ProcSpawnResult,
} from "@humansandmachines/gsv/protocol";
import type { TestHarness } from "wrangler";
import { DEFAULT_WORKERS_AI_MODEL } from "../src/inference/default-models";
import { createGatewayTestHarness, webSocketUrl } from "./harness";
import { startOpenAiFixture, type OpenAiFixture } from "./openai-fixture";

const USERNAME = "process-runtime-user";
const PASSWORD = "process-runtime-password";
const USER_UID = 1000;
const MODEL_ID = "integration-model";

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
  connectMachine(peerId: string): Promise<GSVClient>;
  waitFor(
    predicate: () => boolean | Promise<boolean>,
    description: string,
    timeoutMs?: number,
  ): Promise<void>;
  close(): Promise<void>;
};

export async function startProcessRuntimeHarness(options: {
  workersAi?: boolean;
} = {}): Promise<ProcessRuntimeHarness> {
  const ai = await startOpenAiFixture();
  let harness: TestHarness | undefined;
  let client: GSVClient | undefined;
  let gatewayUrl: string;

  try {
    harness = createGatewayTestHarness(options);
    const { url } = await harness.listen();
    gatewayUrl = webSocketUrl(url);
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
      peer: {
        id: "process-runtime-integration",
        version: "1.0.0",
        platform: "node",
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
  const machineClients = new Set<GSVClient>();
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
    connectMachine: async (peerId) => {
      const issued = await connectedClient.sys.token.create({ kind: "machine", peerId, label: "Integration machine" });
      const machine = new GSVClient({
        url: gatewayUrl, username: USERNAME, token: issued.token.token,
        peer: { id: peerId, version: "fixture-machine", platform: "linux", implements: ["fs.read"] },
      });
      machineClients.add(machine);
      await machine.connect();
      return machine;
    },
    configureAi: async (pid) => {
      const models: AiModelEntry[] = [{
        id: MODEL_ID,
        name: "Integration model",
        provider: "custom",
        model: MODEL_ID,
        baseUrl: ai.baseUrl,
        providerStyle: "openai-chat-completions",
        transportTarget: "gsv",
      }];
      // Any automatic Ship wake uses the local binding fixture, independently of this process's scripted model.
      if (options.workersAi !== false) {
        models.unshift({
          id: "background-fixture",
          name: "Background fixture",
          provider: "workers-ai",
          model: DEFAULT_WORKERS_AI_MODEL,
        });
      }
      await connectedClient.sys.config.set({
        key: `users/${USER_UID}/ai/models`,
        value: JSON.stringify({
          version: 1,
          models,
        }),
      });
      await connectedClient.sys.config.set({
        key: `users/${USER_UID}/ai/models/${MODEL_ID}/api_key`,
        value: "fixture-only",
      });
      const result = await connectedClient.proc.ai.config.set({
        pid,
        modelId: MODEL_ID,
        reasoning: "off",
      });
      if (!result.ok) throw new Error(result.error);
    },
    waitFor,
    close: async () => {
      stopSignals();
      for (const pid of [...spawnedPids].reverse()) {
        await connectedClient.proc.kill({ pid, archive: false }).catch(() => {});
      }
      for (const machine of machineClients) machine.close();
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
