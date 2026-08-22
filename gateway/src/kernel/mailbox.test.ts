function isString<T>(value: T): value is T & string { return String(value) === value; }

import { beforeEach, describe, expect, it, vi } from "vitest";

import { bodyFromBytes } from "@humansandmachines/gsv/protocol";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { AdapterStore } from "./adapter-store";
import type { KernelContext } from "./context";
import { MailboxStore } from "./mailbox-store";
import {
  acceptManagedInboundMail,
  completeManagedInboundMail,
  managedMailAddressForOwner,
  type MailboxNotificationDependencies,
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

const ensurePersonalControllerMock = vi.fn<
  MailboxNotificationDependencies["ensurePersonalController"]
>();
const sendRuntimeEventMock = vi.fn<
  MailboxNotificationDependencies["sendRuntimeEvent"]
>();
const notificationDependencies: MailboxNotificationDependencies = {
  ensurePersonalController: ensurePersonalControllerMock,
  sendRuntimeEvent: sendRuntimeEventMock,
};

describe("managed Kernel mailbox", () => {
  beforeEach(() => {
    sendRuntimeEventMock.mockReset();
    ensurePersonalControllerMock.mockReset();
    ensurePersonalControllerMock.mockResolvedValue("proc:personal");
  });

  it("stores exact mail under the primary human and aliases exact-byte retries", async () => {
    await runWithRealKernelSql(async (sql) => {
      const storage = new MemoryR2Bucket();
      const ctx = mailboxContext(sql, storage);

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

  it("routes one reduced event to Personal even while a DM points to Work", async () => {
    await runWithRealKernelSql(async (sql) => {
      const storage = new MemoryR2Bucket();
      const ctx = mailboxContext(sql, storage);
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
      sendRuntimeEventMock.mockImplementation(async (_installationId, _pid, frame) => ({
        type: "res",
        id: frame.id,
        ok: true,
        data: {
          eventId: accepted.messageId,
          runId: "runtime-event-run:1",
          queued: false,
        },
      }));

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
      await completeManagedInboundMail(completion, ctx, notificationDependencies);
      await completeManagedInboundMail(completion, ctx, notificationDependencies);

      expect(ensurePersonalControllerMock).toHaveBeenCalledOnce();
      expect(ensurePersonalControllerMock).toHaveBeenCalledWith(1000, ctx);
      expect(sendRuntimeEventMock).toHaveBeenCalledOnce();
      expect(sendRuntimeEventMock).toHaveBeenCalledWith(
        "installation-1",
        "proc:personal",
        expect.objectContaining({
          call: "proc.runtime.event.deliver",
          args: {
            eventId: accepted.messageId,
            event: {
              type: "mail.received",
              messageId: accepted.messageId,
              receivedAt: SENSITIVE_METADATA.receivedAt,
              summary: "Mike approved the contract.",
              category: "work",
              requiresAttention: true,
              confidence: 0.94,
            },
          },
        }),
      );
      const deliveredFrame = sendRuntimeEventMock.mock.calls[0]![2];
      expect(deliveredFrame.args.event).not.toHaveProperty("eventId");
      const serializedFrame = JSON.stringify(deliveredFrame);
      for (const sentinel of [
        "mailbox:1000:primary",
        "private-envelope@example.com",
        "PRIVATE-DISPLAY-SENTINEL",
        "PRIVATE-SUBJECT-SENTINEL",
        "PRIVATE-RAW-HEADER-SENTINEL",
        "PRIVATE-BODY-SENTINEL",
      ]) {
        expect(serializedFrame).not.toContain(sentinel);
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

  it("retries Personal delivery with the same event id after a transient failure", async () => {
    await runWithRealKernelSql(async (sql) => {
      const ctx = mailboxContext(sql, new MemoryR2Bucket());
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
      sendRuntimeEventMock
        .mockResolvedValueOnce(null)
        .mockImplementationOnce(async (_installationId, _pid, frame) => ({
          type: "res",
          id: frame.id,
          ok: true,
          data: {
            eventId: accepted.messageId,
            runId: "runtime-event-run:retry",
            queued: false,
          },
        }));

      await expect(completeManagedInboundMail(completion, ctx, notificationDependencies))
        .rejects.toThrow("Personal intelligence returned no valid response");
      expect(ctx.mailboxes.getMessage(1000, accepted.messageId)?.eventDeliveredAt).toBeNull();

      await completeManagedInboundMail(completion, ctx, notificationDependencies);

      expect(sendRuntimeEventMock).toHaveBeenCalledTimes(2);
      expect(sendRuntimeEventMock.mock.calls.map((call) => call[2].args.eventId))
        .toEqual([accepted.messageId, accepted.messageId]);
      expect(ctx.mailboxes.getMessage(1000, accepted.messageId)?.eventDeliveredAt)
        .toEqual(expect.any(Number));
    });
  });

  it("derives the production and staging mailbox domains from canonical routing", async () => {
    await runWithRealKernelSql((sql) => {
      const production = mailboxContext(sql, new MemoryR2Bucket());
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

function mailboxContext(sql: SqlStorage, storage: MemoryR2Bucket): KernelContext {
  const humans = [
    { username: "hank", uid: 1000, gid: 1000, gecos: "Hank", home: "/home/hank", shell: "/bin/sh" },
    { username: "sam", uid: 1001, gid: 1001, gecos: "Sam", home: "/home/sam", shell: "/bin/sh" },
  ];
  const auth = {
    getPasswdEntries: () => humans,
    getPasswdByUid: (uid: number) => humans.find((entry) => entry.uid === uid) ?? null,
    getShadowByUsername: (username: string) => ({ username, hash: "password-hash" }),
    isPersonalAgentUid: () => false,
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
    procs: { list: () => [], get: () => null },
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
