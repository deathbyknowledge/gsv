function isString<T>(value: T): value is T & string { return String(value) === value; }

import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { testPeer } from "../test-support/peers";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import type { KernelContext } from "./context";
import type { Kernel } from "./do";
import type { InstallationDirectoryResult } from "@humansandmachines/gsv/services/directory";
import { MailboxStore } from "./mailbox-store";
import {
  claimManagedOutboundMail,
  completeManagedOutboundMail,
  handleMailSend,
  recoverManagedOutboundEnqueue,
  resolveOutboundMailReference,
  outboundEnqueueRetryDelay,
} from "./outbound-mail";

describe("managed outbound mail", () => {
  it("converges interrupted current and successor tasks into one chain after Kernel eviction", async () => {
    const installationId = crypto.randomUUID();
    const stub = env.KERNEL.getByName(installationId);
    const outboundId = "mail-outbound:interrupted-successor";
    const bytes = new TextEncoder().encode("Owned body");
    const fingerprint = `sha256:${[...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    const currentId = await runInDurableObject(stub, async (instance: Kernel, state) => {
      instance.mailboxes.ensureOutbound({ version: 1, outboundId, fingerprint, ownerUid: 1000, deliveryId: "interrupted-successor",
        from: "fixture@example.invalid", to: "recipient@example.invalid", subject: "Interrupted fixture", bodyDigest: fingerprint,
        bodyPath: "/home/fixture/.gsv/mail/outbox/interrupted.txt", textSize: bytes.byteLength, createdAt: 1 });
      await instance.bindings.STORAGE.put("home/fixture/.gsv/mail/outbox/interrupted.txt", bytes);
      instance.mailboxes.markOutboundQueued(outboundId, fingerprint);
      instance.mailboxes.beginOutboundEnqueue(outboundId, fingerprint, Date.now() + 7_200_000);
      instance.mailboxes.markOutboundEnqueued(outboundId, fingerprint);
      const current = await instance.schedule(new Date(Date.now() + 3_600_000), "onManagedOutboundEnqueue", outboundId);
      await instance.scheduleManagedOutboundEnqueue(outboundId, Date.now() + 7_200_000, current.id);
      expect(state.storage.sql.exec("SELECT id FROM cf_agents_schedules WHERE callback = 'onManagedOutboundEnqueue'").toArray()).toHaveLength(2);
      return current.id;
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance: Kernel, state) => {
      const attemptsBefore = instance.mailboxes.getOutbound(outboundId)!.enqueueAttempts;
      const previous = instance.env.MANAGED_MAIL_OUTBOUND;
      const send = vi.fn(async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }));
      instance.env.MANAGED_MAIL_OUTBOUND = { send, sendBatch: vi.fn(async () => { throw new Error("Unexpected batch"); }), metrics: vi.fn(async () => ({ backlogCount: 0, backlogBytes: 0 })) };
      try {
        state.storage.sql.exec("UPDATE cf_agents_schedules SET time = 0 WHERE id = ?", currentId);
        await instance.alarm();
        const pending = state.storage.sql.exec<{ id: string }>("SELECT id FROM cf_agents_schedules WHERE callback = 'onManagedOutboundEnqueue'").toArray();
        expect(pending).toHaveLength(1);
        expect(pending[0].id).not.toBe(currentId);
        state.storage.sql.exec("UPDATE cf_agents_schedules SET time = 0 WHERE id = ?", pending[0].id);
        await instance.alarm();
        expect(state.storage.sql.exec("SELECT payload FROM cf_agents_schedules WHERE callback = 'onManagedOutboundEnqueue'").toArray())
          .toEqual([{ payload: JSON.stringify(outboundId) }]);
        // Re-arming while the current row is due can deliver an automatic alarm during the directory RPC.
        // Publication is at least once; the invariant is one durable chain carrying the same opaque reference.
        expect(send.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(instance.mailboxes.getOutbound(outboundId)).toMatchObject({ state: "queued" });
        expect(instance.mailboxes.getOutbound(outboundId)!.enqueueAttempts).toBeGreaterThanOrEqual(attemptsBefore + send.mock.calls.length);
        for (const call of send.mock.calls) expect(call).toEqual([{ version: 2, installationId, outboundId }]);

        await instance.completeManagedOutboundMail({ version: 1, outboundId, fingerprint, state: "accepted", providerMessageId: "interrupted-provider" });
        const publicationsAtCompletion = send.mock.calls.length;
        state.storage.sql.exec("UPDATE cf_agents_schedules SET time = 0 WHERE callback = 'onManagedOutboundEnqueue'");
        await instance.alarm();
        expect(state.storage.sql.exec("SELECT id FROM cf_agents_schedules WHERE callback = 'onManagedOutboundEnqueue'").toArray()).toEqual([]);
        expect(send).toHaveBeenCalledTimes(publicationsAtCompletion);
        expect(instance.mailboxes.getOutbound(outboundId)).toMatchObject({ state: "accepted", enqueueNextAt: null, providerMessageId: "interrupted-provider" });
      } finally { instance.env.MANAGED_MAIL_OUTBOUND = previous; }
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, (instance: Kernel, state) => {
      expect(state.storage.sql.exec("SELECT id FROM cf_agents_schedules WHERE callback = 'onManagedOutboundEnqueue'").toArray()).toEqual([]);
      expect(instance.mailboxes.getOutbound(outboundId)).toMatchObject({ state: "accepted", enqueueNextAt: null, providerMessageId: "interrupted-provider" });
    });
  });

  it("restores an already-enqueued legacy intent with no task across Kernel eviction", async () => {
    const installationId = crypto.randomUUID();
    const stub = env.KERNEL.getByName(installationId);
    const outboundId = "mail-outbound:legacy-pending";
    const fingerprint = `sha256:${"a".repeat(64)}`;
    await runInDurableObject(stub, (instance: Kernel) => {
      instance.mailboxes.ensureOutbound({ version: 1, outboundId, fingerprint, ownerUid: 1000, deliveryId: "legacy-pending",
        from: "fixture@example.invalid", to: "recipient@example.invalid", subject: "Pending fixture", bodyDigest: fingerprint,
        bodyPath: "/home/fixture/.gsv/mail/outbox/pending.txt", textSize: 10, createdAt: 1 });
      instance.mailboxes.markOutboundQueued(outboundId, fingerprint);
      instance.mailboxes.markOutboundEnqueued(outboundId, fingerprint);
    });
    for (let restart = 0; restart < 2; restart += 1) {
      await evictDurableObject(stub);
      await runInDurableObject(stub, (instance: Kernel, state) => {
        expect(instance.mailboxes.getOutbound(outboundId)).toMatchObject({ state: "queued", enqueuedAt: expect.any(Number) });
        expect(state.storage.sql.exec<{ payload: string }>("SELECT payload FROM cf_agents_schedules WHERE callback = 'onManagedOutboundEnqueue'").toArray())
          .toEqual([{ payload: JSON.stringify(outboundId) }]);
      });
    }
    await runInDurableObject(stub, async (instance: Kernel, state) => {
      await instance.completeManagedOutboundMail({ version: 1, outboundId, fingerprint, state: "accepted", providerMessageId: "legacy-provider" });
      state.storage.sql.exec("UPDATE cf_agents_schedules SET time = 0 WHERE callback = 'onManagedOutboundEnqueue'");
      await instance.alarm();
      expect(state.storage.sql.exec("SELECT id FROM cf_agents_schedules WHERE callback = 'onManagedOutboundEnqueue'").toArray()).toEqual([]);
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, (_instance: Kernel, state) => {
      expect(state.storage.sql.exec("SELECT id FROM cf_agents_schedules WHERE callback = 'onManagedOutboundEnqueue'").toArray()).toEqual([]);
    });
  });

  it("re-publishes dropped queue notifications from the durable outbox until exact completion", async () => {
    await runWithRealKernelSql(async (sql) => {
      const storage = new MemoryR2Bucket();
      const queue = { send: vi.fn(async () => undefined) };
      let ctx = outboundContext(sql, storage, queue);
      const sent = await handleMailSend({ to: "mike@example.com", subject: "Dropped notifications", text: "Keep this intent.", deliveryId: "dropped-queue" }, ctx);
      if (!sent.ok) throw new Error(sent.error);
      const first = ctx.mailboxes.getOutbound(sent.outboundId)!;
      for (let attempt = 2; attempt <= 8; attempt += 1) {
        ctx = outboundContext(sql, storage, queue);
        const before = Date.now();
        await recoverManagedOutboundEnqueue(sent.outboundId, ctx, true);
        const next = ctx.mailboxes.getOutbound(sent.outboundId)!;
        expect(next).toMatchObject({ state: "queued", enqueuedAt: first.enqueuedAt, enqueueAttempts: attempt, fingerprint: first.fingerprint });
        expect(next.enqueueNextAt).toBeGreaterThanOrEqual(before + outboundEnqueueRetryDelay(attempt));
        expect(ctx.scheduleManagedOutboundEnqueue).toHaveBeenCalledExactlyOnceWith(sent.outboundId, next.enqueueNextAt);
      }
      const command = { version: 2, installationId: ctx.installationId, outboundId: sent.outboundId };
      expect(queue.send.mock.calls).toEqual(Array.from({ length: 8 }, () => [command]));
      completeManagedOutboundMail({ version: 1, outboundId: sent.outboundId, fingerprint: first.fingerprint, state: "accepted", providerMessageId: "provider-once" }, ctx);
      const afterCompletion = outboundContext(sql, storage, queue);
      await recoverManagedOutboundEnqueue(sent.outboundId, afterCompletion, true);
      expect(queue.send).toHaveBeenCalledTimes(8);
      expect(afterCompletion.scheduleManagedOutboundEnqueue).not.toHaveBeenCalled();
      expect(afterCompletion.mailboxes.getOutbound(sent.outboundId)).toMatchObject({ state: "accepted", enqueueNextAt: null });
    });
  });

  it.each([false, true])("preserves a delayed accepted completion with missing bytes and lost Queue reply=%s", async (lostReply) => {
    await runWithRealKernelSql(async (sql) => {
      const storage = new MemoryR2Bucket();
      const queue = { send: vi.fn(async () => undefined) };
      if (lostReply) queue.send.mockRejectedValueOnce(new Error("Queue accepted but its reply was lost"));
      const ctx = outboundContext(sql, storage, queue);
      const sent = await handleMailSend({ to: "mike@example.com", subject: "Delayed receipt", text: "Provider already accepted this.", deliveryId: "delayed-accepted" }, ctx);
      if (!sent.ok) throw new Error(sent.error);
      const outbound = ctx.mailboxes.getOutbound(sent.outboundId)!;
      expect(outbound.enqueuedAt).toEqual(lostReply ? null : expect.any(Number));
      const reference = { version: 1 as const, outboundId: sent.outboundId, fingerprint: outbound.fingerprint };
      const claimed = await claimManagedOutboundMail(reference, ctx);
      expect(claimed.status).toBe("ready");
      if (claimed.status !== "ready") throw new Error("Fixture claim was not ready");
      expect(await new Response(claimed.body.stream).text()).toBe("Provider already accepted this.");
      storage.delete(outbound.bodyPath.slice(1));
      const read = vi.spyOn(storage, "get");
      const restarted = outboundContext(sql, storage, queue);
      await recoverManagedOutboundEnqueue(sent.outboundId, restarted, true);
      expect(read).not.toHaveBeenCalled();
      expect(queue.send).toHaveBeenCalledTimes(2);
      expect(queue.send.mock.calls[1]).toEqual(queue.send.mock.calls[0]);
      expect(restarted.mailboxes.getOutbound(sent.outboundId)).toMatchObject({ state: "queued", fingerprint: reference.fingerprint });
      completeManagedOutboundMail({ ...reference, state: "accepted", providerMessageId: "accepted-before-retry" }, restarted);
      expect(restarted.mailboxes.getOutbound(sent.outboundId)).toMatchObject({ state: "accepted", providerMessageId: "accepted-before-retry" });
    });
  });

  it("fails an incomplete staging intent before publication when its body is missing", async () => {
    await runWithRealKernelSql(async (sql) => {
      const queue = { send: vi.fn(async () => undefined) };
      const ctx = outboundContext(sql, new MemoryR2Bucket(), queue);
      const outboundId = "mail-outbound:staging-body-missing";
      const fingerprint = `sha256:${"a".repeat(64)}`;
      ctx.mailboxes.ensureOutbound({ version: 1, outboundId, fingerprint, ownerUid: 1000, deliveryId: "staging-body-missing",
        from: "fixture@example.invalid", to: "recipient@example.invalid", subject: "Incomplete staging", bodyDigest: fingerprint,
        bodyPath: "/home/fixture/.gsv/mail/outbox/missing.txt", textSize: 10, createdAt: 1 });
      await recoverManagedOutboundEnqueue(outboundId, ctx, true);
      expect(queue.send).not.toHaveBeenCalled();
      expect(ctx.mailboxes.getOutbound(outboundId)).toMatchObject({ state: "failed", errorCode: "body_unavailable" });
    });
  });

  it("keeps queue publication paused beyond transport retries and resumes after reactivation", async () => {
    await runWithRealKernelSql(async (sql) => {
      const storage = new MemoryR2Bucket();
      const queue = { send: vi.fn(async () => undefined) };
      const ctx = outboundContext(sql, storage, queue);
      const sent = await handleMailSend({ to: "mike@example.com", subject: "Paused intent", text: "Wait for reactivation.", deliveryId: "restricted-queue" }, ctx);
      if (!sent.ok) throw new Error(sent.error);
      const identity = { found: true as const, installationId: ctx.installationId, handle: "hank", canonicalOrigin: "https://hank.gsv.space" };
      const resolve = vi.fn<() => Promise<InstallationDirectoryResult>>(async () => ({ ...identity, state: "restricted" }));
      ctx.env.INSTALLATION_DIRECTORY = { resolveHostname: resolve, resolveInstallation: resolve };
      const read = vi.spyOn(storage, "get");
      for (let attempt = 0; attempt < 7; attempt += 1) await recoverManagedOutboundEnqueue(sent.outboundId, ctx, true);
      resolve.mockRejectedValueOnce(new Error("Directory unavailable"));
      await recoverManagedOutboundEnqueue(sent.outboundId, ctx, true);
      expect(queue.send).toHaveBeenCalledOnce();
      expect(read).not.toHaveBeenCalled();
      expect(ctx.scheduleManagedOutboundEnqueue).toHaveBeenCalledTimes(9);
      expect(ctx.mailboxes.getOutbound(sent.outboundId)).toMatchObject({ state: "queued", enqueueAttempts: 9 });
      resolve.mockResolvedValue({ ...identity, state: "active" });
      await recoverManagedOutboundEnqueue(sent.outboundId, ctx, true);
      expect(queue.send).toHaveBeenCalledTimes(2);
      expect(queue.send.mock.calls[1]).toEqual(queue.send.mock.calls[0]);
      expect(ctx.mailboxes.getOutbound(sent.outboundId)).toMatchObject({ state: "queued", enqueueAttempts: 10 });
    });
  });

  it("retains the outbox without publishing or reading its body when the directory binding is missing", async () => {
    await runWithRealKernelSql(async (sql) => {
      const storage = new MemoryR2Bucket();
      const queue = { send: vi.fn(async () => undefined) };
      const ctx = outboundContext(sql, storage, queue);
      Reflect.deleteProperty(ctx.env, "INSTALLATION_DIRECTORY");
      const sent = await handleMailSend({ to: "mike@example.com", subject: "Directory unavailable", text: "Wait for directory recovery.", deliveryId: "missing-directory" }, ctx);
      if (!sent.ok) throw new Error(sent.error);
      const read = vi.spyOn(storage, "get");
      await recoverManagedOutboundEnqueue(sent.outboundId, ctx, true);
      expect(queue.send).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(ctx.mailboxes.getOutbound(sent.outboundId)).toMatchObject({ state: "queued", enqueueAttempts: 2, enqueuedAt: null });
      expect(ctx.scheduleManagedOutboundEnqueue).toHaveBeenCalledTimes(2);
    });
  });

  it.each([null, "retained", "deleting", "deleted"] as const)("stops durable publication when the installation becomes %s", async (terminal) => {
    await runWithRealKernelSql(async (sql) => {
      const queue = { send: vi.fn(async () => undefined) };
      const ctx = outboundContext(sql, new MemoryR2Bucket(), queue);
      const sent = await handleMailSend({ to: "mike@example.com", subject: "Retired intent", text: "No new delivery.", deliveryId: "retired-queue" }, ctx);
      if (!sent.ok) throw new Error(sent.error);
      const resolve = async (): Promise<InstallationDirectoryResult> => terminal === null ? { found: false }
        : { found: true, installationId: ctx.installationId, handle: "hank", canonicalOrigin: "https://hank.gsv.space", state: terminal };
      ctx.env.INSTALLATION_DIRECTORY = { resolveHostname: resolve, resolveInstallation: resolve };
      await recoverManagedOutboundEnqueue(sent.outboundId, ctx, true);
      expect(ctx.mailboxes.getOutbound(sent.outboundId)).toMatchObject({ state: "failed", errorCode: "installation_inactive", enqueueNextAt: null });
      const scheduled = vi.mocked(ctx.scheduleManagedOutboundEnqueue).mock.calls.length;
      await recoverManagedOutboundEnqueue(sent.outboundId, ctx, true);
      expect(ctx.scheduleManagedOutboundEnqueue).toHaveBeenCalledTimes(scheduled);
      expect(queue.send).toHaveBeenCalledOnce();
      expect(ctx.mailboxes.pendingOutboundEnqueues()).toEqual([]);
    });
  });

  it("keeps real RPC lookup scoped to each Kernel across eviction and retirement", async () => {
    const firstId = crypto.randomUUID();
    const first = env.KERNEL.getByName(firstId);
    const second = env.KERNEL.getByName(crypto.randomUUID());
    const outboundId = "mail-outbound:same-id";
    for (const [kernel, fingerprint] of [[first, `sha256:${"a".repeat(64)}`], [second, `sha256:${"b".repeat(64)}`]] as const) {
      await runInDurableObject(kernel, (instance: Kernel) => {
        instance.mailboxes.ensureOutbound({
          version: 1, outboundId, fingerprint, ownerUid: 1000, deliveryId: "same-id",
          from: "fixture@example.invalid", to: "recipient@example.invalid", subject: "Owned fixture",
          bodyDigest: fingerprint, bodyPath: "/home/fixture/.gsv/mail/outbox/fixture/message.txt",
          textSize: 10, createdAt: 1,
        });
      });
    }
    expect(await first.resolveOutboundMailReference({ outboundId })).toEqual({ version: 1, outboundId, fingerprint: `sha256:${"a".repeat(64)}` });
    expect(await second.resolveOutboundMailReference({ outboundId })).toEqual({ version: 1, outboundId, fingerprint: `sha256:${"b".repeat(64)}` });
    await evictDurableObject(first);
    expect(await first.resolveOutboundMailReference({ outboundId })).toEqual({ version: 1, outboundId, fingerprint: `sha256:${"a".repeat(64)}` });
    expect(await first.resolveOutboundMailReference({ outboundId: "mail-outbound:missing" })).toBeNull();
    await runInDurableObject(first, (instance: Kernel) => {
      instance.retirement.begin({ version: 1, installationId: firstId, operationId: crypto.randomUUID() });
    });
    await evictDurableObject(first);
    await runInDurableObject(first, async (instance: Kernel) => {
      await expect(instance.resolveOutboundMailReference({ outboundId })).rejects.toThrow("retired");
    });
    expect(await second.resolveOutboundMailReference({ outboundId })).toEqual({ version: 1, outboundId, fingerprint: `sha256:${"b".repeat(64)}` });
  });

  it("resolves only the authoritative immutable reference without hydrating the body", async () => {
    await runWithRealKernelSql(async (sql) => {
      const storage = new MemoryR2Bucket();
      const ctx = outboundContext(sql, storage, { send: vi.fn(async () => undefined) });
      const args = { to: "mike@example.com", subject: "Immutable", text: "Original body", deliveryId: "lookup-1" };
      const sent = await handleMailSend(args, ctx);
      if (!sent.ok) throw new Error(sent.error);
      const outbound = ctx.mailboxes.getOutbound(sent.outboundId)!;
      const reference = { version: 1, outboundId: sent.outboundId, fingerprint: outbound.fingerprint };
      const read = vi.spyOn(storage, "get");
      read.mockRejectedValue(new Error("Body must not be hydrated"));

      expect(resolveOutboundMailReference({ outboundId: sent.outboundId }, ctx)).toEqual(reference);
      await expect(handleMailSend({ ...args, text: "Changed body" }, ctx)).resolves.toMatchObject({ ok: false, retryable: false });
      expect(resolveOutboundMailReference({ outboundId: sent.outboundId }, ctx)).toEqual(reference);
      expect(resolveOutboundMailReference({ outboundId: "mail-outbound:missing" }, ctx)).toBeNull();
      expect(read).not.toHaveBeenCalled();

      completeManagedOutboundMail({ ...reference, version: 1, state: "accepted", providerMessageId: "lookup-provider" }, ctx);
      expect(resolveOutboundMailReference({ outboundId: sent.outboundId }, ctx)).toEqual(reference);
      expect(read).not.toHaveBeenCalled();
    });
  });

  it("does not resolve a foreign outbox id or normalize an altered identity", async () => {
    let foreignId = "";
    await runWithRealKernelSql(async (sql) => {
      const ctx = outboundContext(sql, new MemoryR2Bucket(), { send: vi.fn(async () => undefined) });
      const sent = await handleMailSend({ to: "mike@example.com", subject: "First space", text: "Owned", deliveryId: "lookup-2" }, ctx);
      if (!sent.ok) throw new Error(sent.error);
      foreignId = sent.outboundId;
    });
    await runWithRealKernelSql((sql) => {
      const ctx = outboundContext(sql, new MemoryR2Bucket(), { send: vi.fn(async () => undefined) });
      expect(resolveOutboundMailReference({ outboundId: foreignId }, ctx)).toBeNull();
      const read = vi.spyOn(ctx.mailboxes, "getOutbound");
      for (const outboundId of [` ${foreignId}`, `${foreignId} `, "", "\n", "x".repeat(257)]) {
        expect(() => resolveOutboundMailReference({ outboundId }, ctx)).toThrow();
      }
      // SAFETY: Extra selectors deliberately exercise the untrusted RPC input boundary.
      expect(() => resolveOutboundMailReference({ outboundId: foreignId, installationId: "installation-1" } as never, ctx)).toThrow();
      expect(read).not.toHaveBeenCalled();
    });
  });

  it("stages one canonical body and settles exact replays", async () => {
    await runWithRealKernelSql(async (sql) => {
      const storage = new MemoryR2Bucket();
      const queue = { send: vi.fn(async () => undefined) };
      const ctx = outboundContext(sql, storage, queue);

      const first = await handleMailSend({
        to: "mike@example.com",
        subject: "Contract",
        text: "Looks good to me.",
        deliveryId: "request-1",
      }, ctx);
      expect(first).toMatchObject({
        ok: true,
        deliveryId: "request-1",
        state: "queued",
        from: "hank@gsv.space",
        to: "mike@example.com",
        replayed: false,
      });
      if (!first.ok) throw new Error(first.error);
      expect(queue.send).toHaveBeenCalledWith({
        version: 2,
        installationId: "installation-1",
        outboundId: first.outboundId,
      });

      const claim = await claimManagedOutboundMail({
        version: 1,
        outboundId: first.outboundId,
        fingerprint: ctx.mailboxes.getOutbound(first.outboundId)!.fingerprint,
      }, ctx);
      expect(claim.status).toBe("ready");
      if (claim.status !== "ready") throw new Error("Expected a ready mail claim");
      expect(claim.draft).toMatchObject({
        from: "hank@gsv.space",
        to: "mike@example.com",
        subject: "Contract",
        bodyDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        textSize: 17,
      });
      expect(await new Response(claim.body.stream).text()).toBe("Looks good to me.");

      completeManagedOutboundMail({
        version: 1,
        outboundId: first.outboundId,
        fingerprint: claim.draft.fingerprint,
        state: "accepted",
        providerMessageId: "provider-1",
      }, ctx);
      await expect(claimManagedOutboundMail({
        version: 1,
        outboundId: first.outboundId,
        fingerprint: claim.draft.fingerprint,
      }, ctx)).resolves.toEqual({
        status: "settled",
        completion: {
          version: 1,
          outboundId: first.outboundId,
          fingerprint: claim.draft.fingerprint,
          state: "accepted",
          providerMessageId: "provider-1",
        },
      });
      completeManagedOutboundMail({
        version: 1,
        outboundId: first.outboundId,
        fingerprint: claim.draft.fingerprint,
        state: "accepted",
        providerMessageId: "provider-1",
      }, ctx);

      const replay = await handleMailSend({
        to: "mike@example.com",
        subject: "Contract",
        text: "Looks good to me.",
        deliveryId: "request-1",
      }, ctx);
      expect(replay).toMatchObject({
        ok: true,
        outboundId: first.outboundId,
        state: "accepted",
        replayed: true,
      });
      expect(queue.send).toHaveBeenCalledTimes(1);
    });
  });

  it("records body ownership before a scheduling failure and resumes on replay", async () => {
    await runWithRealKernelSql(async (sql) => {
      const storage = new MemoryR2Bucket();
      const queue = { send: vi.fn(async () => undefined) };
      const ctx = outboundContext(sql, storage, queue);
      ctx.scheduleManagedOutboundEnqueue = vi.fn()
        .mockRejectedValueOnce(new Error("schedule unavailable"))
        .mockResolvedValueOnce(undefined);
      const args = {
        to: "mike@example.com",
        subject: "Owned staging",
        text: "Keep this body owned.",
        deliveryId: "owned-staging-1",
      };

      await expect(handleMailSend(args, ctx)).resolves.toMatchObject({
        ok: false,
        retryable: true,
        deliveryId: "owned-staging-1",
      });
      const staged = ctx.mailboxes.getOutboundForDelivery(1000, "owned-staging-1");
      expect(staged).toMatchObject({ state: "staging" });
      expect(await storage.text(staged!.bodyPath.slice(1))).toBe("Keep this body owned.");
      expect(storage.keys()).toHaveLength(2);

      await expect(handleMailSend(args, ctx)).resolves.toMatchObject({
        ok: true,
        outboundId: staged!.outboundId,
        state: "queued",
        replayed: true,
      });
      expect(storage.keys()).toHaveLength(2);
      expect(queue.send).toHaveBeenCalledTimes(1);
    });
  });

  it("rejects a concurrent delivery conflict before writing its body", async () => {
    await runWithRealKernelSql(async (sql) => {
      const storage = new MemoryR2Bucket();
      const queue = { send: vi.fn(async () => undefined) };
      const ctx = outboundContext(sql, storage, queue);
      const originalPut = storage.put.bind(storage);
      let releaseFirstPut!: () => void;
      let reportFirstPut!: () => void;
      const firstPutStarted = new Promise<void>((resolve) => {
        reportFirstPut = resolve;
      });
      const firstPutGate = new Promise<void>((resolve) => {
        releaseFirstPut = resolve;
      });
      let shouldBlock = true;
      const put = vi.spyOn(storage, "put").mockImplementation(async (...args) => {
        if (shouldBlock) {
          shouldBlock = false;
          reportFirstPut();
          await firstPutGate;
        }
        return await originalPut(...args);
      });

      const first = handleMailSend({
        to: "mike@example.com",
        subject: "Canonical",
        text: "First body",
        deliveryId: "concurrent-delivery-1",
      }, ctx);
      await firstPutStarted;
      const conflict = await handleMailSend({
        to: "mike@example.com",
        subject: "Conflict",
        text: "Second body",
        deliveryId: "concurrent-delivery-1",
      }, ctx);
      releaseFirstPut();

      await expect(first).resolves.toMatchObject({ ok: true, replayed: false });
      expect(conflict).toMatchObject({
        ok: false,
        retryable: false,
        error: expect.stringContaining("conflicts"),
      });
      expect(put).toHaveBeenCalledTimes(2);
      expect(storage.keys()).toHaveLength(2);
    });
  });

  it.each(["missing", "corrupt"])(
    "durably fails a queued intent when its body is %s",
    async (failure) => {
      await runWithRealKernelSql(async (sql) => {
        const storage = new MemoryR2Bucket();
        const queue = { send: vi.fn(async () => undefined) };
        const ctx = outboundContext(sql, storage, queue);
        const sent = await handleMailSend({
          to: "mike@example.com",
          subject: "Unavailable body",
          text: "Durable body",
          deliveryId: `body-${failure}`,
        }, ctx);
        if (!sent.ok) throw new Error(sent.error);
        const outbound = ctx.mailboxes.getOutbound(sent.outboundId)!;
        expect(outbound.enqueuedAt).toEqual(expect.any(Number));
        if (failure === "missing") {
          storage.delete(outbound.bodyPath.slice(1));
        } else {
          await storage.put(outbound.bodyPath.slice(1), "Broken body!");
        }

        const first = await claimManagedOutboundMail({
          version: 1,
          outboundId: outbound.outboundId,
          fingerprint: outbound.fingerprint,
        }, ctx);
        expect(first).toEqual({
          status: "settled",
          completion: {
            version: 1,
            outboundId: outbound.outboundId,
            fingerprint: outbound.fingerprint,
            state: "failed",
            errorCode: "body_unavailable",
          },
        });
        expect(ctx.mailboxes.getOutbound(outbound.outboundId)).toMatchObject({
          state: "failed",
          errorCode: "body_unavailable",
          completedAt: expect.any(Number),
        });
        await expect(claimManagedOutboundMail({
          version: 1,
          outboundId: outbound.outboundId,
          fingerprint: outbound.fingerprint,
        }, ctx)).resolves.toEqual(first);
      });
    },
  );

  it("rejects a mismatched claim reference without mutating the canonical intent", async () => {
    await runWithRealKernelSql(async (sql) => {
      const ctx = outboundContext(
        sql,
        new MemoryR2Bucket(),
        { send: vi.fn(async () => undefined) },
      );
      const sent = await handleMailSend({
        to: "mike@example.com",
        subject: "Reference",
        text: "Keep the canonical intent queued.",
        deliveryId: "reference-mismatch",
      }, ctx);
      if (!sent.ok) throw new Error(sent.error);

      await expect(claimManagedOutboundMail({
        version: 1,
        outboundId: sent.outboundId,
        fingerprint: `sha256:${"0".repeat(64)}`,
      }, ctx)).resolves.toEqual({
        status: "rejected",
        errorCode: "reference_mismatch",
      });
      expect(ctx.mailboxes.getOutbound(sent.outboundId)).toMatchObject({
        state: "queued",
        errorCode: null,
      });
    });
  });

  it("recovers queue publication after a restart without minting a second intent", async () => {
    await runWithRealKernelSql(async (sql) => {
      const storage = new MemoryR2Bucket();
      const queue = {
        send: vi.fn()
          .mockRejectedValueOnce(new Error("queue unavailable"))
          .mockResolvedValueOnce(undefined),
      };
      const ctx = outboundContext(sql, storage, queue);
      const args = {
        to: "mike@example.com",
        subject: "Contract",
        text: "Retry me.",
        deliveryId: "request-1",
      };

      const first = await handleMailSend(args, ctx);
      expect(first).toMatchObject({
        ok: true,
        deliveryId: "request-1",
        state: "queued",
      });
      if (!first.ok) throw new Error(first.error);
      expect(ctx.mailboxes.getOutbound(first.outboundId)).toMatchObject({
        enqueueAttempts: 1,
        enqueuedAt: null,
      });

      const reference = resolveOutboundMailReference({ outboundId: first.outboundId }, ctx);
      const restarted = outboundContext(sql, storage, queue);
      await recoverManagedOutboundEnqueue(first.outboundId, restarted, true);
      expect(restarted.mailboxes.getOutbound(first.outboundId)).toMatchObject({
        enqueueAttempts: 2,
        enqueuedAt: expect.any(Number),
      });
      const retried = await handleMailSend(args, restarted);
      expect(retried).toMatchObject({
        ok: true,
        outboundId: first.outboundId,
        state: "queued",
        replayed: true,
      });
      const command = { version: 2, installationId: ctx.installationId, outboundId: first.outboundId };
      expect(queue.send.mock.calls).toEqual([[command], [command]]);
      expect(resolveOutboundMailReference({ outboundId: first.outboundId }, restarted)).toEqual(reference);
    });
  });

  it("keeps one recovery chain while callers replay during a Queue outage", async () => {
    await runWithRealKernelSql(async (sql) => {
      const storage = new MemoryR2Bucket();
      const queue = { send: vi.fn().mockRejectedValue(new Error("queue unavailable")) };
      const ctx = outboundContext(sql, storage, queue);
      const args = {
        to: "mike@example.com",
        subject: "Contract",
        text: "Retry me.",
        deliveryId: "outage-replay-1",
      };

      const first = await handleMailSend(args, ctx);
      if (!first.ok) throw new Error(first.error);
      for (let index = 0; index < 5; index += 1) {
        await expect(handleMailSend(args, ctx)).resolves.toMatchObject({
          ok: true,
          outboundId: first.outboundId,
          replayed: true,
        });
      }
      expect(ctx.scheduleManagedOutboundEnqueue).toHaveBeenCalledTimes(1);

      await recoverManagedOutboundEnqueue(first.outboundId, ctx, true);
      expect(ctx.scheduleManagedOutboundEnqueue).toHaveBeenCalledTimes(2);
    });
  });

  it("hands queued reference recovery to its successor during a body-storage outage", async () => {
    await runWithRealKernelSql(async (sql) => {
      const storage = new MemoryR2Bucket();
      const queue = { send: vi.fn().mockRejectedValue(new Error("queue unavailable")) };
      const ctx = outboundContext(sql, storage, queue);
      const sent = await handleMailSend({
        to: "mike@example.com",
        subject: "Contract",
        text: "Retry me.",
        deliveryId: "body-outage-1",
      }, ctx);
      if (!sent.ok) throw new Error(sent.error);
      const restarted = outboundContext(sql, storage, {
        send: vi.fn(async () => undefined),
      });
      storage.failGet = true;
      const read = vi.spyOn(storage, "get");

      await expect(
        recoverManagedOutboundEnqueue(sent.outboundId, restarted, true),
      ).resolves.toMatchObject({ outboundId: sent.outboundId });
      expect(restarted.scheduleManagedOutboundEnqueue).toHaveBeenCalledTimes(1);
      expect(read).not.toHaveBeenCalled();
      expect(restarted.mailboxes.getOutbound(sent.outboundId)).toMatchObject({ state: "queued", enqueuedAt: expect.any(Number) });
    });
  });

  it("rejects conflicting reuse of a delivery id", async () => {
    await runWithRealKernelSql(async (sql) => {
      const ctx = outboundContext(
        sql,
        new MemoryR2Bucket(),
        { send: vi.fn(async () => undefined) },
      );
      await handleMailSend({
        to: "mike@example.com",
        subject: "One",
        text: "First",
        deliveryId: "request-1",
      }, ctx);

      const conflict = await handleMailSend({
        to: "mike@example.com",
        subject: "Two",
        text: "Second",
        deliveryId: "request-1",
      }, ctx);
      expect(conflict).toMatchObject({
        ok: false,
        retryable: false,
        deliveryId: "request-1",
        error: expect.stringContaining("conflicts"),
      });
    });
  });

  it("rejects addresses containing more than one at sign", async () => {
    await runWithRealKernelSql(async (sql) => {
      const ctx = outboundContext(
        sql,
        new MemoryR2Bucket(),
        { send: vi.fn(async () => undefined) },
      );
      await expect(handleMailSend({
        to: "one@two@example.com",
        subject: "Invalid",
        text: "Do not queue this.",
        deliveryId: "request-1",
      }, ctx)).resolves.toMatchObject({
        ok: false,
        retryable: false,
      });
      expect(ctx.mailboxes.getOutboundForDelivery(1000, "request-1")).toBeNull();
    });
  });

  it("rejects contradictory transport completions", async () => {
    await runWithRealKernelSql(async (sql) => {
      const ctx = outboundContext(
        sql,
        new MemoryR2Bucket(),
        { send: vi.fn(async () => undefined) },
      );
      const sent = await handleMailSend({
        to: "mike@example.com",
        subject: "Completion",
        text: "Validate the result.",
        deliveryId: "request-1",
      }, ctx);
      if (!sent.ok) throw new Error(sent.error);
      const reference = ctx.mailboxes.getOutbound(sent.outboundId)!;
      expect(() => completeManagedOutboundMail({
        version: 1,
        outboundId: sent.outboundId,
        fingerprint: reference.fingerprint,
        state: "failed",
      }, ctx)).toThrow("requires only an error code");
      expect(() => completeManagedOutboundMail({
        version: 1,
        outboundId: sent.outboundId,
        fingerprint: reference.fingerprint,
        state: "accepted",
        providerMessageId: "provider-1",
        errorCode: "contradiction",
      }, ctx)).toThrow("cannot include an error code");
    });
  });

  it("derives reply destination and threading from an owner-scoped message", async () => {
    await runWithRealKernelSql(async (sql) => {
      const ctx = outboundContext(
        sql,
        new MemoryR2Bucket(),
        { send: vi.fn(async () => undefined) },
      );
      ctx.mailboxes.ensureMailbox("mailbox:1000:primary", 1000, "hank@gsv.space");
      ctx.mailboxes.recordMessage({
        messageId: "mail:source",
        mailboxId: "mailbox:1000:primary",
        intakeId: "intake-source",
        digest: `sha256:${"a".repeat(64)}`,
        envelopeFrom: "fallback@example.com",
        envelopeTo: "hank@gsv.space",
        headerMessageId: "<source@example.com>",
        displayFrom: "Mike <mike@example.com>",
        to: ["hank@gsv.space"],
        cc: [],
        replyTo: ["Mike <reply@example.com>"],
        subject: "Contract",
        sentAt: 1,
        receivedAt: 2,
        rawPath: "/home/hank/.gsv/mail/inbox/mail:source/raw.eml",
        textPath: "/home/hank/.gsv/mail/inbox/mail:source/message.txt",
        sizeBytes: 100,
        attachments: [],
      });

      const result = await handleMailSend({
        replyToMessageId: "mail:source",
        text: "Thanks.",
        deliveryId: "reply-1",
      }, ctx);
      expect(result).toMatchObject({
        ok: true,
        to: "reply@example.com",
        subject: "Re: Contract",
      });
      if (!result.ok) throw new Error(result.error);
      expect(ctx.mailboxes.getOutbound(result.outboundId)).toMatchObject({
        replyToMessageId: "mail:source",
        inReplyTo: "<source@example.com>",
        references: "<source@example.com>",
      });
    });
  });

  it("replies to the message From header before the SMTP envelope sender", async () => {
    await runWithRealKernelSql(async (sql) => {
      const ctx = outboundContext(
        sql,
        new MemoryR2Bucket(),
        { send: vi.fn(async () => undefined) },
      );
      ctx.mailboxes.ensureMailbox("mailbox:1000:primary", 1000, "hank@gsv.space");
      ctx.mailboxes.recordMessage({
        messageId: "mail:source-from",
        mailboxId: "mailbox:1000:primary",
        intakeId: "intake-source-from",
        digest: `sha256:${"b".repeat(64)}`,
        envelopeFrom: "bounce@example.net",
        envelopeTo: "hank@gsv.space",
        headerMessageId: "<source-from@example.com>",
        displayFrom: "Mike <mike@example.com>",
        to: ["hank@gsv.space"],
        cc: [],
        replyTo: [],
        subject: "Contract",
        sentAt: 1,
        receivedAt: 2,
        rawPath: "/home/hank/.gsv/mail/inbox/mail:source-from/raw.eml",
        textPath: "/home/hank/.gsv/mail/inbox/mail:source-from/message.txt",
        sizeBytes: 100,
        attachments: [],
      });

      const result = await handleMailSend({
        replyToMessageId: "mail:source-from",
        text: "Thanks.",
        deliveryId: "reply-from-1",
      }, ctx);
      expect(result).toMatchObject({
        ok: true,
        to: "mike@example.com",
      });
    });
  });

  it("does not create state when the managed transport is unavailable", async () => {
    await runWithRealKernelSql(async (sql) => {
      const ctx = outboundContext(sql, new MemoryR2Bucket(), undefined);
      const result = await handleMailSend({
        to: "mike@example.com",
        subject: "Hello",
        text: "Hello.",
        deliveryId: "request-1",
      }, ctx);
      expect(result).toEqual({
        ok: false,
        error: "Managed outbound mail is not available",
        retryable: false,
      });
      expect(ctx.mailboxes.getOutboundForDelivery(1000, "request-1")).toBeNull();
    });
  });

  it("repairs a same-size queued body but leaves terminal state independent of R2", async () => {
    await runWithRealKernelSql(async (sql) => {
      const storage = new MemoryR2Bucket();
      const queue = { send: vi.fn(async () => undefined) };
      const ctx = outboundContext(sql, storage, queue);
      const args = {
        to: "Mike@Example.COM",
        subject: "Integrity",
        text: "Original body",
        deliveryId: "request-1",
      };
      const sent = await handleMailSend(args, ctx);
      if (!sent.ok) throw new Error(sent.error);
      const outbound = ctx.mailboxes.getOutbound(sent.outboundId)!;
      const bodyKey = outbound.bodyPath.slice(1);
      await storage.put(bodyKey, "Corrupted bod");

      const replay = await handleMailSend(args, ctx);
      expect(replay).toMatchObject({
        ok: true,
        to: "Mike@example.com",
        state: "queued",
        replayed: true,
      });
      expect(await storage.text(bodyKey)).toBe("Original body");

      completeManagedOutboundMail({
        version: 1,
        outboundId: outbound.outboundId,
        fingerprint: outbound.fingerprint,
        state: "accepted",
        providerMessageId: "provider-integrity",
      }, ctx);
      storage.delete(bodyKey);
      const terminal = await handleMailSend(args, ctx);
      expect(terminal).toMatchObject({
        ok: true,
        state: "accepted",
        replayed: true,
      });
      expect(await storage.text(bodyKey)).toBeNull();
    });
  });
});

function outboundContext(
  sql: SqlStorage,
  storage: MemoryR2Bucket,
  queue: { send: ReturnType<typeof vi.fn> } | undefined,
): KernelContext {
  const humans = [{
    username: "hank",
    uid: 1000,
    gid: 1000,
    gecos: "Hank",
    home: "/home/hank",
    shell: "/bin/sh",
  }];
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  return {
    env: {
      INSTALLATION_DIRECTORY: {
        resolveHostname: async (): Promise<InstallationDirectoryResult> => ({ found: false }),
        resolveInstallation: async (installationId: string): Promise<InstallationDirectoryResult> => ({
          found: true, installationId, handle: "hank", canonicalOrigin: "https://hank.gsv.space", state: "active",
        }),
      },
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      STORAGE: storage as R2Bucket,
      ...(queue ? { MANAGED_MAIL_OUTBOUND: queue } : undefined),
    },
    installationId: "installation-1",
    installationIdentity: {
      installationId: "installation-1",
      handle: "hank",
      canonicalOrigin: "https://hank.gsv.space",
    },
    requestId: "request-1",
    callerOwnerUid: 1000,
    peer: testPeer({ kind: "human", account: { ...humans[0], gids: [1000, 100], cwd: "/home/hank" }, calls: ["mail.send"] }),
    auth: {
      getPasswdEntries: () => humans,
      getPasswdByUid: (uid: number) => humans.find((entry) => entry.uid === uid) ?? null,
      getShadowByUsername: (username: string) => ({ username, hash: "password-hash" }),
      isPersonalAgentUid: () => false,
      resolveGids: (_username: string, gid: number) => [gid, 100],
    },
    mailboxes: new MailboxStore(sql),
    procs: { getOwnerUid: () => 1000 },
    scheduleManagedOutboundEnqueue: vi.fn(async () => undefined),
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  } as KernelContext;
}

class MemoryR2Bucket {
  private readonly objects = new Map<string, Uint8Array>();
  failGet = false;

  async head(key: string): Promise<R2Object | null> {
    const bytes = this.objects.get(key);
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    return bytes ? ({ size: bytes.byteLength } as R2Object) : null;
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    if (this.failGet) throw new Error("R2 unavailable");
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    return {
      size: bytes.byteLength,
      body: new Blob([bytes]).stream(),
      arrayBuffer: async () => bytes.slice().buffer,
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as R2ObjectBody;
  }

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
  ): Promise<R2Object> {
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const bytes = isString(value)
      ? new TextEncoder().encode(value)
      : value === null
        ? new Uint8Array()
        // SAFETY: test fixture is constructed with the asserted kernel domain shape.
        : new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
    this.objects.set(key, bytes);
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    return { size: bytes.byteLength } as R2Object;
  }

  delete(key: string): void {
    this.objects.delete(key);
  }

  async text(key: string): Promise<string | null> {
    const bytes = this.objects.get(key);
    return bytes ? new TextDecoder().decode(bytes) : null;
  }

  keys(): string[] {
    return [...this.objects.keys()];
  }
}
