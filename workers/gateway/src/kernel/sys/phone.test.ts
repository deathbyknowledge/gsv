import { afterEach, describe, expect, it, vi } from "vitest";
import type { PhoneCall } from "@humansandmachines/gsv/protocol";
import type { InstallationPhone } from "@humansandmachines/gsv/services/phone";
import type { KernelContext } from "../context";
import { handlePhoneRequest, type PhoneRequest } from "./phone";
import { testPeer } from "../../test-support/peers";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { runSqlMigrations } from "../../schema/runner";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT, runKernelSqlMigrations } from "../schema/migrations";
import { ResponsibilityStore } from "../responsibility-store";
import { PhoneCallStore } from "../phone-store";
import { allowInOwnerApprovalPolicy } from "../approval-policy";
import { DEFAULT_TOOL_APPROVAL_POLICY, parseToolApprovalPolicy, resolveToolApproval } from "../../process/approval";
import * as processTransport from "../../shared/utils";

const OWNER = 1000;
const brief = { to: "+34910000000", business: "Restaurante Lúa", onBehalfOf: "Esteve", goal: "Book a table for four on Friday at 21:00", mustNot: ["give card details"] };
const toolOwner = { runId: "run:1", requestId: "tool:1" };

afterEach(() => vi.restoreAllMocks());

describe("phone syscalls", () => {
  it("places an agent's call only after the owner approves the brief, then makes its work wait on the call", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const placed: PhoneCall = { callId: "call:1", requestId: "request:1", ownerUid: OWNER, processId: "proc:ship", brief, state: "queued", revision: 1, createdAt: 1 };
      const call = vi.fn(async () => ({ call: placed }));
      const { ctx, responsibilities, getInstallation } = context(storage, { call }, { processId: "proc:ship", toolOwner });
      const work = responsibilities.create({ ownerUid: OWNER, title: "Book Lúa", source: { kind: "process", processId: "proc:ship" },
        actor: { kind: "process", processId: "proc:ship" }, assignee: { kind: "ship" }, state: "active", priority: "normal",
        observedByShip: true, now: Date.now() }).record;
      const authorize = vi.spyOn(processTransport, "sendFrameToProcess").mockResolvedValueOnce({ type: "res", id: "approval", ok: true, data: { approved: false } });

      const request: PhoneRequest = { type: "req", id: "place", call: "sys.phone.call", args: { requestId: "request:1", brief, responsibilityId: work.id } };
      await expect(handlePhoneRequest(request, ctx)).rejects.toThrow("not approved");
      expect(authorize).toHaveBeenCalledWith("trusted-installation", "proc:ship", expect.objectContaining({
        call: "proc.tool.authorize", args: expect.objectContaining({ syscall: "sys.phone.call", args: expect.objectContaining({ brief }) }),
      }));
      expect(getInstallation).not.toHaveBeenCalled();

      authorize.mockResolvedValueOnce({ type: "res", id: "approval", ok: true, data: { approved: true } });
      const response = await handlePhoneRequest(request, ctx);
      expect(response).toMatchObject({ ok: true, data: { call: { callId: "call:1" } } });
      expect(getInstallation).toHaveBeenCalledWith("trusted-installation");
      expect(call).toHaveBeenCalledWith(
        { ownerUid: OWNER, human: false, processId: "proc:ship" },
        { requestId: "request:1", brief, responsibilityId: work.id },
        expect.stringMatching(/on a phone call for Esteve[\s\S]*Goal: Book a table for four[\s\S]*- give card details/),
      );
      expect(responsibilities.get(OWNER, work.id)).toMatchObject({ state: "waiting", blocker: "phone call call:1", details: { phoneCall: { callId: "call:1" } } });
    });
  });

  it("refuses agent calls without an approving tool call or the work they serve, before reaching the service", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const call = vi.fn();
      const direct = context(storage, { call }, { processId: "proc:ship" });
      const request: PhoneRequest = { type: "req", id: "place", call: "sys.phone.call", args: { requestId: "request:1", brief } };
      await expect(handlePhoneRequest(request, direct.ctx)).rejects.toThrow("approved tool call");
      const unowned = context(storage, { call }, { processId: "proc:ship", toolOwner });
      await expect(handlePhoneRequest(request, unowned.ctx)).rejects.toThrow("responsibilityId");
      const invalid = context(storage, { call });
      await expect(handlePhoneRequest({ ...request, args: { requestId: "request:1", brief: { ...brief, to: "112" } } }, invalid.ctx)).rejects.toThrow();
      expect(call).not.toHaveBeenCalled();
      expect(direct.getInstallation).not.toHaveBeenCalled();
    });
  });

  it("keys an agent's call to the tool call that placed it", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const placed: PhoneCall = { callId: "call:1", requestId: "x", ownerUid: OWNER, processId: "proc:ship", brief, state: "queued", revision: 1, createdAt: 1 };
      const call = vi.fn(async () => ({ call: placed }));
      vi.spyOn(processTransport, "sendFrameToProcess").mockResolvedValue({ type: "res", id: "approval", ok: true, data: { approved: true } });
      const keys: string[] = [];
      for (const owner of [toolOwner, toolOwner, { ...toolOwner, requestId: "tool:2" }]) {
        const { ctx, responsibilities } = context(storage, { call }, { processId: "proc:ship", toolOwner: owner });
        const work = responsibilities.create({ ownerUid: OWNER, title: "Book Lúa", source: { kind: "process", processId: "proc:ship" },
          actor: { kind: "process", processId: "proc:ship" }, assignee: { kind: "ship" }, state: "active", priority: "normal",
          observedByShip: true, now: Date.now() }).record;
        await handlePhoneRequest({ type: "req", id: crypto.randomUUID(), call: "sys.phone.call", args: { brief, responsibilityId: work.id } }, ctx);
        keys.push((call.mock.calls.at(-1) as unknown as [unknown, { requestId: string }])[1].requestId);
      }
      expect(keys[0]).toMatch(/^tool:[0-9a-f]{64}$/);
      expect(keys[1]).toBe(keys[0]);
      expect(keys[2]).not.toBe(keys[0]);
    });
  });

  it("names the owner from the name they set, and asks for one rather than saying the handle", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const placed: PhoneCall = { callId: "call:1", requestId: "place", ownerUid: OWNER, brief, state: "queued", revision: 1, createdAt: 1 };
      const call = vi.fn(async () => ({ call: placed }));
      const { onBehalfOf: _omitted, ...unnamed } = brief;
      const named = context(storage, { call }, { owner: { displayName: "Steve" } });
      await handlePhoneRequest({ type: "req", id: "place", call: "sys.phone.call", args: { brief: unnamed } }, named.ctx);
      expect(call).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ requestId: "place", brief: { ...unnamed, onBehalfOf: "Steve" } }),
        expect.stringMatching(/on a phone call for Steve/));

      const placeholder = context(storage, { call }, { owner: { displayName: "ship-handle" } });
      await expect(handlePhoneRequest({ type: "req", id: "again", call: "sys.phone.call", args: { brief: unnamed } }, placeholder.ctx))
        .rejects.toThrow(/brief\.onBehalfOf: .*Ask them/);
      expect(call).toHaveBeenCalledTimes(1);
    });
  });

  it("reports each problem with the brief as one readable line", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx } = context(storage, {});
      const { goal: _goal, ...goalless } = brief;
      const failure = handlePhoneRequest({ type: "req", id: "place", call: "sys.phone.call", args: { brief: { ...goalless, to: "112" } } }, ctx);
      await expect(failure).rejects.toThrow("brief.goal: required");
      await expect(failure).rejects.toThrow(/brief\.to: Use an international number/);
      await expect(failure).rejects.not.toThrow(/"code"/);
    });
  });

  it("keeps live audio and take-over with the signed-in owner", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const process = context(storage, {}, { processId: "proc:ship", toolOwner });
      for (const call of ["sys.phone.watch", "sys.phone.join"] as const) {
        await expect(handlePhoneRequest({ type: "req", id: call, call, args: { callId: "call:1" } }, process.ctx)).rejects.toThrow("human owner");
      }
      expect(process.getInstallation).not.toHaveBeenCalled();

      const join = vi.fn(async () => ({ call: {} as PhoneCall, provider: "twilio" as const, token: "t", identity: "i", expiresAt: 1, connectParams: {} }));
      const owner = context(storage, { join });
      await handlePhoneRequest({ type: "req", id: "join", call: "sys.phone.join", args: { callId: "call:1" } }, owner.ctx);
      expect(join).toHaveBeenCalledWith({ ownerUid: OWNER, human: true }, "call:1");
    });
  });

  it("lets a crew Process act only on the calls it placed", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const other: PhoneCall = { callId: "call:other", requestId: "r", ownerUid: OWNER, processId: "proc:other", brief, state: "in_progress", revision: 2, createdAt: 1 };
      const mine: PhoneCall = { ...other, callId: "call:mine", processId: "proc:crew" };
      const end = vi.fn(async () => ({ call: other }));
      const { ctx } = context(storage, {
        get: async (_actor, callId) => ({ call: callId === "call:mine" ? mine : other }),
        list: async () => ({ calls: [other, mine], usage: { enabled: true, dayStartsAt: 0, callsToday: 2, dailyLimit: 10, activeCalls: 2, concurrentLimit: 2, maxCallSeconds: 360 } }),
        end,
      }, { processId: "proc:crew", toolOwner });
      await expect(handlePhoneRequest({ type: "req", id: "end", call: "sys.phone.end", args: { callId: "call:other" } }, ctx)).rejects.toThrow("Unknown call");
      expect(end).not.toHaveBeenCalled();
      const listed = await handlePhoneRequest({ type: "req", id: "list", call: "sys.phone.list", args: {} }, ctx);
      expect(listed).toMatchObject({ ok: true, data: { calls: [{ callId: "call:mine" }] } });
    });
  });

  it("says when this Ship has no calls service", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx } = context(storage, {});
      ctx.env = { ...ctx.env, PHONE: undefined };
      await expect(handlePhoneRequest({ type: "req", id: "list", call: "sys.phone.list", args: {} }, ctx)).rejects.toThrow("not configured");
    });
  });
});

describe("phone call approval", () => {
  it("asks for every call and never remembers an allow", async () => {
    expect(resolveToolApproval(DEFAULT_TOOL_APPROVAL_POLICY, "sys.phone.call").action).toBe("ask");
    const values = new Map<string, string>();
    // SAFETY: allowInOwnerApprovalPolicy reaches only get and set.
    const config = { get: (key: string) => values.get(key) ?? null, set: (key: string, value: string) => { values.set(key, value); } } as unknown as KernelContext["config"];
    expect(allowInOwnerApprovalPolicy(config, OWNER, { match: "sys.phone.call", target: "gsv" })).toBe(false);
    expect(values.size).toBe(0);
    expect(allowInOwnerApprovalPolicy(config, OWNER, { match: "mail.send", target: "gsv" })).toBe(true);
  });

  it("adds the ask rule to saved policies that allow by default and name no rule for calls", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id < 85));
      const saved = {
        "users/1000/ai/tools/approval": JSON.stringify({ default: "auto", rules: [{ match: "mail.send", action: "ask" }] }),
        "users/1001/ai/tools/approval": JSON.stringify({ default: "auto", rules: [{ match: "sys.phone.*", action: "deny" }] }),
        "users/1002/ai/tools/approval": JSON.stringify({ default: "ask", rules: [] }),
        "config/ai/tools/approval": JSON.stringify({ default: "auto", rules: [] }),
      };
      for (const [key, value] of Object.entries(saved)) sql.exec("INSERT INTO config_kv (key, value) VALUES (?, ?)", key, value);
      runKernelSqlMigrations(storage);
      runKernelSqlMigrations(storage);
      const stored = Object.fromEntries(sql.exec<{ key: string; value: string }>("SELECT key, value FROM config_kv").toArray().map(({ key, value }) => [key, value]));
      const decide = (key: string) => resolveToolApproval(parseToolApprovalPolicy(stored[key]), "sys.phone.call").action;
      expect(decide("users/1000/ai/tools/approval")).toBe("ask");
      expect(decide("config/ai/tools/approval")).toBe("ask");
      expect(decide("users/1001/ai/tools/approval")).toBe("deny");
      expect(stored["users/1002/ai/tools/approval"]).toBe(saved["users/1002/ai/tools/approval"]);
      expect(JSON.parse(stored["users/1000/ai/tools/approval"]).rules).toHaveLength(2);
    });
  });
});

function context(
  storage: DurableObjectStorage,
  service: Partial<InstallationPhone>,
  options: { processId?: string; toolOwner?: KernelContext["toolOwner"]; owner?: { displayName?: string; gecos?: string } } = {},
) {
  const dispose = vi.fn();
  const getInstallation = vi.fn(async () => ({ ...service, [Symbol.dispose]: dispose }));
  const responsibilities = new ResponsibilityStore(storage);
  const partial = {
    installationId: "trusted-installation",
    env: { PHONE: { getInstallation } },
    peer: testPeer({ account: { uid: options.processId ? 1001 : OWNER, username: options.processId ? "ship" : "esteve", gids: [] }, calls: ["*"] }),
    processId: options.processId,
    toolOwner: options.toolOwner,
    procs: {
      getOwnerUid: () => OWNER,
      get: (processId: string) => ({ processId, isPersonalController: processId === "proc:ship", ownerUid: OWNER }),
    },
    responsibilities,
    phoneCalls: new PhoneCallStore(storage),
    reconcileResponsibilityWake: async () => {},
    broadcastToUserUid: vi.fn(),
    defer: () => {},
    installationIdentity: { handle: "ship-handle" },
    auth: { getPasswdByUid: (uid: number) => ({ uid, username: "esteve", gecos: options.owner?.gecos ?? "" }) },
    profiles: { draft: () => options.owner?.displayName ? { fields: { displayName: options.owner.displayName } } : undefined },
  };
  // SAFETY: The phone handlers tested here reach only the supplied context services.
  const ctx = partial as unknown as KernelContext;
  return { ctx, responsibilities, getInstallation, dispose };
}
