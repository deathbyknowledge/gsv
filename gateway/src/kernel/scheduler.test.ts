import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import type {
  ProcessIdentity,
  SchedulePrincipal,
  ScheduleRecord,
} from "@humansandmachines/gsv/protocol";
import { getProcessByPid } from "../shared/utils";
import type { RequestFrame } from "../protocol/frames";
import { Kernel } from "./do";
import {
  computeNextRunAfterFinish,
  computeNextRunAt,
  handleSchedulerAdd,
  handleSchedulerList,
  handleSchedulerRemove,
  handleSchedulerRun,
  handleSchedulerUpdate,
  normalizeScheduleExpression,
  ScheduleStore,
} from "./scheduler";
import type { KernelContext } from "./context";
import type { Process } from "../process/do";
import type { AccountIdentityKind, AuthStore } from "./auth-store";
import {
  USER_KERNEL_INSTANCE_STORAGE_KEY,
  type UserKernelInstanceMarker,
} from "./user-kernels";
import { userKernelName } from "../shared/kernel-names";

const USER_IDENTITY: ProcessIdentity = {
  uid: 1000,
  gid: 1000,
  gids: [1000, 100],
  username: "sam",
  home: "/home/sam",
  cwd: "/home/sam",
};

const PERSONAL_AGENT_IDENTITY: ProcessIdentity = {
  uid: 2000,
  gid: 2000,
  gids: [2000],
  username: "sam-agent",
  home: "/home/sam-agent",
  cwd: "/home/sam-agent",
};

const CUSTOM_AGENT_IDENTITY: ProcessIdentity = {
  uid: 3000,
  gid: 3000,
  gids: [3000],
  username: "wiki-builder",
  home: "/home/wiki-builder",
  cwd: "/home/wiki-builder",
};

type ScheduleTestAuth = Pick<AuthStore, "addUser" | "addGroup" | "setPersonalAgent">;

function addTestAccount(
  auth: ScheduleTestAuth,
  identity: ProcessIdentity,
  gecos: string,
  kind: AccountIdentityKind = "human",
): void {
  auth.addUser({
    username: identity.username,
    uid: identity.uid,
    gid: identity.gid,
    gecos,
    home: identity.home,
    shell: "/bin/init",
  }, kind);
  auth.addGroup({ name: identity.username, gid: identity.gid, members: [] });
}

function addTestUser(auth: ScheduleTestAuth): void {
  addTestAccount(auth, USER_IDENTITY, "Sam");
  auth.addGroup({ name: "users", gid: 100, members: [USER_IDENTITY.username] });
}

function makeReq(call: string, args: unknown): RequestFrame {
  return { type: "req", id: crypto.randomUUID(), call, args } as RequestFrame;
}

async function newScheduleKernel(): Promise<{
  kernel: DurableObjectStub<Kernel>;
  kernelName: string;
}> {
  const username = `sched-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const kernelName = userKernelName(username);
  const kernel = await getAgentByName<Env, Kernel>(env.KERNEL, kernelName);
  await runInDurableObject(kernel, async (instance: Kernel, state) => {
    const marker: UserKernelInstanceMarker = {
      version: 1,
      kind: "user",
      username,
      uid: USER_IDENTITY.uid,
      generation: 1,
      lifecycle: "active",
      updatedAt: Date.now(),
    };
    await state.storage.put(USER_KERNEL_INSTANCE_STORAGE_KEY, marker);
    (instance as unknown as { userKernelMarker: UserKernelInstanceMarker }).userKernelMarker = marker;
  });
  return { kernel, kernelName };
}

async function prepareScheduleTargetProcess(
  kernelName: string,
  process: DurableObjectStub<Process>,
  pid: string,
  conversationId = "default",
  identity: ProcessIdentity = USER_IDENTITY,
  ownerIdentity: ProcessIdentity = identity,
): Promise<void> {
  const setIdentity = await process.recvFrame(makeReq("proc.setidentity", {
    pid,
    kernelName,
    identity,
    ownerIdentity,
    profile: "task",
  }));
  expect(setIdentity?.type).toBe("res");
  expect(setIdentity && "ok" in setIdentity ? setIdentity.ok : false).toBe(true);

  await runInDurableObject(process, (instance: Process) => {
    const processStore = (instance as unknown as {
      store: {
        ensureConversation(conversationId: string): unknown;
        setValue(key: string, value: string): void;
      };
    }).store;
    processStore.ensureConversation(conversationId);
    processStore.setValue("currentRun", JSON.stringify({
      runId: `test-suppressed-${crypto.randomUUID()}`,
      queued: false,
      conversationId,
    }));
  });
}

function schedulePrincipal(pid?: string): SchedulePrincipal {
  return {
    kind: pid ? "process" : "user",
    uid: USER_IDENTITY.uid,
    username: USER_IDENTITY.username,
    ...(pid ? { pid } : {}),
  };
}

function makeScheduleRecord(partial: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    id: "sched-1",
    ownerUid: USER_IDENTITY.uid,
    creator: schedulePrincipal(),
    runAs: schedulePrincipal(),
    name: "test schedule",
    enabled: true,
    expression: { kind: "every", everyMs: 60_000 },
    target: { kind: "process.spawn", prompt: "Run the scheduled task." },
    overlapPolicy: "skip",
    createdAtMs: 1,
    updatedAtMs: 1,
    state: {
      nextRunAtMs: Date.now() + 60_000,
      runningAtMs: null,
      lastRunAtMs: null,
      lastStatus: null,
      lastError: null,
      lastDurationMs: null,
      runCount: 0,
    },
    ...partial,
  };
}

function makeSchedulerContext(overrides: Partial<KernelContext> = {}): KernelContext {
  return {
    identity: {
      role: "user",
      process: USER_IDENTITY,
      capabilities: ["*"],
    },
    config: {
      get: vi.fn((key: string) => key === "config/server/timezone" ? "UTC" : null),
    },
    procs: {
      get: vi.fn(),
    },
    ...overrides,
  } as unknown as KernelContext;
}

describe("scheduler", () => {
  it("computes cron next-runs in the schedule timezone", () => {
    const expression = {
      kind: "cron" as const,
      expr: "0 9 * * *",
      timezone: "Europe/Amsterdam",
    };

    expect(new Date(computeNextRunAt(expression, Date.parse("2026-03-28T07:59:00.000Z"))!).toISOString())
      .toBe("2026-03-28T08:00:00.000Z");
    expect(new Date(computeNextRunAt(expression, Date.parse("2026-03-29T06:59:00.000Z"))!).toISOString())
      .toBe("2026-03-29T07:00:00.000Z");
  });

  it("treats full-range cron day fields as wildcards", () => {
    expect(new Date(computeNextRunAt({
      kind: "cron",
      expr: "0 9 */1 * 1",
      timezone: "UTC",
    }, Date.parse("2026-05-03T08:59:00.000Z"))!).toISOString())
      .toBe("2026-05-04T09:00:00.000Z");

    expect(new Date(computeNextRunAt({
      kind: "cron",
      expr: "0 9 1-31 * 1",
      timezone: "UTC",
    }, Date.parse("2026-05-03T08:59:00.000Z"))!).toISOString())
      .toBe("2026-05-04T09:00:00.000Z");

    expect(new Date(computeNextRunAt({
      kind: "cron",
      expr: "0 9 15 * 0-6",
      timezone: "UTC",
    }, Date.parse("2026-05-03T08:59:00.000Z"))!).toISOString())
      .toBe("2026-05-15T09:00:00.000Z");
  });

  it("computes recurring next-runs from the completion boundary", () => {
    const anchorMs = Date.parse("2026-04-28T10:00:00.000Z");

    expect(computeNextRunAfterFinish({
      kind: "every",
      everyMs: 15 * 60_000,
      anchorMs,
    }, Date.parse("2026-04-28T10:14:59.000Z"))).toEqual({
      enabled: true,
      nextRunAtMs: Date.parse("2026-04-28T10:15:00.000Z"),
    });

    expect(computeNextRunAfterFinish({
      kind: "every",
      everyMs: 15 * 60_000,
      anchorMs,
    }, Date.parse("2026-04-28T10:15:00.000Z"))).toEqual({
      enabled: true,
      nextRunAtMs: Date.parse("2026-04-28T10:30:00.000Z"),
    });
  });

  it("disables one-shot expressions after completion", () => {
    expect(computeNextRunAfterFinish({
      kind: "after",
      afterMs: 30_000,
    }, Date.now())).toEqual({ enabled: false, nextRunAtMs: null });

    expect(computeNextRunAfterFinish({
      kind: "at",
      atMs: Date.now() + 30_000,
    }, Date.now())).toEqual({ enabled: false, nextRunAtMs: null });
  });

  it("rejects invalid cron and timezone expressions", () => {
    expect(() => normalizeScheduleExpression({
      kind: "cron",
      expr: "0 9 * *",
      timezone: "UTC",
    })).toThrow("cron expression must use five fields");

    expect(() => normalizeScheduleExpression({
      kind: "cron",
      expr: "0 9 * * *",
      timezone: "No/Such_Zone",
    })).toThrow("timezone must be a valid IANA timezone");

    expect(() => normalizeScheduleExpression({
      kind: "every",
      everyMs: 999,
    })).toThrow("schedule everyMs must be at least 1000");
  });

  it("defaults cron schedules to the system timezone and arms a wake", async () => {
    const wake = vi.fn(async () => "wake-1");
    const store = {
      create: vi.fn((input) => ({
        id: "sched-1",
        ownerUid: input.ownerUid,
        creator: input.creator,
        runAs: input.runAs,
        name: input.name,
        enabled: input.enabled,
        expression: input.expression,
        target: input.target,
        overlapPolicy: "skip",
        createdAtMs: input.now,
        updatedAtMs: input.now,
        state: {
          nextRunAtMs: Date.now() + 60_000,
          runningAtMs: null,
          lastRunAtMs: null,
          lastStatus: null,
          lastError: null,
          lastDurationMs: null,
          runCount: 0,
        },
      })),
      setWakeScheduleId: vi.fn(),
    };
    const ctx = {
      identity: {
        role: "user",
        process: USER_IDENTITY,
        capabilities: ["*"],
      },
      config: {
        get: vi.fn((key: string) => (
          key === "config/server/timezone" ? "Europe/Amsterdam" : null
        )),
      },
      procs: {
        get: vi.fn(),
      },
      schedules: store,
      scheduleScheduleWake: wake,
    } as unknown as KernelContext;

    const result = await handleSchedulerAdd({
      name: "morning check",
      expression: { kind: "cron", expr: "0 9 * * *", timezone: "" },
      target: {
        kind: "process.spawn",
        prompt: "Check the system state.",
      },
    }, ctx);

    expect(result.schedule.expression).toEqual({
      kind: "cron",
      expr: "0 9 * * *",
      timezone: "Europe/Amsterdam",
    });
    expect(wake).toHaveBeenCalledWith("sched-1", expect.any(Number));
    expect(store.setWakeScheduleId).toHaveBeenCalledWith("sched-1", "wake-1");
  });

  it("rejects enabled one-shot timestamps that are not in the future", async () => {
    const create = vi.fn();
    const ctx = makeSchedulerContext({
      schedules: { create } as unknown as ScheduleStore,
    });

    await expect(handleSchedulerAdd({
      name: "past event",
      expression: { kind: "at", atMs: Date.now() - 1_000 },
      target: { kind: "process.spawn", prompt: "Do not run." },
    }, ctx)).rejects.toThrow("schedule atMs must be in the future");

    expect(create).not.toHaveBeenCalled();
  });

  it("rejects enabling a past one-shot before changing its wake", async () => {
    const existing = makeScheduleRecord({
      enabled: false,
      expression: { kind: "at", atMs: Date.now() - 1_000 },
      state: {
        ...makeScheduleRecord().state,
        nextRunAtMs: null,
      },
    });
    const stored = { ...existing, wakeScheduleId: null };
    const update = vi.fn();
    const cancel = vi.fn(async () => {});
    const ctx = makeSchedulerContext({
      schedules: {
        getStored: vi.fn(() => stored),
        update,
      } as unknown as ScheduleStore,
      cancelScheduleWake: cancel,
      scheduleScheduleWake: vi.fn(async () => "wake-new"),
    });

    await expect(handleSchedulerUpdate({
      id: existing.id,
      patch: { enabled: true },
    }, ctx)).rejects.toThrow("schedule atMs must be in the future");

    expect(cancel).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("requires shell.exec access for command schedules", async () => {
    const ctx = makeSchedulerContext({
      identity: {
        role: "user",
        process: USER_IDENTITY,
        capabilities: ["sched.add"],
      },
      schedules: {
        create: vi.fn(),
      } as unknown as ScheduleStore,
    });

    await expect(handleSchedulerAdd({
      name: "command",
      expression: { kind: "after", afterMs: 1_000 },
      target: { kind: "command.exec", command: "proc list" },
    }, ctx)).rejects.toThrow("Permission denied: shell.exec");
  });

  it("requires proc.spawn access for process spawn schedules", async () => {
    const ctx = makeSchedulerContext({
      identity: {
        role: "user",
        process: USER_IDENTITY,
        capabilities: ["sched.add"],
      },
      schedules: {
        create: vi.fn(),
      } as unknown as ScheduleStore,
    });

    await expect(handleSchedulerAdd({
      name: "spawn",
      expression: { kind: "after", afterMs: 1_000 },
      target: { kind: "process.spawn", prompt: "Run the scheduled task." },
    }, ctx)).rejects.toThrow("Permission denied: proc.spawn");
  });

  it("requires proc.send access for process event schedules", async () => {
    const ctx = makeSchedulerContext({
      identity: {
        role: "user",
        process: USER_IDENTITY,
        capabilities: ["sched.add"],
      },
      procs: {
        get: vi.fn(() => ({
          processId: "proc:target",
          ownerUid: USER_IDENTITY.uid,
        })),
      } as unknown as KernelContext["procs"],
      schedules: {
        create: vi.fn(),
      } as unknown as ScheduleStore,
    });

    await expect(handleSchedulerAdd({
      name: "event",
      expression: { kind: "after", afterMs: 1_000 },
      target: {
        kind: "process.event",
        pid: "proc:target",
        message: "Run the pulse.",
      },
    }, ctx)).rejects.toThrow("Permission denied: proc.send");
  });

  it("lists only the caller owner for non-root, even when ownerUid is supplied", () => {
    const list = vi.fn(() => ({ records: [], count: 0 }));
    const ctx = makeSchedulerContext({
      schedules: { list } as unknown as ScheduleStore,
    });

    const result = handleSchedulerList({ ownerUid: 2000, includeDisabled: true }, ctx);

    expect(result).toEqual({ schedules: [], count: 0 });
    expect(list).toHaveBeenCalledWith({
      ownerUid: USER_IDENTITY.uid,
      includeDisabled: true,
      limit: undefined,
      offset: undefined,
    });
  });

  it("lists by the owning human for process-originated calls", () => {
    const list = vi.fn(() => ({ records: [], count: 0 }));
    const ctx = makeSchedulerContext({
      identity: {
        role: "user",
        process: PERSONAL_AGENT_IDENTITY,
        capabilities: ["*"],
      },
      processId: "proc:agent",
      procs: {
        getOwnerUid: vi.fn(() => USER_IDENTITY.uid),
      } as unknown as KernelContext["procs"],
      schedules: { list } as unknown as ScheduleStore,
    });

    handleSchedulerList({ includeDisabled: true }, ctx);

    expect(list).toHaveBeenCalledWith({
      ownerUid: USER_IDENTITY.uid,
      includeDisabled: true,
      limit: undefined,
      offset: undefined,
    });
  });

  it("lets root list another owner's schedules", () => {
    const list = vi.fn(() => ({ records: [], count: 0 }));
    const ctx = makeSchedulerContext({
      identity: {
        role: "user",
        process: {
          ...USER_IDENTITY,
          uid: 0,
          gid: 0,
          gids: [0],
          username: "root",
          home: "/root",
          cwd: "/root",
        },
        capabilities: ["*"],
      },
      schedules: { list } as unknown as ScheduleStore,
    });

    handleSchedulerList({ ownerUid: 2000 }, ctx);

    expect(list).toHaveBeenCalledWith({
      ownerUid: 2000,
      includeDisabled: undefined,
      limit: undefined,
      offset: undefined,
    });
  });

  it("rejects root schedule listings outside an active user Kernel's owner", () => {
    const list = vi.fn(() => ({ records: [], count: 0 }));
    const ctx = makeSchedulerContext({
      kernelKind: "user",
      kernelOwnerUid: USER_IDENTITY.uid,
      identity: {
        role: "user",
        process: {
          ...USER_IDENTITY,
          uid: 0,
          gid: 0,
          gids: [0],
          username: "root",
          home: "/root",
          cwd: "/root",
        },
        capabilities: ["*"],
      },
      schedules: { list } as unknown as ScheduleStore,
    });

    expect(() => handleSchedulerList({}, ctx)).toThrow("cross-user schedule listing");
    expect(() => handleSchedulerList({ ownerUid: 2000 }, ctx)).toThrow("cross-user schedule listing");
    expect(list).not.toHaveBeenCalled();

    handleSchedulerList({ ownerUid: USER_IDENTITY.uid }, ctx);
    expect(list).toHaveBeenCalledWith({
      ownerUid: USER_IDENTITY.uid,
      includeDisabled: undefined,
      limit: undefined,
      offset: undefined,
    });
  });

  it("creates process event schedules under the owning human for agent-backed callers", async () => {
    const create = vi.fn((input) => makeScheduleRecord({
      ownerUid: input.ownerUid,
      creator: input.creator,
      runAs: input.runAs,
      enabled: input.enabled,
      expression: input.expression,
      target: input.target,
    }));
    const setWakeScheduleId = vi.fn();
    const ctx = makeSchedulerContext({
      identity: {
        role: "user",
        process: PERSONAL_AGENT_IDENTITY,
        capabilities: ["*"],
      },
      processId: "proc:agent",
      procs: {
        getOwnerUid: vi.fn(() => USER_IDENTITY.uid),
        get: vi.fn(() => ({
          processId: "proc:target",
          uid: PERSONAL_AGENT_IDENTITY.uid,
          ownerUid: USER_IDENTITY.uid,
        })),
      } as unknown as KernelContext["procs"],
      schedules: {
        create,
        setWakeScheduleId,
      } as unknown as ScheduleStore,
    });

    const result = await handleSchedulerAdd({
      name: "agent pulse",
      enabled: false,
      expression: { kind: "after", afterMs: 1_000 },
      target: {
        kind: "process.event",
        pid: "proc:target",
        message: "Run the pulse.",
      },
    }, ctx);

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      ownerUid: USER_IDENTITY.uid,
      creator: expect.objectContaining({
        kind: "process",
        uid: PERSONAL_AGENT_IDENTITY.uid,
        pid: "proc:agent",
      }),
    }));
    expect(result.schedule.ownerUid).toBe(USER_IDENTITY.uid);
    expect(setWakeScheduleId).toHaveBeenCalledWith("sched-1", null);
  });

  it("passes the caller owner uid when running schedules", async () => {
    const runSchedules = vi.fn(async () => ({ ran: 0, results: [] }));
    const ctx = makeSchedulerContext({
      identity: {
        role: "user",
        process: PERSONAL_AGENT_IDENTITY,
        capabilities: ["*"],
      },
      processId: "proc:agent",
      procs: {
        getOwnerUid: vi.fn(() => USER_IDENTITY.uid),
      } as unknown as KernelContext["procs"],
      runSchedules,
    });
    const args = { id: "sched-1", mode: "force" as const };

    await handleSchedulerRun(args, ctx);

    expect(runSchedules).toHaveBeenCalledWith(args, ctx.identity, USER_IDENTITY.uid);
  });

  it("rejects update and remove of another owner's schedule", async () => {
    const foreign = makeScheduleRecord({ ownerUid: 2000 });
    const ctx = makeSchedulerContext({
      schedules: {
        getStored: vi.fn(() => foreign),
      } as unknown as ScheduleStore,
    });

    await expect(handleSchedulerUpdate({
      id: foreign.id,
      patch: { enabled: false },
    }, ctx)).rejects.toThrow("Permission denied");

    await expect(handleSchedulerRemove({ id: foreign.id }, ctx)).rejects.toThrow("Permission denied");
  });

  it("updates schedules by cancelling the old wake and arming the new one", async () => {
    const existing = makeScheduleRecord();
    const stored = { ...existing, wakeScheduleId: "wake-old" };
    const updated = makeScheduleRecord({
      name: "renamed",
      state: { ...existing.state, nextRunAtMs: Date.now() + 120_000 },
    });
    const cancel = vi.fn(async () => {});
    const wake = vi.fn(async () => "wake-new");
    const setWakeScheduleId = vi.fn();
    const ctx = makeSchedulerContext({
      schedules: {
        getStored: vi.fn(() => stored),
        update: vi.fn(() => updated),
        setWakeScheduleId,
      } as unknown as ScheduleStore,
      cancelScheduleWake: cancel,
      scheduleScheduleWake: wake,
    });

    const result = await handleSchedulerUpdate({
      id: existing.id,
      patch: { name: "renamed" },
    }, ctx);

    expect(result.schedule.name).toBe("renamed");
    expect(cancel).toHaveBeenCalledWith("wake-old");
    expect(wake).toHaveBeenCalledWith(existing.id, updated.state.nextRunAtMs);
    expect(setWakeScheduleId).toHaveBeenCalledWith(existing.id, "wake-new");
  });

  it("does not cancel the existing wake when update patch validation fails", async () => {
    const existing = makeScheduleRecord();
    const stored = { ...existing, wakeScheduleId: "wake-old" };
    const cancel = vi.fn(async () => {});
    const update = vi.fn();
    const ctx = makeSchedulerContext({
      schedules: {
        getStored: vi.fn(() => stored),
        update,
      } as unknown as ScheduleStore,
      cancelScheduleWake: cancel,
      scheduleScheduleWake: vi.fn(async () => "wake-new"),
    });

    await expect(handleSchedulerUpdate({
      id: existing.id,
      patch: {
        expression: {
          kind: "cron",
          expr: "0 9 * *",
          timezone: "UTC",
        },
      },
    }, ctx)).rejects.toThrow("cron expression must use five fields");

    expect(cancel).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("removes schedules by cancelling their pending wake", async () => {
    const existing = makeScheduleRecord();
    const stored = { ...existing, wakeScheduleId: "wake-old" };
    const cancel = vi.fn(async () => {});
    const ctx = makeSchedulerContext({
      schedules: {
        getStored: vi.fn(() => stored),
        remove: vi.fn(() => stored),
      } as unknown as ScheduleStore,
      cancelScheduleWake: cancel,
    });

    const result = await handleSchedulerRemove({ id: existing.id }, ctx);

    expect(result).toEqual({ removed: true });
    expect(cancel).toHaveBeenCalledWith("wake-old");
  });

  it("runs a due schedule through the Kernel and delivers a process event", async () => {
    const pid = `sched-event-${crypto.randomUUID()}`;
    const conversationId = "ops";
    const { kernel, kernelName } = await newScheduleKernel();
    const process = await getProcessByPid(pid);

    await runInDurableObject(kernel, (instance: Kernel) => {
      const k = instance as unknown as {
        auth: ScheduleTestAuth;
        caps: { seed: () => void };
        procs: {
          spawn: typeof instance["procs"]["spawn"];
        };
      };
      k.caps.seed();
      addTestUser(k.auth);
      addTestAccount(k.auth, PERSONAL_AGENT_IDENTITY, "Sam Agent", "agent");
      k.auth.setPersonalAgent(USER_IDENTITY.uid, PERSONAL_AGENT_IDENTITY.uid);
      k.procs.spawn(pid, PERSONAL_AGENT_IDENTITY, {
        ownerUid: USER_IDENTITY.uid,
        kernelGeneration: 1,
        profile: "task",
        label: "scheduled target",
      });
    });

    await prepareScheduleTargetProcess(
      kernelName,
      process,
      pid,
      conversationId,
      PERSONAL_AGENT_IDENTITY,
      USER_IDENTITY,
    );

    const scheduleId = await runInDurableObject(kernel, (instance: Kernel) => {
      const k = instance as unknown as {
        schedules: ScheduleStore;
        ctx: DurableObjectState;
      };
      const now = Date.now();
      const schedule = k.schedules.create({
        ownerUid: USER_IDENTITY.uid,
        creator: schedulePrincipal(),
        runAs: schedulePrincipal(),
        name: "ops pulse",
        enabled: true,
        expression: { kind: "every", everyMs: 60_000, anchorMs: now - 120_000 },
        target: {
          kind: "process.event",
          pid,
          conversationId,
          message: "Run the scheduled ops pulse.",
          data: { source: "test" },
        },
        now,
      });
      k.ctx.storage.sql.exec(
        "UPDATE schedules SET next_run_at = ? WHERE schedule_id = ?",
        now - 1_000,
        schedule.id,
      );
      return schedule.id;
    });

    await runInDurableObject(kernel, (instance: Kernel) => instance.onScheduleDue(scheduleId));

    const messages = await runInDurableObject(process, (instance: Process) => {
      return (instance as unknown as {
        store: { getMessages: (opts: { conversationId: string }) => Array<{ role: string; content: string }> };
      }).store.getMessages({ conversationId });
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("Scheduled event `ops pulse` fired.");
    expect(messages[0].content).toContain("Run the scheduled ops pulse.");

    const schedule = await runInDurableObject(kernel, (instance: Kernel) => {
      return (instance as unknown as { schedules: ScheduleStore }).schedules.get(scheduleId);
    });
    expect(schedule?.state.lastStatus).toBe("ok");
    expect(schedule?.state.runCount).toBe(1);
    expect(schedule?.state.nextRunAtMs).toEqual(expect.any(Number));
  });

  it("records an error when a process event targets a closed conversation", async () => {
    const pid = `sched-event-closed-${crypto.randomUUID()}`;
    const { kernel, kernelName } = await newScheduleKernel();
    const process = await getProcessByPid(pid);

    await runInDurableObject(kernel, (instance: Kernel) => {
      const k = instance as unknown as {
        auth: ScheduleTestAuth;
        caps: { seed: () => void };
        procs: { spawn: typeof instance["procs"]["spawn"] };
      };
      k.caps.seed();
      addTestUser(k.auth);
      k.procs.spawn(pid, USER_IDENTITY, {
        ownerUid: USER_IDENTITY.uid,
        kernelGeneration: 1,
        label: "closed scheduled target",
      });
    });
    await prepareScheduleTargetProcess(kernelName, process, pid, "closed");
    await process.recvFrame(makeReq("proc.conversation.close", { conversationId: "closed" }));

    const scheduleId = await runInDurableObject(kernel, (instance: Kernel) => {
      const k = instance as unknown as { schedules: ScheduleStore; ctx: DurableObjectState };
      const now = Date.now();
      const schedule = k.schedules.create({
        ownerUid: USER_IDENTITY.uid,
        creator: schedulePrincipal(),
        runAs: schedulePrincipal(),
        name: "closed conversation",
        enabled: true,
        expression: { kind: "every", everyMs: 60_000, anchorMs: now - 120_000 },
        target: {
          kind: "process.event",
          pid,
          conversationId: "closed",
          message: "Do not run.",
        },
        now,
      });
      k.ctx.storage.sql.exec(
        "UPDATE schedules SET next_run_at = ? WHERE schedule_id = ?",
        now - 1_000,
        schedule.id,
      );
      return schedule.id;
    });

    await runInDurableObject(kernel, (instance: Kernel) => instance.onScheduleDue(scheduleId));

    const schedule = await runInDurableObject(kernel, (instance: Kernel) =>
      (instance as unknown as { schedules: ScheduleStore }).schedules.get(scheduleId),
    );
    expect(schedule?.state.lastStatus).toBe("error");
    expect(schedule?.state.lastError).toBe("Conversation is closed: closed");
  });

  it("runs a due command schedule through the Kernel shell", async () => {
    const { kernel } = await newScheduleKernel();
    const scheduleId = await runInDurableObject(kernel, (instance: Kernel) => {
      const k = instance as unknown as {
        auth: ScheduleTestAuth;
        caps: { seed: () => void };
        procs: { spawn: typeof instance["procs"]["spawn"] };
        schedules: ScheduleStore;
        ctx: DurableObjectState;
      };
      k.caps.seed();
      addTestUser(k.auth);
      k.procs.spawn("init:1000", USER_IDENTITY, {
        kernelGeneration: 1,
        profile: "init",
        label: "init",
      });
      const now = Date.now();
      const schedule = k.schedules.create({
        ownerUid: USER_IDENTITY.uid,
        creator: schedulePrincipal(),
        runAs: schedulePrincipal(),
        name: "command",
        enabled: true,
        expression: { kind: "every", everyMs: 60_000, anchorMs: now - 120_000 },
        target: {
          kind: "command.exec",
          command: "printf 'scheduled command\\n'",
        },
        now,
      });
      k.ctx.storage.sql.exec(
        "UPDATE schedules SET next_run_at = ? WHERE schedule_id = ?",
        now - 1_000,
        schedule.id,
      );
      return schedule.id;
    });

    await runInDurableObject(kernel, (instance: Kernel) => instance.onScheduleDue(scheduleId));

    const state = await runInDurableObject(kernel, (instance: Kernel) => {
      const k = instance as unknown as { schedules: ScheduleStore };
      return {
        schedule: k.schedules.get(scheduleId),
        result: k.schedules.history(scheduleId)[0]?.result,
      };
    });

    expect(state.schedule?.state.lastStatus).toBe("ok");
    expect(state.result).toMatchObject({
      kind: "command.exec",
      command: "printf 'scheduled command\\n'",
      exitCode: 0,
      stdout: "scheduled command\n",
    });
  });

  it("runs command schedules as the stored run-as account", async () => {
    const { kernel } = await newScheduleKernel();
    const runAs: SchedulePrincipal = {
      kind: "process",
      uid: CUSTOM_AGENT_IDENTITY.uid,
      username: CUSTOM_AGENT_IDENTITY.username,
      pid: "proc:wiki-builder",
    };
    const scheduleId = await runInDurableObject(kernel, (instance: Kernel) => {
      const k = instance as unknown as {
        auth: ScheduleTestAuth;
        caps: {
          seed: () => void;
          grant: (gid: number, capability: string) => { ok: boolean; error?: string };
        };
        schedules: ScheduleStore;
        ctx: DurableObjectState;
      };
      k.caps.seed();
      addTestAccount(k.auth, PERSONAL_AGENT_IDENTITY, "Sam Agent", "agent");
      k.auth.setPersonalAgent(USER_IDENTITY.uid, PERSONAL_AGENT_IDENTITY.uid);
      addTestAccount(k.auth, CUSTOM_AGENT_IDENTITY, "Wiki Builder", "agent");
      k.caps.grant(CUSTOM_AGENT_IDENTITY.gid, "shell.exec");

      const now = Date.now();
      const schedule = k.schedules.create({
        ownerUid: USER_IDENTITY.uid,
        creator: runAs,
        runAs,
        name: "agent command",
        enabled: true,
        expression: { kind: "every", everyMs: 60_000, anchorMs: now - 120_000 },
        target: {
          kind: "command.exec",
          command: "whoami",
        },
        now,
      });
      k.ctx.storage.sql.exec(
        "UPDATE schedules SET next_run_at = ? WHERE schedule_id = ?",
        now - 1_000,
        schedule.id,
      );
      return schedule.id;
    });

    await runInDurableObject(kernel, (instance: Kernel) => instance.onScheduleDue(scheduleId));

    const state = await runInDurableObject(kernel, (instance: Kernel) => {
      const k = instance as unknown as { schedules: ScheduleStore };
      return {
        schedule: k.schedules.get(scheduleId),
        result: k.schedules.history(scheduleId)[0]?.result,
      };
    });

    expect(state.schedule?.state.lastStatus).toBe("ok");
    expect(state.result).toMatchObject({
      kind: "command.exec",
      command: "whoami",
      exitCode: 0,
      stdout: "wiki-builder\n",
    });
  });

  it("fails process events when the run-as account no longer exists", async () => {
    const { kernel } = await newScheduleKernel();
    const record = makeScheduleRecord({
      runAs: { kind: "user", uid: 9999, username: "gone" },
      target: { kind: "process.event", pid: "missing", message: "Do not deliver." },
    });

    await expect(runInDurableObject(kernel, (instance: Kernel) =>
      (instance as unknown as {
        dispatchScheduleTarget: (
          record: ScheduleRecord,
          scheduledAtMs: number | null,
          firedAtMs: number,
        ) => Promise<unknown>;
      }).dispatchScheduleTarget(record, null, Date.now()),
    )).rejects.toThrow("Cannot resolve schedule run-as uid 9999");
  });

  it.each([
    {
      capability: "proc.spawn",
      target: { kind: "process.spawn", prompt: "Do not run." } as const,
    },
    {
      capability: "proc.send",
      target: { kind: "process.event", pid: "missing", message: "Do not deliver." } as const,
    },
  ])("rechecks $capability when a process schedule fires", async ({ capability, target }) => {
    const { kernel } = await newScheduleKernel();
    const record = makeScheduleRecord({ target });

    await runInDurableObject(kernel, (instance: Kernel) => {
      const k = instance as unknown as {
        auth: ScheduleTestAuth;
        caps: { revoke: (gid: number, capability: string) => { ok: boolean; error?: string } };
      };
      addTestUser(k.auth);
      k.caps.revoke(100, "proc.*");
    });

    await expect(runInDurableObject(kernel, (instance: Kernel) =>
      (instance as unknown as {
        dispatchScheduleTarget: (
          record: ScheduleRecord,
          scheduledAtMs: number | null,
          firedAtMs: number,
        ) => Promise<unknown>;
      }).dispatchScheduleTarget(record, null, Date.now()),
    )).rejects.toThrow(`Permission denied: ${capability}`);
  });

  it("fires an armed one-shot schedule through the Agent alarm", async () => {
    const pid = `sched-alarm-${crypto.randomUUID()}`;
    const { kernel, kernelName } = await newScheduleKernel();
    const process = await getProcessByPid(pid);

    await runInDurableObject(kernel, (instance: Kernel) => {
      const k = instance as unknown as {
        auth: ScheduleTestAuth;
        caps: { seed: () => void };
        procs: { spawn: typeof instance["procs"]["spawn"] };
      };
      k.caps.seed();
      addTestUser(k.auth);
      k.procs.spawn(pid, USER_IDENTITY, {
        kernelGeneration: 1,
        profile: "task",
        label: "alarm target",
      });
    });

    await prepareScheduleTargetProcess(kernelName, process, pid);

    const scheduleId = await runInDurableObject(kernel, async (instance: Kernel) => {
      const k = instance as unknown as {
        schedules: ScheduleStore;
        ctx: DurableObjectState;
        scheduleScheduleWake: (scheduleId: string, dueAtMs: number) => Promise<string>;
      };
      const now = Date.now();
      const schedule = k.schedules.create({
        ownerUid: USER_IDENTITY.uid,
        creator: schedulePrincipal(),
        runAs: schedulePrincipal(),
        name: "one-shot alarm",
        enabled: true,
        expression: { kind: "after", afterMs: 30_000 },
        target: {
          kind: "process.event",
          pid,
          message: "Run from the Agent alarm path.",
        },
        now,
      });
      const wakeId = await k.scheduleScheduleWake(schedule.id, schedule.state.nextRunAtMs!);
      k.schedules.setWakeScheduleId(schedule.id, wakeId);

      const dueAtMs = now - 1_000;
      k.ctx.storage.sql.exec(
        "UPDATE schedules SET next_run_at = ? WHERE schedule_id = ?",
        dueAtMs,
        schedule.id,
      );
      k.ctx.storage.sql.exec(
        "UPDATE cf_agents_schedules SET time = ? WHERE id = ?",
        Math.floor(dueAtMs / 1_000),
        wakeId,
      );
      return schedule.id;
    });

    await runDurableObjectAlarm(kernel);

    const messages = await runInDurableObject(process, (instance: Process) =>
      (instance as unknown as {
        store: { getMessages: () => Array<{ role: string; content: string }> };
      }).store.getMessages(),
    );
    expect(messages).toEqual([
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining("Run from the Agent alarm path."),
      }),
    ]);

    const schedule = await runInDurableObject(kernel, (instance: Kernel) =>
      (instance as unknown as { schedules: ScheduleStore }).schedules.get(scheduleId),
    );
    expect(schedule?.enabled).toBe(false);
    expect(schedule?.state.lastStatus).toBe("ok");
    expect(schedule?.state.runCount).toBe(1);
  });

  it("rounds Kernel wake rows up to avoid firing before millisecond-precision due times", async () => {
    const { kernel } = await newScheduleKernel();
    const dueAtMs = (Math.floor(Date.now() / 1_000) * 1_000) + 30_123;

    const row = await runInDurableObject(kernel, async (instance: Kernel) => {
      const k = instance as unknown as {
        ctx: DurableObjectState;
        scheduleScheduleWake: (scheduleId: string, dueAtMs: number) => Promise<string>;
      };
      const wakeId = await k.scheduleScheduleWake("sched-rounding", dueAtMs);
      return k.ctx.storage.sql.exec<{ time: number }>(
        "SELECT time FROM cf_agents_schedules WHERE id = ?",
        wakeId,
      ).toArray()[0];
    });

    expect(row.time * 1_000).toBeGreaterThanOrEqual(dueAtMs);
    expect(row.time * 1_000).toBeLessThan(dueAtMs + 1_000);
  });

  it("re-arms when an existing wake fires before the GSV schedule is due", async () => {
    const pid = `sched-early-${crypto.randomUUID()}`;
    const { kernel, kernelName } = await newScheduleKernel();
    const process = await getProcessByPid(pid);

    await runInDurableObject(kernel, (instance: Kernel) => {
      const k = instance as unknown as {
        caps: { seed: () => void };
        procs: { spawn: typeof instance["procs"]["spawn"] };
      };
      k.caps.seed();
      k.procs.spawn(pid, USER_IDENTITY, {
        kernelGeneration: 1,
        profile: "task",
        label: "early wake target",
      });
    });

    await prepareScheduleTargetProcess(kernelName, process, pid);

    const scheduleId = await runInDurableObject(kernel, async (instance: Kernel) => {
      const k = instance as unknown as {
        schedules: ScheduleStore;
        ctx: DurableObjectState;
        scheduleScheduleWake: (scheduleId: string, dueAtMs: number) => Promise<string>;
      };
      const now = Date.now();
      const nextRunAtMs = now + 30_000;
      const schedule = k.schedules.create({
        ownerUid: USER_IDENTITY.uid,
        creator: schedulePrincipal(),
        runAs: schedulePrincipal(),
        name: "early wake",
        enabled: true,
        expression: { kind: "after", afterMs: 30_000 },
        target: {
          kind: "process.event",
          pid,
          message: "This should wait until the schedule is actually due.",
        },
        now,
      });
      const oldWakeId = await k.scheduleScheduleWake(schedule.id, nextRunAtMs);
      k.schedules.setWakeScheduleId(schedule.id, oldWakeId);
      k.ctx.storage.sql.exec(
        "UPDATE schedules SET next_run_at = ? WHERE schedule_id = ?",
        nextRunAtMs,
        schedule.id,
      );
      k.ctx.storage.sql.exec(
        "UPDATE cf_agents_schedules SET time = ? WHERE id = ?",
        Math.floor(now / 1_000),
        oldWakeId,
      );
      return schedule.id;
    });

    await runDurableObjectAlarm(kernel);

    const state = await runInDurableObject(kernel, (instance: Kernel) => {
      const k = instance as unknown as {
        schedules: ScheduleStore;
        ctx: DurableObjectState;
      };
      const schedule = k.schedules.getStored(scheduleId);
      const wakeRows = k.ctx.storage.sql.exec<{ id: string; time: number }>(
        "SELECT id, time FROM cf_agents_schedules WHERE callback = 'onScheduleDue'",
      ).toArray();
      return { schedule, wakeRows };
    });
    const messages = await runInDurableObject(process, (instance: Process) =>
      (instance as unknown as {
        store: { getMessages: () => Array<{ role: string; content: string }> };
      }).store.getMessages(),
    );

    expect(messages).toHaveLength(0);
    expect(state.schedule?.enabled).toBe(true);
    expect(state.schedule?.state.lastStatus).toBeNull();
    expect(state.schedule?.wakeScheduleId).toBeTruthy();
    expect(state.wakeRows).toEqual([
      expect.objectContaining({ id: state.schedule?.wakeScheduleId }),
    ]);
    expect(state.wakeRows[0].time * 1_000).toBeGreaterThanOrEqual(state.schedule!.state.nextRunAtMs!);
  });

  it("ignores stale wake rows before checking due state", async () => {
    const pid = `sched-stale-${crypto.randomUUID()}`;
    const { kernel, kernelName } = await newScheduleKernel();
    const process = await getProcessByPid(pid);

    await runInDurableObject(kernel, (instance: Kernel) => {
      const k = instance as unknown as {
        caps: { seed: () => void };
        procs: { spawn: typeof instance["procs"]["spawn"] };
      };
      k.caps.seed();
      k.procs.spawn(pid, USER_IDENTITY, {
        kernelGeneration: 1,
        profile: "task",
        label: "stale wake target",
      });
    });

    await prepareScheduleTargetProcess(kernelName, process, pid);

    const scheduleId = await runInDurableObject(kernel, async (instance: Kernel) => {
      const k = instance as unknown as {
        schedules: ScheduleStore;
        ctx: DurableObjectState;
        scheduleScheduleWake: (scheduleId: string, dueAtMs: number) => Promise<string>;
      };
      const now = Date.now();
      const schedule = k.schedules.create({
        ownerUid: USER_IDENTITY.uid,
        creator: schedulePrincipal(),
        runAs: schedulePrincipal(),
        name: "stale wake",
        enabled: true,
        expression: { kind: "after", afterMs: 30_000 },
        target: {
          kind: "process.event",
          pid,
          message: "A stale wake must not deliver this message.",
        },
        now,
      });
      const oldWakeId = await k.scheduleScheduleWake(schedule.id, now + 1_000);
      const newWakeId = await k.scheduleScheduleWake(schedule.id, now + 60_000);
      k.schedules.setWakeScheduleId(schedule.id, newWakeId);
      k.ctx.storage.sql.exec(
        "UPDATE schedules SET next_run_at = ? WHERE schedule_id = ?",
        now - 1_000,
        schedule.id,
      );
      k.ctx.storage.sql.exec(
        "UPDATE cf_agents_schedules SET time = ? WHERE id = ?",
        Math.floor((now - 1_000) / 1_000),
        oldWakeId,
      );
      return schedule.id;
    });

    await runDurableObjectAlarm(kernel);

    const messages = await runInDurableObject(process, (instance: Process) =>
      (instance as unknown as {
        store: { getMessages: () => Array<{ role: string; content: string }> };
      }).store.getMessages(),
    );
    expect(messages).toHaveLength(0);

    const state = await runInDurableObject(kernel, (instance: Kernel) => {
      const k = instance as unknown as {
        schedules: ScheduleStore;
        ctx: DurableObjectState;
      };
      const schedule = k.schedules.getStored(scheduleId);
      const wakeRows = k.ctx.storage.sql.exec<{ id: string }>(
        "SELECT id FROM cf_agents_schedules WHERE callback = 'onScheduleDue'",
      ).toArray();
      return { schedule, wakeRows };
    });
    expect(state.schedule?.enabled).toBe(true);
    expect(state.schedule?.state.lastStatus).toBeNull();
    expect(state.wakeRows).toEqual([
      expect.objectContaining({ id: state.schedule?.wakeScheduleId }),
    ]);
  });

  it("force-runs a process event schedule before it is due", async () => {
    const pid = `sched-force-${crypto.randomUUID()}`;
    const conversationId = "ops";
    const { kernel, kernelName } = await newScheduleKernel();
    const process = await getProcessByPid(pid);

    await runInDurableObject(kernel, (instance: Kernel) => {
      const k = instance as unknown as {
        auth: ScheduleTestAuth;
        caps: { seed: () => void };
        procs: { spawn: typeof instance["procs"]["spawn"] };
      };
      k.caps.seed();
      addTestUser(k.auth);
      k.procs.spawn(pid, USER_IDENTITY, {
        kernelGeneration: 1,
        profile: "task",
        label: "scheduled target",
      });
    });

    await prepareScheduleTargetProcess(kernelName, process, pid, conversationId);

    const { scheduleId, nextRunAtMs } = await runInDurableObject(kernel, (instance: Kernel) => {
      const k = instance as unknown as { schedules: ScheduleStore };
      const now = Date.now();
      const schedule = k.schedules.create({
        ownerUid: USER_IDENTITY.uid,
        creator: schedulePrincipal(),
        runAs: schedulePrincipal(),
        name: "manual pulse",
        enabled: true,
        expression: { kind: "every", everyMs: 60_000, anchorMs: now + 60_000 },
        target: {
          kind: "process.event",
          pid,
          conversationId,
          message: "Run early.",
        },
        now,
      });
      return { scheduleId: schedule.id, nextRunAtMs: schedule.state.nextRunAtMs };
    });

    const runResult = await runInDurableObject(kernel, (instance: Kernel) =>
      (instance as unknown as {
        runSchedules: (args: { id: string; mode: "force" }) => Promise<unknown>;
      }).runSchedules({ id: scheduleId, mode: "force" }),
    );

    expect(runResult).toMatchObject({
      ran: 1,
      results: [{ scheduleId, status: "ok" }],
    });
    const schedule = await runInDurableObject(kernel, (instance: Kernel) =>
      (instance as unknown as { schedules: ScheduleStore }).schedules.get(scheduleId),
    );
    expect(schedule?.state.nextRunAtMs).toBe(nextRunAtMs);
    expect(schedule?.enabled).toBe(true);

    const messages = await runInDurableObject(process, (instance: Process) =>
      (instance as unknown as {
        store: { getMessages: (opts: { conversationId: string }) => Array<{ content: string }> };
      }).store.getMessages({ conversationId }),
    );
    expect(messages[0].content).toContain("Run early.");
  });

  it("skips a due schedule that is already running", async () => {
    const { kernel } = await newScheduleKernel();
    const scheduleId = await runInDurableObject(kernel, (instance: Kernel) => {
      const k = instance as unknown as {
        caps: { seed: () => void };
        procs: { spawn: typeof instance["procs"]["spawn"] };
        schedules: ScheduleStore;
        ctx: DurableObjectState;
      };
      k.caps.seed();
      k.procs.spawn("init:1000", USER_IDENTITY, {
        kernelGeneration: 1,
        profile: "init",
        label: "init",
      });
      const now = Date.now();
      const schedule = k.schedules.create({
        ownerUid: USER_IDENTITY.uid,
        creator: schedulePrincipal(),
        runAs: schedulePrincipal(),
        name: "overlap",
        enabled: true,
        expression: { kind: "every", everyMs: 60_000, anchorMs: now - 120_000 },
        target: {
          kind: "process.spawn",
          prompt: "This should not run twice.",
        },
        now,
      });
      k.ctx.storage.sql.exec(
        "UPDATE schedules SET next_run_at = ?, running_at = ? WHERE schedule_id = ?",
        now - 1_000,
        now - 500,
        schedule.id,
      );
      return schedule.id;
    });

    const result = await runInDurableObject(kernel, (instance: Kernel) =>
      (instance as unknown as {
        runSchedules: (args: { id: string; mode: "due" }) => Promise<unknown>;
      }).runSchedules({ id: scheduleId, mode: "due" }),
    );

    expect(result).toMatchObject({
      ran: 0,
      results: [{ scheduleId, status: "skipped", error: "schedule is already running" }],
    });
  });

  it("re-arms a due alarm that overlaps a forced run", async () => {
    const { kernel } = await newScheduleKernel();
    const { scheduleId, oldWakeId } = await runInDurableObject(kernel, async (instance: Kernel) => {
      const k = instance as unknown as {
        schedules: ScheduleStore;
        ctx: DurableObjectState;
        scheduleScheduleWake: (scheduleId: string, dueAtMs: number) => Promise<string>;
      };
      const now = Date.now();
      const schedule = k.schedules.create({
        ownerUid: USER_IDENTITY.uid,
        creator: schedulePrincipal(),
        runAs: schedulePrincipal(),
        name: "force overlap",
        enabled: true,
        expression: { kind: "every", everyMs: 60_000 },
        target: { kind: "process.spawn", prompt: "Run after the forced execution." },
        now,
      });
      const dueAtMs = now - 1_000;
      k.ctx.storage.sql.exec(
        "UPDATE schedules SET next_run_at = ? WHERE schedule_id = ?",
        dueAtMs,
        schedule.id,
      );
      const oldWakeId = await k.scheduleScheduleWake(schedule.id, dueAtMs);
      k.schedules.setWakeScheduleId(schedule.id, oldWakeId);
      expect(k.schedules.markRunning(schedule.id, now - 500)).not.toBeNull();
      k.ctx.storage.sql.exec(
        "UPDATE cf_agents_schedules SET time = ? WHERE id = ?",
        Math.floor(dueAtMs / 1_000),
        oldWakeId,
      );
      return { scheduleId: schedule.id, oldWakeId };
    });

    await runDurableObjectAlarm(kernel);

    const state = await runInDurableObject(kernel, (instance: Kernel) => {
      const k = instance as unknown as {
        schedules: ScheduleStore;
        ctx: DurableObjectState;
      };
      const schedule = k.schedules.getStored(scheduleId);
      const wakeRows = k.ctx.storage.sql.exec<{ id: string }>(
        "SELECT id FROM cf_agents_schedules WHERE callback = 'onScheduleDue'",
      ).toArray();
      return { schedule, wakeRows };
    });

    expect(state.schedule?.state.runningAtMs).not.toBeNull();
    expect(state.schedule?.wakeScheduleId).toEqual(expect.any(String));
    expect(state.schedule?.wakeScheduleId).not.toBe(oldWakeId);
    expect(state.wakeRows).toEqual([
      { id: state.schedule!.wakeScheduleId! },
    ]);
  });

  it("releases and records an execution interrupted by runtime replacement", async () => {
    const { kernel } = await newScheduleKernel();
    const finishedAtMs = Date.now();
    const scheduleId = await runInDurableObject(kernel, (instance: Kernel) => {
      const store = (instance as unknown as { schedules: ScheduleStore }).schedules;
      const schedule = store.create({
        ownerUid: USER_IDENTITY.uid,
        creator: schedulePrincipal(),
        runAs: schedulePrincipal(),
        name: "interrupted",
        enabled: true,
        expression: { kind: "every", everyMs: 60_000 },
        target: { kind: "process.spawn", prompt: "retry me" },
        now: finishedAtMs - 10_000,
      });
      expect(store.markRunning(schedule.id, finishedAtMs - 5_000)).not.toBeNull();
      expect(store.releaseInterruptedRuns(
        "User Kernel lifecycle changed",
        finishedAtMs,
      )).toBe(1);
      return schedule.id;
    });

    const recovered = await runInDurableObject(kernel, (instance: Kernel) => {
      const store = (instance as unknown as { schedules: ScheduleStore }).schedules;
      return {
        schedule: store.get(scheduleId),
        history: store.history(scheduleId),
        releasedAgain: store.releaseInterruptedRuns("duplicate recovery", finishedAtMs + 1),
      };
    });

    expect(recovered.releasedAgain).toBe(0);
    expect(recovered.schedule?.state).toMatchObject({
      runningAtMs: null,
      lastStatus: "error",
      lastError: "User Kernel lifecycle changed",
      lastDurationMs: 5_000,
      runCount: 1,
    });
    expect(recovered.history).toHaveLength(1);
    expect(recovered.history[0]).toMatchObject({
      status: "error",
      error: "User Kernel lifecycle changed",
      result: {
        interrupted: true,
        error: "User Kernel lifecycle changed",
      },
    });
  });

  it("releases interrupted executions only for the exact owner", async () => {
    const { kernel } = await newScheduleKernel();
    const finishedAtMs = Date.now();
    const recovered = await runInDurableObject(kernel, (instance: Kernel) => {
      const store = (instance as unknown as { schedules: ScheduleStore }).schedules;
      const owned = store.create({
        ownerUid: USER_IDENTITY.uid,
        creator: schedulePrincipal(),
        runAs: schedulePrincipal(),
        name: "owned interrupted run",
        enabled: true,
        expression: { kind: "every", everyMs: 60_000 },
        target: { kind: "process.spawn", prompt: "retry the owned run" },
        now: finishedAtMs - 10_000,
      });
      const other = store.create({
        ownerUid: PERSONAL_AGENT_IDENTITY.uid,
        creator: schedulePrincipal(),
        runAs: schedulePrincipal(),
        name: "other interrupted run",
        enabled: true,
        expression: { kind: "every", everyMs: 60_000 },
        target: { kind: "process.spawn", prompt: "leave the other run alone" },
        now: finishedAtMs - 10_000,
      });
      expect(store.markRunning(owned.id, finishedAtMs - 5_000)).not.toBeNull();
      expect(store.markRunning(other.id, finishedAtMs - 4_000)).not.toBeNull();

      const released = store.releaseInterruptedRunsForOwner(
        USER_IDENTITY.uid,
        "Owner runtime was fenced",
        finishedAtMs,
      );
      const releasedAgain = store.releaseInterruptedRunsForOwner(
        USER_IDENTITY.uid,
        "duplicate owner recovery",
        finishedAtMs + 1,
      );

      return {
        released,
        releasedAgain,
        owned: store.get(owned.id),
        ownedHistory: store.history(owned.id),
        other: store.get(other.id),
        otherHistory: store.history(other.id),
      };
    });

    expect(recovered.released).toBe(1);
    expect(recovered.releasedAgain).toBe(0);
    expect(recovered.owned?.state).toMatchObject({
      runningAtMs: null,
      lastStatus: "error",
      lastError: "Owner runtime was fenced",
      lastDurationMs: 5_000,
      runCount: 1,
    });
    expect(recovered.ownedHistory).toHaveLength(1);
    expect(recovered.ownedHistory[0]).toMatchObject({
      status: "error",
      error: "Owner runtime was fenced",
      result: {
        interrupted: true,
        error: "Owner runtime was fenced",
      },
    });
    expect(recovered.other?.state).toMatchObject({
      runningAtMs: finishedAtMs - 4_000,
      lastStatus: null,
      lastError: null,
      runCount: 0,
    });
    expect(recovered.otherHistory).toEqual([]);
  });

  it("rejects unsafe owner ids before interrupted-run recovery", async () => {
    const { kernel } = await newScheduleKernel();
    const errors = await runInDurableObject(kernel, (instance: Kernel) => {
      const store = (instance as unknown as { schedules: ScheduleStore }).schedules;
      return [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY]
        .map((ownerUid) => {
          try {
            store.releaseInterruptedRunsForOwner(ownerUid, "must not run");
            return null;
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        });
    });

    expect(errors).toEqual(Array.from(
      { length: 5 },
      () => "ownerUid must be a safe non-negative integer",
    ));
  });

  it("re-arms a future wake after an interrupted forced run", async () => {
    const { kernel } = await newScheduleKernel();
    const state = await runInDurableObject(kernel, async (instance: Kernel) => {
      const k = instance as unknown as {
        schedules: ScheduleStore;
        ctx: DurableObjectState;
        userKernelMarker: UserKernelInstanceMarker;
        scheduleScheduleWake: (scheduleId: string, dueAtMs: number) => Promise<string>;
        rearmPendingSchedules: (marker: UserKernelInstanceMarker) => Promise<void>;
      };
      const now = Date.now();
      const schedule = k.schedules.create({
        ownerUid: USER_IDENTITY.uid,
        creator: schedulePrincipal(),
        runAs: schedulePrincipal(),
        name: "future interrupted force",
        enabled: true,
        expression: { kind: "every", everyMs: 60_000 },
        target: { kind: "process.spawn", prompt: "Run at the original due time." },
        now,
      });
      const nextRunAtMs = schedule.state.nextRunAtMs!;
      const oldWakeId = await k.scheduleScheduleWake(schedule.id, nextRunAtMs);
      k.schedules.setWakeScheduleId(schedule.id, oldWakeId);
      expect(k.schedules.markRunning(schedule.id, now)).not.toBeNull();
      expect(k.schedules.releaseInterruptedRuns("User Kernel was suspended", now + 1)).toBe(1);

      await k.rearmPendingSchedules(k.userKernelMarker);

      const recovered = k.schedules.getStored(schedule.id)!;
      const wakeRows = k.ctx.storage.sql.exec<{ id: string }>(
        "SELECT id FROM cf_agents_schedules WHERE callback = 'onScheduleDue'",
      ).toArray();
      return { recovered, wakeRows, oldWakeId, nextRunAtMs };
    });

    expect(state.recovered.state.nextRunAtMs).toBe(state.nextRunAtMs);
    expect(state.recovered.state.nextRunAtMs).toBeGreaterThan(Date.now());
    expect(state.recovered.state.runningAtMs).toBeNull();
    expect(state.recovered.wakeScheduleId).toEqual(expect.any(String));
    expect(state.recovered.wakeScheduleId).not.toBe(state.oldWakeId);
    expect(state.wakeRows).toEqual([
      { id: state.recovered.wakeScheduleId! },
    ]);
  });

  it("disables an after schedule once it runs", async () => {
    const pid = `sched-once-${crypto.randomUUID()}`;
    const { kernel, kernelName } = await newScheduleKernel();
    const process = await getProcessByPid(pid);

    await runInDurableObject(kernel, (instance: Kernel) => {
      const k = instance as unknown as {
        auth: ScheduleTestAuth;
        caps: { seed: () => void };
        procs: { spawn: typeof instance["procs"]["spawn"] };
      };
      k.caps.seed();
      addTestUser(k.auth);
      k.procs.spawn(pid, USER_IDENTITY, {
        kernelGeneration: 1,
        profile: "task",
        label: "one-shot target",
      });
    });

    await prepareScheduleTargetProcess(kernelName, process, pid);

    const scheduleId = await runInDurableObject(kernel, (instance: Kernel) => {
      const k = instance as unknown as {
        schedules: ScheduleStore;
        ctx: DurableObjectState;
      };
      const now = Date.now();
      const schedule = k.schedules.create({
        ownerUid: USER_IDENTITY.uid,
        creator: schedulePrincipal(),
        runAs: schedulePrincipal(),
        name: "one shot",
        enabled: true,
        expression: { kind: "after", afterMs: 1_000 },
        target: {
          kind: "process.event",
          pid,
          message: "Run once.",
        },
        now,
      });
      k.ctx.storage.sql.exec(
        "UPDATE schedules SET next_run_at = ? WHERE schedule_id = ?",
        now - 1_000,
        schedule.id,
      );
      return schedule.id;
    });

    await runInDurableObject(kernel, (instance: Kernel) => instance.onScheduleDue(scheduleId));

    const schedule = await runInDurableObject(kernel, (instance: Kernel) =>
      (instance as unknown as { schedules: ScheduleStore }).schedules.get(scheduleId),
    );
    expect(schedule?.enabled).toBe(false);
    expect(schedule?.state.nextRunAtMs).toBeNull();
    expect(schedule?.state.lastStatus).toBe("ok");
  });

  it("runs a due process.spawn schedule and sends the prompt to the cron process", async () => {
    const { kernel } = await newScheduleKernel();
    const scheduleId = await runInDurableObject(kernel, (instance: Kernel) => {
      const k = instance as unknown as {
        auth: ScheduleTestAuth;
        caps: { seed: () => void };
        procs: { spawn: typeof instance["procs"]["spawn"] };
        schedules: ScheduleStore;
        ctx: DurableObjectState;
      };
      k.caps.seed();
      addTestUser(k.auth);
      addTestAccount(k.auth, PERSONAL_AGENT_IDENTITY, "Sam Agent", "agent");
      k.auth.setPersonalAgent(USER_IDENTITY.uid, PERSONAL_AGENT_IDENTITY.uid);
      k.procs.spawn("init:1000", USER_IDENTITY, {
        kernelGeneration: 1,
        profile: "init",
        label: "init",
      });
      const now = Date.now();
      const schedule = k.schedules.create({
        ownerUid: USER_IDENTITY.uid,
        creator: schedulePrincipal(),
        runAs: schedulePrincipal(),
        name: "cron spawn",
        enabled: true,
        expression: { kind: "every", everyMs: 60_000, anchorMs: now - 120_000 },
        target: {
          kind: "process.spawn",
          profile: "cron",
          label: "cron spawn",
          prompt: "Run the scheduled cron task.",
        },
        now,
      });
      k.ctx.storage.sql.exec(
        "UPDATE schedules SET next_run_at = ? WHERE schedule_id = ?",
        now - 1_000,
        schedule.id,
      );
      return schedule.id;
    });

    await runInDurableObject(kernel, (instance: Kernel) => instance.onScheduleDue(scheduleId));

    const spawned = await runInDurableObject(kernel, (instance: Kernel) => {
      const k = instance as unknown as {
        schedules: ScheduleStore;
        procs: {
          get: (pid: string) => {
            processId: string;
            uid: number;
            ownerUid: number;
            label: string | null;
            interactive: boolean;
          } | null;
        };
      };
      const history = k.schedules.history(scheduleId);
      const result = history[0]?.result as { pid?: string } | null | undefined;
      return {
        pid: result?.pid,
        cronProcess: result?.pid ? k.procs.get(result.pid) : null,
        schedule: k.schedules.get(scheduleId),
      };
    });

    expect(spawned.pid).toBeTruthy();
    expect(spawned.cronProcess).toEqual(
      expect.objectContaining({
        processId: spawned.pid,
        uid: PERSONAL_AGENT_IDENTITY.uid,
        ownerUid: USER_IDENTITY.uid,
        label: "cron spawn",
        interactive: false,
      }),
    );
    expect(spawned.schedule?.state.lastStatus).toBe("ok");

    const cronProcess = await getProcessByPid(spawned.pid!);
    const messages = await runInDurableObject(cronProcess, (instance: Process) =>
      (instance as unknown as {
        store: { getMessages: () => Array<{ role: string; content: string }> };
      }).store.getMessages(),
    );
    expect(messages[0]).toEqual(expect.objectContaining({
      role: "user",
      content: "Run the scheduled cron task.",
    }));
  });

  it("runs process-principal spawn schedules after the creator process is gone", async () => {
    const { kernel } = await newScheduleKernel();
    const runAs: SchedulePrincipal = {
      kind: "process",
      uid: CUSTOM_AGENT_IDENTITY.uid,
      username: CUSTOM_AGENT_IDENTITY.username,
      pid: "proc:dead-creator",
    };
    const scheduleId = await runInDurableObject(kernel, (instance: Kernel) => {
      const k = instance as unknown as {
        auth: ScheduleTestAuth;
        caps: {
          grant: (gid: number, capability: string) => { ok: boolean; error?: string };
        };
        schedules: ScheduleStore;
        ctx: DurableObjectState;
      };
      addTestUser(k.auth);
      addTestAccount(k.auth, CUSTOM_AGENT_IDENTITY, "Wiki Builder", "agent");
      k.caps.grant(CUSTOM_AGENT_IDENTITY.gid, "proc.spawn");

      const now = Date.now();
      const schedule = k.schedules.create({
        ownerUid: USER_IDENTITY.uid,
        creator: runAs,
        runAs,
        name: "agent cron spawn",
        enabled: true,
        expression: { kind: "every", everyMs: 60_000, anchorMs: now - 120_000 },
        target: {
          kind: "process.spawn",
          label: "agent cron",
          prompt: "Run the agent-owned cron task.",
        },
        now,
      });
      k.ctx.storage.sql.exec(
        "UPDATE schedules SET next_run_at = ? WHERE schedule_id = ?",
        now - 1_000,
        schedule.id,
      );
      return schedule.id;
    });

    await runInDurableObject(kernel, (instance: Kernel) => instance.onScheduleDue(scheduleId));

    const spawned = await runInDurableObject(kernel, (instance: Kernel) => {
      const k = instance as unknown as {
        schedules: ScheduleStore;
        procs: {
          get: (pid: string) => {
            processId: string;
            uid: number;
            ownerUid: number;
            label: string | null;
            interactive: boolean;
            parentPid: string | null;
          } | null;
        };
      };
      const history = k.schedules.history(scheduleId);
      const result = history[0]?.result as { pid?: string } | null | undefined;
      return {
        pid: result?.pid,
        cronProcess: result?.pid ? k.procs.get(result.pid) : null,
        schedule: k.schedules.get(scheduleId),
      };
    });

    expect(spawned.pid).toBeTruthy();
    expect(spawned.schedule?.state.lastStatus).toBe("ok");
    expect(spawned.cronProcess).toEqual(
      expect.objectContaining({
        processId: spawned.pid,
        uid: CUSTOM_AGENT_IDENTITY.uid,
        ownerUid: USER_IDENTITY.uid,
        parentPid: null,
        label: "agent cron",
        interactive: false,
      }),
    );
  });
});
