import { describe, expect, it } from "vitest";
import type { GsvFs } from "../../../fs/gsv-fs";
import type { KernelContext } from "../../../kernel/context";
import { MailboxStore, type RecordMailMessageInput } from "../../../kernel/mailbox-store";
import { runWithRealKernelSql } from "../../../test-support/real-kernel-sql";
import { buildMailCommand } from "./mail";

describe("mail shell command", () => {
  it("lists and reads only the calling human's indexed mail", async () => {
    await runWithRealKernelSql(async (sql) => {
      const mailboxes = new MailboxStore(sql);
      mailboxes.ensureMailbox("mailbox:1000:primary", 1000, "hank@gsv.space");
      mailboxes.ensureMailbox("mailbox:1001:primary", 1001, "sam@gsv.space");
      mailboxes.recordMessage(messageInput());
      mailboxes.recordMessage(messageInput({
        messageId: "mail:bbbbbbbb",
        mailboxId: "mailbox:1001:primary",
        intakeId: "intake-sam",
        digest: `sha256:${"b".repeat(64)}`,
        rawPath: "/home/sam/.gsv/mail/inbox/mail:bbbbbbbb/raw.eml",
        textPath: "/home/sam/.gsv/mail/inbox/mail:bbbbbbbb/message.txt",
      }));
      const fs = {
        readFile: async (path: string) => `contents:${path}`,
      } as GsvFs;
      const ctx = {
        identity: {
          role: "user",
          process: {
            uid: 1000,
            gid: 1000,
            gids: [1000, 100],
            username: "hank",
            home: "/home/hank",
            cwd: "/home/hank",
          },
          capabilities: [],
        },
        mailboxes,
        procs: { getOwnerUid: () => null },
      } as unknown as KernelContext;
      const command = buildMailCommand(fs, ctx);

      const listed = await command.execute(["list"]);
      expect(listed.exitCode).toBe(0);
      expect(listed.stdout).toContain("mail:aaaaaaaa");
      expect(listed.stdout).not.toContain("mail:bbbbbbbb");

      const shown = await command.execute(["show", "mail:aaaa"]);
      expect(shown).toMatchObject({
        exitCode: 0,
        stdout: "contents:/home/hank/.gsv/mail/inbox/mail:aaaaaaaa/message.txt",
      });

      const foreign = await command.execute(["show", "mail:bbbb"]);
      expect(foreign.exitCode).toBe(1);
      expect(foreign.stderr).toContain("message not found");
    });
  });
});

function messageInput(
  overrides: Partial<RecordMailMessageInput> = {},
): RecordMailMessageInput {
  return {
    messageId: "mail:aaaaaaaa",
    mailboxId: "mailbox:1000:primary",
    intakeId: "intake-hank",
    digest: `sha256:${"a".repeat(64)}`,
    envelopeFrom: "mike@example.com",
    envelopeTo: "hank@gsv.space",
    headerMessageId: null,
    displayFrom: "Mike",
    to: ["hank@gsv.space"],
    cc: [],
    replyTo: ["mike@example.com"],
    subject: "Hello",
    sentAt: null,
    receivedAt: 1_700_000_000_000,
    rawPath: "/home/hank/.gsv/mail/inbox/mail:aaaaaaaa/raw.eml",
    textPath: "/home/hank/.gsv/mail/inbox/mail:aaaaaaaa/message.txt",
    sizeBytes: 100,
    attachments: [],
    ...overrides,
  };
}
