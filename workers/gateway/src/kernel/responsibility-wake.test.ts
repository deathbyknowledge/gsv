import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as processTransport from "../shared/utils";
import type { Kernel } from "./do";
import * as personalController from "./personal-controller";

const OWNER = 1000;
const MINUTE_MS = 60_000;
const PERSON = { kind: "account", uid: OWNER, username: "person" } as const;
const SHIP = { kind: "process", processId: "proc:ship", runId: "run:ship" } as const;

afterEach(() => vi.restoreAllMocks());

async function fixture(work: (kernel: Kernel) => Promise<void>) {
  const stub = env.KERNEL.get(env.KERNEL.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, work);
}

function ship() {
  const found = vi.spyOn(personalController, "ensurePersonalController").mockResolvedValue("proc:ship");
  const deliver = vi.spyOn(processTransport, "deliverEventToProcess").mockImplementation(async (_installation, _pid, args) => (
    { eventId: args.eventId, runId: args.eventId, queued: false }
  ));
  return { found, deliver };
}

function ready(kernel: Kernel, title: string) {
  return kernel.responsibilities.create({
    ownerUid: OWNER, title, source: PERSON, assignee: { kind: "ship" }, state: "open", priority: "normal",
    actor: PERSON, observedByShip: false, now: Date.now(),
  }).record;
}

/** The owner's wake timer firing. */
async function wake(kernel: Kernel) {
  await kernel.responsibilityRuntime.onResponsibilityWake(kernel.responsibilities.wakeState(OWNER));
}

/** One runner pass, which the timer's kick runs in the same alarm. */
async function runEvents(kernel: Kernel) {
  await kernel.eventRuntime.onEvents({ id: `task:${crypto.randomUUID()}` });
}

function batches(kernel: Kernel) {
  return kernel.ctx.storage.sql.exec<{ seq: number; subject: string; state: string; last_error: string | null; body_json: string }>(
    `SELECT e.seq, e.subject, d.state, d.last_error, e.body_json FROM events e JOIN deliveries d ON d.seq = e.seq
     WHERE e.type = 'responsibility.ready' ORDER BY e.seq`,
  ).toArray().map(({ body_json, ...row }) => ({ ...row, body: JSON.parse(body_json) }));
}

describe("responsibility wakes on the event log", () => {
  it("hands due work to Ship as one event and arms its recovery from the delivery", async () => {
    const { deliver } = ship();
    await fixture(async (kernel) => {
      const first = ready(kernel, "Answer the landlord");
      const second = ready(kernel, "Book the dentist");
      await wake(kernel);
      const ledgerRevision = kernel.responsibilities.revision(OWNER);
      const [batch] = batches(kernel);
      expect(batches(kernel)).toEqual([{
        seq: batch!.seq, subject: `owner:${OWNER}`, state: "pending", last_error: null,
        body: { responsibilityIds: [first.id, second.id], ledgerRevision },
      }]);
      // The timer kicked the runner, which is due at once.
      expect(kernel.ctx.storage.sql.exec(
        "SELECT 1 FROM cf_agents_schedules WHERE callback = 'onEvents' AND time <= ?", Math.ceil(Date.now() / 1_000),
      ).toArray()).toHaveLength(1);

      const deliveredFrom = Date.now();
      await runEvents(kernel);
      const eventId = `evt_${batch!.seq}:personal:${OWNER}`;
      expect(deliver).toHaveBeenCalledExactlyOnceWith(expect.any(String), "proc:ship", {
        eventId,
        event: {
          kind: "responsibility.ready", severity: "info", audience: "model",
          payload: { batchId: eventId, ledgerRevision, responsibilityIds: [first.id, second.id], receivedAtMs: expect.any(Number) },
        },
        admission: { idle: "start", busy: "join" },
        responsibilities: { ledgerRevision, ids: [first.id, second.id] },
      });
      expect(batches(kernel)).toMatchObject([{ state: "delivered" }]);
      const recoveryAt = kernel.responsibilities.nextWakeAt(OWNER, Date.now())!;
      expect(recoveryAt).toBeGreaterThanOrEqual(deliveredFrom + 5 * MINUTE_MS);
      expect(recoveryAt).toBeLessThanOrEqual(Date.now() + 5 * MINUTE_MS);
      // Its delivery set the timer for that recovery.
      expect(kernel.responsibilities.wakeState(OWNER).scheduledAtMs).toBe(Math.ceil(recoveryAt / 1_000) * 1_000);
    });
  });

  it("holds work that comes due while a batch waits for the next batch", async () => {
    const { deliver } = ship();
    deliver.mockRejectedValueOnce(new Error("Ship is restarting"));
    await fixture(async (kernel) => {
      const first = ready(kernel, "Answer the landlord");
      await wake(kernel);
      await runEvents(kernel);
      const second = ready(kernel, "Book the dentist");
      const third = ready(kernel, "Renew the passport");
      await wake(kernel);
      expect(batches(kernel)).toMatchObject([{ state: "pending", last_error: "Ship is restarting", body: { responsibilityIds: [first.id] } }]);
      expect(kernel.responsibilities.wakeState(OWNER)).toMatchObject({ taskId: null, scheduledAtMs: null });

      kernel.ctx.storage.sql.exec("UPDATE deliveries SET next_attempt_at = 0");
      await runEvents(kernel);
      expect(kernel.responsibilities.wakeState(OWNER).taskId).not.toBeNull();
      await wake(kernel);
      await runEvents(kernel);
      expect(batches(kernel)).toMatchObject([
        { state: "delivered", body: { responsibilityIds: [first.id] } },
        { state: "delivered", body: { responsibilityIds: [second.id, third.id] } },
      ]);
      expect(deliver).toHaveBeenCalledTimes(3);
    });
  });

  it("withdraws a batch whose work was settled while it waited, without finding Ship", async () => {
    const { found, deliver } = ship();
    await fixture(async (kernel) => {
      const record = ready(kernel, "Answer the landlord");
      await wake(kernel);
      kernel.responsibilities.update({
        ownerUid: OWNER, id: record.id, patch: { state: "resolved", resolution: "Answered" },
        actor: SHIP, observedByShip: true, now: Date.now(),
      });
      await runEvents(kernel);
      expect(found).not.toHaveBeenCalled();
      expect(deliver).not.toHaveBeenCalled();
      expect(batches(kernel)).toMatchObject([{ state: "withdrawn", last_error: "its work was settled while it waited" }]);
      expect(kernel.responsibilities.wakeState(OWNER)).toMatchObject({ taskId: null, scheduledAtMs: null });
    });
  });

  it("delivers only the work still open when part of a batch was settled", async () => {
    const { deliver } = ship();
    await fixture(async (kernel) => {
      const answered = ready(kernel, "Answer the landlord");
      const open = ready(kernel, "Book the dentist");
      await wake(kernel);
      kernel.responsibilities.update({
        ownerUid: OWNER, id: answered.id, patch: { state: "resolved", resolution: "Answered" },
        actor: SHIP, observedByShip: true, now: Date.now(),
      });
      await runEvents(kernel);
      expect(deliver).toHaveBeenCalledOnce();
      expect(deliver.mock.calls[0]?.[2]).toMatchObject({
        event: { payload: { responsibilityIds: [open.id] } },
        responsibilities: { ids: [open.id] },
      });
    });
  });

  it("takes no batch while the space is restricted, and checks again in a minute", async () => {
    const { deliver } = ship();
    await fixture(async (kernel) => {
      const record = ready(kernel, "Answer the landlord");
      const revision = kernel.responsibilities.revision(OWNER);
      vi.spyOn(kernel.onboarding, "managedWorkGate").mockResolvedValue({ allowed: false, code: 423, message: "Installation is restricted" });
      const before = Date.now();
      await wake(kernel);
      expect(batches(kernel)).toEqual([]);
      expect(kernel.responsibilities.revision(OWNER)).toBe(revision);
      expect(kernel.responsibilities.get(OWNER, record.id)).toMatchObject({ state: "open" });
      expect(kernel.responsibilities.wakeState(OWNER).scheduledAtMs).toBeGreaterThanOrEqual(before + MINUTE_MS);
      expect(deliver).not.toHaveBeenCalled();
    });
  });

  it("hands Ship due work while a contact message ahead of it keeps failing", async () => {
    const { deliver } = ship();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await fixture(async (kernel) => {
      // A contact message whose stored body no longer reads keeps retrying in Ship's background lane.
      const now = Date.now();
      const { seq } = kernel.ctx.storage.sql.exec<{ seq: number }>(
        `INSERT INTO events (type, owner_uid, subject, actor_json, idempotency_key, body_json, created_at)
         VALUES ('contact.message', ?, 'contact:stuck', '{"kind":"kernel"}', 'stuck', '{}', ?) RETURNING seq`,
        OWNER, now,
      ).one();
      kernel.ctx.storage.sql.exec(
        `INSERT INTO deliveries (seq, consumer, lane, state, attempt_count, next_attempt_at, updated_at)
         VALUES (?, ?, 'background', 'pending', 0, ?, ?)`,
        seq, `personal:${OWNER}`, now, now,
      );
      const record = ready(kernel, "Answer the landlord");
      await wake(kernel);
      await runEvents(kernel);
      expect(batches(kernel)).toMatchObject([{ state: "delivered", body: { responsibilityIds: [record.id] } }]);
      expect(deliver).toHaveBeenCalledOnce();
      expect(kernel.ctx.storage.sql.exec("SELECT state, attempt_count FROM deliveries WHERE seq = ?", seq).one())
        .toEqual({ state: "pending", attempt_count: 1 });
    });
  });

  it("tells Ship about work the person settled before the batch was taken", async () => {
    const { deliver } = ship();
    await fixture(async (kernel) => {
      const record = ready(kernel, "Answer the landlord");
      kernel.responsibilities.update({
        ownerUid: OWNER, id: record.id, patch: { state: "cancelled", resolution: "No longer needed" },
        actor: PERSON, observedByShip: false, now: Date.now(),
      });
      await wake(kernel);
      await runEvents(kernel);
      expect(deliver.mock.calls[0]?.[2]).toMatchObject({ responsibilities: { ids: [record.id] } });
    });
  });
});
