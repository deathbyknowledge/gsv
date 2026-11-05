import { GSVClient } from "@humansandmachines/gsv";
import {
  isAdapterInboundResult,
  wireFrameSchemas,
  type AdapterInboundResult,
  type ContactSummary,
} from "@humansandmachines/gsv/protocol";
import type { TestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { TestShipNetwork } from "../src/test-support/ship-network";
import { CENSUS_EVENT_TYPES, CENSUS_ROUTES } from "./census-types";
import { UNDELIVERABLE_REPLY } from "./fixtures/messenger-faults";
import { createGatewayTestHarness, webSocketUrl } from "./harness";
import { startProcessRuntimeHarness, type ProcessRuntimeHarness } from "./process-runtime-harness";

const INSTALLATION_ID = "inst_integration_default";
const OWNER_UID = 1000;
const SHIP = `personal:${OWNER_UID}`;
const CENSUS_DOMAIN = "census.ship.test";
const PEER_DOMAIN = "peer.ship.test";
const PEER_USER = "census-peer";
const PEER_PASSWORD = "census-peer-password";
const ACCOUNT_ID = "census-inbound";
const ACTOR_ID = "discord:user-census";
const SURFACE = { kind: "dm" as const, id: "discord:dm-census" };
const WAIT_MS = 60_000;

const logRowSchema = z.object({
  seq: z.number(),
  type: z.string(),
  consumer: z.string().nullable(),
  lane: z.string().nullable(),
  state: z.string().nullable(),
  runId: z.string().nullable(),
  pid: z.string().nullable(),
});
type LogRow = z.infer<typeof logRowSchema>;

const shellOutputSchema = z.object({ exitCode: z.number(), output: z.string() });

/**
 * Fires every producer of agent work on one clean instance, then reads the Kernel's event
 * log: every registered type is there, delivered where it belongs, and every run a process
 * holds was started or joined by a delivery the log made to that process.
 */
describe("event census", () => {
  let network: TestShipNetwork;
  let runtime: ProcessRuntimeHarness;
  let peerHarness: TestHarness;
  let peer: GSVClient;
  let shipPid: string;
  let worker: string;

  beforeAll(async () => {
    const passthrough = globalThis.fetch;
    network = new TestShipNetwork().install();
    peerHarness = createGatewayTestHarness({ network: { domain: PEER_DOMAIN } });
    const peerOrigin = await serveOnNetwork(network, peerHarness, (await peerHarness.listen()).url, PEER_DOMAIN);
    runtime = await startProcessRuntimeHarness({
      network: { domain: CENSUS_DOMAIN },
      // The census Ship meets the peer on the open network, so its owner makes their profile public.
      profile: "public",
      beforeSetup: async (harness, url) => { await serveOnNetwork(network, harness, url, CENSUS_DOMAIN); },
    });
    // The scripted model is a local server, not a Ship on the test network.
    network.hosts.set(new URL(runtime.ai.baseUrl).host, (request) => passthrough(request));
    await new GSVClient().requestOnce(webSocketUrl(peerOrigin), "sys.setup", {
      onboardingToken: "integration-onboarding-default",
      username: PEER_USER,
      password: PEER_PASSWORD,
      agentName: "census_peer_ship",
      timezone: "Europe/Amsterdam",
      profile: "public",
    });
    peer = new GSVClient({
      url: webSocketUrl(peerOrigin), username: PEER_USER, password: PEER_PASSWORD,
      peer: { id: "census-peer-client", version: "1.0.0", platform: "integration" },
    });
    await peer.connect();
    // The census watches where work goes, not who approves it.
    await runtime.client.sys.config.set({
      key: `users/${OWNER_UID}/ai/tools/approval`,
      value: JSON.stringify({ default: "auto", rules: [] }),
    });
  });

  afterAll(async () => {
    peer?.close();
    await Promise.allSettled([runtime?.close(), peerHarness?.close()]);
    vi.restoreAllMocks();
  });

  it("delivers the welcome and a person's message to Ship", async () => {
    await runtime.settleWelcome();
    const ship = (await runtime.client.proc.list({})).processes.find(({ personal }) => personal);
    if (!ship) throw new Error("No Ship after the welcome");
    shipPid = ship.pid;
    expect(await rows("responsibility.ready")).toContainEqual(expect.objectContaining({ consumer: SHIP, pid: shipPid, state: "delivered" }));

    const { conversation } = await runtime.client.conversation.ship({});
    const sent = await runtime.client.conversation.send({ conversationId: conversation.id, text: "Census: hello, Ship." });
    await waitForRun(shipPid, sent.runId);
    expect(await rows("message.received")).toContainEqual(expect.objectContaining({
      consumer: SHIP, lane: "person", state: "delivered", pid: shipPid, runId: sent.runId,
    }));
  });

  it("routes a messenger's messages to Ship and to work, reports a reply it refuses, and returns to Ship", async () => {
    await (await kernelStorage()).exec(
      `INSERT INTO identity_links (adapter, account_id, actor_id, uid, created_at, linked_by_uid, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      "discord", ACCOUNT_ID, ACTOR_ID, OWNER_UID, Date.now(), OWNER_UID,
      JSON.stringify({ surfaceKind: SURFACE.kind, surfaceId: SURFACE.id }),
    );
    const work = (await runtime.spawn("census messenger work")).pid;

    // Only Ship, in its own run, opens a private chat's direct line to work, so it is scripted for this one turn.
    await runtime.configureAi(shipPid);
    runtime.ai.enqueue(
      { kind: "tool-calls", calls: [{ id: "census-route", name: "Shell", arguments: { input: `message route set --process ${work} --to here` } }] },
      { kind: "message", text: "Census: the line is open." },
    );
    const toShip = await inbound("census-ship", "Census: open a line to the work process.");
    expect(toShip.delivered).toMatchObject({ pid: shipPid });
    if (!toShip.delivered) throw new Error("The messenger's message did not reach Ship");
    await waitForRun(shipPid, toShip.delivered.runId);
    expect(await rows("message.received")).toContainEqual(expect.objectContaining({
      consumer: SHIP, lane: "person", state: "delivered", pid: shipPid, runId: toShip.delivered.runId,
    }));
    const restored = await runtime.client.proc.ai.config.set({ pid: shipPid, modelId: "background-fixture", reasoning: "off" });
    if (!restored.ok) throw new Error(restored.error);

    await runtime.configureAi(work);
    runtime.ai.enqueue({ kind: "message", text: UNDELIVERABLE_REPLY });
    const toWork = await inbound("census-work", "Census: a message for the work process.");
    expect(toWork.delivered).toMatchObject({ pid: work });
    await waitForLog("delivery.failed to the work process", async () => (await rows("delivery.failed")).some(({ consumer, state }) => consumer === `proc:${work}` && state === "delivered"));
    expect(await rows("message.received")).toContainEqual(expect.objectContaining({ consumer: `proc:${work}`, state: "delivered", runId: toWork.delivered?.runId }));

    await inbound("census-return", "/ship");
    await waitForLog("work.returned to Ship", async () => (await rows("work.returned")).some(({ consumer, lane, state }) => consumer === SHIP && lane === "person" && state === "delivered"));
  });

  it("delivers a person's prompt and message to a process, and a process's prompt to its child", async () => {
    worker = (await runtime.spawn("census worker", { prompt: "Census: start." })).pid;
    const sent = await runtime.client.proc.send({ pid: worker, message: "Census: a message for the worker." });
    if (!sent.ok) throw new Error(sent.error);
    await waitForRun(worker, sent.runId);
    // A person's prompt and message stop the process's run, on the person lane.
    const toWorker = (await rows("message.received")).filter(({ consumer }) => consumer === `proc:${worker}`);
    expect(toWorker).toHaveLength(2);
    expect(toWorker).toContainEqual(expect.objectContaining({ lane: "person", state: "delivered", pid: worker, runId: sent.runId }));

    // A process's prompt waits its turn, on the background lane.
    await shell(worker, "proc spawn --label census-child --prompt 'Census: a prompt from a process.'");
    await waitForLog("process.message to the child", async () => {
      const child = (await runtime.client.proc.list({})).processes.find(({ label }) => label === "census-child");
      return child !== undefined && (await rows("process.message")).some(({ consumer, lane, state }) =>
        consumer === `proc:${child.pid}` && lane === "background" && state === "delivered");
    });
  });

  it("carries process messages, calls and their ends between processes", async () => {
    const callee = (await runtime.spawn("census callee")).pid;
    await shell(worker, `proc send ${callee} Census: a note between processes.`);
    await shell(worker, `proc call ${callee} --timeout 60s Census: a question with an answer.`);
    await waitForLog("ipc.message to the callee", async () => (await rows("ipc.message")).some(({ consumer, state }) => consumer === `proc:${callee}` && state === "delivered"));
    await waitForLog("ipc.reply to the worker", async () => (await rows("ipc.reply")).some(({ consumer, state }) => consumer === `proc:${worker}` && state === "delivered"));

    // A callee that can't answer before its caller's deadline: the caller hears of the timeout.
    const slow = (await runtime.spawn("census slow callee")).pid;
    await runtime.configureAi(slow);
    const held = runtime.ai.hold({ kind: "message", text: "Too late." });
    await shell(worker, `proc call ${slow} --timeout 1s Census: a question answered too late.`);
    await held.started;
    await waitForLog("ipc.timeout to the worker", async () => (await rows("ipc.timeout")).some(({ consumer, state }) => consumer === `proc:${worker}` && state === "delivered"));
    held.release();

    // A delegated task that outlasts its check-in: the caller hears it is overdue, then its answer.
    await shell(worker, "proc delegate --check-after 1s --label census-delegate Census: a task that outlasts its check-in.");
    await waitForLog("ipc.overdue to the worker", async () => (await rows("ipc.overdue")).some(({ consumer, state }) => consumer === `proc:${worker}` && state === "delivered"));
    await waitForLog("the delegate's answer", async () => (await rows("ipc.reply")).filter(({ consumer }) => consumer === `proc:${worker}`).length === 2);
    expect((await rows("ipc.call")).filter(({ state }) => state === "delivered")).toHaveLength(3);
  });

  it("tells a watching process when a target's connection changes", async () => {
    const machine = await runtime.connectMachine("census-machine");
    const watch = { signal: "target.status", targetId: "census-machine", key: "census-target", once: false };
    await shell(worker, `signal watch --json '${JSON.stringify(watch)}'`);
    machine.close();
    await waitForLog("target.status to the worker", async () => (await rows("target.status")).some(({ consumer, state }) => consumer === `proc:${worker}` && state === "delivered"));
  });

  it("fires schedules into a process, a new process and Ship's ledger", async () => {
    const before = (await rows("responsibility.ready")).length;
    const soon = { kind: "after" as const, afterMs: 1_000 };
    await runtime.client.sched.add({ name: "census event", expression: soon, target: { kind: "process.event", pid: worker, message: "Census: a scheduled event." } });
    await runtime.client.sched.add({ name: "census spawn", expression: soon, target: { kind: "process.spawn", label: "census scheduled", prompt: "Census: a scheduled process." } });
    await runtime.client.sched.add({ name: "census ledger", expression: soon, target: { kind: "responsibility", message: "Census: a scheduled responsibility." } });
    await waitForLog("schedule.fired to the worker", async () => (await rows("schedule.fired")).some(({ consumer, state }) => consumer === `proc:${worker}` && state === "delivered"));
    // A scheduled spawn's context carries no origin of its own, so its prompt arrives as its owner's message.
    await waitForLog("the scheduled process's prompt", async () => {
      const scheduled = (await runtime.client.proc.list({})).processes.find(({ label }) => label === "census scheduled");
      return scheduled !== undefined && (await rows("message.received")).some(({ consumer, state }) => consumer === `proc:${scheduled.pid}` && state === "delivered");
    });
    await waitForLog("the scheduled responsibility for Ship", async () => (await rows("responsibility.ready")).filter(({ state }) => state === "delivered").length > before);
  });

  it("logs a source's event, tells its owner and wakes Ship", async () => {
    const before = (await rows("responsibility.ready")).length;
    await runtime.client.request("event.source.add", { name: "census-feed", notify: "messenger", ship: "wake" });
    expect((await runtime.client.request("event.emit", { source: "census-feed", events: [{ title: "Census reading" }] })).data)
      .toEqual({ accepted: 1, duplicates: 0 });
    // A source's events are the log's own record: no consumer takes them.
    expect(await rows("source.event")).toEqual([expect.objectContaining({ consumer: null })]);
    await waitForLog("owner.notified for Ship", async () => (await rows("owner.notified")).some(({ consumer, state }) => consumer === SHIP && state === "delivered"));
    await waitForLog("the source's responsibility for Ship", async () => (await rows("responsibility.ready")).filter(({ state }) => state === "delivered").length > before);
  });

  it("hands a contact's message to Ship once Ship handles that contact", async () => {
    const invite = await runtime.client.contact.invite.create({ expiresInSeconds: 300 });
    await peer.contact.invite.accept({ code: invite.code });
    const contact = await firstContact(runtime.client);
    const remote = await firstContact(peer);
    if (!contact.preferences) throw new Error("A contact has preferences");
    await runtime.client.contact.preferences.update({ contactId: contact.id, expectedRevision: contact.preferences.revision, patch: { shipHandlesMessages: true } });
    await waitForLog("the peer's message delivered", async () => (await peer.contact.send({
      contactId: remote.id, text: "Census: hello from another Ship.", idempotencyKey: "census-contact",
    })).state === "delivered");
    await waitForLog("contact.message to Ship", async () => (await rows("contact.message")).some(({ consumer, state }) => consumer === SHIP && state === "delivered"));
  });

  it("logs every registered type, and every run a process holds came from a delivery", async () => {
    await waitForLog("every delivery to end and every process to rest", async () => {
      const log = await readLog();
      if (log.some(({ state }) => state === "pending")) return false;
      return (await runtime.client.proc.list({})).processes.every(({ activeRunId, queuedCount }) => activeRunId === null && queuedCount === 0);
    }, 90_000);
    const log = await readLog();
    const logged = new Set(log.map(({ type }) => type));
    expect({
      missing: CENSUS_EVENT_TYPES.filter((type) => !logged.has(type)),
      misrouted: log.filter((row) => !routedAsListed(row)).map(({ seq, type, consumer, lane }) => `${type} #${seq} to ${consumer ?? "no one"} on ${lane ?? "no lane"}`),
      refused: log.filter(({ state }) => state === "failed"),
      outsideTheLog: await runsOutsideTheLog(log),
    }).toEqual({ missing: [], misrouted: [], refused: [], outsideTheLog: [] });
  }, 120_000);

  async function kernelStorage() {
    return await runtime.harness.getWorker("gsv").getDurableObjectStorage("KERNEL", { name: INSTALLATION_ID });
  }

  /** Every event the Kernel logged, once per delivery it routed, or once alone when it routed none. */
  async function readLog(): Promise<LogRow[]> {
    return z.array(logRowSchema).parse(await (await kernelStorage()).exec(`
      SELECT e.seq, e.type, d.consumer, d.lane, d.state, d.run_id AS runId, json_extract(d.outcome_json, '$.pid') AS pid
      FROM events e LEFT JOIN deliveries d ON d.seq = e.seq
      ORDER BY e.seq, d.consumer`));
  }

  async function rows(type: string): Promise<LogRow[]> {
    return (await readLog()).filter((row) => row.type === type);
  }

  /**
   * The runs each live process holds that no delivery started or joined. A run's id is the id
   * its Process admitted it under, and the log records that id beside the delivery it admitted.
   */
  async function runsOutsideTheLog(log: LogRow[]): Promise<string[]> {
    const delivered = new Set(log.flatMap(({ state, pid, runId }) => state === "delivered" && pid && runId ? [`${pid} ${runId}`] : []));
    const strays: string[] = [];
    for (const { pid, label } of (await runtime.client.proc.list({})).processes) {
      const history = await runtime.client.proc.history({ pid, format: 2, limit: 1000 });
      if (!history.ok || history.format !== 2) throw new Error(`No typed history for ${pid}`);
      const runs = new Set(history.records.flatMap(({ runId }) => runId ? [runId] : []));
      for (const runId of runs) {
        if (!delivered.has(`${pid} ${runId}`)) strays.push(`${label ?? pid}: ${runId}`);
      }
    }
    return strays;
  }

  async function waitForLog(description: string, predicate: () => Promise<boolean>, timeoutMs = WAIT_MS): Promise<void> {
    await runtime.waitFor(predicate, description, timeoutMs);
  }

  /** Waits for a process to finish a run it was given, read from its history wherever the run's output went. */
  async function waitForRun(pid: string, runId: string): Promise<void> {
    const finished = async () => {
      const history = await runtime.client.proc.history({ pid, format: 2, tail: true, limit: 50 });
      if (!history.ok || history.format !== 2) throw new Error(`No typed history for ${pid}`);
      return history.activeRunId !== runId && history.records.some((record) => record.runId === runId);
    };
    try {
      await runtime.waitFor(finished, `run ${runId} to finish`, WAIT_MS);
    } catch (error) {
      const history = await runtime.client.proc.history({ pid, format: 2, tail: true, limit: 10 });
      const state = history.ok && history.format === 2
        ? { activeRunId: history.activeRunId, pendingHil: history.pendingHil?.syscall ?? null, records: history.records.map(({ kind, runId: id }) => `${kind}@${id}`) }
        : history;
      throw new Error(`${error instanceof Error ? error.message : String(error)}: ${JSON.stringify(state)}`);
    }
  }

  /** Runs a shell command as the process itself, as its own CodeMode would. */
  async function shell(pid: string, command: string): Promise<string> {
    const ran = await runtime.client.codemode.run({ pid, target: "gsv", code: `return await shell(${JSON.stringify(command)});` });
    if (ran.status !== "completed") throw new Error(`${command}: ${ran.error}`);
    const result = shellOutputSchema.parse(ran.result);
    if (result.exitCode !== 0) throw new Error(`${command}: exit ${result.exitCode}: ${result.output}`);
    return result.output;
  }

  /** A message from the linked messenger actor in their private chat. */
  async function inbound(id: string, text: string): Promise<AdapterInboundResult> {
    const response = await runtime.harness.getWorker("gsv-test-dependencies").fetch("http://gsv-test-dependencies/__test/service-frame/discord", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        installation: { installationId: INSTALLATION_ID },
        frame: {
          type: "req", id, call: "adapter.inbound",
          args: {
            adapter: "discord", accountId: ACCOUNT_ID, deliveryId: `${id}-delivery`,
            message: { messageId: `${id}-message`, surface: SURFACE, actor: { id: ACTOR_ID }, text, timestamp: Date.now(), wasMentioned: true },
          },
        },
      }),
    });
    if (!response.ok) throw new Error(`The service-frame endpoint answered ${response.status}`);
    const frame = wireFrameSchemas.response.parse(await response.json());
    if (!frame.ok) throw new Error(frame.error?.message ?? "The Gateway refused the message");
    if (frame.data === undefined || !isAdapterInboundResult(frame.data)) throw new Error("The Gateway answered with no ingress result");
    return frame.data;
  }

  async function firstContact(client: GSVClient): Promise<ContactSummary> {
    let found: ContactSummary | undefined;
    await runtime.waitFor(async () => {
      found = (await client.contact.list({})).contacts[0];
      return found !== undefined;
    }, "a contact", WAIT_MS);
    if (!found) throw new Error("No contact");
    return found;
  }
});

/** Whether a delivery went to the kind of consumer, on the lane, its type's census row lists; an event with no row routes nowhere. */
function routedAsListed({ type, consumer, lane }: LogRow): boolean {
  const route = Object.entries(CENSUS_ROUTES).find(([listed]) => listed === type)?.[1];
  if (!route) return false;
  if (consumer === null) return route.to.length === 0;
  const to = consumer.startsWith("personal:") ? "ship" : consumer.startsWith("proc:") ? "process" : null;
  return route.to.some((listed) => listed === to) && route.lane === lane;
}

/** Serves a harness's Ship and its repository host on the test network, before its setup publishes it there. */
async function serveOnNetwork(network: TestShipNetwork, harness: TestHarness, url: URL, domain: string): Promise<URL> {
  const origin = new URL(url);
  origin.hostname = "localhost";
  const dependencies = harness.getWorker("gsv-test-dependencies");
  const response = await dependencies.fetch("http://gsv-test-dependencies/__test/default-origin", { method: "POST", body: origin.origin });
  if (response.status !== 204) throw new Error(`The default origin was refused: ${response.status}`);
  network.hosts.set(`default.${domain}`, servedBy((input, init) => harness.fetch(input, init)));
  network.hosts.set(`pds.${domain}`, servedBy((input, init) => dependencies.fetch(input, init)));
  return origin;
}

/** A host on the test network that a harness serves, as its Worker sees the request. */
function servedBy(serve: TestHarness["fetch"]): (request: Request) => Promise<Response> {
  return async (request) => {
    // SAFETY: In this Node process the network's requests are Node's own, which the harness takes as its init.
    const answer = await serve(request.url, request as never);
    // SAFETY: The harness answers with Node's own Response, the class the network's callers receive.
    return answer as never;
  };
}
