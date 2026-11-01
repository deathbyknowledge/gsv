import { GSVClient } from "@humansandmachines/gsv";
import { wireFrameSchemas, type AdapterGatewayRequestFrame } from "@humansandmachines/gsv/protocol";
import type { TestHarness } from "wrangler";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createGatewayTestHarness, webSocketUrl } from "./harness";
import { startOpenAiFixture, type OpenAiFixture } from "./openai-fixture";

const INSTALLATION_ID = "inst_integration_default";
const USERNAME = "quote-user";
const PASSWORD = "quote-integration-password";
const USER_UID = 1000;
const MODEL_ID = "integration-model";
// The Kernel treats every adapter alike, so these use the shapes the WhatsApp adapter sends: a
// bare phone number for actor and surface, and the provider id its webhook normalizes into replyToId.
const ACCOUNT_ID = "integration-inbound";
const ACTOR_ID = "34600000000";
const SURFACE = { kind: "dm" as const, id: "34600000000" };

type Outbound = { message: { deliveryId: string; text: string } };

function inbound(messageId: string, text: string, replyToId?: string, surface = SURFACE, actorId = ACTOR_ID): AdapterGatewayRequestFrame {
  return {
    type: "req",
    id: messageId,
    call: "adapter.inbound",
    args: {
      adapter: "discord",
      accountId: ACCOUNT_ID,
      deliveryId: messageId,
      message: {
        messageId,
        surface,
        actor: { id: actorId },
        text,
        ...(replyToId === undefined ? undefined : { replyToId }),
        timestamp: Date.now(),
        wasMentioned: true,
      },
    },
  };
}

async function waitFor(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function userText(request: OpenAiFixture["requests"][number]): string[] {
  return request.messages.flatMap((message) => {
    // SAFETY: the OpenAI fixture records the chat-completions message array it received.
    const { role, content } = message as { role: string; content: string | Array<{ text?: string }> };
    if (role !== "user") return [];
    return [Array.isArray(content) ? content.map((part) => part.text ?? "").join("") : content];
  });
}

describe("quoted replies through the real Gateway, Kernel, Conversation and Process", () => {
  let harness: TestHarness;
  let baseUrl: URL;
  let ai: OpenAiFixture;
  const clients = new Set<GSVClient>();

  beforeAll(async () => {
    ai = await startOpenAiFixture();
    harness = createGatewayTestHarness();
  });
  beforeEach(async () => {
    ({ url: baseUrl } = await harness.listen());
  });
  afterEach(async () => {
    for (const client of clients) client.close();
    clients.clear();
    await harness.reset();
  });
  afterAll(async () => {
    await harness.close();
    await ai.close();
  });

  async function sendFrame(frame: AdapterGatewayRequestFrame) {
    const response = await harness.getWorker("gsv-test-dependencies").fetch(
      "http://gsv-test-dependencies/__test/service-frame/discord",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ installation: { installationId: INSTALLATION_ID }, frame }),
      },
    );
    expect(response.ok).toBe(true);
    const parsed = wireFrameSchemas.response.parse(await response.json());
    expect(parsed).toMatchObject({ ok: true, data: { ok: true } });
    return parsed;
  }

  async function outbound(): Promise<Outbound[]> {
    const response = await harness.getWorker("gsv-test-dependencies").fetch(
      `http://gsv-test-dependencies/__test/outbound?installationId=${INSTALLATION_ID}&accountId=${ACCOUNT_ID}`,
    );
    // SAFETY: the dependency fixture returns its recorded outbound contract.
    return await response.json() as Outbound[];
  }

  async function setup(): Promise<{ client: GSVClient; pid: string }> {
    const oneShot = new GSVClient();
    await oneShot.requestOnce(webSocketUrl(baseUrl), "sys.setup", {
      onboardingToken: "integration-onboarding-default",
      username: USERNAME,
      password: PASSWORD,
      agentName: "quote-agent",
      timezone: "Europe/Amsterdam",
    });
    const setupClient = new GSVClient({
      url: webSocketUrl(baseUrl),
      username: USERNAME,
      password: PASSWORD,
      peer: { id: "quote-integration", version: "1.0.0", platform: "node" },
    });
    clients.add(setupClient);
    await setupClient.connect();
    const { conversation } = await setupClient.conversation.ship({});
    if (!conversation.handlerPid) throw new Error("Missing Ship");
    const pid = conversation.handlerPid;
    await setupClient.sys.config.set({
      key: `users/${USER_UID}/ai/models`,
      value: JSON.stringify({
        version: 1,
        models: [{
          id: MODEL_ID, name: "Integration model", provider: "custom", model: MODEL_ID,
          baseUrl: ai.baseUrl, providerStyle: "openai-chat-completions", transportTarget: "gsv",
        }],
      }),
    });
    await setupClient.sys.config.set({ key: `users/${USER_UID}/ai/models/${MODEL_ID}/api_key`, value: "fixture-only" });
    await setupClient.proc.ai.config.set({ pid, modelId: MODEL_ID, reasoning: "off" });
    const storage = await harness.getWorker("gsv").getDurableObjectStorage("KERNEL", { name: INSTALLATION_ID });
    await storage.exec(
      `INSERT INTO identity_links (adapter, account_id, actor_id, uid, created_at, linked_by_uid, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      "discord", ACCOUNT_ID, ACTOR_ID, USER_UID, Date.now(), USER_UID,
      JSON.stringify({ surfaceKind: SURFACE.kind, surfaceId: SURFACE.id }),
    );
    return { client: setupClient, pid };
  }

  async function settled(client: GSVClient, pid: string): Promise<void> {
    await waitFor(async () => {
      const history = await client.proc.history({ pid });
      return history.ok && history.activeRunId === null;
    }, "the run to finish");
  }

  it("shows the model what was quoted, whichever side wrote it, and keeps the canonical text clean", async () => {
    const { client, pid } = await setup();

    // Ship answers; the fixture adapter reports `fixture:<deliveryId>` as the provider id.
    ai.enqueue({ kind: "message", text: "Option A, or option B?" });
    await sendFrame(inbound("wamid.first", "what are my options?"));
    await waitFor(async () => (await outbound()).length >= 1, "Ship's reply");
    await settled(client, pid);
    const [shipReply] = await outbound();
    const shipProviderId = `fixture:${shipReply!.message.deliveryId}`;

    // The person quotes Ship's message.
    const beforeShipQuote = ai.requests.length;
    ai.enqueue({ kind: "message", text: "Done." });
    await sendFrame(inbound("wamid.quote-ship", "yes, that one", shipProviderId));
    await waitFor(async () => ai.requests.length > beforeShipQuote, "the model call");
    await settled(client, pid);
    expect(userText(ai.requests.at(-1)!).at(-1)).toContain(
      "[Replying to Ship's earlier message:]\n> Option A, or option B?\n\nyes, that one",
    );

    // The person quotes their own earlier message.
    const beforeOwnQuote = ai.requests.length;
    ai.enqueue({ kind: "message", text: "Fine." });
    await sendFrame(inbound("wamid.quote-own", "ignore this", "wamid.first"));
    await waitFor(async () => ai.requests.length > beforeOwnQuote, "the model call");
    await settled(client, pid);
    expect(userText(ai.requests.at(-1)!).at(-1)).toContain(
      "[Replying to their own earlier message:]\n> what are my options?\n\nignore this",
    );

    // A message from before this existed, or past retention: the model is told, and doesn't guess.
    const beforeUnknown = ai.requests.length;
    ai.enqueue({ kind: "message", text: "Which one?" });
    await sendFrame(inbound("wamid.quote-old", "what about that?", "wamid.long-gone"));
    await waitFor(async () => ai.requests.length > beforeUnknown, "the model call");
    await settled(client, pid);
    expect(userText(ai.requests.at(-1)!).at(-1)).toContain(
      "[Replying to an earlier message you cannot see. Do not guess what it said; ask if it matters.]\n\nwhat about that?",
    );

    // The person's own history stays what they wrote, with no `>` lines.
    const { conversation } = await client.conversation.ship({});
    const history = await client.conversation.history({ conversationId: conversation.id });
    const texts = history.messages.map((message) => message.text);
    expect(texts).toEqual(expect.arrayContaining(["yes, that one", "ignore this", "what about that?"]));
    expect(texts.some((text) => text.includes("> "))).toBe(false);

    // Ship's reply and the inbound messages left one reference row each and no message text.
    const kernel = await harness.getWorker("gsv").getDurableObjectStorage("KERNEL", { name: INSTALLATION_ID });
    const rows = await kernel.exec("SELECT * FROM adapter_message_refs ORDER BY id");
    expect(rows.map((row) => row.provider_message_id)).toEqual(expect.arrayContaining(["wamid.first", shipProviderId, "wamid.quote-ship"]));
    expect(JSON.stringify(rows)).not.toContain("what are my options?");
  });

  it("does not resolve a provider id recorded on a different surface", async () => {
    const { client, pid } = await setup();
    ai.enqueue({ kind: "message", text: "Secret answer." });
    await sendFrame(inbound("wamid.private", "something private"));
    await waitFor(async () => (await outbound()).length >= 1, "Ship's reply");
    await settled(client, pid);

    const kernel = await harness.getWorker("gsv").getDurableObjectStorage("KERNEL", { name: INSTALLATION_ID });
    const otherSurface = { kind: "dm" as const, id: "34699999999" };
    const otherActor = "34699999999";
    await kernel.exec(
      `INSERT INTO identity_links (adapter, account_id, actor_id, uid, created_at, linked_by_uid, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      "discord", ACCOUNT_ID, otherActor, USER_UID, Date.now(), USER_UID,
      JSON.stringify({ surfaceKind: otherSurface.kind, surfaceId: otherSurface.id }),
    );

    const before = ai.requests.length;
    ai.enqueue({ kind: "message", text: "Which one?" });
    await sendFrame(inbound("wamid.elsewhere", "what did that say?", "wamid.private", otherSurface, otherActor));
    await waitFor(async () => ai.requests.length > before, "the model call");
    await settled(client, pid);
    const last = userText(ai.requests.at(-1)!).at(-1)!;
    expect(last).toContain("[Replying to an earlier message you cannot see.");
    expect(last).toContain("what did that say?");
    expect(last.split("what did that say?")[0]).not.toContain("something private");
  });
});
