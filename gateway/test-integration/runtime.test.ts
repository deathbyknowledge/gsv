import { GSVClient } from "@humansandmachines/gsv";
import {
  isAdapterInboundResult,
  type AdapterGatewayRequestFrame,
  type AdapterGatewayResponseFrame,
  type AdapterInboundResult,
  type ProcAiConfigSetResult,
} from "@humansandmachines/gsv/protocol";
import type { TestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGatewayTestHarness, webSocketUrl } from "./harness";
import {
  INTEGRATION_REPLY,
  startOpenAiFixture,
  type OpenAiFixture,
} from "./openai-fixture";

const USERNAME = "runtime-user";
const PASSWORD = "runtime-integration-password";
const CLIENT_ID = "runtime-integration";
const ACCOUNT_ID = "integration-inbound";
const ACTOR_ID = "discord:user-42";
const SURFACE = { kind: "dm" as const, id: "discord:dm-42" };

type RunSignal = {
  signal: string;
  payload: Record<string, unknown>;
};

type RecordedOutboundMessage = {
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
  let client: GSVClient;
  let ai: OpenAiFixture;
  let preSetupServiceResponse: AdapterGatewayResponseFrame;

  beforeAll(async () => {
    ai = await startOpenAiFixture();
    harness = createGatewayTestHarness();
    ({ url: baseUrl } = await harness.listen());

    preSetupServiceResponse = await sendServiceFrame(harness, inboundFrame({
      id: "pre-setup",
      deliveryId: "pre-setup-delivery",
      messageId: "pre-setup-message",
      text: "hello before setup",
    }));

    const oneShot = new GSVClient();
    await oneShot.requestOnce(webSocketUrl(baseUrl), "sys.setup", {
      username: USERNAME,
      password: PASSWORD,
      agentName: "runtime-agent",
      timezone: "Europe/Amsterdam",
    });

    client = new GSVClient({
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
    await client.connect();
  });

  afterAll(async () => {
    client?.close();
    await harness?.close();
    await ai?.close();
  });

  it("runs inference, history, reset, and kill through real process boundaries", async () => {
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
      if (payload && typeof payload === "object") {
        signals.push({ signal, payload: payload as Record<string, unknown> });
      }
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
        (event as Record<string, unknown>).type
      )).toEqual([
        "start",
        "text_start",
        "text_delta",
        "text_end",
        "done",
      ]);
      expect(streamPayloads.map(({ seq }) => seq)).toEqual([1, 2, 3, 4, 5]);

      const runSignals = signals
        .filter(({ payload }) => payload.runId === runId)
        .map(({ signal }) => signal);
      expect(runSignals).toEqual(expect.arrayContaining([
        "proc.run.started",
        "proc.run.stream",
        "proc.run.output",
        "proc.run.finished",
      ]));
      expect(signals).toContainEqual(expect.objectContaining({
        signal: "proc.run.output",
        payload: expect.objectContaining({
          pid: spawned.pid,
          runId,
          text: INTEGRATION_REPLY,
        }),
      }));
      expect(signals).toContainEqual(expect.objectContaining({
        signal: "proc.run.finished",
        payload: expect.objectContaining({
          pid: spawned.pid,
          runId,
          status: "ok",
          reason: "turn.complete",
          text: INTEGRATION_REPLY,
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
      messageCount: 4,
      activeRunId: null,
    });
    if (!history.ok) throw new Error(history.error);
    expect(history.messages.map(({ role, content, runId }) => ({ role, content, runId }))).toEqual([
      { role: "user", content: "first deterministic message", runId: first.runId },
      { role: "assistant", content: INTEGRATION_REPLY, runId: first.runId },
      { role: "user", content: "second deterministic message", runId: second.runId },
      { role: "assistant", content: INTEGRATION_REPLY, runId: second.runId },
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
          stopReason: "stop",
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
      archivedMessages: 4,
      archivedTo: expect.stringMatching(/\.history\.gen-1\.jsonl\.gz$/),
      archives: [expect.objectContaining({ generation: 1, messages: 4 })],
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
      if (payload && typeof payload === "object") {
        thirdSignals.push({ signal, payload: payload as Record<string, unknown> });
      }
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
      archivedMessages: 2,
      archivedTo: expect.stringMatching(/\.history\.gen-2\.jsonl\.gz$/),
      archives: expect.arrayContaining([
        expect.objectContaining({ generation: 2, messages: 2 }),
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
    const usePersonalFrame = inboundFrame({
      id: "use-personal",
      deliveryId: "use-personal-delivery",
      messageId: "use-personal-message",
      text: "/use personal",
    });
    const usePersonal = inboundResult(await sendServiceFrame(harness, usePersonalFrame));
    expect(usePersonal).toMatchObject({
      ok: true,
      reply: {
        deliveryId: expect.stringMatching(/^adapter-ingress:[0-9a-f]{64}:reply$/),
        text: "This chat now uses a new personal-agent process.",
        replyToId: "use-personal-message",
      },
    });
    expect(inboundResult(await sendServiceFrame(harness, {
      ...usePersonalFrame,
      id: "use-personal-replay",
    }))).toEqual({ ...usePersonal, replayed: "completed" });

    const afterPersonal = await client.proc.list();
    const newPersonalProcesses = afterPersonal.processes.filter(({ pid }) =>
      !beforePersonal.processes.some((process) => process.pid === pid)
    );
    expect(newPersonalProcesses).toEqual([
      expect.objectContaining({
        pid: expect.stringMatching(/^proc:adapter-ingress:[0-9a-f]{64}$/),
        username: "runtime-agent",
        interactive: true,
      }),
    ]);

    const wherePersonal = inboundResult(await sendServiceFrame(harness, inboundFrame({
      id: "where-personal",
      deliveryId: "where-personal-delivery",
      messageId: "where-personal-message",
      text: "/where",
    })));
    expect(wherePersonal.reply).toMatchObject({
      text: expect.stringContaining(newPersonalProcesses[0]!.pid.slice(0, 13)),
      replyToId: "where-personal-message",
    });

    const target = await client.proc.spawn({
      label: "adapter route target",
      interactive: true,
    });
    if (!target.ok) throw new Error(target.error);
    await configureDeterministicAi(client, target.pid, ai.baseUrl);

    const useTarget = inboundResult(await sendServiceFrame(harness, inboundFrame({
      id: "use-target",
      deliveryId: "use-target-delivery",
      messageId: "use-target-message",
      text: `/use ${target.pid}`,
    })));
    expect(useTarget.reply).toMatchObject({
      text: expect.stringContaining(target.pid.slice(0, 13)),
      replyToId: "use-target-message",
    });

    const whereTarget = inboundResult(await sendServiceFrame(harness, inboundFrame({
      id: "where-target",
      deliveryId: "where-target-delivery",
      messageId: "where-target-message",
      text: "/where",
    })));
    expect(whereTarget.reply).toMatchObject({
      text: expect.stringContaining(target.pid.slice(0, 13)),
      replyToId: "where-target-message",
    });

    const beforeNormal = await client.proc.list();
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

    const firstOutbound = await waitForOutbound(harness, ACCOUNT_ID, 1);
    expect(firstOutbound[0]).toMatchObject({
      accountId: ACCOUNT_ID,
      message: {
        deliveryId: expect.any(String),
        surface: SURFACE,
        actorId: ACTOR_ID,
        text: INTEGRATION_REPLY,
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

    const twoOutbound = await waitForOutbound(harness, ACCOUNT_ID, 2);
    expect(twoOutbound[1]?.message).toMatchObject({
      surface: SURFACE,
      actorId: ACTOR_ID,
      text: INTEGRATION_REPLY,
      replyToId: "normal-two-message",
    });

    const routedHistory = await client.proc.history({ pid: target.pid });
    expect(routedHistory).toMatchObject({ ok: true, messageCount: 4 });
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
      content: INTEGRATION_REPLY,
      runId: firstNormal.delivered?.runId,
    });
    expect(routedHistory.messages[2]).toMatchObject({
      role: "user",
      content: "second routed adapter message",
      runId: secondNormal.delivered?.runId,
    });
    expect(routedHistory.messages[3]).toMatchObject({
      role: "assistant",
      content: INTEGRATION_REPLY,
      runId: secondNormal.delivered?.runId,
    });

    const afterNormal = await client.proc.list();
    expect(afterNormal.processes.map(({ pid }) => pid)).toEqual(
      beforeNormal.processes.map(({ pid }) => pid),
    );
    expect(await client.proc.history({ pid: target.pid })).toMatchObject({
      ok: true,
      messageCount: 4,
      messages: [
        expect.objectContaining({ content: "first routed adapter message" }),
        expect.objectContaining({ content: INTEGRATION_REPLY }),
        expect.objectContaining({ content: "second routed adapter message" }),
        expect.objectContaining({ content: INTEGRATION_REPLY }),
      ],
    });

    const replayedNormal = inboundResult(await sendServiceFrame(harness, {
      ...firstNormalFrame,
      id: "normal-one-replay",
    }));
    expect(replayedNormal).toEqual({ ...firstNormal, replayed: "completed" });
    expect(await listOutbound(harness, ACCOUNT_ID)).toHaveLength(2);
    expect(await client.proc.history({ pid: target.pid })).toMatchObject({
      ok: true,
      messageCount: 4,
    });
  });
});

async function configureDeterministicAi(
  client: GSVClient,
  pid: string,
  baseUrl: string,
): Promise<void> {
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
      body: JSON.stringify(frame),
    },
  );
  if (!response.ok) {
    throw new Error(`Test dependency service-frame endpoint returned ${response.status}`);
  }
  return await response.json() as AdapterGatewayResponseFrame;
}

function inboundResult(response: AdapterGatewayResponseFrame): AdapterInboundResult {
  if (!response.ok) {
    throw new Error(response.error?.message ?? "Gateway rejected adapter ingress");
  }
  if (!isAdapterInboundResult(response.data)) {
    throw new Error("Gateway returned an invalid adapter ingress result");
  }
  return response.data;
}

async function listOutbound(
  harness: TestHarness,
  accountId: string,
): Promise<RecordedOutboundMessage[]> {
  const response = await harness.getWorker("gsv-test-dependencies").fetch(
    `http://gsv-test-dependencies/__test/outbound?accountId=${encodeURIComponent(accountId)}`,
  );
  if (!response.ok) {
    throw new Error(`Test dependency outbound endpoint returned ${response.status}`);
  }
  return await response.json() as RecordedOutboundMessage[];
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
    ok: false,
    error: expect.stringContaining("EACCES"),
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
