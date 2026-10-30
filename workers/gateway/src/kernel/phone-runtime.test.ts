import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import type { PhoneCall, SysPhoneGetResult } from "@humansandmachines/gsv/protocol";
import type { InstallationPhone } from "@humansandmachines/gsv/services/phone";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import type { Kernel } from "./do";
import { PhoneRuntime, admitQueuedPhoneEvent, phoneCallBlocker } from "./phone-runtime";
import { PhoneCallStore } from "./phone-store";
import { ResponsibilityStore } from "./responsibility-store";
import { ShipEventStore } from "./ship-event-store";

const OWNER = 1000;
const SHIP = 1001;
const INSTALLATION = "installation:phone-test";
const ANSWERED_AT = Date.UTC(2026, 9, 29, 18);
const actor = { kind: "system", component: "test" } as const;

afterEach(() => vi.restoreAllMocks());

describe("phone notifications", () => {
  it("raises each question with Ship once and ignores a revision older than one applied", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const f = fixture(storage);
      const work = waitingWork(f.responsibilities, "call:1");
      f.current = { call: call({ revision: 3, state: "asking", responsibilityId: work.id, question: question("q:1") }) };

      await f.runtime.changed(change(3, "asked"));
      await f.runtime.changed(change(3, "asked"));
      expect(f.shipEvents.next(OWNER)).toMatchObject({ eventId: "phone.asked:call:1:q:1", event: {
        type: "phone.asked", callId: "call:1", questionId: "q:1", question: "Only 21:30 is free. Take it?", responsibilityId: work.id,
      } });
      expect(f.shipEvents.backlog(OWNER).queued).toBe(1);
      expect(f.broadcast).toHaveBeenCalledWith(OWNER, "phone.changed", { callId: "call:1", revision: 3, state: "asking" });

      f.get.mockClear();
      await f.runtime.changed(change(2, "changed"));
      expect(f.get).not.toHaveBeenCalled();
      expect(f.phoneCalls.get("call:1")).toMatchObject({ revision: 3, state: "asking", askedQuestionId: "q:1" });
    });
  });

  it("files the transcript, reopens the work and hands the result to Ship once; a settled call never changes", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const f = fixture(storage);
      const work = waitingWork(f.responsibilities, "call:1");
      f.current = {
        call: call({ revision: 7, state: "ended", outcome: "completed", summary: "Booked for 21:30", responsibilityId: work.id }),
        transcript: [
          { at: ANSWERED_AT + 1_000, speaker: "agent", text: "Hi! I'm calling for Esteve, I'm his AI assistant." },
          { at: ANSWERED_AT + 3_000, speaker: "callee", text: "Sure, 21:30 works." },
        ],
      };

      await f.runtime.changed(change(7, "ended"));
      const path = "/home/ship/calls/2026-10-29-call:1.md";
      expect(f.transcriptFiled).toHaveBeenCalledWith({ ownerUid: OWNER, human: false }, "call:1", path);
      const file = await env.STORAGE.get(path.slice(1));
      expect(await file?.text()).toContain("**Restaurante Lúa** [0:03]: Sure, 21:30 works.");
      expect(file?.customMetadata?.uid).toBe(String(SHIP));
      expect(f.responsibilities.get(OWNER, work.id)).toMatchObject({
        state: "open", details: { phoneCall: { callId: "call:1", outcome: "completed", transcriptPath: path } },
      });
      expect(f.responsibilities.get(OWNER, work.id)?.blocker).toBeUndefined();
      expect(f.shipEvents.next(OWNER)).toMatchObject({ eventId: "phone.ended:call:1", event: {
        type: "phone.ended", outcome: "completed", summary: "Booked for 21:30", transcriptPath: path, responsibilityId: work.id,
      } });

      // A late or replayed notification for the settled call is ignored without reading it again.
      f.get.mockClear();
      f.current = { call: { ...f.current.call, revision: 8 } };
      await f.runtime.changed(change(8, "changed"));
      expect(f.get).not.toHaveBeenCalled();
      expect(f.phoneCalls.get("call:1")).toMatchObject({ revision: 7, transcriptPath: path });
      expect(f.shipEvents.backlog(OWNER).queued).toBe(1);
    });
  });

  it("ignores a notification for another installation or owner", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const f = fixture(storage);
      f.current = { call: call({ revision: 1, state: "ringing" }) };
      await f.runtime.changed({ ...change(1, "changed"), installationId: "installation:other" });
      expect(f.get).not.toHaveBeenCalled();
      f.current = { call: { ...call({ revision: 1, state: "ringing" }), ownerUid: 2000 } };
      await f.runtime.changed(change(1, "changed"));
      expect(f.phoneCalls.get("call:1")).toBeNull();
    });
  });

  it("drops a queued question once its deadline passed or its work was settled", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const responsibilities = new ResponsibilityStore(storage);
      const work = waitingWork(responsibilities, "call:1");
      const asked = {
        type: "phone.asked" as const, callId: "call:1", to: "+34910000000", questionId: "q:1", question: "Take it?",
        deadlineAt: Date.now() + 30_000, responsibilityId: work.id, ledgerRevision: 1,
      };
      expect(admitQueuedPhoneEvent(OWNER, asked, responsibilities)).toBe(true);
      expect(admitQueuedPhoneEvent(OWNER, { ...asked, deadlineAt: Date.now() - 1 }, responsibilities)).toBe(false);
      responsibilities.update({ ownerUid: OWNER, id: work.id, patch: { state: "resolved" }, actor, observedByShip: false, now: Date.now() });
      expect(admitQueuedPhoneEvent(OWNER, asked, responsibilities)).toBe(false);
    });
  });
});

function fixture(storage: DurableObjectStorage) {
  const shipEvents = new ShipEventStore(storage);
  const responsibilities = new ResponsibilityStore(storage);
  const phoneCalls = new PhoneCallStore(storage);
  const broadcast = vi.fn();
  const state: { current: SysPhoneGetResult } = { current: { call: call({ revision: 1, state: "queued" }) } };
  const get = vi.fn(async () => state.current);
  const transcriptFiled = vi.fn(async () => {});
  // SAFETY: PhoneRuntime reaches only these members of the calls service.
  const service = { get, transcriptFiled } as unknown as InstallationPhone;
  const passwd: Record<number, { uid: number; gid: number; username: string; home: string }> = {
    [OWNER]: { uid: OWNER, gid: 100, username: "esteve", home: "/home/esteve" },
    [SHIP]: { uid: SHIP, gid: 100, username: "ship", home: "/home/ship" },
  };
  const auth = {
    getPasswdByUid: (uid: number) => passwd[uid] ?? null,
    getPersonalAgentUid: (uid: number) => uid === OWNER ? SHIP : null,
    isAccountDisabled: () => false,
    resolveGids: () => [100],
  };
  const host = {
    installationId: INSTALLATION,
    ctx: { storage },
    phoneCalls, responsibilities, shipEvents, auth,
    retirement: { assertActive: () => {} },
    onboarding: { managedWorkGate: async () => ({ allowed: true }) },
    connectionRuntime: { broadcastToUserUid: broadcast },
    shipEventRuntime: { queue: vi.fn(async () => {}) },
    responsibilityRuntime: { reconcileResponsibilityWake: vi.fn(async () => {}) },
    buildKernelContext: () => ({
      installationId: INSTALLATION, auth, env: { STORAGE: env.STORAGE, PHONE: { getInstallation: async () => service } },
    }),
  };
  // SAFETY: PhoneRuntime reaches only these Kernel members.
  const runtime = new PhoneRuntime(host as unknown as Kernel);
  return {
    runtime, shipEvents, responsibilities, phoneCalls, broadcast, get, transcriptFiled,
    get current() { return state.current; },
    set current(value: SysPhoneGetResult) { state.current = value; },
  };
}

function waitingWork(responsibilities: ResponsibilityStore, callId: string) {
  return responsibilities.create({
    ownerUid: OWNER, title: "Book a table at Lúa", source: actor, actor, assignee: { kind: "ship" },
    state: "waiting", blocker: phoneCallBlocker(callId), priority: "normal", observedByShip: true, now: Date.now(),
  }).record;
}

function change(revision: number, event: "changed" | "asked" | "ended") {
  return { installationId: INSTALLATION, ownerUid: OWNER, callId: "call:1", revision, event };
}

function question(questionId: string) {
  return { questionId, question: "Only 21:30 is free. Take it?", askedAt: Date.now(), deadlineAt: Date.now() + 45_000 };
}

function call(fields: Partial<PhoneCall> & Pick<PhoneCall, "revision" | "state">): PhoneCall {
  return {
    callId: "call:1", requestId: "request:1", ownerUid: OWNER, createdAt: ANSWERED_AT, answeredAt: ANSWERED_AT,
    brief: { to: "+34910000000", business: "Restaurante Lúa", onBehalfOf: "Esteve", goal: "Book a table for four on Friday" },
    ...fields,
  };
}
