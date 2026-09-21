import { describe, expect, it } from "vitest";
import type { ProcessIdentity, ProcessScopePolicy } from "@humansandmachines/gsv/protocol";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { ProcessRegistry } from "./processes";
import { FederationStore } from "./federation-store";
import { CapabilityStore } from "./capabilities";
import { processPeerContext } from "./peer";
import type { KernelContext } from "./context";
import { assertScopedConversation, assertScopedProcess, assertScopedRequest, currentProcessScope, scopedCapabilities } from "./process-scope";

const IDENTITY: ProcessIdentity = { uid: 1000, gid: 1000, gids: [1000], username: "owner", home: "/home/owner", cwd: "/home/owner" };
const policy = (): ProcessScopePolicy => ({ conversations: [], resources: [], materials: [{ name: "help.txt", text: "Chosen public help" }],
  expiresAtMs: Date.now() + 60_000, budgets: { processes: 3, generations: 2, messages: 1 } });

describe("durable Process scopes", () => {
  it("shares finite effect allowances across descendants and exact retries", async () => {
    await runWithRealKernelSql((sql, storage) => {
      const procs = new ProcessRegistry(sql);
      const scope = storage.transactionSync(() => procs.scopes.create(1000, "proc:root", policy()));
      for (const pid of ["proc:root", "proc:child"]) storage.transactionSync(() => {
        procs.scopes.consume(scope.id, "processes", pid, 1);
        procs.spawn(pid, IDENTITY, { ownerUid: 1000, scopeId: scope.id });
      });
      storage.transactionSync(() => procs.scopes.consume(scope.id, "generations", "inference:one", 1));
      const restored = new ProcessRegistry(sql);
      storage.transactionSync(() => restored.scopes.consume(scope.id, "generations", "inference:one", 1));
      storage.transactionSync(() => restored.scopes.consume(scope.id, "generations", "inference:two", 1));
      expect(() => storage.transactionSync(() => restored.scopes.consume(scope.id, "generations", "inference:three", 1))).toThrow("allowance is exhausted");
      expect(restored.scopes.forProcess("proc:child")?.used).toEqual({ processes: 2, generations: 2, messages: 0 });
      storage.transactionSync(() => restored.scopes.revoke(scope.id, 1000, 1));
      expect(() => restored.scopes.consume(scope.id, "generations", "inference:one", 1)).toThrow("no longer active");
      expect(() => restored.scopes.revoke(scope.id, 1001, 1)).toThrow("not found");
    });
  });

  it("denies sibling scope reads, alternate targets, nested privileges and deleted-process late calls", async () => {
    await runWithRealKernelSql((sql, storage) => {
      const procs = new ProcessRegistry(sql);
      const scope = storage.transactionSync(() => procs.scopes.create(1000, "proc:helper", policy()));
      procs.spawn("proc:helper", IDENTITY, { scopeId: scope.id });
      procs.spawn("proc:personal", IDENTITY, {});
      // SAFETY: these synchronous policy checks use exactly the real stores and trusted peer supplied here.
      const ctx = { procs, federation: new FederationStore(storage), caps: new CapabilityStore(sql), processId: "proc:helper", processScopeId: scope.id,
        peer: processPeerContext({ installationId: "inst:test", processId: "proc:helper", identity: IDENTITY, calls: ["*"] }) } as KernelContext;
      expect(currentProcessScope(ctx)?.id).toBe(scope.id);
      expect(() => assertScopedConversation(ctx, "conversation:private")).toThrow("outside");
      expect(() => assertScopedProcess(ctx, "proc:personal")).toThrow("outside");
      expect(() => assertScopedRequest({ type: "req", id: "one", call: "sys.config.get", args: { key: "config/private" } }, ctx)).toThrow("denies");
      expect(() => assertScopedRequest({ type: "req", id: "two", call: "shell.exec", args: { input: "pwd", target: "laptop" } }, ctx)).toThrow("outside");
      expect(scopedCapabilities(["*"])).not.toContain("net.fetch");
      expect(scopedCapabilities(["conversation.history"])).toEqual(["conversation.history"]);
      expect(() => assertScopedRequest({ type: "req", id: "three", call: "ai.config", args: {} }, { ...ctx, processRunId: "run:tool" })).toThrow("not a model capability");
      procs.kill("proc:helper");
      expect(() => currentProcessScope(ctx)).toThrow("no longer exists");
    });
  });

  it("preserves isolated archive homes when account credentials or groups change", async () => {
    await runWithRealKernelSql((sql, storage) => {
      const procs = new ProcessRegistry(sql);
      const scope = storage.transactionSync(() => procs.scopes.create(1000, "proc:helper", policy()));
      procs.spawn("proc:helper", { ...IDENTITY, home: "/var/scopes/one", cwd: "/materials" }, { scopeId: scope.id });
      procs.updateIdentity("proc:helper", { ...IDENTITY, gids: [1000, 100] });
      expect(procs.getIdentity("proc:helper")).toMatchObject({ home: "/var/scopes/one", cwd: "/materials", gids: [1000, 100] });
      expect(() => procs.scopes.requireActive(scope.id, 1, scope.policy.expiresAtMs)).toThrow("no longer active");
    });
  });
});
