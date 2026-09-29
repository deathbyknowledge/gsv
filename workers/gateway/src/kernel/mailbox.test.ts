function isString<T>(value: T): value is T & string { return String(value) === value; }

import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";

import { bodyFromBytes, type BinaryBody } from "@humansandmachines/gsv/protocol";
import { hashPassword, makeShadowEntry } from "../auth/shadow";
import * as stableId from "../shared/stable-id";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { testPeer } from "../test-support/peers";
import { AdapterStore } from "./adapter-store";
import type { KernelContext } from "./context";
import type { Kernel } from "./do";
import { MailboxStore } from "./mailbox-store";
import { ResponsibilityStore } from "./responsibility-store";
import { ResponsibilitySourcePolicyStore } from "./responsibility-source-policies";
import {
  acceptManagedInboundMail,
  completeManagedInboundMail,
  managedMailAddressForOwner,
} from "./mailbox";

const RAW = new TextEncoder().encode([
  "From: Mike <mike@example.com>",
  "To: hank@gsv.space",
  "Subject: Re: contract",
  "",
  "Looks good to me.",
].join("\r\n"));

const METADATA = {
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  version: 1 as const,
  intakeId: "intake-1",
  digest: `sha256:${"a".repeat(64)}`,
  receivedAt: 1_700_000_000_000,
  rawSize: RAW.byteLength,
  envelope: {
    from: "mike@example.com",
    to: "hank@gsv.space",
  },
  rfcMessageId: "<message@example.com>",
  from: { name: "Mike", address: "mike@example.com" },
  to: [{ address: "hank@gsv.space" }],
  cc: [],
  replyTo: [{ address: "mike@example.com" }],
  subject: "Re: contract",
  text: "Looks good to me.",
  attachments: [],
};

const SENSITIVE_RAW = new TextEncoder().encode([
  "X-Private-Header: PRIVATE-RAW-HEADER-SENTINEL",
  "From: PRIVATE-DISPLAY-SENTINEL <private-envelope@example.com>",
  "To: hank@gsv.space",
  "Subject: PRIVATE-SUBJECT-SENTINEL",
  "",
  "PRIVATE-BODY-SENTINEL",
].join("\r\n"));

const SENSITIVE_METADATA = {
  ...METADATA,
  digest: `sha256:${"b".repeat(64)}`,
  rawSize: SENSITIVE_RAW.byteLength,
  envelope: {
    ...METADATA.envelope,
    from: "private-envelope@example.com",
  },
  from: {
    name: "PRIVATE-DISPLAY-SENTINEL",
    address: "private-envelope@example.com",
  },
  subject: "PRIVATE-SUBJECT-SENTINEL",
  text: "PRIVATE-BODY-SENTINEL",
};

describe("managed Kernel mailbox", () => {
  it("stores exact mail under the primary human and aliases exact-byte retries", async () => {
    await runWithRealKernelSql(async (sql, kernelStorage) => {
      const storage = new MemoryR2Bucket();
      const ctx = mailboxContext(sql, kernelStorage, storage);

      const accepted = await acceptManagedInboundMail(
        METADATA,
        bodyFromBytes(RAW),
        ctx,
      );
      expect(accepted.messageId).toMatch(/^mail:[0-9a-f]{64}$/);

      const message = ctx.mailboxes.getMessage(1000, accepted.messageId);
      expect(message).toMatchObject({
        mailboxId: "mailbox:1000:primary",
        subject: "Re: contract",
        envelopeFrom: "mike@example.com",
        replyTo: ["mike@example.com"],
      });
      expect(storage.bytes(message!.rawPath.slice(1))).toEqual(RAW);
      expect(new TextDecoder().decode(storage.bytes(message!.textPath.slice(1))))
        .toContain("Looks good to me.");

      const replay = await acceptManagedInboundMail(
        { ...METADATA, intakeId: "intake-retry" },
        bodyFromBytes(RAW),
        ctx,
      );
      expect(replay).toEqual(accepted);
      expect(ctx.mailboxes.list(1000).count).toBe(1);
      expect(ctx.mailboxes.getIntake("intake-retry")).toMatchObject({
        messageId: accepted.messageId,
      });
      expect(ctx.mailboxes.list(1001).count).toBe(0);
    });
  });

  it("records one reduced mail responsibility even while a DM points to Work", async () => {
    await runWithRealKernelSql(async (sql, kernelStorage) => {
      const storage = new MemoryR2Bucket();
      const ctx = mailboxContext(sql, kernelStorage, storage);
      const reconcileWake = vi.fn(async () => {});
      ctx.reconcileResponsibilityWake = reconcileWake;
      const accepted = await acceptManagedInboundMail(
        SENSITIVE_METADATA,
        bodyFromBytes(SENSITIVE_RAW),
        ctx,
      );
      const mailbox = ctx.mailboxes.getPrimaryMailbox()!;
      ctx.mailboxes.setNotificationUid(mailbox.mailboxId, 4242);
      ctx.mailboxes.setNotificationPid(mailbox.mailboxId, "proc:legacy-inbox");
      const dmRoute = {
        adapter: "telegram",
        accountId: "managed",
        actorId: "telegram:42",
        // SAFETY: test fixture is constructed with the asserted kernel domain shape.
        surfaceKind: "dm" as const,
        surfaceId: "telegram:42",
        uid: 1000,
      };
      ctx.adapters.surfaceRoutes.setRoute({
        ...dmRoute,
        pid: "proc:work",
        mode: "work",
        updatedByUid: 1000,
      });
      const completion = {
        // SAFETY: test fixture is constructed with the asserted kernel domain shape.
        version: 1 as const,
        intakeId: SENSITIVE_METADATA.intakeId,
        messageId: accepted.messageId,
        summary: {
          summary: "Mike approved the contract.",
          // SAFETY: test fixture is constructed with the asserted kernel domain shape.
          category: "work" as const,
          requiresAttention: true,
          confidence: 0.94,
        },
      };
      await completeManagedInboundMail(completion, ctx);
      await completeManagedInboundMail(completion, ctx);

      const listed = ctx.responsibilities.list({
        ownerUid: 1000,
        includeTerminal: true,
      });
      expect(listed.records).toHaveLength(1);
      expect(listed.records[0]).toMatchObject({
        title: `Review received email ${accepted.messageId}`,
        source: {
          kind: "event",
          eventType: "mail.received",
          eventId: accepted.messageId,
        },
        assignee: { kind: "ship" },
        state: "open",
        priority: "high",
        dedupeKey: `mail.received:${accepted.messageId}`,
        details: {
          eventType: "mail.received",
          messageId: accepted.messageId,
          receivedAt: SENSITIVE_METADATA.receivedAt,
          summary: "Mike approved the contract.",
          category: "work",
          requiresAttention: true,
          confidence: 0.94,
          contentTrust: "untrusted",
        },
      });
      expect(reconcileWake).toHaveBeenCalledOnce();
      expect(reconcileWake).toHaveBeenCalledWith(1000);
      const serializedResponsibility = JSON.stringify(listed.records[0]);
      for (const sentinel of [
        "mailbox:1000:primary",
        "private-envelope@example.com",
        "PRIVATE-DISPLAY-SENTINEL",
        "PRIVATE-SUBJECT-SENTINEL",
        "PRIVATE-RAW-HEADER-SENTINEL",
        "PRIVATE-BODY-SENTINEL",
      ]) {
        expect(serializedResponsibility).not.toContain(sentinel);
      }

      const message = ctx.mailboxes.getMessage(1000, accepted.messageId)!;
      expect(message).toMatchObject({
        mailboxId: "mailbox:1000:primary",
        envelopeFrom: "private-envelope@example.com",
        displayFrom: "PRIVATE-DISPLAY-SENTINEL <private-envelope@example.com>",
        subject: "PRIVATE-SUBJECT-SENTINEL",
        summary: "Mike approved the contract.",
        eventDeliveredAt: expect.any(Number),
      });
      expect(storage.bytes(message.rawPath.slice(1))).toEqual(SENSITIVE_RAW);
      expect(ctx.mailboxes.getMailbox(mailbox.mailboxId)).toMatchObject({
        notificationUid: 4242,
        notificationPid: "proc:legacy-inbox",
      });
      expect(ctx.adapters.surfaceRoutes.resolvePid(dmRoute)).toBe("proc:work");
    });
  });

  it("keeps the responsibility durable when wake scheduling fails", async () => {
    await runWithRealKernelSql(async (sql, kernelStorage) => {
      const ctx = mailboxContext(sql, kernelStorage, new MemoryR2Bucket());
      const accepted = await acceptManagedInboundMail(METADATA, bodyFromBytes(RAW), ctx);
      const completion = {
        // SAFETY: test fixture is constructed with the asserted kernel domain shape.
        version: 1 as const,
        intakeId: METADATA.intakeId,
        messageId: accepted.messageId,
        summary: {
          summary: "Mike approved the contract.",
          // SAFETY: test fixture is constructed with the asserted kernel domain shape.
          category: "work" as const,
          requiresAttention: true,
          confidence: 0.94,
        },
      };
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      ctx.reconcileResponsibilityWake = vi.fn(async () => {
        throw new Error("scheduler unavailable");
      });

      await completeManagedInboundMail(completion, ctx);
      await Promise.resolve();

      expect(ctx.responsibilities.list({ ownerUid: 1000 }).records).toHaveLength(1);
      expect(ctx.mailboxes.getMessage(1000, accepted.messageId)?.eventDeliveredAt)
        .toEqual(expect.any(Number));
      expect(warning).toHaveBeenCalledWith(
        "[Kernel] Failed to schedule received-mail responsibility:",
        expect.objectContaining({ message: "scheduler unavailable" }),
      );
      warning.mockRestore();
    });
  });

  it("stores mail without waking the Ship when incoming-mail responsibilities are disabled", async () => {
    await runWithRealKernelSql(async (sql, kernelStorage) => {
      const ctx = mailboxContext(sql, kernelStorage, new MemoryR2Bucket());
      ctx.responsibilitySources.set(1000, "mail.received", false);
      ctx.reconcileResponsibilityWake = vi.fn(async () => {});
      const accepted = await acceptManagedInboundMail(METADATA, bodyFromBytes(RAW), ctx);

      await completeManagedInboundMail({
        version: 1,
        intakeId: METADATA.intakeId,
        messageId: accepted.messageId,
        summary: {
          summary: "Mike approved the contract.",
          category: "work",
          requiresAttention: true,
          confidence: 0.9,
        },
      }, ctx);

      expect(ctx.mailboxes.getMessage(1000, accepted.messageId)).toMatchObject({
        summary: "Mike approved the contract.",
        eventDeliveredAt: expect.any(Number),
      });
      expect(ctx.responsibilities.list({ ownerUid: 1000 }).records).toEqual([]);
      expect(ctx.reconcileResponsibilityWake).not.toHaveBeenCalled();
    });
  });

  it("derives the production and staging mailbox domains from canonical routing", async () => {
    await runWithRealKernelSql((sql, kernelStorage) => {
      const production = mailboxContext(sql, kernelStorage, new MemoryR2Bucket());
      expect(managedMailAddressForOwner(1000, production)).toBe("hank@gsv.space");

      const staging = {
        ...production,
        installationIdentity: {
          installationId: "installation-1",
          handle: "hank",
          canonicalOrigin: "https://hank.staging.gsv.space",
        },
      };
      expect(managedMailAddressForOwner(1000, staging)).toBe("hank@staging.gsv.space");
      expect(managedMailAddressForOwner(1001, staging)).toBeNull();
    });
  });
});

describe("managed mailbox account removal", () => {
  it("rejects fresh mail for the removed primary owner without reassigning the mailbox, while replay and summaries finish", async () => {
    await withMailboxKernel(async (kernel, root) => {
      const accepted = await kernel.acceptManagedInboundMail(METADATA, bodyFromBytes(RAW));
      const mailbox = kernel.mailboxes.getPrimaryMailbox();
      const writes = vi.spyOn(kernel.bindings.STORAGE, "put");
      const wake = vi.spyOn(kernel.responsibilityRuntime, "reconcileResponsibilityWake");
      await kernel.people.remove(1000, root);
      expect(kernel.auth.isAccountDisabled(1000)).toBe(true);
      const cancelled = vi.fn();
      await expect(kernel.acceptManagedInboundMail({ ...METADATA, intakeId: "fresh-after-removal", digest: `sha256:${"c".repeat(64)}` }, unreadBody(cancelled)))
        .rejects.toThrow("active human account");
      expect(cancelled).toHaveBeenCalledOnce();
      expect(writes).not.toHaveBeenCalled();
      expect(kernel.mailboxes.getIntake("fresh-after-removal")).toBeNull();
      expect(kernel.mailboxes.getPrimaryMailbox()).toEqual(mailbox);
      expect(kernel.mailboxes.getMailboxForOwner(1001)).toBeNull();
      expect(managedMailAddressForOwner(1000, root)).toBe(METADATA.envelope.to);

      for (const intakeId of [METADATA.intakeId, "accepted-digest-retry"]) {
        await expect(kernel.acceptManagedInboundMail({ ...METADATA, intakeId }, bodyFromBytes(RAW))).resolves.toEqual(accepted);
      }
      await expect(kernel.acceptManagedInboundMail({ ...METADATA, intakeId: "wrong-address", envelope: { ...METADATA.envelope, to: "other@gsv.space" } }, bodyFromBytes(RAW)))
        .rejects.toThrow("Mailbox identity conflicts");
      expect(kernel.mailboxes.getIntake("wrong-address")).toBeNull();
      const completion = { version: 1, intakeId: METADATA.intakeId, messageId: accepted.messageId, summary: {
        summary: "Previously accepted email", category: "work", requiresAttention: true, confidence: 0.9,
      } } satisfies Parameters<Kernel["completeManagedInboundMail"]>[0];
      await kernel.completeManagedInboundMail(completion);
      await kernel.completeManagedInboundMail(completion);
      expect(kernel.mailboxes.getMessage(1000, accepted.messageId)).toMatchObject({
        summary: completion.summary.summary, eventDeliveredAt: expect.any(Number),
      });
      expect(kernel.mailboxes.list(1000).count).toBe(1);
      expect(kernel.responsibilities.list({ ownerUid: 1000 }).records).toEqual([]);
      expect(wake).not.toHaveBeenCalled();
      expect(writes).not.toHaveBeenCalled();
    });
  });

  it("excludes removed humans when selecting the first mailbox owner", async () => {
    await withMailboxKernel(async (kernel, root) => {
      await kernel.people.remove(1000, root);
      const accepted = await kernel.acceptManagedInboundMail(METADATA, bodyFromBytes(RAW));
      expect(kernel.mailboxes.getPrimaryMailbox()).toMatchObject({ ownerUid: 1001, mailboxId: "mailbox:1001:primary" });
      expect(kernel.mailboxes.getMessage(1001, accepted.messageId)?.rawPath).toContain("/home/sam/");
      expect(kernel.mailboxes.list(1000).count).toBe(0);
    });
  });

  it("does not create a mailbox or consume the body when no enabled human remains", async () => {
    await withMailboxKernel(async (kernel, root) => {
      await kernel.people.remove(1000, root);
      await kernel.people.remove(1001, root);
      const writes = vi.spyOn(kernel.bindings.STORAGE, "put");
      const cancelled = vi.fn();
      await expect(kernel.acceptManagedInboundMail(METADATA, unreadBody(cancelled))).rejects.toThrow("configured human account");
      expect(kernel.mailboxes.getPrimaryMailbox()).toBeNull();
      expect(writes).not.toHaveBeenCalled();
      expect(cancelled).toHaveBeenCalledOnce();
    });
  });

  it.each([false, true])("rechecks removal after the message hash before storage (existing mailbox: %s)", async (persisted) => {
    await withMailboxKernel(async (kernel, root) => {
      if (persisted) kernel.mailboxes.ensureMailbox("mailbox:1000:primary", 1000, METADATA.envelope.to);
      const before = kernel.mailboxes.getPrimaryMailbox();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const originalHash = stableId.stableOpaqueId;
      const hash = vi.spyOn(stableId, "stableOpaqueId").mockImplementationOnce(async (...args) => {
        entered.resolve(); await release.promise; return originalHash(...args);
      });
      const writes = vi.spyOn(kernel.bindings.STORAGE, "put");
      const cancelled = vi.fn();
      try {
        const pending = kernel.acceptManagedInboundMail(METADATA, unreadBody(cancelled));
        await entered.promise;
        await kernel.people.remove(1000, root);
        release.resolve();
        await expect(pending).rejects.toThrow("active human account");
        expect(kernel.mailboxes.getPrimaryMailbox()).toEqual(before);
        expect(kernel.mailboxes.getIntake(METADATA.intakeId)).toBeNull();
        expect(writes).not.toHaveBeenCalled();
        expect(cancelled).toHaveBeenCalledOnce();
      } finally { release.resolve(); hash.mockRestore(); }
    });
  });

  it("finishes storage admitted before removal and completes its summary without new notification work", async () => {
    await withMailboxKernel(async (kernel, root) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const body: BinaryBody = { length: RAW.byteLength, stream: new ReadableStream<Uint8Array>({
        async pull(controller) { entered.resolve(); await release.promise; controller.enqueue(RAW); controller.close(); },
      }, { highWaterMark: 0 }) };
      const pending = kernel.acceptManagedInboundMail(METADATA, body);
      await entered.promise;
      expect(kernel.mailboxes.getPrimaryMailbox()?.ownerUid).toBe(1000);
      await kernel.people.remove(1000, root);
      release.resolve();
      const accepted = await pending;
      const stored = kernel.mailboxes.getMessage(1000, accepted.messageId)!;
      const raw = await kernel.bindings.STORAGE.get(stored.rawPath.slice(1));
      expect(new Uint8Array(await raw!.arrayBuffer())).toEqual(RAW);
      await kernel.completeManagedInboundMail({ version: 1, intakeId: METADATA.intakeId, messageId: accepted.messageId, summary: {
        summary: "Accepted before removal", category: "work", requiresAttention: true, confidence: 0.9,
      } });
      expect(kernel.mailboxes.getMessage(1000, accepted.messageId)?.eventDeliveredAt).toEqual(expect.any(Number));
      expect(kernel.responsibilities.list({ ownerUid: 1000 }).records).toEqual([]);
    });
  });
});

async function withMailboxKernel(work: (kernel: Kernel, root: KernelContext) => Promise<void>) {
  await runInDurableObject(env.KERNEL.getByName(`inst_mail_${crypto.randomUUID()}`), async (kernel: Kernel) => {
    const password = await hashPassword("mailbox-fixture-password");
    kernel.auth.setShadow(makeShadowEntry("root", password));
    for (const [uid, username] of [[1000, "hank"], [1001, "sam"]] as const) {
      kernel.auth.addUser({ username, uid, gid: uid, gecos: username, home: `/home/${username}`, shell: "/bin/init" });
      kernel.auth.addGroup({ name: username, gid: uid, members: [] });
      kernel.auth.setShadow(makeShadowEntry(username, password));
    }
    const root = kernel.buildKernelContext({ peer: testPeer({
      account: { uid: 0, gid: 0, gids: [0], username: "root", home: "/root", cwd: "/root" }, calls: ["*"],
    }) });
    const gate = vi.spyOn(kernel.onboarding, "managedWorkGate").mockResolvedValue({ allowed: true });
    try { await work(kernel, root); } finally { gate.mockRestore(); }
  });
}

function unreadBody(cancelled: () => void): BinaryBody {
  return { length: RAW.byteLength, stream: new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(RAW); controller.close(); }, cancel: cancelled,
  }, { highWaterMark: 0 }) };
}

function mailboxContext(
  sql: SqlStorage,
  kernelStorage: DurableObjectStorage,
  storage: MemoryR2Bucket,
): KernelContext {
  const humans = [
    { username: "hank", uid: 1000, gid: 1000, gecos: "Hank", home: "/home/hank", shell: "/bin/sh" },
    { username: "sam", uid: 1001, gid: 1001, gecos: "Sam", home: "/home/sam", shell: "/bin/sh" },
  ];
  const auth = {
    getPasswdEntries: () => humans,
    getPasswdByUid: (uid: number) => humans.find((entry) => entry.uid === uid) ?? null,
    getShadowByUsername: (username: string) => ({ username, hash: "password-hash" }),
    isPersonalAgentUid: () => false,
    isAccountDisabled: () => false,
    resolveGids: (_username: string, gid: number) => [gid, 100],
  };
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  return {
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    env: { STORAGE: storage as R2Bucket },
    installationId: "installation-1",
    installationIdentity: {
      installationId: "installation-1",
      handle: "hank",
      canonicalOrigin: "https://hank.gsv.space",
    },
    auth,
    caps: { resolve: () => ["*"] },
    adapters: new AdapterStore(sql),
    mailboxes: new MailboxStore(sql),
    responsibilities: new ResponsibilityStore(kernelStorage),
    responsibilitySources: new ResponsibilitySourcePolicyStore(sql),
    procs: { list: () => [], get: () => null },
    reconcileResponsibilityWake: async () => {},
    defer: (promise) => {
      void promise;
    },
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  } as KernelContext;
}

class MemoryR2Bucket {
  private readonly objects = new Map<string, Uint8Array>();

  async head(key: string): Promise<R2Object | null> {
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    return this.objects.has(key) ? ({} as R2Object) : null;
  }

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
  ): Promise<R2Object> {
    let bytes: Uint8Array;
    if (value instanceof ReadableStream) {
      bytes = new Uint8Array(await new Response(value).arrayBuffer());
    } else if (isString(value)) {
      bytes = new TextEncoder().encode(value);
    } else if (value === null) {
      bytes = new Uint8Array();
    } else if (value instanceof Blob) {
      bytes = new Uint8Array(await value.arrayBuffer());
    } else if (ArrayBuffer.isView(value)) {
      bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
    } else {
      bytes = new Uint8Array(value).slice();
    }
    this.objects.set(key, bytes);
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    return {} as R2Object;
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }

  bytes(key: string): Uint8Array {
    const value = this.objects.get(key);
    if (!value) throw new Error(`Missing object: ${key}`);
    return value;
  }
}
