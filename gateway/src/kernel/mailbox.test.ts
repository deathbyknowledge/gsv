import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared/utils", () => ({
  sendFrameToProcess: vi.fn(),
}));

import { bodyFromBytes } from "@humansandmachines/gsv/protocol";
import { sendFrameToProcess } from "../shared/utils";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import type { KernelContext } from "./context";
import { MailboxStore } from "./mailbox-store";
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

const sendFrameToProcessMock = vi.mocked(sendFrameToProcess);

describe("managed Kernel mailbox", () => {
  beforeEach(() => {
    sendFrameToProcessMock.mockReset();
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

  it("records one summary and idempotently delivers a typed Inbox event", async () => {
    await runWithRealKernelSql(async (sql) => {
      const ctx = mailboxContext(sql, new MemoryR2Bucket());
      const accepted = await acceptManagedInboundMail(METADATA, bodyFromBytes(RAW), ctx);
      sendFrameToProcessMock.mockImplementation(async (_installationId, _pid, frame) => ({
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
        version: 1 as const,
        intakeId: METADATA.intakeId,
        messageId: accepted.messageId,
        summary: {
          summary: "Mike approved the contract.",
          category: "work" as const,
          requiresAttention: true,
          confidence: 0.94,
        },
      };
      await completeManagedInboundMail(completion, ctx);
      await completeManagedInboundMail(completion, ctx);

      expect(ctx.ensureMailboxNotificationProcess).toHaveBeenCalledOnce();
      expect(sendFrameToProcessMock).toHaveBeenCalledOnce();
      expect(sendFrameToProcessMock).toHaveBeenCalledWith(
        "installation-1",
        "proc:inbox",
        expect.objectContaining({
          call: "proc.runtime.event.deliver",
          args: {
            event: expect.objectContaining({
              type: "mail.received",
              messageId: accepted.messageId,
              summary: "Mike approved the contract.",
              envelopeFrom: "mike@example.com",
            }),
          },
        }),
      );
      expect(ctx.mailboxes.getMessage(1000, accepted.messageId)).toMatchObject({
        summary: "Mike approved the contract.",
        eventDeliveredAt: expect.any(Number),
      });
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
  return {
    env: { STORAGE: storage as unknown as R2Bucket },
    installationId: "installation-1",
    installationIdentity: {
      installationId: "installation-1",
      handle: "hank",
      canonicalOrigin: "https://hank.gsv.space",
    },
    auth,
    caps: { resolve: () => ["*"] },
    mailboxes: new MailboxStore(sql),
    procs: { list: () => [], get: () => null },
    ensureMailboxNotificationProcess: vi.fn(async () => "proc:inbox"),
  } as unknown as KernelContext;
}

class MemoryR2Bucket {
  private readonly objects = new Map<string, Uint8Array>();

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
  ): Promise<R2Object> {
    let bytes: Uint8Array;
    if (value instanceof ReadableStream) {
      bytes = new Uint8Array(await new Response(value).arrayBuffer());
    } else if (typeof value === "string") {
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
