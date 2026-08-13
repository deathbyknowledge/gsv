import { defineCommand } from "just-bash";
import type { ExecResult } from "just-bash";
import type { GsvFs } from "../../../fs/gsv-fs";
import type { KernelContext } from "../../../kernel/context";
import { resolveCallerOwnerUid } from "../../../kernel/context";
import { managedMailAddressForOwner } from "../../../kernel/mailbox";
import type { MailMessageRecord } from "../../../kernel/mailbox-store";

const MAIL_USAGE = `Usage:
  mail address
  mail list [--limit N] [--offset N]
  mail search <query> [--limit N] [--offset N]
  mail show <message-id> [--raw]
`;

export function buildMailCommand(fs: GsvFs, ctx: KernelContext) {
  return defineCommand("mail", async (args): Promise<ExecResult> => {
    try {
      return await runMailCommand(args, fs, ctx);
    } catch (error) {
      return failed(error);
    }
  });
}

async function runMailCommand(
  args: string[],
  fs: GsvFs,
  ctx: KernelContext,
): Promise<ExecResult> {
  const [subcommand = "help", ...rest] = args;
  const ownerUid = resolveCallerOwnerUid(ctx);
  switch (subcommand) {
    case "help":
    case "--help":
    case "-h":
      return completed(MAIL_USAGE);
    case "address": {
      if (rest.length > 0) throw new Error(`unexpected argument: ${rest[0]}`);
      const address = managedMailAddressForOwner(ownerUid, ctx);
      if (!address) throw new Error("managed mail is not available for this account");
      return completed(`${address}\n`);
    }
    case "list": {
      const page = parsePage(rest);
      return completed(formatMessagePage(
        ctx.mailboxes.list(ownerUid, page.limit, page.offset).messages,
      ));
    }
    case "search": {
      const parsed = parseSearch(rest);
      return completed(formatMessagePage(
        ctx.mailboxes.search(ownerUid, parsed.query, parsed.limit, parsed.offset).messages,
      ));
    }
    case "show":
      return await showMessage(rest, ownerUid, fs, ctx);
    default:
      throw new Error(`unknown command: ${subcommand}\n${MAIL_USAGE}`);
  }
}

async function showMessage(
  args: string[],
  ownerUid: number,
  fs: GsvFs,
  ctx: KernelContext,
): Promise<ExecResult> {
  let raw = false;
  let selector: string | undefined;
  for (const arg of args) {
    if (arg === "--raw") {
      raw = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`unexpected argument: ${arg}`);
    } else if (selector) {
      throw new Error(`unexpected argument: ${arg}`);
    } else {
      selector = arg;
    }
  }
  if (!selector) throw new Error("show requires a message id");
  const message = ctx.mailboxes.getMessage(ownerUid, selector);
  if (!message) throw new Error(`message not found: ${selector}`);
  return completed(await fs.readFile(raw ? message.rawPath : message.textPath));
}

function formatMessagePage(messages: MailMessageRecord[]): string {
  if (messages.length === 0) return "No messages.\n";
  return `${messages.map((message) => [
    message.messageId,
    new Date(message.receivedAt).toISOString(),
    cleanColumn(message.displayFrom ?? message.envelopeFrom),
    cleanColumn(message.subject ?? "(no subject)"),
    message.category ?? "unsummarized",
    message.requiresAttention === true ? "attention" : "",
  ].join("\t")).join("\n")}\n`;
}

function cleanColumn(value: string): string {
  return value.replace(/[\t\r\n]+/g, " ").trim();
}

function parseSearch(args: string[]): {
  query: string;
  limit: number;
  offset: number;
} {
  const terms: string[] = [];
  const pageArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--limit" || arg === "--offset") {
      pageArgs.push(arg, args[index + 1] ?? "");
      index += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(`unexpected argument: ${arg}`);
    } else {
      terms.push(arg);
    }
  }
  const query = terms.join(" ").trim();
  if (!query) throw new Error("search requires a query");
  return { query, ...parsePage(pageArgs) };
}

function parsePage(args: string[]): { limit: number; offset: number } {
  let limit = 50;
  let offset = 0;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== "--limit" && arg !== "--offset") {
      throw new Error(`unexpected argument: ${arg}`);
    }
    const value = Number(args[index + 1]);
    index += 1;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${arg} requires a non-negative integer`);
    }
    if (arg === "--limit") {
      if (value === 0 || value > 200) throw new Error("--limit must be between 1 and 200");
      limit = value;
    } else {
      offset = value;
    }
  }
  return { limit, offset };
}

function completed(stdout: string): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function failed(error: unknown): ExecResult {
  return {
    stdout: "",
    stderr: `mail: ${error instanceof Error ? error.message : String(error)}\n`,
    exitCode: 1,
  };
}
