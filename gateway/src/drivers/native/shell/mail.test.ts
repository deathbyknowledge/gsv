import type {
  MailSendArgs,
  MailSendResult,
  MailStatusResult,
} from "@humansandmachines/gsv/protocol";
import type { CommandContext } from "just-bash";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GsvFs } from "../../../fs/gsv-fs";
import type { KernelContext } from "../../../kernel/context";
import { MailboxStore, type RecordMailMessageInput } from "../../../kernel/mailbox-store";
import { runWithRealKernelSql } from "../../../test-support/real-kernel-sql";
import { buildMailCommand } from "./mail";

const handleMailSend = vi.hoisted(() => vi.fn());
const handleMailStatus = vi.hoisted(() => vi.fn());

vi.mock("../../../kernel/outbound-mail", () => ({
  handleMailSend,
}));

vi.mock("../../../kernel/outbound-status", () => ({
  handleMailStatus,
}));

describe("mail shell command", () => {
  beforeEach(() => {
    handleMailSend.mockReset();
    handleMailStatus.mockReset();
  });

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

  it("sends new mail and replies with deterministic per-frame delivery ids", async () => {
    const fs = {
      stat: vi.fn(async () => ({
        isFile: true,
        isDirectory: false,
        size: 19,
      })),
      readFile: vi.fn(async (path: string) => (
        path === "/draft.txt" ? "Reply from a file.\n" : `contents:${path}`
      )),
    } as unknown as GsvFs;
    const ctx = commandContext("shell-frame-7");
    handleMailSend.mockImplementation(async (input: MailSendArgs): Promise<MailSendResult> => ({
      ok: true,
      deliveryId: input.deliveryId!,
      outboundId: `outbound:${input.deliveryId}`,
      state: "queued",
      from: "hank@gsv.space",
      to: input.to ?? "mike@example.com",
      subject: input.subject ?? "Re: Hello",
      replayed: false,
    }));
    const command = buildMailCommand(fs, ctx);

    const sent = await command.execute([
      "send",
      "--to",
      "mike@example.com",
      "--subject",
      "Hello",
      "--message",
      "Checking in.",
    ], shellCommandContext());
    const replied = await command.execute([
      "reply",
      "mail:aaaaaaaa",
      "--body",
      "/draft.txt",
    ], shellCommandContext());

    expect(handleMailSend).toHaveBeenNthCalledWith(1, {
      text: "Checking in.",
      to: "mike@example.com",
      subject: "Hello",
      deliveryId: "shell-frame-7:mail:1",
    }, ctx);
    expect(handleMailSend).toHaveBeenNthCalledWith(2, {
      text: "Reply from a file.\n",
      replyToMessageId: "mail:aaaaaaaa",
      deliveryId: "shell-frame-7:mail:2",
    }, ctx);
    expect(fs.readFile).toHaveBeenCalledWith("/draft.txt");
    expect(sent).toMatchObject({ exitCode: 0 });
    expect(sent.stdout).toContain("state=queued");
    expect(sent.stdout).toContain("delivery_id=shell-frame-7:mail:1");
    expect(replied.stdout).toContain("delivery_id=shell-frame-7:mail:2");
  });

  it("preserves explicit delivery ids while ordinals track every outbound command", async () => {
    const fs = {} as GsvFs;
    const ctx = commandContext("shell-frame-explicit");
    handleMailSend.mockImplementation(async (input: MailSendArgs): Promise<MailSendResult> => ({
      ok: true,
      deliveryId: input.deliveryId!,
      outboundId: `outbound:${input.deliveryId}`,
      state: "queued",
      from: "hank@gsv.space",
      to: input.to!,
      subject: input.subject!,
      replayed: false,
    }));
    const command = buildMailCommand(fs, ctx);

    await command.execute([
      "send",
      "--to",
      "one@example.com",
      "--subject",
      "One",
      "--message",
      "First",
      "--delivery-id",
      "explicit-1",
    ], shellCommandContext());
    await command.execute([
      "send",
      "--to",
      "two@example.com",
      "--subject",
      "Two",
      "--message",
      "Second",
    ], shellCommandContext());

    expect(handleMailSend.mock.calls[0][0].deliveryId).toBe("explicit-1");
    expect(handleMailSend.mock.calls[1][0].deliveryId).toBe(
      "shell-frame-explicit:mail:2",
    );
  });

  it("requires an outer request id for an implicit delivery id", async () => {
    const command = buildMailCommand({} as GsvFs, commandContext());

    const result = await command.execute([
      "send",
      "--to",
      "mike@example.com",
      "--subject",
      "Hello",
      "--message",
      "Checking in.",
    ], shellCommandContext());

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("outer request id or --delivery-id");
    expect(handleMailSend).not.toHaveBeenCalled();
  });

  it("reads and formats an exact outbound delivery status", async () => {
    const ctx = commandContext("shell-status-1");
    handleMailStatus.mockReturnValue({
      outbound: {
        deliveryId: "delivery-1",
        outboundId: "mail-outbound:1",
        state: "accepted",
        from: "hank@gsv.space",
        to: "mike@example.com",
        subject: "Hello\nthere",
        providerMessageId: "provider-1",
        createdAt: Date.parse("2026-08-13T12:00:00.000Z"),
        queuedAt: Date.parse("2026-08-13T12:00:01.000Z"),
        completedAt: Date.parse("2026-08-13T12:00:02.000Z"),
      },
    } satisfies MailStatusResult);
    const command = buildMailCommand({} as GsvFs, ctx);

    const result = await command.execute(["status", "delivery-1"]);

    expect(handleMailStatus).toHaveBeenCalledWith({ deliveryId: "delivery-1" }, ctx);
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("state=accepted");
    expect(result.stdout).toContain("subject=Hello there");
    expect(result.stdout).toContain("provider_message_id=provider-1");
    expect(result.stdout).toContain("created_at=2026-08-13T12:00:00.000Z");
    expect(result.stdout).toContain("queued_at=2026-08-13T12:00:01.000Z");
    expect(result.stdout).toContain("completed_at=2026-08-13T12:00:02.000Z");
  });

  it("reports missing outbound delivery status without disclosing ownership", async () => {
    handleMailStatus.mockReturnValue({ outbound: null } satisfies MailStatusResult);
    const command = buildMailCommand({} as GsvFs, commandContext("shell-status-missing"));

    const result = await command.execute(["status", "missing-or-foreign"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("outbound delivery not found");
  });

  it("requires mail.status capability before reading delivery status", async () => {
    const command = buildMailCommand(
      {} as GsvFs,
      commandContext("shell-status-denied", ["shell.exec", "mail.send"]),
    );

    const result = await command.execute(["status", "delivery-1"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Permission denied: mail.status");
    expect(handleMailStatus).not.toHaveBeenCalled();
  });

  it("requires mail.send capability before sending", async () => {
    const command = buildMailCommand(
      {} as GsvFs,
      commandContext("shell-frame-denied", ["shell.exec"]),
    );

    const result = await command.execute([
      "send",
      "--to",
      "mike@example.com",
      "--subject",
      "Hello",
      "--message",
      "Checking in.",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Permission denied: mail.send");
    expect(handleMailSend).not.toHaveBeenCalled();
  });

  it("rejects oversized body files before reading them", async () => {
    const fs = {
      stat: vi.fn(async () => ({
        isFile: true,
        isDirectory: false,
        size: 1024 * 1024 + 1,
      })),
      readFile: vi.fn(),
    } as unknown as GsvFs;
    const command = buildMailCommand(fs, commandContext("shell-frame-large"));

    const result = await command.execute([
      "send",
      "--to",
      "mike@example.com",
      "--subject",
      "Hello",
      "--body",
      "/large.txt",
    ], shellCommandContext());

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("mail body exceeds 1048576 bytes");
    expect(fs.stat).toHaveBeenCalledWith("/large.txt");
    expect(fs.readFile).not.toHaveBeenCalled();
    expect(handleMailSend).not.toHaveBeenCalled();
  });

  it("stops a cancelled shell invocation before sending", async () => {
    const controller = new AbortController();
    controller.abort(new Error("shell request cancelled"));
    const command = buildMailCommand(
      {} as GsvFs,
      commandContext("shell-frame-cancelled"),
    );

    const result = await command.execute([
      "send",
      "--to",
      "mike@example.com",
      "--subject",
      "Hello",
      "--message",
      "Checking in.",
    ], shellCommandContext(controller.signal));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("shell request cancelled");
    expect(handleMailSend).not.toHaveBeenCalled();
  });

  it("reports retryable send failures with the reusable delivery id", async () => {
    const ctx = commandContext("shell-frame-retry");
    handleMailSend.mockResolvedValue({
      ok: false,
      error: "mail queue is unavailable",
      retryable: true,
    } satisfies MailSendResult);
    const command = buildMailCommand({} as GsvFs, ctx);

    const result = await command.execute([
      "reply",
      "mail:aaaaaaaa",
      "--subject",
      "Re: Hello",
      "--message",
      "Trying again.",
    ], shellCommandContext());

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("delivery_id=shell-frame-retry:mail:1");
    expect(result.stderr).toContain("retry with --delivery-id");
  });

  it("rejects ambiguous compose input before calling the Kernel", async () => {
    const command = buildMailCommand({} as GsvFs, commandContext("shell-frame-invalid"));

    const result = await command.execute([
      "send",
      "--to",
      "mike@example.com",
      "--subject",
      "Hello",
      "--message",
      "inline",
      "--body",
      "/draft.txt",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("mutually exclusive");
    expect(handleMailSend).not.toHaveBeenCalled();
  });
});

function commandContext(
  requestId?: string,
  capabilities = ["shell.exec", "mail.send", "mail.status"],
): KernelContext {
  return {
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
      capabilities,
    },
    ...(requestId ? { requestId } : {}),
    procs: { getOwnerUid: () => null },
  } as unknown as KernelContext;
}

function shellCommandContext(signal?: AbortSignal): CommandContext {
  return {
    cwd: "/",
    env: new Map(),
    stdin: "",
    fs: {
      resolvePath: (_cwd: string, path: string) => path,
    },
    ...(signal ? { signal } : {}),
  } as unknown as CommandContext;
}

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
