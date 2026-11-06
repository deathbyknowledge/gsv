import { GSVClient } from "@humansandmachines/gsv";
import { jsonObjectSchema } from "@humansandmachines/gsv/protocol";
import type {
  AiModelEntry,
  JsonObject,
  ProcSpawnArgs,
  ProcSpawnResult,
} from "@humansandmachines/gsv/protocol";
import type { TestHarness } from "wrangler";
import { DEFAULT_WORKERS_AI_MODEL } from "../src/inference/default-models";
import { createGatewayTestHarness, webSocketUrl, type TestNetworkOptions } from "./harness";
import { startOpenAiFixture, type OpenAiFixture } from "./openai-fixture";
import type { IntegrationState } from "./fixtures/dependencies";

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
  spawn(label: string, args?: Omit<ProcSpawnArgs, "label">): Promise<Extract<ProcSpawnResult, { ok: true }>>;
  configureAi(pid: string, contextWindowTokens?: number): Promise<void>;
  connectMachine(peerId: string): Promise<GSVClient>;
  /** Waits out the fresh owner's welcome, leaving it resolved and Ship idle. */
  settleWelcome(): Promise<void>;
  waitFor(
    predicate: () => boolean | Promise<boolean>,
    description: string,
    timeoutMs?: number,
  ): Promise<void>;
  close(): Promise<void>;
};

export async function startProcessRuntimeHarness(options: {
  workersAi?: boolean;
  instances?: boolean;
  pds?: boolean;
  /** The profile choice the person makes at setup. */
  profile?: "public" | "private";
  managedMailQueue?: string;
  network?: TestNetworkOptions;
  /** Runs once the Gateway listens and before setup, such as to serve it on a test network. */
  beforeSetup?: (harness: TestHarness, url: URL) => Promise<void>;
} = {}): Promise<ProcessRuntimeHarness> {
  const ai = await startOpenAiFixture();
  let harness: TestHarness | undefined;
  let client: GSVClient | undefined;
  let gatewayUrl: string;

  try {
    harness = createGatewayTestHarness(options);
    const { url } = await harness.listen();
    await options.beforeSetup?.(harness, url);
    // Mail and the open network address the Ship by its handle under its canonical origin.
    if (options.managedMailQueue || options.pds) {
      const { INTEGRATION_STATE } = await harness.getWorker<{
        INTEGRATION_STATE: DurableObjectNamespace<IntegrationState>;
      }>("gsv-test-dependencies").getEnv();
      await INTEGRATION_STATE.getByName("integration-recorder").setDefaultOrigin("https://default.gsv.space");
    }
    gatewayUrl = webSocketUrl(url);
    const setupClient = new GSVClient();
    await setupClient.requestOnce(webSocketUrl(url), "sys.setup", { onboardingToken: "integration-onboarding-default",
      username: USERNAME,
      password: PASSWORD,
      agentName: "process-runtime-agent",
      timezone: "Europe/Amsterdam",
      profile: options.profile,
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
    spawn: async (label, args = {}) => {
      const spawned = await connectedClient.proc.spawn({
        label,
        interactive: true,
        ...args,
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
    configureAi: async (pid, contextWindowTokens) => {
      const models: AiModelEntry[] = [{
        id: MODEL_ID,
        name: "Integration model",
        contextWindowTokens,
        provider: "custom",
        model: MODEL_ID,
        baseUrl: ai.baseUrl,
        providerStyle: "openai-chat-completions",
        transportTarget: "gsv",
      }];
      if (contextWindowTokens !== undefined) models[0]!.maxTokens = 4_000;
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
    settleWelcome: () => settleWelcome(connectedClient),
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

/**
 * A fresh owner's sign-in starts their welcome, which the deployment's default model answers. A test that
 * needs a quiet Ship waits for that here, ending where an established owner is: greeted, the welcome
 * resolved, and Ship idle.
 */
async function settleWelcome(client: GSVClient): Promise<void> {
  const welcome = async () => (await client.r12y.list({})).responsibilities
    .find(({ details }) => details?.responsibilityType === "onboarding.initial");
  const { conversation } = await client.conversation.ship({});
  await waitFor(async () => (await client.conversation.history({ conversationId: conversation.id })).messages
    .some(({ author }) => author.kind === "process"), "Ship's welcome");
  const record = await welcome();
  if (!record) throw new Error("Sign-in did not start the welcome");
  await client.r12y.update({ id: record.id, patch: { state: "resolved" } });
  const ship = (await client.proc.list({})).processes.find(({ personal }) => personal);
  await waitFor(async () => {
    const history = ship ? await client.proc.history({ pid: ship.pid }) : undefined;
    return history?.ok === true && history.activeRunId === null;
  }, "Ship to finish its welcome");
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
