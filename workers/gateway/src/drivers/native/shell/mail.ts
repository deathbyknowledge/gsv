import { MAIL_MAX_OUTBOUND_TEXT_BYTES as MAX_OUTBOUND_TEXT_BYTES } from "@humansandmachines/gsv/services/mail";
import { defineCommand } from "just-bash";
import type { CommandContext, ExecResult } from "just-bash";
import type {
  MailMessageSummary,
  MailPage,
  MailSendArgs,
  MailSendResult,
  MailStatusResult,
} from "@humansandmachines/gsv/protocol";
import type { GsvFs } from "../../../fs/gsv-fs";
import type { KernelContext } from "../../../kernel/context";
import { resolveCallerOwnerUid } from "../../../kernel/context";
import { managedMailAddressForOwner } from "../../../kernel/mailbox";
import { handleMailSend } from "../../../kernel/outbound-mail";
import { handleMailStatus } from "../../../kernel/outbound-status";
import { handleMailList, handleMailRead, handleMailSearch } from "../../../kernel/inbound-mail-read";
import {
  requireCommandCapability,
  requireShellOptionValue,
} from "./common";

type MailSendOptions = { to?: string; subject?: string; message?: string; bodyPath?: string; deliveryId?: string; replyToMessageId?: string };
type MailSearchOptions = MailPageOptions & { query: string };
type MailPageOptions = { limit?: number; before?: string };

const MAIL_USAGE = `Usage:
  mail address
  mail list [--limit N] [--before CURSOR]
  mail search <query> [--limit N] [--before CURSOR]
  mail show <message-id> [--raw]
  mail status <delivery-id>
  mail send --to ADDRESS --subject SUBJECT (--message TEXT | --body PATH) [--delivery-id ID]
  mail reply <message-id> [--subject SUBJECT] (--message TEXT | --body PATH) [--delivery-id ID]
`;

export function buildMailCommand(fs: GsvFs, ctx: KernelContext) {
  let outboundInvocationOrdinal = 0;
  return defineCommand("mail", async (args, shellCtx): Promise<ExecResult> => {
    try {
      return await runMailCommand(
        args,
        shellCtx,
        fs,
        ctx,
        () => {
          outboundInvocationOrdinal += 1;
          return outboundInvocationOrdinal;
        },
      );
    } catch (error) {
      return failed(error instanceof Error ? error : String(error));
    }
  });
}

async function runMailCommand(
  args: string[],
  shellCtx: CommandContext,
  fs: GsvFs,
  ctx: KernelContext,
  nextOutboundInvocationOrdinal: () => number,
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
    case "list":
      requireCommandCapability(ctx, "mail.list");
      return completed(formatMessagePage(handleMailList(parsePage(rest), ctx), "mail list"));
    case "search": {
      requireCommandCapability(ctx, "mail.search");
      const parsed = parseSearch(rest);
      return completed(formatMessagePage(handleMailSearch(parsed, ctx), `mail search ${shellQuote(parsed.query)}`));
    }
    case "show":
      return await showMessage(rest, fs, ctx);
    case "status":
      return statusMail(rest, ctx);
    case "send":
      return await sendMail(
        rest,
        shellCtx,
        fs,
        ctx,
        nextOutboundInvocationOrdinal(),
        false,
      );
    case "reply":
      return await sendMail(
        rest,
        shellCtx,
        fs,
        ctx,
        nextOutboundInvocationOrdinal(),
        true,
      );
    default:
      throw new Error(`unknown command: ${subcommand}\n${MAIL_USAGE}`);
  }
}

function statusMail(args: string[], ctx: KernelContext): ExecResult {
  requireCommandCapability(ctx, "mail.status");
  if (args.length === 0) throw new Error("mail status requires a delivery id");
  if (args.length > 1) throw new Error(`unexpected argument: ${args[1]}`);
  const result = handleMailStatus({ deliveryId: args[0] }, ctx);
  return formatStatusResult(result);
}

async function sendMail(
  args: string[],
  shellCtx: CommandContext,
  fs: GsvFs,
  ctx: KernelContext,
  invocationOrdinal: number,
  reply: boolean,
): Promise<ExecResult> {
  requireCommandCapability(ctx, "mail.send");
  const options = parseSend(args, reply);
  const requestCtx = withShellSignal(ctx, shellCtx);
  requestCtx.requestSignal?.throwIfAborted();
  let text = options.message!;
  if (options.bodyPath) {
    const path = shellCtx.fs.resolvePath(shellCtx.cwd, options.bodyPath);
    const stat = await fs.stat(path);
    requestCtx.requestSignal?.throwIfAborted();
    if (!stat.isFile) throw new Error(`mail body is not a file: ${options.bodyPath}`);
    if (stat.size > MAX_OUTBOUND_TEXT_BYTES) {
      throw new Error(`mail body exceeds ${MAX_OUTBOUND_TEXT_BYTES} bytes`);
    }
    text = await fs.readFile(path);
    requestCtx.requestSignal?.throwIfAborted();
  }
  const deliveryId = options.deliveryId
    ?? defaultDeliveryId(ctx.requestId, invocationOrdinal);
  const input: MailSendArgs = { text, deliveryId };
  if (options.to) input.to = options.to;
  if (options.subject !== undefined) input.subject = options.subject;
  if (options.replyToMessageId) input.replyToMessageId = options.replyToMessageId;
  return formatSendResult(await handleMailSend(input, requestCtx), deliveryId);
}

function withShellSignal(ctx: KernelContext, shellCtx: CommandContext): KernelContext {
  if (!shellCtx.signal || shellCtx.signal === ctx.requestSignal) return ctx;
  return {
    ...ctx,
    requestSignal: ctx.requestSignal
      ? AbortSignal.any([ctx.requestSignal, shellCtx.signal])
      : shellCtx.signal,
  };
}

function parseSend(args: string[], reply: boolean): MailSendOptions {
  let to: string | undefined;
  let subject: string | undefined;
  let message: string | undefined;
  let bodyPath: string | undefined;
  let deliveryId: string | undefined;
  let replyToMessageId: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (
      current === "--to"
      || current === "--subject"
      || current === "--message"
      || current === "--body"
      || current === "--delivery-id"
    ) {
      index += 1;
      const value = requireShellOptionValue(args[index], current);
      if (current === "--to") {
        if (reply) throw new Error("mail reply does not accept --to");
        to = value;
      } else if (current === "--subject") {
        subject = value;
      } else if (current === "--message") {
        message = value;
      } else if (current === "--body") {
        bodyPath = value;
      } else {
        deliveryId = value.trim();
        if (!deliveryId) throw new Error("--delivery-id requires a value");
      }
      continue;
    }
    if (current.startsWith("--")) {
      throw new Error(`unexpected argument: ${current}`);
    }
    if (!reply) throw new Error(`unexpected argument: ${current}`);
    if (replyToMessageId) throw new Error(`unexpected argument: ${current}`);
    replyToMessageId = current;
  }

  if (reply) {
    if (!replyToMessageId) throw new Error("mail reply requires a message id");
  } else {
    if (!to) throw new Error("mail send requires --to");
    if (subject === undefined) throw new Error("mail send requires --subject");
  }
  if (message === undefined && bodyPath === undefined) {
    throw new Error(`mail ${reply ? "reply" : "send"} requires --message or --body`);
  }
  if (message !== undefined && bodyPath !== undefined) {
    throw new Error("--message and --body are mutually exclusive");
  }
  const parsed: MailSendOptions = {};
  if (to) parsed.to = to;
  if (subject !== undefined) parsed.subject = subject;
  if (message !== undefined) parsed.message = message;
  if (bodyPath) parsed.bodyPath = bodyPath;
  if (deliveryId) parsed.deliveryId = deliveryId;
  if (replyToMessageId) parsed.replyToMessageId = replyToMessageId;
  return parsed;
}

function defaultDeliveryId(requestId: string | undefined, ordinal: number): string {
  if (!requestId) {
    throw new Error("mail send requires an outer request id or --delivery-id");
  }
  return `${requestId}:mail:${ordinal}`;
}

function formatSendResult(result: MailSendResult, deliveryId: string): ExecResult {
  if (!result.ok) {
    throw new Error(
      `${result.error} (delivery_id=${result.deliveryId ?? deliveryId}${
        result.retryable ? "; retry with --delivery-id using this value" : ""
      })`,
    );
  }
  return completed([
    `state=${result.state}`,
    `delivery_id=${result.deliveryId}`,
    `outbound_id=${result.outboundId}`,
    `from=${result.from}`,
    `to=${result.to}`,
    `subject=${cleanColumn(result.subject)}`,
    ...(result.errorCode ? [`error_code=${result.errorCode}`] : []),
    `replayed=${result.replayed ? "true" : "false"}`,
    "",
  ].join("\n"));
}

function formatStatusResult(result: MailStatusResult): ExecResult {
  const outbound = result.outbound;
  if (!outbound) throw new Error("outbound delivery not found");
  return completed([
    `state=${outbound.state}`,
    `delivery_id=${outbound.deliveryId}`,
    `outbound_id=${outbound.outboundId}`,
    `from=${outbound.from}`,
    `to=${outbound.to}`,
    `subject=${cleanColumn(outbound.subject)}`,
    ...(outbound.providerMessageId
      ? [`provider_message_id=${outbound.providerMessageId}`]
      : []),
    ...(outbound.errorCode ? [`error_code=${outbound.errorCode}`] : []),
    `created_at=${new Date(outbound.createdAt).toISOString()}`,
    ...(outbound.queuedAt === null
      ? []
      : [`queued_at=${new Date(outbound.queuedAt).toISOString()}`]),
    ...(outbound.completedAt === null
      ? []
      : [`completed_at=${new Date(outbound.completedAt).toISOString()}`]),
    "",
  ].join("\n"));
}

async function showMessage(
  args: string[],
  fs: GsvFs,
  ctx: KernelContext,
): Promise<ExecResult> {
  requireCommandCapability(ctx, "mail.read");
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
  if (raw) {
    const message = ctx.mailboxes.getMessage(resolveCallerOwnerUid(ctx), selector);
    if (!message) throw new Error(`Mail message not found: ${selector}`);
    return completed(await fs.readFile(message.rawPath));
  }
  const { message } = await handleMailRead({ messageId: selector }, ctx, fs);
  return completed(message.truncated
    ? `${message.text}\n[Message cut short; read ${message.textPath} for the rest.]\n`
    : message.text);
}

function formatMessagePage(page: MailPage, command: string): string {
  if (page.messages.length === 0) return "No messages.\n";
  const rows = page.messages.map((message: MailMessageSummary) => [
    message.messageId,
    new Date(message.receivedAt).toISOString(),
    cleanColumn(message.from),
    cleanColumn(message.subject ?? "(no subject)"),
    message.category ?? "unsummarized",
    message.requiresAttention === true ? "attention" : "",
  ].join("\t"));
  if (page.next) rows.push(`More: ${command} --before ${page.next}`);
  return `${rows.join("\n")}\n`;
}

function shellQuote(value: string): string {
  return /^[\w@.+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function cleanColumn(value: string): string {
  return value.replace(/[\t\r\n]+/g, " ").trim();
}

function parseSearch(args: string[]): MailSearchOptions {
  const terms: string[] = [];
  const pageArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--limit" || arg === "--before" || arg === "--offset") {
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

function parsePage(args: string[]): MailPageOptions {
  const page: MailPageOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    index += 1;
    if (arg === "--offset") {
      throw new Error("--offset is gone; continue with the --before value printed after a page");
    }
    if (arg === "--before") {
      if (!value) throw new Error("--before requires a cursor");
      page.before = value;
    } else if (arg === "--limit") {
      const limit = Number(value);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
        throw new Error("--limit must be between 1 and 200");
      }
      page.limit = limit;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  return page;
}

function completed(stdout: string): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function failed(error: Error | string): ExecResult {
  return {
    stdout: "",
    stderr: `mail: ${error instanceof Error ? error.message : String(error)}\n`,
    exitCode: 1,
  };
}
