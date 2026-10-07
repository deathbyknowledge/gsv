import { describe, expect, it, vi } from "vitest";
import type { BrowserHandoff, ResponsibilityState } from "@humansandmachines/gsv/protocol";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { testPeer } from "../test-support/peers";
import type { KernelContext } from "./context";
import { ResponsibilityStore } from "./responsibility-store";
import { handleResponsibilityUpdate } from "./responsibilities";
import { handleInstanceRequest } from "./sys/instance";

function setup(storage: DurableObjectStorage) {
  const responsibilities = new ResponsibilityStore(storage);
  const actor = { kind: "account" as const, uid: 1000, username: "owner" };
  const { record } = responsibilities.create({ ownerUid: 1000, title: "Sign in", details: { original: "kept" }, source: actor,
    assignee: { kind: "ship" }, state: "open", priority: "normal", actor, observedByShip: true, now: Date.now() });
  let handoff: BrowserHandoff = { instanceId: "instance", requestId: "login", tabId: 1, purpose: "Sign in", site: "https://example.com",
    responsibilityId: record.id, state: "pending", revision: 1, createdAt: Date.now(), expiresAt: Date.now() + 60000 };
  const service = {
    requestHandoff: vi.fn(async () => ({ handoff: structuredClone(handoff), actionPath: "/zen" })),
    getHandoff: vi.fn(async () => ({ handoff: structuredClone(handoff) })),
    cancelHandoff: vi.fn(async () => { handoff = { ...handoff, state: "cancelled", revision: handoff.revision + 1 }; return { handoff: structuredClone(handoff) }; }),
  };
  // SAFETY: These handlers use only the supplied principal, responsibility store, provider, and wake callback.
  const ctx = {
    installationId: "test-installation", installationIdentity: null,
    peer: testPeer({ account: { uid: 1000, gid: 1000, gids: [1000], username: "owner", home: "/home/owner", cwd: "/home/owner" }, calls: ["*"] }),
    env: { INSTANCES: { getInstallation: async () => service } }, responsibilities, reconcileResponsibilityWake: vi.fn(async () => {}),
  } as KernelContext;
  const request = () => handleInstanceRequest({ type: "req", id: "request", call: "sys.browser.handoff.request", args: {
    instanceId: "instance", requestId: "login", tabId: 1, purpose: "Sign in", responsibilityId: record.id.slice("r12y:".length),
  } }, ctx);
  return { ctx, service, request, id: record.id, work: () => responsibilities.get(1000, record.id)!,
    handoff: () => handoff, updateHandoff: (patch: Partial<BrowserHandoff>) => { handoff = { ...handoff, ...patch }; } };
}

describe("browser handoff responsibility ownership", () => {
  it.each(["completed", "cancelled", "expired", "failed"] as const)("reconciles a %s handoff retry without re-blocking open work", async state => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const test = setup(storage);
      await test.request();
      expect(test.work()).toMatchObject({ state: "waiting", details: { original: "kept", browserHandoff: { instanceId: "instance", requestId: "login" } } });
      expect(test.service.requestHandoff).toHaveBeenCalledWith({ ownerUid: 1000, human: true }, expect.objectContaining({ responsibilityId: test.id }));
      test.updateHandoff({ state });
      expect(await test.request()).toMatchObject({ ok: true, data: { handoff: { state } } });
      expect(test.work()).toMatchObject({ state: "open" });
      expect(test.work().blocker).toBeUndefined();
      const revision = test.work().revision;
      await test.request();
      expect(test.work().revision).toBe(revision);
    });
  });

  it("rechecks completion that races installing the waiting state", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const test = setup(storage);
      test.service.requestHandoff.mockImplementationOnce(async () => {
        const stale = structuredClone(test.handoff());
        test.updateHandoff({ state: "completed" });
        return { handoff: stale, actionPath: "/zen" };
      });
      expect(await test.request()).toMatchObject({ ok: true, data: { handoff: { state: "completed" } } });
      expect(test.work().state).toBe("open");
    });
  });

  it("releases a late handoff admission after the work was cancelled", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const test = setup(storage);
      test.service.requestHandoff.mockImplementationOnce(async () => {
        await handleResponsibilityUpdate({ id: test.id, patch: { state: "cancelled" } }, test.ctx);
        return { handoff: structuredClone(test.handoff()), actionPath: "/zen" };
      });
      expect(await test.request()).toMatchObject({ ok: true, data: { handoff: { state: "cancelled" } } });
      expect(test.work().state).toBe("cancelled");
      expect(test.service.cancelHandoff).toHaveBeenCalledOnce();
    });
  });

  it.each(["cancelled", "resolved"] satisfies ResponsibilityState[])("releases human control before work becomes %s, including a simultaneous details edit", async state => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const test = setup(storage);
      await test.request();
      test.updateHandoff({ state: "active" });
      await handleResponsibilityUpdate({ id: test.id, patch: { state, details: { done: true } } }, test.ctx);
      expect(test.handoff().state).toBe("cancelled");
      expect(test.work()).toMatchObject({ state, details: { done: true } });
      expect(test.service.cancelHandoff).toHaveBeenCalledWith({ ownerUid: 1000, human: true }, { instanceId: "instance", requestId: "login" });
    });
  });

  it("does not release another responsibility's handoff through editable details", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const test = setup(storage);
      await test.request();
      test.updateHandoff({ responsibilityId: `r12y:${crypto.randomUUID()}` });
      await handleResponsibilityUpdate({ id: test.id, patch: { state: "cancelled" } }, test.ctx);
      expect(test.service.cancelHandoff).not.toHaveBeenCalled();
      expect(test.handoff().state).toBe("pending");
    });
  });

  it("retains retryable work when provider cleanup fails and honors stale revisions before cleanup", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const test = setup(storage);
      await test.request();
      const revision = test.work().revision;
      await expect(handleResponsibilityUpdate({ id: test.id, expectedRevision: revision - 1, patch: { state: "cancelled" } }, test.ctx)).rejects.toThrow("revision conflict");
      expect(test.service.cancelHandoff).not.toHaveBeenCalled();
      test.service.cancelHandoff.mockRejectedValueOnce(new Error("Provider unavailable"));
      await expect(handleResponsibilityUpdate({ id: test.id, patch: { state: "cancelled" } }, test.ctx)).rejects.toThrow("Provider unavailable");
      expect(test.work()).toMatchObject({ state: "waiting", revision });
      await handleResponsibilityUpdate({ id: test.id, patch: { state: "cancelled" } }, test.ctx);
      expect(test.work().state).toBe("cancelled");
    });
  });

  it("does not overwrite a concurrent responsibility edit after cleanup", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const test = setup(storage);
      await test.request();
      test.service.cancelHandoff.mockImplementationOnce(async () => {
        await handleResponsibilityUpdate({ id: test.id, patch: { title: "A newer title" } }, test.ctx);
        test.updateHandoff({ state: "cancelled" });
        return { handoff: structuredClone(test.handoff()) };
      });
      await expect(handleResponsibilityUpdate({ id: test.id, patch: { state: "cancelled", title: "An old title" } }, test.ctx)).rejects.toThrow("revision conflict");
      expect(test.work()).toMatchObject({ state: "waiting", title: "A newer title" });
      await handleResponsibilityUpdate({ id: test.id, patch: { state: "cancelled" } }, test.ctx);
      expect(test.work()).toMatchObject({ state: "cancelled", title: "A newer title" });
    });
  });
});
