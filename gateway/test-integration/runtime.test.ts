import { GSVClient } from "@humansandmachines/gsv";
import {
  adapterGatewayResponseFrameSchema,
  isAdapterInboundResult,
  type AdapterGatewayRequestFrame,
  type AdapterGatewayResponseFrame,
  type AdapterInboundResult,
  type ProcAiConfigSetResult,
  type ProcHilRequest,
} from "@humansandmachines/gsv/protocol";
import type { TestHarness } from "wrangler";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createGatewayTestHarness, webSocketUrl } from "./harness";
import {
  INTEGRATION_REPLY,
  startOpenAiFixture,
  type OpenAiFixture,
} from "./openai-fixture";
import { SINGLETON_INSTALLATION_ID } from "../src/installation/identity";

const USERNAME = "runtime-user";
const PASSWORD = "runtime-integration-password";
const CLIENT_ID = "runtime-integration";
const ACCOUNT_ID = "integration-inbound";
const ACTOR_ID = "discord:user-42";
const SURFACE = { kind: "dm" as const, id: "discord:dm-42" };

type RunSignal = {
  signal: string;
  payload: {
    runId?: string;
    seq?: number;
    event?: { type: string };
  };
};

type RecordedOutboundMessage = {
  installationId: string;
  accountId: string;
  message: {
    deliveryId: string;
    surface: typeof SURFACE;
    actorId?: string;
    text: string;
    replyToId?: string;
  };
};

type GatewayTestEnv = {
  STORAGE: R2Bucket;
};

describe("gateway runtime integration", () => {
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
    for (const client of clients) {
      client.close();
    }
    clients.clear();
    await harness.reset();
  });

  afterAll(async () => {
    await harness.close();
    await ai.close();
  });

  it("runs inference, history, reset, and kill through real process boundaries", async () => {
    const preSetupServiceResponse = await sendServiceFrame(harness, inboundFrame({
      id: "pre-setup",
      deliveryId: "pre-setup-delivery",
      messageId: "pre-setup-message",
      text: "hello before setup",
    }));
    const client = await setupClient();

    expect(preSetupServiceResponse).toMatchObject({
      type: "res",
      id: "pre-setup",
      ok: false,
      error: {
        code: 503,
        message: "Service identity is not configured",
      },
    });

    const spawned = await client.proc.spawn({
      label: "deterministic runtime",
      interactive: true,
    });
    if (!spawned.ok) throw new Error(spawned.error);
    await configureDeterministicAi(client, spawned.pid, ai.baseUrl);

    const signals: RunSignal[] = [];
    const stopSignals = client.onSignal((signal, payload) => {
      // SAFETY: Runtime signal payloads use the fields asserted by this fixture.
      signals.push({ signal, payload: payload as RunSignal["payload"] });
    });
    const generationRequestOffset = ai.requests.length;

    const first = await client.proc.send({
      pid: spawned.pid,
      message: "first deterministic message",
      origin: {
        kind: "adapter",
        adapter: "spoofed",
        accountId: "spoofed",
        surface: { kind: "dm", id: "spoofed" },
        actorId: "spoofed",
      },
    });
    if (!first.ok) throw new Error(first.error);
    expect(first).toMatchObject({ status: "started" });
    expect(first).not.toHaveProperty("queued");
    await waitFor(() => signals.some(({ signal, payload }) =>
      signal === "proc.run.finished" && payload.runId === first.runId
    ), "first process run to finish");

    const second = await client.proc.send({
      pid: spawned.pid,
      message: "second deterministic message",
    });
    if (!second.ok) throw new Error(second.error);
    expect(second).toMatchObject({ status: "started" });
    expect(second).not.toHaveProperty("queued");
    expect(second.runId).not.toBe(first.runId);

    await waitFor(() => [first.runId, second.runId].every((runId) =>
      signals.some(({ signal, payload }) =>
        signal === "proc.run.finished" && payload.runId === runId
      )
    ), "both process runs to finish");
    stopSignals();

    for (const runId of [first.runId, second.runId]) {
      const streamPayloads = signals
        .filter(({ signal, payload }) => signal === "proc.run.stream" && payload.runId === runId)
        .map(({ payload }) => payload);
      expect(streamPayloads.map(({ event }) =>
        // SAFETY: Stream events in this fixture always carry a string type.
        (event as { type: string }).type
      )).toEqual([
        "start",
        "toolcall_start",
        "toolcall_delta",
        "toolcall_end",
        "done",
      ]);
      expect(streamPayloads.map(({ seq }) => seq)).toEqual([1, 2, 3, 4, 5]);

      const runSignals = signals
        .filter(({ payload }) => payload.runId === runId)
        .map(({ signal }) => signal);
      expect(runSignals).toEqual(expect.arrayContaining([
        "proc.run.started",
        "proc.run.stream",
        "proc.run.finished",
      ]));
      expect(signals).toContainEqual(expect.objectContaining({
        signal: "message.committed",
        payload: expect.objectContaining({
          directed: true,
          message: expect.objectContaining({
            processId: spawned.pid,
            runId,
            text: INTEGRATION_REPLY,
          }),
        }),
      }));
      expect(signals).toContainEqual(expect.objectContaining({
        signal: "proc.run.finished",
        payload: expect.objectContaining({
          pid: spawned.pid,
          runId,
          status: "ok",
          reason: "message.sent",
          text: null,
        }),
      }));
    }

    const generationRequests = ai.requests.slice(generationRequestOffset);
    expect(generationRequests).toHaveLength(2);
    expect(generationRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "/v1/chat/completions",
        usesFixtureCredential: true,
        model: "integration-model",
        stream: true,
        messageCount: expect.any(Number),
        toolCount: expect.any(Number),
      }),
    ]));

    const history = await client.proc.history({ pid: spawned.pid });
    expect(history).toMatchObject({
      ok: true,
      pid: spawned.pid,
      messageCount: 6,
      activeRunId: null,
    });
    if (!history.ok) throw new Error(history.error);
    expect(history.messages).toEqual([
      expect.objectContaining({
        role: "user",
        content: "first deterministic message",
        runId: first.runId,
      }),
      expect.objectContaining({
        role: "assistant",
        runId: first.runId,
        content: expect.objectContaining({
          toolCalls: [expect.objectContaining({ name: "Message" })],
        }),
      }),
      expect.objectContaining({
        role: "toolResult",
        runId: first.runId,
        content: expect.objectContaining({ toolName: "Message" }),
      }),
      expect.objectContaining({
        role: "user",
        content: "second deterministic message",
        runId: second.runId,
      }),
      expect.objectContaining({
        role: "assistant",
        runId: second.runId,
        content: expect.objectContaining({
          toolCalls: [expect.objectContaining({ name: "Message" })],
        }),
      }),
      expect.objectContaining({
        role: "toolResult",
        runId: second.runId,
        content: expect.objectContaining({ toolName: "Message" }),
      }),
    ]);
    expect(history.messages[0]).toMatchObject({
      origin: {
        kind: "client",
        connectionId: expect.any(String),
        clientId: CLIENT_ID,
        platform: "node",
      },
    });
    expect(history.messages[1]).toMatchObject({
      metadata: {
        provider: {
          api: "openai-completions",
          provider: "custom",
          model: "integration-model",
          responseId: expect.stringMatching(/^chatcmpl-integration-/),
          stopReason: "toolUse",
        },
        usage: {
          inputTokens: 10,
          outputTokens: 3,
          totalTokens: 13,
          cost: null,
          costIncomplete: true,
        },
      },
    });

    const reset = await client.proc.reset({ pid: spawned.pid });
    expect(reset).toMatchObject({
      ok: true,
      pid: spawned.pid,
      archivedMessages: 6,
      archivedTo: expect.stringMatching(/\.history\.gen-1\.jsonl\.gz$/),
      archives: [expect.objectContaining({ generation: 1, messages: 6 })],
    });
    if (!reset.ok || !reset.archivedTo) throw new Error("proc.reset did not archive history");
    await expectArchive(harness, client, reset.archivedTo);
    expect(await client.proc.history({ pid: spawned.pid })).toMatchObject({
      ok: true,
      messages: [],
      messageCount: 0,
    });
    expect((await client.proc.list()).processes.some(({ pid }) => pid === spawned.pid)).toBe(true);

    const thirdSignals: RunSignal[] = [];
    const stopThirdSignals = client.onSignal((signal, payload) => {
      // SAFETY: Runtime signal payloads use the fields asserted by this fixture.
      thirdSignals.push({ signal, payload: payload as RunSignal["payload"] });
    });
    const third = await client.proc.send({
      pid: spawned.pid,
      message: "message after reset",
    });
    if (!third.ok) throw new Error(third.error);
    await waitFor(() => thirdSignals.some(({ signal, payload }) =>
      signal === "proc.run.finished" && payload.runId === third.runId
    ), "post-reset process run to finish");
    stopThirdSignals();

    const killed = await client.proc.kill({ pid: spawned.pid });
    expect(killed).toMatchObject({
      ok: true,
      pid: spawned.pid,
      archivedMessages: 3,
      archivedTo: expect.stringMatching(/\.history\.gen-2\.jsonl\.gz$/),
      archives: expect.arrayContaining([
        expect.objectContaining({ generation: 2, messages: 3 }),
      ]),
    });
    if (!killed.ok || !killed.archivedTo) throw new Error("proc.kill did not archive history");
    await expectArchive(harness, client, killed.archivedTo);
    expect((await client.proc.list()).processes.some(({ pid }) => pid === spawned.pid)).toBe(false);
    await expect(client.proc.history({ pid: spawned.pid })).rejects.toThrow(
      `Process not found: ${spawned.pid}`,
    );
  });

  it("routes reciprocal adapter ingress, durable commands, and automatic replies", async () => {
    const client = await setupClient();
    const beforeChallenge = await processHistoryCounts(client);
    const challengeFrame = inboundFrame({
      id: "challenge",
      deliveryId: "challenge-delivery",
      messageId: "challenge-message",
      text: "hello from an unlinked actor",
    });
    const challengeResponse = await sendServiceFrame(harness, challengeFrame);
    const challenge = inboundResult(challengeResponse);
    expect(challenge).toMatchObject({
      ok: true,
      challenge: {
        deliveryId: expect.stringMatching(/^adapter-ingress:[0-9a-f]{64}:challenge$/),
        code: expect.stringMatching(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/),
        expiresAt: expect.any(Number),
      },
    });
    if (!challenge.challenge) throw new Error("adapter ingress returned no link challenge");
    expect(challenge.challenge.prompt).toContain(challenge.challenge.code);
    expect(challenge.challenge.expiresAt).toBeGreaterThan(Date.now());

    const challengeReplay = inboundResult(await sendServiceFrame(harness, {
      ...challengeFrame,
      id: "challenge-replay",
    }));
    expect(challengeReplay).toEqual({ ...challenge, replayed: "completed" });
    expect(await processHistoryCounts(client)).toEqual(beforeChallenge);

    const consumed = await client.sys.link.consume({ code: challenge.challenge.code.toLowerCase() });
    expect(consumed).toMatchObject({
      linked: true,
      link: {
        adapter: "discord",
        accountId: ACCOUNT_ID,
        actorId: ACTOR_ID,
        uid: 1000,
      },
    });
    expect((await client.sys.link.list()).links).toContainEqual(expect.objectContaining({
      adapter: "discord",
      accountId: ACCOUNT_ID,
      actorId: ACTOR_ID,
      uid: 1000,
      linkedByUid: 1000,
    }));

    const beforePersonal = await client.proc.list();
    const personalProcesses = beforePersonal.processes.filter(({ personal }) => personal);
    expect(personalProcesses).toHaveLength(1);

    const homeFrame = inboundFrame({
      id: "home",
      deliveryId: "home-delivery",
      messageId: "home-message",
      text: "/home",
    });
    const home = inboundResult(await sendServiceFrame(harness, homeFrame));
    expect(home).toMatchObject({
      ok: true,
      reply: {
        deliveryId: expect.stringMatching(/^adapter-ingress:[0-9a-f]{64}:reply$/),
        text: expect.stringContaining("[PERSONAL HOME]"),
        replyToId: "home-message",
      },
    });
    expect(inboundResult(await sendServiceFrame(harness, {
      ...homeFrame,
      id: "home-replay",
    }))).toEqual({ ...home, replayed: "completed" });

    const afterPersonal = await client.proc.list();
    expect(afterPersonal.processes).toEqual(beforePersonal.processes);

    const wherePersonal = inboundResult(await sendServiceFrame(harness, inboundFrame({
      id: "where-personal",
      deliveryId: "where-personal-delivery",
      messageId: "where-personal-message",
      text: "/where",
    })));
    expect(wherePersonal.reply).toMatchObject({
      text: expect.stringContaining(personalProcesses[0]!.pid.slice(0, 13)),
      replyToId: "where-personal-message",
    });

    const target = await client.proc.spawn({
      label: "adapter route target",
      interactive: true,
    });
    if (!target.ok) throw new Error(target.error);
    await configureDeterministicAi(client, personalProcesses[0]!.pid, ai.baseUrl);
    await configureDeterministicAi(client, target.pid, ai.baseUrl);

    ai.enqueue(
      {
        kind: "tool-calls",
        calls: [{
          id: "route-work-call",
          name: "Shell",
          arguments: {
            input: `message route set --process ${target.pid} --to here`,
          },
        }],
      },
      { kind: "message", text: "work direct line ready" },
    );
    const workTarget = inboundResult(await sendServiceFrame(harness, inboundFrame({
      id: "work-target",
      deliveryId: "work-target-delivery",
      messageId: "work-target-message",
      text: "Open a direct line to the prepared work process.",
    })));
    expect(workTarget).toMatchObject({
      ok: true,
      delivered: {
        pid: personalProcesses[0]!.pid,
        runId: expect.any(String),
        queued: false,
      },
    });
    if (!workTarget.delivered) throw new Error("Personal handoff run was not admitted");

    const pendingRoute = await waitForPendingHil(
      client,
      personalProcesses[0]!.pid,
      workTarget.delivered.runId,
    );
    expect(pendingRoute).toMatchObject({
      toolName: "Shell",
      syscall: "shell.exec",
      args: {
        input: `message route set --process ${target.pid} --to here`,
      },
    });
    expect(await client.proc.hil({
      pid: personalProcesses[0]!.pid,
      requestId: pendingRoute.requestId,
      decision: "approve",
    })).toMatchObject({
      ok: true,
      pid: personalProcesses[0]!.pid,
      requestId: pendingRoute.requestId,
      resumed: true,
    });
    await waitFor(async () => {
      const history = await client.proc.history({ pid: personalProcesses[0]!.pid });
      return history.ok
        && history.activeRunId === null
        && history.messages.some(({ role, runId, content }) => (
          role === "toolResult"
          && runId === workTarget.delivered?.runId
          && JSON.stringify(content).includes(target.pid)
        ));
    }, "personal controller to set the work route");
    let personalRouteReply: RecordedOutboundMessage | undefined;
    await waitFor(async () => {
      personalRouteReply = (await listOutbound(harness, ACCOUNT_ID)).find(({ message }) => (
        message.replyToId === "work-target-message"
        && message.text.includes("work direct line ready")
      ));
      return personalRouteReply !== undefined;
    }, "personal route confirmation");
    expect(personalRouteReply?.message.text).toBe(
      "[PERSONAL INTELLIGENCE] work direct line ready",
    );

    const beforeNormal = await client.proc.list();
    const workOutboundOffset = (await listOutbound(harness, ACCOUNT_ID)).length;
    const firstNormalFrame = inboundFrame({
      id: "normal-one",
      deliveryId: "normal-one-delivery",
      messageId: "normal-one-message",
      text: "first routed adapter message",
      actor: {
        id: ACTOR_ID,
        name: "Integration Actor",
        handle: "@integration",
      },
    });
    const firstNormal = inboundResult(await sendServiceFrame(harness, firstNormalFrame));
    expect(firstNormal).toMatchObject({
      ok: true,
      delivered: {
        uid: 1000,
        pid: target.pid,
        runId: expect.any(String),
        queued: false,
      },
    });

    const firstOutbound = await waitForOutbound(
      harness,
      ACCOUNT_ID,
      workOutboundOffset + 1,
    );
    expect(firstOutbound.find(({ message }) => (
      message.replyToId === "normal-one-message"
    ))).toMatchObject({
      accountId: ACCOUNT_ID,
      message: {
        deliveryId: expect.any(String),
        surface: SURFACE,
        actorId: ACTOR_ID,
        text: `[WORK SESSION] ${INTEGRATION_REPLY}`,
        replyToId: "normal-one-message",
      },
    });

    const secondNormal = inboundResult(await sendServiceFrame(harness, inboundFrame({
      id: "normal-two",
      deliveryId: "normal-two-delivery",
      messageId: "normal-two-message",
      text: "second routed adapter message",
    })));
    expect(secondNormal.delivered).toMatchObject({ pid: target.pid, queued: false });

    const twoOutbound = await waitForOutbound(
      harness,
      ACCOUNT_ID,
      workOutboundOffset + 2,
    );
    expect(twoOutbound.find(({ message }) => (
      message.replyToId === "normal-two-message"
    ))?.message).toMatchObject({
      surface: SURFACE,
      actorId: ACTOR_ID,
      text: `[WORK SESSION] ${INTEGRATION_REPLY}`,
      replyToId: "normal-two-message",
    });

    const routedHistory = await client.proc.history({ pid: target.pid });
    expect(routedHistory).toMatchObject({ ok: true, messageCount: 6 });
    if (!routedHistory.ok) throw new Error(routedHistory.error);
    expect(routedHistory.messages[0]).toMatchObject({
      role: "user",
      content: "first routed adapter message",
      runId: firstNormal.delivered?.runId,
      origin: {
        kind: "adapter",
        adapter: "discord",
        accountId: ACCOUNT_ID,
        surface: SURFACE,
        actorId: ACTOR_ID,
        actorLabel: "@integration",
        messageId: "normal-one-message",
      },
    });
    expect(routedHistory.messages[1]).toMatchObject({
      role: "assistant",
      content: expect.objectContaining({
        toolCalls: [expect.objectContaining({ name: "Message" })],
      }),
      runId: firstNormal.delivered?.runId,
    });
    expect(routedHistory.messages[2]).toMatchObject({
      role: "toolResult",
      content: expect.objectContaining({ toolName: "Message" }),
      runId: firstNormal.delivered?.runId,
    });
    expect(routedHistory.messages[3]).toMatchObject({
      role: "user",
      content: "second routed adapter message",
      runId: secondNormal.delivered?.runId,
    });
    expect(routedHistory.messages[4]).toMatchObject({
      role: "assistant",
      content: expect.objectContaining({
        toolCalls: [expect.objectContaining({ name: "Message" })],
      }),
      runId: secondNormal.delivered?.runId,
    });
    expect(routedHistory.messages[5]).toMatchObject({
      role: "toolResult",
      content: expect.objectContaining({ toolName: "Message" }),
      runId: secondNormal.delivered?.runId,
    });

    const afterNormal = await client.proc.list();
    expect(afterNormal.processes.map(({ pid }) => pid)).toEqual(
      beforeNormal.processes.map(({ pid }) => pid),
    );
    expect(await client.proc.history({ pid: target.pid })).toMatchObject({
      ok: true,
      messageCount: 6,
      messages: [
        expect.objectContaining({ content: "first routed adapter message" }),
        expect.objectContaining({ role: "assistant" }),
        expect.objectContaining({ role: "toolResult" }),
        expect.objectContaining({ content: "second routed adapter message" }),
        expect.objectContaining({ role: "assistant" }),
        expect.objectContaining({ role: "toolResult" }),
      ],
    });

    const replayedNormal = inboundResult(await sendServiceFrame(harness, {
      ...firstNormalFrame,
      id: "normal-one-replay",
    }));
    expect(replayedNormal).toEqual({ ...firstNormal, replayed: "completed" });
    expect(await listOutbound(harness, ACCOUNT_ID)).toHaveLength(twoOutbound.length);
    expect(await client.proc.history({ pid: target.pid })).toMatchObject({
      ok: true,
      messageCount: 6,
    });

    const returnHomeFrame = inboundFrame({
      id: "return-home",
      deliveryId: "return-home-delivery",
      messageId: "return-home-message",
      text: "/home",
    });
    const returnedHome = inboundResult(await sendServiceFrame(harness, returnHomeFrame));
    expect(returnedHome).toMatchObject({
      ok: true,
      reply: {
        text: expect.stringContaining("[PERSONAL HOME]"),
        replyToId: "return-home-message",
      },
    });
    expect(inboundResult(await sendServiceFrame(harness, {
      ...returnHomeFrame,
      id: "return-home-replay",
    }))).toEqual({ ...returnedHome, replayed: "completed" });

    const afterHome = inboundResult(await sendServiceFrame(harness, inboundFrame({
      id: "after-home",
      deliveryId: "after-home-delivery",
      messageId: "after-home-message",
      text: "back at personal home",
    })));
    expect(afterHome).toMatchObject({
      ok: true,
      delivered: {
        pid: personalProcesses[0]!.pid,
        runId: expect.any(String),
      },
    });
  });

  async function setupClient(): Promise<GSVClient> {
    const oneShot = new GSVClient();
    await oneShot.requestOnce(webSocketUrl(baseUrl), "sys.setup", {
      username: USERNAME,
      password: PASSWORD,
      agentName: "runtime-agent",
      timezone: "Europe/Amsterdam",
    });

    const client = new GSVClient({
      url: webSocketUrl(baseUrl),
      username: USERNAME,
      password: PASSWORD,
      client: {
        id: CLIENT_ID,
        version: "1.0.0",
        platform: "node",
        role: "user",
      },
    });
    clients.add(client);
    await client.connect();
    return client;
  }
});

async function configureDeterministicAi(
  client: GSVClient,
  pid: string,
  baseUrl: string,
): Promise<void> {
  // SAFETY: The client command name is a stable protocol literal accepted by the test client.
  const result = await client.call<ProcAiConfigSetResult>("proc.ai.config.set" as string, {
    pid,
    values: {
      "config/ai/provider": "custom",
      "config/ai/model": "integration-model",
      "config/ai/base_url": baseUrl,
      "config/ai/provider_style": "openai-chat-completions",
      "config/ai/transport_target": "gsv",
      "config/ai/api_key": "fixture-only",
      "config/ai/reasoning": "off",
      "config/ai/generation/timeout_ms": "5000",
      "config/ai/fallback_model_profile": "integration-no-fallback",
    },
  });
  expect(result).toMatchObject({
    ok: true,
    pid,
    config: {
      values: {
        "config/ai/provider": "custom",
        "config/ai/model": "integration-model",
        "config/ai/base_url": baseUrl,
        "config/ai/provider_style": "openai-chat-completions",
        "config/ai/transport_target": "gsv",
        "config/ai/api_key": "redacted",
        "config/ai/reasoning": "off",
        "config/ai/generation/timeout_ms": "5000",
        "config/ai/fallback_model_profile": "integration-no-fallback",
      },
    },
  });
}

async function processHistoryCounts(client: GSVClient): Promise<Array<{
  pid: string;
  messageCount: number;
}>> {
  const { processes } = await client.proc.list();
  const pids = processes.map(({ pid }) => pid).sort();
  return await Promise.all(pids.map(async (pid) => {
    const history = await client.proc.history({ pid });
    if (!history.ok) throw new Error(history.error);
    return { pid, messageCount: history.messageCount };
  }));
}

async function waitForPendingHil(
  client: GSVClient,
  pid: string,
  runId: string,
): Promise<ProcHilRequest> {
  let pending: ProcHilRequest | null = null;
  await waitFor(async () => {
    const history = await client.proc.history({ pid });
    if (!history.ok || history.pendingHil?.runId !== runId) {
      return false;
    }
    pending = history.pendingHil;
    return true;
  }, `pending approval for ${runId}`);
  if (!pending) {
    throw new Error(`Process ${pid} did not expose approval for ${runId}`);
  }
  return pending;
}

function inboundFrame(options: {
  id: string;
  deliveryId: string;
  messageId: string;
  text: string;
  actor?: { id: string; name?: string; handle?: string };
}): AdapterGatewayRequestFrame {
  return {
    type: "req",
    id: options.id,
    call: "adapter.inbound",
    args: {
      adapter: "discord",
      accountId: ACCOUNT_ID,
      deliveryId: options.deliveryId,
      message: {
        messageId: options.messageId,
        surface: SURFACE,
        actor: options.actor ?? { id: ACTOR_ID },
        text: options.text,
        timestamp: Date.now(),
        wasMentioned: true,
      },
    },
  };
}

async function sendServiceFrame(
  harness: TestHarness,
  frame: AdapterGatewayRequestFrame,
): Promise<AdapterGatewayResponseFrame> {
  const response = await harness.getWorker("gsv-test-dependencies").fetch(
    "http://gsv-test-dependencies/__test/service-frame",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        installation: {
          installationId: SINGLETON_INSTALLATION_ID,
        },
        frame,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Test dependency service-frame endpoint returned ${response.status}`);
  }
  return adapterGatewayResponseFrameSchema.parse(await response.json());
}

function inboundResult(response: AdapterGatewayResponseFrame): AdapterInboundResult {
  if (!response.ok) {
    throw new Error(response.error?.message ?? "Gateway rejected adapter ingress");
  }
  if (response.data === undefined || !isAdapterInboundResult(response.data)) {
    throw new Error("Gateway returned an invalid adapter ingress result");
  }
  return response.data;
}

async function listOutbound(
  harness: TestHarness,
  accountId: string,
): Promise<RecordedOutboundMessage[]> {
  const response = await harness.getWorker("gsv-test-dependencies").fetch(
    `http://gsv-test-dependencies/__test/outbound?installationId=${encodeURIComponent(SINGLETON_INSTALLATION_ID)}&accountId=${encodeURIComponent(accountId)}`,
  );
  if (!response.ok) {
    throw new Error(`Test dependency outbound endpoint returned ${response.status}`);
  }
  const body = await response.json();
  if (!Array.isArray(body)) throw new Error("Gateway returned invalid outbound messages");
  // SAFETY: The test dependency endpoint returns the recorded outbound message contract.
  return body as RecordedOutboundMessage[];
}

async function waitForOutbound(
  harness: TestHarness,
  accountId: string,
  count: number,
): Promise<RecordedOutboundMessage[]> {
  let messages: RecordedOutboundMessage[] = [];
  await waitFor(async () => {
    messages = await listOutbound(harness, accountId);
    return messages.length >= count;
  }, `${count} adapter outbound message(s)`);
  return messages;
}

async function expectArchive(
  harness: TestHarness,
  client: GSVClient,
  path: string,
): Promise<void> {
  const response = await client.request("fs.transfer.stat", { path });
  expect(response.data).toMatchObject({
    ok: true,
    path,
    size: expect.any(Number),
    isFile: true,
    isDirectory: false,
  });

  const env = await harness.getWorker<GatewayTestEnv>("gsv").getEnv();
  const object = await env.STORAGE.head(path.replace(/^\//, ""));
  expect(object).toMatchObject({ size: expect.any(Number) });
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
