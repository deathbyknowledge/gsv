import { GSVClient } from "@humansandmachines/gsv";
import { describe, expect, it } from "vitest";
import { createGatewayTestHarness, webSocketUrl } from "./harness";
import type { IntegrationState } from "./fixtures/dependencies";

const INSTALLATION = "inst_integration_default";
const PASSWORD = "welcome-fixture-password";
const GREETING = "Hola, soy GSV. ¿De qué quieres que me encargue?";

async function until(predicate: () => Promise<boolean>, description: string): Promise<void> {
  await expect.poll(predicate, { timeout: 20_000, message: description }).toBe(true);
}

function waitForUser(id: string): string {
  return `r12y update ${id} --json '{"state":"waiting","blocker":"Waiting for the user to respond to the welcome","nextCheckAtMs":null}'`;
}

describe("setup welcome", () => {
  it("recovers setup, waits for popup dismissal, then wakes Ship once with its language", async () => {
    const harness = createGatewayTestHarness();
    let client: GSVClient | undefined;
    try {
      const { url } = await harness.listen();
      const endpoint = webSocketUrl(url);
      const { INTEGRATION_STATE } = await harness.getWorker<{ INTEGRATION_STATE: DurableObjectNamespace<IntegrationState> }>("gsv-test-dependencies").getEnv();
      const recorder = INTEGRATION_STATE.getByName("integration-recorder");
      await recorder.scriptManagedInference(INSTALLATION);
      const setup = new GSVClient();
      const args = { onboardingToken: "integration-onboarding-default", username: "welcome-owner", password: PASSWORD,
        agentName: "welcome-agent", timezone: "Europe/Amsterdam", language: "es-mx" };
      await recorder.setOnboardingCompletionFailure("default", "before-activation");
      await expect(setup.requestOnce(endpoint, "sys.setup", args)).rejects.toBeDefined();
      expect((await recorder.listScriptedManagedRequests(INSTALLATION)).length).toBe(0);
      await recorder.setOnboardingCompletionFailure("default", "after-activation");
      await expect(setup.requestOnce(endpoint, "sys.setup", args)).rejects.toBeDefined();
      await setup.requestOnce(endpoint, "sys.setup", args);

      client = new GSVClient({ url: endpoint, username: args.username, password: PASSWORD,
        peer: { id: "welcome-test", platform: "browser", version: "test" } });
      await client.connect();
      const connected = client;
      const { conversation } = await connected.conversation.ship({});
      const { responsibilities } = await connected.r12y.list({});
      const welcome = responsibilities.find((record) => record.details?.responsibilityType === "onboarding.initial")!;
      expect(welcome.state).toBe("waiting");
      expect(welcome.nextCheckAtMs).toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(await recorder.listScriptedManagedRequests(INSTALLATION)).toEqual([]);
      await connected.sys.config.set({ key: "users/1000/ui/welcome_card_seen", value: "1" });
      await until(async () => (await recorder.listScriptedManagedRequests(INSTALLATION)).length > 0, "popup dismissal to wake Ship without a chat message");
      const initial = (await recorder.listScriptedManagedRequests(INSTALLATION))[0]!;
      const prompt = initial.systemPrompt ?? "";
      expect(prompt.includes("Preferred language: es-MX")).toBe(true);
      expect(prompt.includes("onboarding.initial")).toBe(true);
      expect(prompt.includes("If the user has already spoken")).toBe(true);
      expect(prompt.includes("on-demand cloud browser")).toBe(true);
      expect(prompt.includes("skills show browser-target")).toBe(true);
      expect(prompt.includes("Zen displays a local welcome")).toBe(false);

      expect((await connected.r12y.get({ id: welcome.id })).responsibility.state).toBe("open");
      expect((await connected.conversation.history({ conversationId: conversation.id })).messages).toEqual([]);
      await recorder.scriptManagedInference(INSTALLATION, [`message send --message '${GREETING}'`, waitForUser(welcome.id), "yield"]);
      await until(async () => (await connected.conversation.history({ conversationId: conversation.id })).messages.length === 1, "canonical welcome to commit");
      await until(async () => (await connected.r12y.get({ id: welcome.id })).responsibility.state === "waiting", "welcome to wait without resolving onboarding");
      expect((await connected.r12y.get({ id: welcome.id })).responsibility.nextCheckAtMs).toBeUndefined();
      const messages = (await connected.conversation.history({ conversationId: conversation.id })).messages;
      expect(messages[0]).toMatchObject({ text: GREETING, author: { kind: "process" } });
      expect(messages.some((message) => message.author.kind === "user")).toBe(false);

      await connected.sys.config.set({ key: "users/1000/ui/welcome_card_seen", value: "1" });
      await expect(setup.requestOnce(endpoint, "sys.setup", args)).rejects.toBeDefined();
      expect((await connected.r12y.get({ id: welcome.id })).responsibility.state).toBe("waiting");
      await connected.sys.config.set({ key: "users/1000/locale/language", value: "fr" });
      await recorder.scriptManagedInference(INSTALLATION, ["message send --message 'Bonjour !' && yield"]);
      await connected.conversation.send({ conversationId: conversation.id, text: "Continue", idempotencyKey: "language-change" });
      await until(async () => (await connected.conversation.history({ conversationId: conversation.id })).messages.length === 3, "language-change reply");
      const requests = await recorder.listScriptedManagedRequests(INSTALLATION);
      const latest = requests.at(-1)!;
      expect(latest.messages).toContain('Preferred language: \\"fr\\"');
      expect(latest.systemPrompt).toBe(initial.systemPrompt);
      expect((await connected.conversation.history({ conversationId: conversation.id })).messages.filter((message) => message.text === GREETING)).toHaveLength(1);
    } finally {
      client?.close();
      await harness.close();
    }
  });

  it("uses ordinary interruption when the user speaks Spanish during an English-default welcome", async () => {
    const harness = createGatewayTestHarness();
    let client: GSVClient | undefined;
    try {
      const { url } = await harness.listen();
      const endpoint = webSocketUrl(url);
      const { INTEGRATION_STATE } = await harness.getWorker<{ INTEGRATION_STATE: DurableObjectNamespace<IntegrationState> }>("gsv-test-dependencies").getEnv();
      const recorder = INTEGRATION_STATE.getByName("integration-recorder");
      await recorder.scriptManagedInference(INSTALLATION);
      await new GSVClient().requestOnce(endpoint, "sys.setup", {
        onboardingToken: "integration-onboarding-default", username: "early-owner", password: PASSWORD, language: "en",
      });

      client = new GSVClient({ url: endpoint, username: "early-owner", password: PASSWORD,
        peer: { id: "early-input-test", platform: "browser", version: "test" } });
      await client.connect();
      const connected = client;
      expect(await recorder.listScriptedManagedRequests(INSTALLATION)).toEqual([]);
      await connected.sys.config.set({ key: "users/1000/ui/welcome_card_seen", value: "1" });
      await until(async () => (await recorder.listScriptedManagedRequests(INSTALLATION)).length === 1, "initial welcome generation");
      const first = (await recorder.listScriptedManagedRequests(INSTALLATION))[0]!;
      expect(first.systemPrompt.includes("Preferred language: en")).toBe(true);
      const { conversation } = await connected.conversation.ship({});
      const { responsibilities } = await connected.r12y.list({});
      const welcome = responsibilities.find((record) => record.details?.responsibilityType === "onboarding.initial")!;
      await connected.conversation.send({ conversationId: conversation.id, text: "Hola, soy Rosa. Ayúdame con mis correos.", idempotencyKey: "early-input" });
      await recorder.scriptManagedInference(INSTALLATION, ["message send --message 'Obsolete English greeting' && yield"], first.logicalRequestId);
      await until(async () => (await recorder.listScriptedManagedRequests(INSTALLATION)).length > 1, "user input to reach generation");
      const next = (await recorder.listScriptedManagedRequests(INSTALLATION)).at(-1)!;
      expect(next.messages).toContain("Hola, soy Rosa");
      expect(next.systemPrompt.includes("respond to their message in their language")).toBe(true);
      const count = (await recorder.listScriptedManagedRequests(INSTALLATION)).length;
      await recorder.scriptManagedInference(INSTALLATION, [waitForUser(welcome.id)], next.logicalRequestId);
      await until(async () => (await recorder.listScriptedManagedRequests(INSTALLATION)).length > count, "deferred welcome to continue the conversation");
      const reply = (await recorder.listScriptedManagedRequests(INSTALLATION)).at(-1)!;
      await recorder.scriptManagedInference(INSTALLATION, ["message send --message 'Hola, Rosa. Empecemos con tus correos.' && yield"], reply.logicalRequestId);
      await until(async () => (await connected.conversation.history({ conversationId: conversation.id })).messages.length === 2, "Spanish reply to commit");
      const history = (await connected.conversation.history({ conversationId: conversation.id })).messages;
      expect(history.map((message) => message.text)).toEqual(["Hola, soy Rosa. Ayúdame con mis correos.", "Hola, Rosa. Empecemos con tus correos."]);
    } finally {
      client?.close();
      await harness.close();
    }
  });

  it("honors a user message before dismissal without starting another welcome afterwards", async () => {
    const harness = createGatewayTestHarness();
    let client: GSVClient | undefined;
    try {
      const { url } = await harness.listen();
      const endpoint = webSocketUrl(url);
      const { INTEGRATION_STATE } = await harness.getWorker<{ INTEGRATION_STATE: DurableObjectNamespace<IntegrationState> }>("gsv-test-dependencies").getEnv();
      const recorder = INTEGRATION_STATE.getByName("integration-recorder");
      await recorder.scriptManagedInference(INSTALLATION);
      await new GSVClient().requestOnce(endpoint, "sys.setup", {
        onboardingToken: "integration-onboarding-default", username: "direct-owner", password: PASSWORD, language: "en",
      });
      client = new GSVClient({ url: endpoint, username: "direct-owner", password: PASSWORD,
        peer: { id: "direct-input-test", platform: "browser", version: "test" } });
      await client.connect();
      const connected = client;
      const { conversation } = await connected.conversation.ship({});
      const { responsibilities } = await connected.r12y.list({});
      const welcome = responsibilities.find((record) => record.details?.responsibilityType === "onboarding.initial")!;
      expect(await recorder.listScriptedManagedRequests(INSTALLATION)).toEqual([]);
      await recorder.scriptManagedInference(INSTALLATION, [waitForUser(welcome.id), "message send --message 'Hola, Rosa. Empecemos con tus correos.' && yield"]);
      await connected.conversation.send({ conversationId: conversation.id, text: "Hola, soy Rosa. Ayúdame con mis correos.", idempotencyKey: "before-dismissal" });
      await until(async () => (await connected.conversation.history({ conversationId: conversation.id })).messages.length === 2, "direct reply before dismissal");
      const count = (await recorder.listScriptedManagedRequests(INSTALLATION)).length;
      await connected.sys.config.set({ key: "users/1000/ui/welcome_card_seen", value: "1" });
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect((await recorder.listScriptedManagedRequests(INSTALLATION)).length).toBe(count);
      expect((await connected.r12y.get({ id: welcome.id })).responsibility.state).toBe("waiting");
    } finally {
      client?.close();
      await harness.close();
    }
  });
});
