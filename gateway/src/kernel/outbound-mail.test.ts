import { describe, expect, it, vi } from "vitest";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import type { KernelContext } from "./context";
import { MailboxStore } from "./mailbox-store";
import {
  claimManagedOutboundMail,
  completeManagedOutboundMail,
  handleMailSend,
  recoverManagedOutboundEnqueue,
} from "./outbound-mail";

describe("managed outbound mail", () => {
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
        version: 1,
        installationId: "installation-1",
        outboundId: first.outboundId,
        fingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
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
      expect(queue.send).toHaveBeenCalledTimes(2);
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

  it("hands recovery to its successor when body verification fails", async () => {
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

      await expect(
        recoverManagedOutboundEnqueue(sent.outboundId, restarted, true),
      ).resolves.toMatchObject({ outboundId: sent.outboundId });
      expect(restarted.scheduleManagedOutboundEnqueue).toHaveBeenCalledTimes(1);
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
  return {
    env: {
      STORAGE: storage as unknown as R2Bucket,
      ...(queue ? { MANAGED_MAIL_OUTBOUND: queue } : {}),
    },
    installationId: "installation-1",
    installationIdentity: {
      installationId: "installation-1",
      handle: "hank",
      canonicalOrigin: "https://hank.gsv.space",
    },
    requestId: "request-1",
    callerOwnerUid: 1000,
    identity: {
      role: "user",
      process: { ...humans[0], gids: [1000, 100], cwd: "/home/hank" },
      capabilities: ["mail.send"],
    },
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
  } as unknown as KernelContext;
}

class MemoryR2Bucket {
  private readonly objects = new Map<string, Uint8Array>();
  failGet = false;

  async head(key: string): Promise<R2Object | null> {
    const bytes = this.objects.get(key);
    return bytes ? ({ size: bytes.byteLength } as R2Object) : null;
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    if (this.failGet) throw new Error("R2 unavailable");
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return {
      size: bytes.byteLength,
      body: new Blob([bytes]).stream(),
      arrayBuffer: async () => bytes.slice().buffer,
    } as unknown as R2ObjectBody;
  }

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
  ): Promise<R2Object> {
    const bytes = typeof value === "string"
      ? new TextEncoder().encode(value)
      : value === null
        ? new Uint8Array()
        : new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
    this.objects.set(key, bytes);
    return { size: bytes.byteLength } as R2Object;
  }

  delete(key: string): void {
    this.objects.delete(key);
  }

  async text(key: string): Promise<string | null> {
    const bytes = this.objects.get(key);
    return bytes ? new TextDecoder().decode(bytes) : null;
  }
}
