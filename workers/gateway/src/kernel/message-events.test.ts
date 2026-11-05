import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import * as processTransport from "../shared/utils";
import { spyOnProcessDeliveries } from "../test-support/process-deliveries";
import { testPeer } from "../test-support/peers";
import { handleAdapterInbound } from "./adapter-ingress";
import type { KernelContext } from "./context";
import { handleConversationSend } from "./conversation-handlers";
import type { Kernel } from "./do";
import * as personalController from "./personal-controller";
import { handleProcSend, handleProcSpawn } from "./proc-handlers";

const OWNER: ProcessIdentity = { uid: 1000, gid: 1000, gids: [1000, 100], username: "sam", home: "/home/sam", cwd: "/home/sam" };
const ROOT: ProcessIdentity = { uid: 0, gid: 0, gids: [0], username: "root", home: "/root", cwd: "/root" };
const SHIP = "ship";
const WORKER = "worker";
const CLIENT = { kind: "client", connectionId: "connection-1", clientId: "desktop-1", platform: "macos" };
const REPLACED = { unavailable: "transitioning", message: "Process is being replaced" } as const;

afterEach(() => vi.restoreAllMocks());

/** The Kernels this file's tests made; only their deliveries reach a test's spy. */
const ownKernels = new Set<string>();

async function fixture(work: (kernel: Kernel) => Promise<void>) {
  const stub = env.KERNEL.get(env.KERNEL.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, async (kernel: Kernel) => {
    ownKernels.add(kernel.installationId);
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

/** Spies on this file's Kernels' deliveries and frames; tests read only the calls their own Kernel made. */
function processes() {
  const deliver = spyOnProcessDeliveries((installationId) => ownKernels.has(installationId), async (_installation, _pid, args) => (
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

function messageEvents(kernel: Kernel, types = ["message.received", "process.message"]) {
  return kernel.ctx.storage.sql.exec<{
    seq: number; type: string; subject: string; idempotency_key: string; actor_json: string; body_json: string;
    consumer: string; lane: string | null; state: string; attempt_count: number; last_error: string | null; run_id: string | null;
  }>(
    `SELECT e.seq, e.type, e.subject, e.idempotency_key, e.actor_json, e.body_json,
       d.consumer, d.lane, d.state, d.attempt_count, d.last_error, d.run_id
     FROM events e JOIN deliveries d ON d.seq = e.seq
     WHERE e.type IN (SELECT value FROM json_each(?)) ORDER BY e.seq`,
    JSON.stringify(types),
  ).toArray().map(({ actor_json, body_json, ...row }) => ({ ...row, actor: JSON.parse(actor_json), body: JSON.parse(body_json) }));
}

const WHATSAPP = { adapter: "whatsapp", accountId: "primary", actorId: "wa:+123" };
const DM = { kind: "dm", id: "dm-1" } as const;
const DM_ROUTE = { ...WHATSAPP, surfaceKind: "dm", surfaceId: DM.id, uid: OWNER.uid } as const;

/** The person's WhatsApp, linked to their account. */
function linkMessenger(kernel: Kernel) {
  kernel.adapters.identityLinks.link(WHATSAPP.adapter, WHATSAPP.accountId, WHATSAPP.actorId, OWNER.uid, OWNER.uid);
}

/** The person's private WhatsApp message, as their adapter delivers it. */
function privateMessage(kernel: Kernel, messageId: string, text: string, replyToId?: string) {
  const adapter = kernel.buildKernelContext({ peer: testPeer({ kind: "service", account: ROOT, calls: ["adapter.inbound"] }) });
  return handleAdapterInbound({
    adapter: WHATSAPP.adapter, accountId: WHATSAPP.accountId, deliveryId: messageId,
    message: { messageId, surface: DM, actor: { id: WHATSAPP.actorId }, text, ...(replyToId ? { replyToId } : undefined) },
  }, adapter);
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

describe("messengers on the event log", () => {
  it("delivers a private message in its ingress, on Ship's person lane, with its reply route pinned", async () => {
    const { delivered, framed } = processes();
    await fixture(async (kernel) => {
      linkMessenger(kernel);
      const result = await privateMessage(kernel, "wamid-1", "yes, that one", "wamid-unknown");

      const conversation = kernel.conversations.getShip(OWNER.uid)!;
      const [event] = messageEvents(kernel);
      const runId = event!.body.runId;
      const origin = { kind: "adapter", ...WHATSAPP, surface: DM, messageId: "wamid-1" };
      expect(result).toEqual({ ok: true, delivered: { uid: OWNER.uid, pid: SHIP, runId, queued: false } });
      expect(runId).toMatch(/^adapter-run:/);
      expect(messageEvents(kernel)).toEqual([{
        seq: event!.seq, type: "message.received", subject: `conversation:${conversation.id}`, idempotency_key: event!.body.content.messageId,
        actor: { kind: "person", uid: OWNER.uid },
        body: {
          runId, origin, quote: { state: "unavailable" },
          content: { kind: "conversation", conversationId: conversation.id, messageId: event!.body.content.messageId, sequence: 1 },
        },
        consumer: `personal:${OWNER.uid}`, lane: "person", state: "delivered", attempt_count: 0, last_error: null, run_id: runId,
      }]);
      expect(delivered(kernel)).toEqual([[kernel.installationId, SHIP, {
        eventId: `evt_${event!.seq}:personal:${OWNER.uid}`,
        input: {
          message: "yes, that one", origin, quote: { state: "unavailable" }, runId,
          interaction: { conversationId: conversation.id, messageId: event!.body.content.messageId },
        },
        admission: { idle: "start", busy: "interrupt" },
      }]]);
      expect(kernel.runRoutes.get(runId)).toMatchObject({
        kind: "adapter", processId: SHIP, replyToId: "wamid-1",
        destination: { kind: "adapter", ...WHATSAPP, surface: DM },
      });
      expect(framed(kernel)).toEqual([]);
    });
  });

  it("pins the reply route only with the event, so a retry after its run ended leaves none behind", async () => {
    const { delivered } = processes();
    await fixture(async (kernel) => {
      linkMessenger(kernel);
      vi.spyOn(kernel.eventRuntime, "deliverNow").mockRejectedValueOnce(new Error("Kernel request reset"));
      await expect(privateMessage(kernel, "wamid-2", "Book it.")).rejects.toThrow("Kernel request reset");
      const [event] = messageEvents(kernel);
      const runId = event!.body.runId;
      expect(kernel.runRoutes.get(runId)).toMatchObject({ kind: "adapter" });

      // The runner delivers it, and its run ends, taking its route along.
      await runEvents(kernel);
      kernel.runRoutes.delete(runId);

      await expect(privateMessage(kernel, "wamid-2", "Book it."))
        .resolves.toEqual({ ok: true, delivered: { uid: OWNER.uid, pid: SHIP, runId, queued: false } });
      expect(messageEvents(kernel)).toEqual([expect.objectContaining({ seq: event!.seq, state: "delivered", run_id: runId })]);
      expect(delivered(kernel)).toHaveLength(1);
      expect(kernel.runRoutes.get(runId)).toBeNull();
    });
  });

  it("fails a message Ship refuses, leaving no reply route", async () => {
    const { deliver } = processes();
    await fixture(async (kernel) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      linkMessenger(kernel);
      deliver.mockImplementationOnce(async (_installation, _pid, args) => ({ eventId: args.eventId, runId: null, queued: false, refused: "media not found: photo" }));

      await expect(privateMessage(kernel, "wamid-3", "Look.")).resolves.toEqual({ ok: false, error: "media not found: photo" });
      const [event] = messageEvents(kernel);
      expect(event).toMatchObject({ state: "failed", last_error: "media not found: photo" });
      expect(kernel.runRoutes.get(event!.body.runId)).toBeNull();
    });
  });

  it("sends a message on a work line to that process's person lane", async () => {
    const { delivered } = processes();
    await fixture(async (kernel) => {
      linkMessenger(kernel);
      kernel.adapters.surfaceRoutes.setRoute({ ...DM_ROUTE, pid: WORKER, mode: "work", updatedByUid: OWNER.uid });

      await expect(privateMessage(kernel, "wamid-4", "Try again.")).resolves.toMatchObject({ ok: true, delivered: { pid: WORKER, queued: false } });
      expect(messageEvents(kernel)).toEqual([expect.objectContaining({ consumer: `proc:${WORKER}`, lane: "person", state: "delivered" })]);
      expect(messageEvents(kernel)[0]!.body).toMatchObject({ pid: WORKER });
      expect(delivered(kernel).map(([, pid]) => pid)).toEqual([WORKER]);
    });
  });
});

describe("work returns on the event log", () => {
  it("records a /ship return with the route it clears, and Ship hears it as a run of its own", async () => {
    const { delivered, framed } = processes();
    await fixture(async (kernel) => {
      linkMessenger(kernel);
      kernel.adapters.surfaceRoutes.setRoute({ ...DM_ROUTE, pid: WORKER, mode: "work", updatedByUid: OWNER.uid });

      await expect(privateMessage(kernel, "wamid-ship", "/ship")).resolves.toMatchObject({ ok: true, reply: { text: "[SHIP] Returned to ship Ship." } });
      expect(kernel.adapters.surfaceRoutes.resolveRoute(DM_ROUTE)).toBeNull();
      const [event] = messageEvents(kernel, ["work.returned"]);
      expect(messageEvents(kernel, ["work.returned"])).toEqual([{
        seq: event!.seq, type: "work.returned", subject: `proc:${WORKER}`, idempotency_key: expect.stringMatching(/^adapter-ingress:/),
        actor: { kind: "person", uid: OWNER.uid },
        body: { workPid: WORKER, ...WHATSAPP, surfaceId: DM.id, messageId: "wamid-ship" },
        consumer: `personal:${OWNER.uid}`, lane: "person", state: "delivered", attempt_count: 0, last_error: null,
        run_id: `evt_${event!.seq}:personal:${OWNER.uid}`,
      }]);
      expect(delivered(kernel)).toEqual([[kernel.installationId, SHIP, {
        eventId: `evt_${event!.seq}:personal:${OWNER.uid}`,
        event: { kind: "adapter.work.returned", severity: "info", audience: "model", payload: { eventId: `evt_${event!.seq}`, workPid: WORKER } },
        admission: { idle: "start", busy: "after" },
      }]]);
      expect(framed(kernel)).toEqual([]);
    });
  });

  it("withdraws a return that a newer private message overtook while Ship couldn't take it", async () => {
    const { deliver, delivered } = processes();
    await fixture(async (kernel) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      linkMessenger(kernel);
      kernel.adapters.surfaceRoutes.setRoute({ ...DM_ROUTE, pid: WORKER, mode: "work", updatedByUid: OWNER.uid });
      deliver.mockResolvedValueOnce(REPLACED);

      await expect(privateMessage(kernel, "wamid-ship", "/ship")).resolves.toMatchObject({ reply: { text: "[SHIP] Returned to ship Ship." } });
      expect(messageEvents(kernel, ["work.returned"])[0]).toMatchObject({ state: "pending", attempt_count: 1 });

      await privateMessage(kernel, "wamid-help", "/help");
      retryNow(kernel);
      await runEvents(kernel);
      expect(messageEvents(kernel, ["work.returned"])[0]).toMatchObject({ state: "withdrawn", last_error: "a newer private message followed the return" });
      expect(delivered(kernel)).toHaveLength(1);
    });
  });
});
