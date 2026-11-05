import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterMessageDestination, ProcHilRequest, ProcessIdentity } from "@humansandmachines/gsv/protocol";
import { stableOpaqueId } from "../shared/stable-id";
import * as processTransport from "../shared/utils";
import { spyOnProcessDeliveries } from "../test-support/process-deliveries";
import type { ChatDelivery, ChatSend } from "./adapter-delivery";
import { chatReply } from "./chat-replies";
import type { Kernel } from "./do";

const OWNER: ProcessIdentity = { uid: 1000, gid: 1000, gids: [1000, 100], username: "sam", home: "/home/sam", cwd: "/home/sam" };
const WORKER = "worker";
const RUN = "run-1";
/** The person's WhatsApp chat, which the worker's run answers on. */
const CHAT: AdapterMessageDestination = {
  kind: "adapter", adapter: "whatsapp", accountId: "primary", actorId: "wa:+123", surface: { kind: "dm", id: "dm-1" },
};
const ROUTE = { kind: "adapter", runId: RUN, processId: WORKER, uid: OWNER.uid, destination: CHAT, replyToId: "wamid-in" } as const;
const BLIP = { state: "retryable", stage: "adapter", error: "Adapter reply failed (whatsapp): WhatsApp delivery is temporarily unavailable" } as const;
const REFUSED = { state: "permanent", stage: "adapter", error: "Adapter reply failed (whatsapp): WhatsApp rejected the delivery" } as const;
const WAKE = { idle: "start", busy: "join" } as const;
const NOTE = { idle: "record", busy: "record" } as const;

afterEach(() => vi.restoreAllMocks());

/** What a test's Kernel delivered to its processes, each as `[installationId, pid, args]`. */
type Delivered = () => Parameters<typeof processTransport.deliverEventToProcess>[];

async function fixture(work: (kernel: Kernel, delivered: Delivered) => Promise<void>) {
  const stub = env.KERNEL.get(env.KERNEL.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, async (kernel: Kernel) => {
    // The tests run each pass themselves; no alarm runs one behind them.
    vi.spyOn(kernel.ctx.storage, "setAlarm").mockResolvedValue(undefined);
    // No Process runs behind the worker, so what this Kernel delivers to it is only recorded.
    const deliver = spyOnProcessDeliveries((installationId) => installationId === kernel.installationId);
    try {
      kernel.caps.seed();
      kernel.auth.addUser({ username: OWNER.username, uid: OWNER.uid, gid: OWNER.gid, gecos: "Sam", home: OWNER.home, shell: "/bin/init" });
      kernel.auth.addGroup({ name: OWNER.username, gid: OWNER.gid, members: [] });
      kernel.auth.addGroup({ name: "users", gid: 100, members: [OWNER.username] });
      kernel.procs.spawn(WORKER, OWNER, { ownerUid: OWNER.uid, interactive: true, label: "worker" });
      kernel.runRoutes.setAdapterRoute({ runId: RUN, processId: WORKER, uid: OWNER.uid, destination: CHAT, replyToId: "wamid-in" });
      await work(kernel, () => deliver.mock.calls);
    } finally {
      // Test files share modules, so nothing this Kernel scheduled may run during a later test.
      kernel.ctx.storage.sql.exec("DELETE FROM cf_agents_schedules");
      await kernel.ctx.storage.deleteAlarm();
    }
  });
}

/** Answers the chat's sends in turn, the last answer repeating, and records what each one carried. */
function chat(kernel: Kernel, ...answers: ChatSend[]) {
  const sent: ChatDelivery[] = [];
  vi.spyOn(kernel.adapterDelivery, "sendToChat").mockImplementation(async (delivery) => {
    sent.push(delivery);
    return answers[Math.min(sent.length, answers.length) - 1] ?? { state: "sent" };
  });
  return sent;
}

/** What the worker's process says about its pending approval. */
function pendingApproval(request: ProcHilRequest | null) {
  vi.spyOn(processTransport, "sendFrameToProcess").mockImplementation(async (_installation, _pid, frame) => (
    frame.type === "req" && frame.call === "proc.history" ? { type: "res", id: frame.id, ok: true, data: { ok: true, pendingHil: request } } : null
  ));
}

function approval(requestId: string): ProcHilRequest {
  return { pid: WORKER, runId: RUN, requestId, callId: `call-${requestId}`, toolName: "Shell", syscall: "shell.exec", target: "gsv", args: { input: "date" }, createdAt: 1 };
}

/** The worker's run sends the person a message, as its Send tool does. */
function send(kernel: Kernel, text: string, actionId = crypto.randomUUID()) {
  return kernel.processOutput.commitProcessMessage(WORKER, { runId: RUN, actionId, text });
}

/** The worker's run waits on an approval, which its Process reports whole. */
function requestApproval(kernel: Kernel, request: ProcHilRequest) {
  const frame = { type: "sig" as const, signal: "proc.run.hil.requested" as const, payload: request };
  return kernel.processOutput.handleProcessSignal(WORKER, frame, frame);
}

/** The worker's run ends in an error, as its Process reports it. */
function failRun(kernel: Kernel) {
  const frame = {
    type: "sig" as const, signal: "proc.run.finished" as const,
    payload: { pid: WORKER, runId: RUN, status: "error", reason: "generation.error" },
  };
  return kernel.processOutput.handleProcessSignal(WORKER, frame, frame);
}

async function runEvents(kernel: Kernel) {
  await kernel.eventRuntime.onEvents({ id: `task:${crypto.randomUUID()}` });
}

function retryNow(kernel: Kernel) {
  kernel.ctx.storage.sql.exec("UPDATE deliveries SET next_attempt_at = 0 WHERE state = 'pending'");
}

function logged(kernel: Kernel, type: string) {
  return kernel.ctx.storage.sql.exec<{
    seq: number; idempotency_key: string; actor_json: string; body_json: string; subject: string; created_at: number;
    consumer: string; lane: string | null; state: string; attempt_count: number; next_attempt_at: number; last_error: string | null;
  }>(
    `SELECT e.seq, e.idempotency_key, e.actor_json, e.body_json, e.subject, e.created_at,
       d.consumer, d.lane, d.state, d.attempt_count, d.next_attempt_at, d.last_error
     FROM events e JOIN deliveries d ON d.seq = e.seq WHERE e.type = ? ORDER BY e.seq`,
    type,
  ).toArray().map(({ actor_json, body_json, ...row }) => ({ ...row, actor: JSON.parse(actor_json), body: JSON.parse(body_json) }));
}

describe("messenger replies on the event log", () => {
  it("sends a run's reply to its chat from the log, read back from its Conversation", async () => {
    await fixture(async (kernel) => {
      const sent = chat(kernel);
      const message = await send(kernel, "Booked the 9:40.");

      const [reply] = logged(kernel, "chat.reply");
      expect(reply).toMatchObject({
        idempotency_key: `message:${message.id}`, subject: `proc:${WORKER}`, actor: { kind: "process", pid: WORKER },
        lane: "messages", state: "pending",
        body: {
          route: { kind: "adapter", runId: RUN, processId: WORKER, uid: OWNER.uid, destination: CHAT, replyToId: "wamid-in" },
          reply: { kind: "message", conversationId: message.conversationId, messageId: message.id, sequence: message.sequence },
        },
      });
      // A chat is named by an opaque id, so no provider's id names a consumer.
      expect(reply!.consumer).toBe(`chat:${reply!.body.chat}`);
      expect(reply!.consumer).not.toMatch(/wa:|dm-1|whatsapp/);

      await runEvents(kernel);
      expect(sent).toEqual([{
        route: reply!.body.route,
        deliveryId: message.id,
        text: "Booked the 9:40.",
        canonical: { conversationId: message.conversationId, messageId: message.id, sequence: message.sequence },
        presentation: "process",
        typing: true,
      }]);
      expect(logged(kernel, "chat.reply")[0]).toMatchObject({ state: "delivered", attempt_count: 0 });
      expect(logged(kernel, "delivery.failed")).toEqual([]);
    });
  });

  it("offers a message's choices to its chat", async () => {
    await fixture(async (kernel) => {
      const sent = chat(kernel);
      await kernel.processOutput.commitProcessMessage(WORKER, {
        runId: RUN, actionId: crypto.randomUUID(), text: "Mornings or nights?", choices: ["Morning person", "Night owl"],
      });

      await runEvents(kernel);
      expect(sent).toEqual([expect.objectContaining({ text: "Mornings or nights?", choices: ["Morning person", "Night owl"] })]);
    });
  });

  it("sends one chat's replies in order, a retrying reply holding back the next", async () => {
    await fixture(async (kernel) => {
      const sent = chat(kernel, BLIP, { state: "sent" });
      await send(kernel, "First.");
      await send(kernel, "Second.");

      await runEvents(kernel);
      expect(sent.map(({ text }) => text)).toEqual(["First."]);
      expect(logged(kernel, "chat.reply").map(({ state, attempt_count }) => [state, attempt_count])).toEqual([["pending", 1], ["pending", 0]]);

      retryNow(kernel);
      await runEvents(kernel);
      expect(sent.map(({ text }) => text)).toEqual(["First.", "First.", "Second."]);
      expect(logged(kernel, "chat.reply").map(({ state }) => state)).toEqual(["delivered", "delivered"]);
    });
  });

  it("retries a blip twice, after 2 s and then 8 s, then wakes the process that wrote the reply", async () => {
    await fixture(async (kernel, delivered) => {
      const sent = chat(kernel, BLIP);
      await send(kernel, "Booked the 9:40.");

      for (const delay of [2_000, 8_000]) {
        const before = Date.now();
        await runEvents(kernel);
        const [reply] = logged(kernel, "chat.reply");
        expect(reply!.state).toBe("pending");
        expect(reply!.next_attempt_at).toBeGreaterThanOrEqual(before + delay);
        expect(reply!.next_attempt_at).toBeLessThanOrEqual(Date.now() + delay);
        retryNow(kernel);
      }
      await runEvents(kernel);
      expect(sent).toHaveLength(3);
      expect(logged(kernel, "chat.reply")[0]).toMatchObject({ state: "failed", attempt_count: 3, last_error: BLIP.error });

      const message = `The message stopped after 3 retry-safe delivery attempts: ${BLIP.error}`;
      const [failure] = logged(kernel, "delivery.failed");
      // The process hears when the message was written, so one it has outlived since is only noted.
      const writtenAt = logged(kernel, "chat.reply")[0]!.created_at;
      expect(failure).toMatchObject({ consumer: `proc:${WORKER}`, lane: "background", body: { pid: WORKER, runId: RUN, message, wake: true, writtenAt } });
      await runEvents(kernel);
      expect(delivered()).toEqual([[kernel.installationId, WORKER, {
        eventId: `evt_${failure!.seq}:proc:${WORKER}`,
        event: {
          kind: "delivery.failed", severity: "error", audience: "both",
          payload: { phase: "message", noticeId: failure!.idempotency_key, runId: RUN, error: message },
        },
        admission: WAKE,
        writtenAt,
      }]]);
    });
  });

  it("never retries a reply that may have arrived, and wakes its process to decide", async () => {
    await fixture(async (kernel) => {
      const sent = chat(kernel, { state: "ambiguous", stage: "adapter", error: "Adapter delivery wamid-out is ambiguous" });
      await send(kernel, "Booked the 9:40.");
      await runEvents(kernel);

      expect(sent).toHaveLength(1);
      expect(logged(kernel, "chat.reply")[0]).toMatchObject({ state: "failed", attempt_count: 1 });
      expect(logged(kernel, "delivery.failed")[0]!.body).toEqual({
        pid: WORKER, runId: RUN, wake: true, writtenAt: logged(kernel, "chat.reply")[0]!.created_at,
        message: "The message reached the adapter, but provider delivery is ambiguous. It was not retried to avoid a duplicate.",
      });
    });
  });

  it("wakes the process for a reply its messenger can never deliver, once", async () => {
    await fixture(async (kernel, delivered) => {
      // The person's WhatsApp isn't linked, so the send refuses the reply for good.
      await send(kernel, "Booked the 9:40.");
      await runEvents(kernel);
      await runEvents(kernel);

      const message = "The message could not be delivered: Adapter destination is not authorized";
      const [reply] = logged(kernel, "chat.reply");
      expect(reply).toMatchObject({ state: "failed", attempt_count: 1, last_error: "Adapter destination is not authorized" });
      const [failure] = logged(kernel, "delivery.failed");
      expect(logged(kernel, "delivery.failed")).toEqual([{
        seq: failure!.seq, idempotency_key: `evt_${reply!.seq}:${reply!.consumer}`, subject: `proc:${WORKER}`, created_at: failure!.created_at,
        actor: { kind: "kernel" }, body: { pid: WORKER, runId: RUN, message, wake: true, writtenAt: reply!.created_at },
        consumer: `proc:${WORKER}`, lane: "background", state: "delivered", attempt_count: 0, next_attempt_at: failure!.next_attempt_at, last_error: null,
      }]);
      expect(delivered()).toEqual([[kernel.installationId, WORKER, expect.objectContaining({ admission: WAKE })]]);
    });
  });

  it("only notes a chat's failed messages once three in a row have failed there, until one gets through", async () => {
    await fixture(async (kernel) => {
      chat(kernel, REFUSED, REFUSED, REFUSED, REFUSED, { state: "sent" }, REFUSED);
      for (let message = 1; message <= 6; message += 1) {
        await send(kernel, `Message ${message}.`);
        await runEvents(kernel);
      }

      expect(logged(kernel, "chat.reply").map(({ state }) => state))
        .toEqual(["failed", "failed", "failed", "failed", "delivered", "failed"]);
      expect(logged(kernel, "delivery.failed").map(({ body }) => body.wake === true)).toEqual([true, true, true, false, true]);
    });
  });

  it("sends an approval request read from its process, and only notes each one that fails", async () => {
    await fixture(async (kernel, delivered) => {
      const sent = chat(kernel, REFUSED);
      for (const requestId of ["approval-1", "approval-2"]) {
        pendingApproval(approval(requestId));
        await requestApproval(kernel, approval(requestId));
        await runEvents(kernel);
      }
      await runEvents(kernel);

      expect(logged(kernel, "chat.reply").map(({ idempotency_key }) => idempotency_key))
        .toEqual([`approval:${RUN}:approval-1`, `approval:${RUN}:approval-2`]);
      expect(sent[0]).toEqual({
        route: logged(kernel, "chat.reply")[0]!.body.route,
        deliveryId: `${RUN}:hil:approval-1`, text: "", hil: approval("approval-1"), presentation: "process", typing: true,
      });
      const failures = logged(kernel, "delivery.failed");
      expect(failures.map(({ body }) => body)).toEqual(["approval-1", "approval-2"].map((requestId) => ({
        pid: WORKER, runId: RUN, requestId, message: `The approval notification could not be delivered: ${REFUSED.error}`,
      })));
      expect(failures[0]!.idempotency_key).not.toBe(failures[1]!.idempotency_key);
      expect(delivered().map(([, , args]) => args)).toEqual(failures.map(({ body }) => expect.objectContaining({
        admission: NOTE, approvalRequestId: body.requestId,
      })));
    });
  });

  it("withdraws an approval request once its process no longer waits on it", async () => {
    await fixture(async (kernel) => {
      const sent = chat(kernel);
      for (const [requestId, pending] of [["approval-resolved", null], ["approval-old", approval("approval-current")]] as const) {
        pendingApproval(pending);
        await requestApproval(kernel, approval(requestId));
        await runEvents(kernel);
      }

      expect(sent).toEqual([]);
      expect(logged(kernel, "chat.reply").map(({ state, last_error }) => [state, last_error])).toEqual([
        ["withdrawn", "the approval is no longer pending"],
        ["withdrawn", "the approval is no longer pending"],
      ]);
    });
  });

  it("withdraws a message that another run's route names", async () => {
    await fixture(async (kernel) => {
      const sent = chat(kernel);
      // Committed while the run had no messenger route, so only the other run's reply names it.
      kernel.runRoutes.delete(RUN);
      const message = await send(kernel, "Booked the 9:40.");
      kernel.eventRuntime.append(await chatReply({ ...ROUTE, runId: "run-2" }, {
        kind: "message", conversationId: message.conversationId, messageId: message.id, sequence: message.sequence,
      }));
      await runEvents(kernel);

      expect(sent).toEqual([]);
      expect(logged(kernel, "chat.reply").map(({ state, last_error }) => [state, last_error])).toEqual([["withdrawn", "the message is not its run's"]]);
    });
  });

  it("tells the chat its run failed as the system, under one identity, and only notes when it can't", async () => {
    await fixture(async (kernel) => {
      const sent = chat(kernel, BLIP, REFUSED);
      await failRun(kernel);
      await runEvents(kernel);
      retryNow(kernel);
      await runEvents(kernel);

      const notice = {
        route: logged(kernel, "chat.reply")[0]!.body.route,
        deliveryId: await stableOpaqueId("process-run-failure", [WORKER, RUN]),
        text: "System notice: Ship couldn’t finish this request. Open Chat for details, or send another message to try again.",
        presentation: "system",
        typing: false,
      };
      expect(sent).toEqual([notice, notice]);
      expect(logged(kernel, "chat.reply")[0]).toMatchObject({ actor: { kind: "kernel" }, idempotency_key: `run.failed:${WORKER}:${RUN}` });
      expect(logged(kernel, "delivery.failed")[0]!.body).toEqual({
        pid: WORKER, runId: RUN, message: `The run failure notice could not be delivered: ${REFUSED.error}`,
      });
    });
  });

  it("hands a retry task queued before the log to the log, once", async () => {
    await fixture(async (kernel) => {
      const sent = chat(kernel);
      // Committed while the run had no messenger route, so only the old task carries it to the chat.
      kernel.runRoutes.delete(RUN);
      const message = await send(kernel, "Booked the 9:40.");
      const task = { runId: RUN, processId: WORKER, route: ROUTE, event: "message.committed", payload: { message, directed: true }, attempt: 6 };

      await kernel.adapterDelivery.onAdapterRouteDelivery(task);
      await kernel.adapterDelivery.onAdapterRouteDelivery(task);
      await runEvents(kernel);

      expect(logged(kernel, "chat.reply")).toEqual([expect.objectContaining({ idempotency_key: `message:${message.id}`, state: "delivered" })]);
      expect(sent.map(({ deliveryId, text }) => [deliveryId, text])).toEqual([[message.id, "Booked the 9:40."]]);
    });
  });

  it("reports a reply that ended unsent with redacted diagnostics, and none of the chat's ids", async () => {
    await fixture(async (kernel) => {
      // Telemetry is on for this Kernel alone.
      const bindings = kernel.bindings;
      vi.spyOn(kernel, "bindings", "get").mockReturnValue({ ...bindings, GSV_TELEMETRY_ENABLED: "1" });
      chat(kernel, {
        state: "permanent", stage: "adapter", error: "WhatsApp rejected the delivery to dm-1",
        diagnostics: { exceptionName: "APIError", exceptionMessage: "Rate limited token=private-provider-token", errorCode: "130429", providerStatusCode: 429, providerRequestId: "meta-trace" },
      });
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      await send(kernel, "Booked the 9:40.");
      await runEvents(kernel);

      const reports = log.mock.calls.flat().filter((record) => JSON.stringify(record).includes("adapter.route_delivery.failed"));
      expect(reports).toEqual([expect.objectContaining({
        installationId: kernel.installationId,
        component: "gateway",
        event: {
          stream: "operational",
          name: "adapter.route_delivery.failed",
          properties: {
            adapter: "whatsapp", deliveryKind: "message", surface: "dm", outcome: "failed", failureKind: "permanent", attempts: 1, stage: "adapter",
            exceptionName: "APIError", exceptionMessage: "Rate limited token=[redacted]", errorCode: "130429", providerStatusCode: 429, providerRequestId: "meta-trace",
          },
        },
      })]);
      expect(JSON.stringify(reports)).not.toMatch(/private-provider-token|dm-1|wa:\+123|Booked/);
    });
  });
});
