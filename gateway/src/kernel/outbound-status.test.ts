import type {
  MailStatusArgs,
  ManagedOutboundMailCompletion,
} from "@humansandmachines/gsv/protocol";
import { describe, expect, it } from "vitest";
import type { RequestFrame } from "../protocol/frames";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { dispatch, type DispatchDeps } from "./dispatch";
import type { KernelContext } from "./context";
import { MailboxStore, type RecordMailOutboundInput } from "./mailbox-store";
import { handleMailStatus } from "./outbound-status";

describe("managed outbound mail status", () => {
  it("returns staging and terminal state without exposing internal delivery fields", async () => {
    await runWithRealKernelSql((sql) => {
      const mailboxes = new MailboxStore(sql);
      const staging = recordOutbound(mailboxes, outboundInput());
      const ctx = statusContext(mailboxes, 1000);

      expect(handleMailStatus({ deliveryId: " delivery-1 " }, ctx)).toEqual({
        outbound: {
          deliveryId: "delivery-1",
          outboundId: "mail-outbound:1",
          state: "staging",
          from: "hank@gsv.space",
          to: "mike@example.com",
          subject: "Hello",
          createdAt: staging.createdAt,
          queuedAt: null,
          completedAt: null,
        },
      });

      mailboxes.markOutboundQueued(staging.outboundId, staging.fingerprint);
      const accepted = completeOutbound(mailboxes, staging, {
        state: "accepted",
        providerMessageId: "provider-message-1",
      });

      expect(handleMailStatus({ deliveryId: "delivery-1" }, ctx)).toEqual({
        outbound: {
          deliveryId: "delivery-1",
          outboundId: "mail-outbound:1",
          state: "accepted",
          from: "hank@gsv.space",
          to: "mike@example.com",
          subject: "Hello",
          createdAt: accepted.createdAt,
          queuedAt: accepted.queuedAt,
          completedAt: accepted.completedAt,
          providerMessageId: "provider-message-1",
        },
      });
    });
  });

  it.each(["failed", "unknown"] as const)(
    "reports %s completion errors",
    async (state) => {
      await runWithRealKernelSql((sql) => {
        const mailboxes = new MailboxStore(sql);
        const queued = recordOutbound(mailboxes, outboundInput({
          outboundId: `mail-outbound:${state}`,
          deliveryId: `delivery-${state}`,
        }));
        mailboxes.markOutboundQueued(queued.outboundId, queued.fingerprint);
        completeOutbound(mailboxes, queued, {
          state,
          errorCode: `${state}_error`,
        });

        expect(handleMailStatus({ deliveryId: `delivery-${state}` }, statusContext(
          mailboxes,
          1000,
        )).outbound).toMatchObject({
          state,
          errorCode: `${state}_error`,
        });
      });
    },
  );

  it("returns the same missing result for unknown and foreign-owned delivery ids", async () => {
    await runWithRealKernelSql((sql) => {
      const mailboxes = new MailboxStore(sql);
      recordOutbound(mailboxes, outboundInput());

      expect(handleMailStatus(
        { deliveryId: "missing" },
        statusContext(mailboxes, 1000),
      )).toEqual({ outbound: null });
      expect(handleMailStatus(
        { deliveryId: "delivery-1" },
        statusContext(mailboxes, 1001),
      )).toEqual({ outbound: null });
    });
  });

  it("uses the calling process owner and does not require managed Queue bindings", async () => {
    await runWithRealKernelSql((sql) => {
      const mailboxes = new MailboxStore(sql);
      recordOutbound(mailboxes, outboundInput());
      const ctx = statusContext(mailboxes, 2000, {
        processId: "agent:2000",
        ownerUid: 1000,
      });

      expect(ctx.env).toEqual({});
      expect(handleMailStatus({ deliveryId: "delivery-1" }, ctx).outbound).toMatchObject({
        deliveryId: "delivery-1",
        state: "staging",
      });
    });
  });

  it.each([
    null,
    {},
    { deliveryId: "" },
    { deliveryId: "   " },
    { deliveryId: `delivery-${"a".repeat(257)}` },
    { deliveryId: "delivery\n1" },
  ])("rejects malformed delivery ids", async (value) => {
    await runWithRealKernelSql((sql) => {
      expect(() => handleMailStatus(
        value as MailStatusArgs,
        statusContext(new MailboxStore(sql), 1000),
      )).toThrow(/mail\.status requires|deliveryId/);
    });
  });

  it("dispatches the owner-scoped status syscall", async () => {
    await runWithRealKernelSql(async (sql) => {
      const mailboxes = new MailboxStore(sql);
      recordOutbound(mailboxes, outboundInput());
      const result = await dispatch(
        {
          type: "req",
          id: "status-request-1",
          call: "mail.status",
          args: { deliveryId: "delivery-1" },
        } as RequestFrame<"mail.status">,
        { type: "connection", id: "connection-1" },
        statusContext(mailboxes, 1000),
        {} as DispatchDeps,
      );

      expect(result).toEqual({
        handled: true,
        response: {
          type: "res",
          id: "status-request-1",
          ok: true,
          data: {
            outbound: expect.objectContaining({
              deliveryId: "delivery-1",
              state: "staging",
            }),
          },
        },
      });
    });
  });
});

function statusContext(
  mailboxes: MailboxStore,
  uid: number,
  process?: { processId: string; ownerUid: number },
): KernelContext {
  return {
    env: {},
    identity: {
      role: "user",
      process: {
        uid,
        gid: uid,
        gids: [uid, 100],
        username: `user-${uid}`,
        home: `/home/user-${uid}`,
        cwd: `/home/user-${uid}`,
      },
      capabilities: ["mail.status"],
    },
    mailboxes,
    ...(process ? { processId: process.processId } : {}),
    procs: {
      getOwnerUid: (processId: string) => (
        process && processId === process.processId ? process.ownerUid : null
      ),
    },
  } as unknown as KernelContext;
}

function outboundInput(
  overrides: Partial<RecordMailOutboundInput> = {},
): RecordMailOutboundInput {
  return {
    version: 1,
    outboundId: "mail-outbound:1",
    ownerUid: 1000,
    deliveryId: "delivery-1",
    fingerprint: `sha256:${"a".repeat(64)}`,
    from: "hank@gsv.space",
    to: "mike@example.com",
    subject: "Hello",
    bodyDigest: `sha256:${"b".repeat(64)}`,
    bodyPath: "/home/hank/.gsv/mail/outbox/mail-outbound:1/message.txt",
    textSize: 5,
    createdAt: 1_800_000_000_000,
    ...overrides,
  };
}

function recordOutbound(
  mailboxes: MailboxStore,
  input: RecordMailOutboundInput,
) {
  return mailboxes.ensureOutbound(input).outbound;
}

function completeOutbound(
  mailboxes: MailboxStore,
  outbound: ReturnType<typeof recordOutbound>,
  completion: Pick<ManagedOutboundMailCompletion, "state" | "providerMessageId" | "errorCode">,
) {
  return mailboxes.completeOutbound({
    version: 1,
    outboundId: outbound.outboundId,
    fingerprint: outbound.fingerprint,
    state: completion.state,
    ...(completion.providerMessageId
      ? { providerMessageId: completion.providerMessageId }
      : {}),
    ...(completion.errorCode ? { errorCode: completion.errorCode } : {}),
  });
}
