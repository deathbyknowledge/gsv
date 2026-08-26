import type {
  MailSendArgs,
  MailSendResult,
  MailStatusResult,
  ProcessIdentity,
} from "@humansandmachines/gsv/protocol";
import { env } from "cloudflare:test";
import type { CommandContext } from "just-bash";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAccountHomeBackend } from "../../../fs/backends/account-home";
import { GsvFs } from "../../../fs/gsv-fs";
import type { KernelContext } from "../../../kernel/context";
import { MailboxStore, type RecordMailMessageInput } from "../../../kernel/mailbox-store";
import { runWithRealKernelSql } from "../../../test-support/real-kernel-sql";
import { buildMailCommand } from "./mail";
import * as outboundMail from "../../../kernel/outbound-mail";
import * as outboundStatus from "../../../kernel/outbound-status";

const handleMailSend = vi.spyOn(outboundMail, "handleMailSend");
const handleMailStatus = vi.spyOn(outboundStatus, "handleMailStatus");

function emptyFs(): GsvFs {
  // SAFETY: these command tests exercise argument and capability handling before filesystem access.
  return {} as GsvFs;
}

describe("mail shell command", () => {
  beforeEach(() => {
    handleMailSend.mockReset();
    handleMailStatus.mockReset();
  });

  it("lists and reads only the calling human's indexed mail", async () => {
    await runWithRealKernelSql(async (sql) => {
      const hankMessageId = `mail:${"a".repeat(64)}`;
      const samMessageId = `mail:${"b".repeat(64)}`;
      const hankRawPath = `/home/hank/.gsv/mail/inbox/${hankMessageId}/raw.eml`;
      const hankTextPath = `/home/hank/.gsv/mail/inbox/${hankMessageId}/message.txt`;
      const mailboxes = new MailboxStore(sql);
      mailboxes.ensureMailbox("mailbox:1000:primary", 1000, "hank@gsv.space");
      mailboxes.ensureMailbox("mailbox:1001:primary", 1001, "sam@gsv.space");
      mailboxes.recordMessage(messageInput({
        messageId: hankMessageId,
        rawPath: hankRawPath,
        textPath: hankTextPath,
      }));
      mailboxes.recordMessage(messageInput({
        messageId: samMessageId,
        mailboxId: "mailbox:1001:primary",
        intakeId: "intake-sam",
        digest: `sha256:${"b".repeat(64)}`,
        rawPath: `/home/sam/.gsv/mail/inbox/${samMessageId}/raw.eml`,
        textPath: `/home/sam/.gsv/mail/inbox/${samMessageId}/message.txt`,
      }));
      const ownerOnlyMetadata = {
        uid: "1000",
        gid: "1000",
        mode: "600",
      };
      await Promise.all([
        env.STORAGE.put(hankRawPath.slice(1), "raw contents", {
          customMetadata: ownerOnlyMetadata,
        }),
        env.STORAGE.put(hankTextPath.slice(1), "text contents", {
          customMetadata: ownerOnlyMetadata,
        }),
      ]);
      const humans = [
        {
          username: "hank",
          uid: 1000,
          gid: 1000,
          home: "/home/hank",
        },
        {
          username: "sam",
          uid: 1001,
          gid: 1001,
          home: "/home/sam",
        },
      ];
      const personalAgent: ProcessIdentity = {
        uid: 2000,
        gid: 2000,
        gids: [2000, 100],
        username: "hank-agent",
        home: "/home/hank-agent",
        cwd: "/home/hank-agent",
      };
      const auth = {
        getPasswdEntries: () => humans,
        getPasswdByUid: (uid: number) => (
          humans.find((entry) => entry.uid === uid) ?? null
        ),
        getPasswdByUsername: (username: string) => (
          humans.find((entry) => entry.username === username) ?? null
        ),
        getPersonalAgentUid: (uid: number) => uid === 1000 ? personalAgent.uid : null,
        isPersonalAgentUid: (uid: number) => uid === personalAgent.uid,
        getGroupByGid: (gid: number) => {
          const entry = humans.find((candidate) => candidate.gid === gid);
          return entry
            ? { name: entry.username, gid, members: [] }
            : null;
        },
        resolveGids: (_username: string, gid: number) => [gid, 100],
      };
      const accountHomes = createAccountHomeBackend(
        env.STORAGE,
        { fetch: async () => new Response("not found", { status: 404 }) },
        personalAgent,
        {
          // SAFETY: this fixture implements the auth methods used by AccountHomeBackend.
          auth: auth as never,
          ownerUid: 1000,
          isRoot: false,
        },
      );
      const fs = new GsvFs(
        env.STORAGE,
        personalAgent,
        undefined,
        undefined,
        null,
        accountHomes,
      );
      const readFile = vi.spyOn(fs, "readFile");
      // SAFETY: this fixture supplies the KernelContext fields used by the command.
      const ctx = {
        env: { STORAGE: env.STORAGE },
        identity: {
          role: "user",
          process: personalAgent,
          capabilities: [],
        },
        processId: "proc:hank-agent",
        auth,
        mailboxes,
        procs: { getOwnerUid: () => 1000 },
      // SAFETY: this fixture supplies the KernelContext fields used by the command.
      } as KernelContext;
      const command = buildMailCommand(fs, ctx);

      const listed = await command.execute(["list"]);
      expect(listed.exitCode).toBe(0);
      expect(listed.stdout).toContain(hankMessageId);
      expect(listed.stdout).not.toContain(samMessageId);

      const shown = await command.execute(["show", "mail:aaaa"]);
      expect(shown.stderr).toBe("");
      expect(shown).toMatchObject({
        exitCode: 0,
        stdout: "text contents",
      });
      const raw = await command.execute(["show", hankMessageId, "--raw"]);
      expect(raw).toMatchObject({ exitCode: 0, stdout: "raw contents" });
      expect(readFile).toHaveBeenNthCalledWith(1, hankTextPath);
      expect(readFile).toHaveBeenNthCalledWith(2, hankRawPath);

      const foreign = await command.execute(["show", "mail:bbbb"]);
      expect(foreign.exitCode).toBe(1);
      expect(foreign.stderr).toContain("message not found");

      const mistyped = await command.execute(["show", `ail:${"a".repeat(64)}`]);
      expect(mistyped.exitCode).toBe(1);
      expect(mistyped.stderr).toContain("message not found");
      expect(readFile).toHaveBeenCalledTimes(2);
    });
  });

  it("sends new mail and replies with deterministic per-frame delivery ids", async () => {
    // SAFETY: this fixture supplies the filesystem methods used by the command.
    const fs = {
      stat: vi.fn(async () => ({
        isFile: true,
        isDirectory: false,
        size: 19,
      })),
      readFile: vi.fn(async (path: string) => (
        path === "/draft.txt" ? "Reply from a file.\n" : `contents:${path}`
      )),
    // SAFETY: this fixture supplies the filesystem methods used by the command.
    } as GsvFs;
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
    const fs = emptyFs();
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
    const command = buildMailCommand(emptyFs(), commandContext());

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
    const command = buildMailCommand(emptyFs(), ctx);

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
    const command = buildMailCommand(emptyFs(), commandContext("shell-status-missing"));

    const result = await command.execute(["status", "missing-or-foreign"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("outbound delivery not found");
  });

  it("requires mail.status capability before reading delivery status", async () => {
    const command = buildMailCommand(
      emptyFs(),
      commandContext("shell-status-denied", ["shell.exec", "mail.send"]),
    );

    const result = await command.execute(["status", "delivery-1"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Permission denied: mail.status");
    expect(handleMailStatus).not.toHaveBeenCalled();
  });

  it("requires mail.send capability before sending", async () => {
    const command = buildMailCommand(
      emptyFs(),
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
    // SAFETY: this fixture supplies the filesystem methods used by the command.
    const fs = {
      stat: vi.fn(async () => ({
        isFile: true,
        isDirectory: false,
        size: 1024 * 1024 + 1,
      })),
      readFile: vi.fn(),
    // SAFETY: this fixture supplies the filesystem methods used by the command.
    } as GsvFs;
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
      emptyFs(),
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
    const command = buildMailCommand(emptyFs(), ctx);

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
    const command = buildMailCommand(emptyFs(), commandContext("shell-frame-invalid"));

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
  // SAFETY: this fixture supplies the KernelContext fields used by mail commands.
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
    requestId,
    procs: { getOwnerUid: () => null },
  } as KernelContext;
}

function shellCommandContext(signal?: AbortSignal): CommandContext {
  // SAFETY: this fixture supplies the CommandContext fields used by mail commands.
  return {
    cwd: "/",
    env: new Map(),
    stdin: "",
    fs: {
      resolvePath: (_cwd: string, path: string) => path,
    },
    signal,
  } as CommandContext;
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
