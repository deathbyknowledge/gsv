import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import * as processTransport from "../shared/utils";
import { testPeer } from "../test-support/peers";
import type { KernelContext } from "./context";
import { handleConversationSend } from "./conversation-handlers";
import type { Kernel } from "./do";
import * as personalController from "./personal-controller";
import { handleProcSend, handleProcSpawn } from "./proc-handlers";

const OWNER: ProcessIdentity = { uid: 1000, gid: 1000, gids: [1000, 100], username: "sam", home: "/home/sam", cwd: "/home/sam" };
const SHIP = "ship";
const WORKER = "worker";
const CLIENT = { kind: "client", connectionId: "connection-1", clientId: "desktop-1", platform: "macos" };
const REPLACED = { unavailable: "transitioning", message: "Process is being replaced" } as const;

afterEach(() => vi.restoreAllMocks());

async function fixture(work: (kernel: Kernel) => Promise<void>) {
  const stub = env.KERNEL.get(env.KERNEL.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, async (kernel: Kernel) => {
    // The tests run each pass themselves; no alarm runs one behind them.
    vi.spyOn(kernel.ctx.storage, "setAlarm").mockResolvedValue(undefined);
    vi.spyOn(personalController, "ensurePersonalController").mockResolvedValue(SHIP);
    try {
      kernel.caps.seed();
      kernel.auth.addUser({ username: OWNER.username, uid: OWNER.uid, gid: OWNER.gid, gecos: "Sam", home: OWNER.home, shell: "/bin/init" });
      kernel.auth.addGroup({ name: OWNER.username, gid: OWNER.gid, members: [] });
      kernel.auth.addGroup({ name: "users", gid: 100, members: [OWNER.username] });
      kernel.procs.spawn(SHIP, OWNER, { ownerUid: OWNER.uid, interactive: true, isPersonalController: true, label: "Ship" });
      kernel.procs.spawn(WORKER, OWNER, { ownerUid: OWNER.uid, interactive: true, label: "worker" });
      await work(kernel);
    } finally {
      // Test files share modules, so nothing this Kernel scheduled may run during a later test.
      kernel.ctx.storage.sql.exec("DELETE FROM cf_agents_schedules");
      await kernel.ctx.storage.deleteAlarm();
    }
  });
}

/** A spy that answers every Kernel; tests read only the calls their own Kernel made. */
function processes() {
  const deliver = vi.spyOn(processTransport, "deliverEventToProcess").mockImplementation(async (_installation, _pid, args) => (
    { eventId: args.eventId, runId: "input" in args ? args.input.runId ?? args.eventId : args.eventId, queued: false }
  ));
  const framed = vi.spyOn(processTransport, "sendFrameToProcess").mockImplementation(async (_installation, _pid, frame) => (
    frame.type === "req" && frame.call === "proc.setidentity" ? { type: "res", id: frame.id, ok: true, data: { ok: true } } : null
  ));
  return {
    deliver,
    delivered: (kernel: Kernel) => deliver.mock.calls.filter(([installationId]) => installationId === kernel.installationId),
    framed: (kernel: Kernel) => framed.mock.calls.filter(([installationId]) => installationId === kernel.installationId)
      .map(([, , frame]) => frame.type === "req" ? frame.call : frame.type),
  };
}

/** A signed-in person at a desktop client. */
function person(kernel: Kernel): KernelContext {
  const ctx = kernel.buildKernelContext({ peer: testPeer({ account: OWNER, calls: ["conversation.*", "proc.*"] }) });
  // SAFETY: these handlers read only the connection's id and its client state.
  ctx.connection = { id: "connection-1", state: { clientId: "desktop-1", clientPlatform: "macos" } } as KernelContext["connection"];
  return ctx;
}

/** The Ship's conversation, ready for messages. */
async function shipConversation(kernel: Kernel) {
  const conversation = kernel.conversations.ensureShip(OWNER.uid, SHIP);
  await processTransport.getConversationById(kernel.installationId, conversation.id)
    .initialize({ ownerUid: OWNER.uid, kind: conversation.kind });
  return conversation;
}

async function runEvents(kernel: Kernel) {
  await kernel.eventRuntime.onEvents({ id: `task:${crypto.randomUUID()}` });
}

function retryNow(kernel: Kernel) {
  kernel.ctx.storage.sql.exec("UPDATE deliveries SET next_attempt_at = 0 WHERE state = 'pending'");
}

function messageEvents(kernel: Kernel) {
  return kernel.ctx.storage.sql.exec<{
    seq: number; type: string; subject: string; idempotency_key: string; actor_json: string; body_json: string;
    consumer: string; lane: string | null; state: string; attempt_count: number; last_error: string | null; run_id: string | null;
  }>(
    `SELECT e.seq, e.type, e.subject, e.idempotency_key, e.actor_json, e.body_json,
       d.consumer, d.lane, d.state, d.attempt_count, d.last_error, d.run_id
     FROM events e JOIN deliveries d ON d.seq = e.seq
     WHERE e.type IN ('message.received', 'process.message') ORDER BY e.seq`,
  ).toArray().map(({ actor_json, body_json, ...row }) => ({ ...row, actor: JSON.parse(actor_json), body: JSON.parse(body_json) }));
}

describe("chat on the event log", () => {
  it("delivers a message in the send, on Ship's person lane, under the run its Conversation recorded", async () => {
    const { delivered, framed } = processes();
    await fixture(async (kernel) => {
      const conversation = await shipConversation(kernel);
      const sent = await handleConversationSend({ conversationId: conversation.id, text: "Book the train.", idempotencyKey: "desktop:1" }, person(kernel));

      const runId = `run:${sent.message.id}`;
      expect(sent).toMatchObject({ handlerPid: SHIP, runId, queued: false });
      const [event] = messageEvents(kernel);
      expect(messageEvents(kernel)).toEqual([{
        seq: event!.seq, type: "message.received", subject: `conversation:${conversation.id}`, idempotency_key: sent.message.id,
        actor: { kind: "person", uid: OWNER.uid },
        body: {
          runId, origin: CLIENT,
          content: { kind: "conversation", conversationId: conversation.id, messageId: sent.message.id, sequence: sent.message.sequence },
        },
        consumer: `personal:${OWNER.uid}`, lane: "person", state: "delivered", attempt_count: 0, last_error: null, run_id: runId,
      }]);
      expect(delivered(kernel)).toEqual([[kernel.installationId, SHIP, {
        eventId: `evt_${event!.seq}:personal:${OWNER.uid}`,
        input: {
          message: "Book the train.", origin: CLIENT, runId,
          interaction: { conversationId: conversation.id, messageId: sent.message.id },
        },
        admission: { idle: "start", busy: "interrupt" },
      }]]);
      expect(kernel.runRoutes.get(runId)).toMatchObject({ kind: "connection", connectionId: "connection-1", processId: SHIP });
      expect(framed(kernel)).toEqual([]);
    });
  });

  it("answers queued when Ship can't take a message now, and the runner delivers it later", async () => {
    const { deliver, delivered } = processes();
    await fixture(async (kernel) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const conversation = await shipConversation(kernel);
      deliver.mockResolvedValueOnce(REPLACED);
      const sent = await handleConversationSend({ conversationId: conversation.id, text: "Still there?", idempotencyKey: "desktop:2" }, person(kernel));

      expect(sent).toMatchObject({ runId: `run:${sent.message.id}`, queued: true });
      expect(messageEvents(kernel)[0]).toMatchObject({ state: "pending", attempt_count: 1, last_error: "Process is being replaced" });

      retryNow(kernel);
      await runEvents(kernel);
      expect(delivered(kernel)).toHaveLength(2);
      expect(messageEvents(kernel)[0]).toMatchObject({ state: "delivered", run_id: sent.runId });
      expect(kernel.runRoutes.get(sent.runId)).toMatchObject({ kind: "connection", connectionId: "connection-1" });
    });
  });

  it("appends nothing for a resend with the same key and answers with the first delivery", async () => {
    const { delivered } = processes();
    await fixture(async (kernel) => {
      const conversation = await shipConversation(kernel);
      const input = { conversationId: conversation.id, text: "Once.", idempotencyKey: "desktop:3" };
      const first = await handleConversationSend(input, person(kernel));
      const again = await handleConversationSend(input, person(kernel));

      expect(again).toEqual(first);
      expect(messageEvents(kernel)).toHaveLength(1);
      expect(delivered(kernel)).toHaveLength(1);
    });
  });

  it("fails the send when Ship refuses the message, without a retry or a reply route", async () => {
    const { deliver, delivered } = processes();
    await fixture(async (kernel) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const conversation = await shipConversation(kernel);
      deliver.mockImplementationOnce(async (_installation, _pid, args) => ({ eventId: args.eventId, runId: null, queued: false, refused: "media not found: photo" }));

      await expect(handleConversationSend({ conversationId: conversation.id, text: "Look.", idempotencyKey: "desktop:4" }, person(kernel)))
        .rejects.toThrow("media not found: photo");
      const [event] = messageEvents(kernel);
      expect(event).toMatchObject({ state: "failed", last_error: "media not found: photo" });
      expect(kernel.runRoutes.get(event!.body.runId)).toBeNull();

      retryNow(kernel);
      await runEvents(kernel);
      expect(delivered(kernel)).toHaveLength(1);
    });
  });

  it("sends a work conversation's message to its process, not to Ship", async () => {
    const { delivered } = processes();
    await fixture(async (kernel) => {
      const conversation = kernel.conversations.ensureWork(OWNER.uid, WORKER, "worker");
      await processTransport.getConversationById(kernel.installationId, conversation.id).initialize({ ownerUid: OWNER.uid, kind: conversation.kind });
      const sent = await handleConversationSend({ conversationId: conversation.id, text: "Try again.", idempotencyKey: "desktop:5" }, person(kernel));

      expect(messageEvents(kernel)).toEqual([expect.objectContaining({ consumer: `proc:${WORKER}`, lane: "person", state: "delivered", run_id: sent.runId })]);
      expect(messageEvents(kernel)[0]!.body).toMatchObject({ pid: WORKER });
      expect(delivered(kernel).map(([, pid]) => pid)).toEqual([WORKER]);
    });
  });
});

describe("direct messages on the event log", () => {
  it("delivers a person's message on its process's person lane, under its delivery's run id", async () => {
    const { delivered, framed } = processes();
    await fixture(async (kernel) => {
      const sent = await handleProcSend({ pid: WORKER, message: "Stop and summarize.", selectedTarget: "gsv" }, person(kernel));

      const [event] = messageEvents(kernel);
      const runId = `evt_${event!.seq}:proc:${WORKER}`;
      expect(sent).toEqual({ ok: true, status: "started", runId });
      expect(messageEvents(kernel)).toEqual([{
        seq: event!.seq, type: "message.received", subject: `proc:${WORKER}`, idempotency_key: event!.idempotency_key,
        actor: { kind: "person", uid: OWNER.uid },
        body: { pid: WORKER, origin: CLIENT, content: { kind: "inline", message: "Stop and summarize.", selectedTarget: "gsv" } },
        consumer: `proc:${WORKER}`, lane: "person", state: "delivered", attempt_count: 0, last_error: null, run_id: runId,
      }]);
      expect(delivered(kernel)).toEqual([[kernel.installationId, WORKER, {
        eventId: runId,
        input: { message: "Stop and summarize.", selectedTarget: "gsv", origin: CLIENT },
        admission: { idle: "start", busy: "interrupt" },
      }]]);
      expect(kernel.runRoutes.get(runId)).toMatchObject({ kind: "connection", connectionId: "connection-1", processId: WORKER });
      expect(framed(kernel)).toEqual([]);
    });
  });

  it("lets a process's message wait its turn on the background lane", async () => {
    const { delivered } = processes();
    await fixture(async (kernel) => {
      const ctx = kernel.buildProcessContext(SHIP, "ship-run");
      if (!ctx) throw new Error("Ship is not registered");
      const sent = await handleProcSend({ pid: WORKER, message: "When you're done, check the logs." }, ctx);

      const [event] = messageEvents(kernel);
      expect(sent).toMatchObject({ ok: true, runId: `evt_${event!.seq}:proc:${WORKER}` });
      expect(event).toMatchObject({ type: "process.message", actor: { kind: "process", pid: SHIP }, lane: "background", state: "delivered" });
      expect(delivered(kernel)[0]![2]).toMatchObject({
        input: { message: "When you're done, check the logs.", origin: { kind: "process", sourcePid: SHIP, uid: OWNER.uid } },
        admission: { idle: "start", busy: "after" },
      });
    });
  });

  it("refuses a message over 64 KiB before appending it", async () => {
    const { delivered } = processes();
    await fixture(async (kernel) => {
      const sent = await handleProcSend({ pid: WORKER, message: "x".repeat(64 * 1024) }, person(kernel));

      expect(sent).toEqual({ ok: false, error: "proc.send message exceeds 64 KiB; write the content to a file and send its path" });
      expect(messageEvents(kernel)).toEqual([]);
      expect(delivered(kernel)).toEqual([]);
    });
  });

  it("answers queued when the process can't take a message now", async () => {
    const { deliver } = processes();
    await fixture(async (kernel) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      deliver.mockResolvedValueOnce(REPLACED);
      const sent = await handleProcSend({ pid: WORKER, message: "Hello." }, person(kernel));

      expect(sent).toMatchObject({ ok: true, queued: true });
      expect(messageEvents(kernel)[0]).toMatchObject({ state: "pending", last_error: "Process is being replaced" });
    });
  });
});

describe("spawn prompts on the event log", () => {
  it("delivers a spawn prompt to its new process through the log", async () => {
    const { delivered, framed } = processes();
    await fixture(async (kernel) => {
      const ctx = kernel.buildProcessContext(SHIP, "ship-run");
      if (!ctx) throw new Error("Ship is not registered");
      const spawned = await handleProcSpawn({ label: "drafter", prompt: "Draft the plan." }, ctx);
      if (!spawned.ok) throw new Error(spawned.error);

      expect(messageEvents(kernel)).toEqual([expect.objectContaining({
        type: "process.message", subject: `proc:${spawned.pid}`, consumer: `proc:${spawned.pid}`, state: "delivered",
      })]);
      expect(delivered(kernel)).toEqual([[kernel.installationId, spawned.pid, expect.objectContaining({
        input: { message: "Draft the plan.", origin: { kind: "process", sourcePid: SHIP, uid: OWNER.uid } },
        admission: { idle: "start", busy: "after" },
      })]]);
      expect(framed(kernel)).toEqual(["proc.setidentity"]);
    });
  });

  it("refuses a prompt over 64 KiB before creating the process", async () => {
    const { framed } = processes();
    await fixture(async (kernel) => {
      const ctx = kernel.buildProcessContext(SHIP, "ship-run");
      if (!ctx) throw new Error("Ship is not registered");
      const before = kernel.procs.list(OWNER.uid).length;
      const spawned = await handleProcSpawn({ prompt: "x".repeat(64 * 1024) }, ctx);

      expect(spawned).toEqual({ ok: false, error: "proc.spawn prompt exceeds 64 KiB; write the content to a file and pass its path" });
      expect(kernel.procs.list(OWNER.uid)).toHaveLength(before);
      expect(messageEvents(kernel)).toEqual([]);
      expect(framed(kernel)).toEqual([]);
    });
  });
});
