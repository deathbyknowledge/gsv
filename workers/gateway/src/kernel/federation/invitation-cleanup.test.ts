import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { DurableTaskScheduler } from "../../shared/durable-tasks";
import type { Kernel } from "../do";
import { FederationStore } from "../federation-store";
import { FederationRuntime } from "../federation-runtime";
import { SignupInvitationCleanup } from "./invitation-cleanup";

function fixture(storage: DurableObjectStorage) {
  const federation = new FederationStore(storage);
  const tasks = new DurableTaskScheduler(storage, (_callback, json) => ({
    callback: "onSignupInvitationCleanup" as const, payload: z.string().parse(JSON.parse(json)),
  }), async () => {});
  const cancel = vi.fn(async () => {});
  const broadcastToUserUid = vi.fn();
  // SAFETY: the cleanup runtime uses only these Kernel-owned stores, binding and coordinator.
  const host = { installationId: "installation:test", federation, tasks,
    bindings: { SPACE_INVITATIONS: { cancel } }, connectionRuntime: { broadcastToUserUid } } as Kernel;
  Object.assign(host, { federationRuntime: new FederationRuntime(host) });
  const cleanup = new SignupInvitationCleanup(host);
  const invite = federation.createInvite({ ownerUid: 1000, tokenHash: crypto.randomUUID(), issuingShipId: "ship:local",
    issuingOrigin: "https://local.example", expiresAtMs: Date.now() + 3_600_000 });
  return { host, federation, tasks, cleanup, invite, cancel, broadcastToUserUid };
}

describe("signup invitation compensation", () => {
  it("recovers an interrupted reservation and keeps retrying after an Accounts outage", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      const f = fixture(storage);
      const task = f.cleanup.enqueue(f.invite.inviteId, Date.now() + 60_000);
      f.cancel.mockRejectedValueOnce(new Error("Accounts disconnected"));
      const reconstructed = new SignupInvitationCleanup(f.host);
      try {
        await expect(reconstructed.run(f.invite.inviteId, task)).rejects.toThrow("Accounts disconnected");
        expect(f.federation.invite(f.invite.inviteId)?.state).toBe("cancelled");
        const retry = sql.exec<{ id: string }>("SELECT id FROM cf_agents_schedules WHERE callback = 'onSignupInvitationCleanup' AND id <> ?", task).one();
        await f.tasks.cancel(task);
        await reconstructed.run(f.invite.inviteId, retry.id);
        expect(f.cancel).toHaveBeenLastCalledWith({ version: 1, installationId: "installation:test", contactInviteId: f.invite.inviteId });
        expect(f.broadcastToUserUid).toHaveBeenCalledWith(1000, "contact.invite.changed");
      } finally {
        sql.exec("DELETE FROM cf_agents_schedules WHERE callback = 'onSignupInvitationCleanup'");
        await f.tasks.arm();
      }
    });
  });

  it("leaves a returned invitation valid when its old cleanup callback was already waiting", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      const f = fixture(storage);
      const task = f.cleanup.enqueue(f.invite.inviteId, Date.now() + 60_000);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const reservation = f.host.federationRuntime.coordinateFederationContact(`invitation:${f.invite.inviteId}`, () => gate);
      const running = f.cleanup.run(f.invite.inviteId, task);
      try {
        await f.cleanup.complete(task);
        release();
        await Promise.all([reservation, running]);
        expect(f.federation.invite(f.invite.inviteId)?.state).toBe("issued");
        expect(f.cancel).not.toHaveBeenCalled();
      } finally {
        release();
        sql.exec("DELETE FROM cf_agents_schedules WHERE callback = 'onSignupInvitationCleanup'");
        await f.tasks.arm();
      }
    });
  });
});
