import { defineCommand } from "@gsv/package/cli";
import type { KernelClientLike, PackageCommandContext } from "@gsv/package/cli";
import type {
  SocialFriendListResult,
  SocialIdentityGetResult,
  SocialMessageSendResult,
  SocialRequestCreateResult,
  SocialRequestDirection,
  SocialRequestGetResult,
  SocialRequestKind,
  SocialRequestListResult,
  SocialRequestRespondArgs,
  SocialRequestRespondResult,
  SocialRequestStatus,
  SocialRequestSummary,
  SocialThreadGetResult,
  SocialThreadListResult,
} from "@gsv/protocol/syscalls/social";

type CommandContext = Pick<PackageCommandContext, "argv" | "kernel" | "stdout">;

const ACTIVE_INBOX_STATUSES = new Set<SocialRequestStatus>([
  "pending",
  "agent-replied",
  "needs-human",
  "accepted",
]);

const REQUEST_KINDS = new Set<SocialRequestKind>([
  "question",
  "task",
  "collaboration",
  "workspace-invite",
  "package-review",
  "other",
]);

const RESPONSE_STATUSES = new Set<SocialRequestRespondArgs["status"]>([
  "agent-replied",
  "needs-human",
  "accepted",
  "declined",
  "completed",
]);

export default defineCommand(async (ctx) => {
  await ctx.stdout.write(await runSocialCommand(ctx));
});

export async function runSocialCommand(ctx: CommandContext): Promise<string> {
  const [command = "help", ...rest] = ctx.argv;
  if (command === "help" || command === "--help" || command === "-h") {
    return socialHelp(rest[0]);
  }
  if (command === "identity") {
    return runIdentityCommand(ctx.kernel, rest);
  }
  if (command === "friends" || command === "friend") {
    return runFriendsCommand(ctx.kernel, rest);
  }
  if (command === "inbox") {
    return runInboxCommand(ctx.kernel, rest);
  }
  if (command === "request" || command === "requests") {
    return runRequestCommand(ctx.kernel, rest);
  }
  if (command === "message" || command === "messages") {
    return runMessageCommand(ctx.kernel, rest);
  }
  if (command === "thread" || command === "threads") {
    return runThreadCommand(ctx.kernel, rest);
  }
  throw new Error(`Unknown social subcommand: ${command}`);
}

async function runIdentityCommand(kernel: KernelClientLike, args: string[]): Promise<string> {
  const result = await kernel.request<SocialIdentityGetResult>("social.identity.get", {});
  if (hasFlag(args, "--json")) {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  if (!result.identity) {
    return "No social identity is configured.\n";
  }
  const lines = [
    `Handle: ${result.identity.handle}`,
    `PDS: ${result.identity.pdsEndpoint}`,
  ];
  if (result.identity.profile?.displayName) {
    lines.push(`Display: ${result.identity.profile.displayName}`);
  }
  return `${lines.join("\n")}\n`;
}

async function runFriendsCommand(kernel: KernelClientLike, args: string[]): Promise<string> {
  const result = await kernel.request<SocialFriendListResult>("social.friend.list", {});
  if (hasFlag(args, "--json")) {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  if (result.friends.length === 0) {
    return "No friends.\n";
  }
  return `${result.friends.map((friend) => {
    const grants = friend.grants.map((grant) => grant.operation).join(", ") || "none";
    return `- ${friend.handle}: grants=${grants}`;
  }).join("\n")}\n`;
}

async function runInboxCommand(kernel: KernelClientLike, args: string[]): Promise<string> {
  const limit = parseLimit(args, 25);
  const result = await kernel.request<SocialRequestListResult>("social.request.list", {
    direction: "inbound",
    limit,
  });
  const active = result.requests.filter((request) => ACTIVE_INBOX_STATUSES.has(request.status));
  if (hasFlag(args, "--json")) {
    return `${JSON.stringify({ requests: active }, null, 2)}\n`;
  }
  if (active.length === 0) {
    return "No inbound active social requests.\n";
  }
  return `${active.map(formatRequestLineWithActions).join("\n")}\n`;
}

async function runRequestCommand(kernel: KernelClientLike, args: string[]): Promise<string> {
  const [subcommand = "list", ...rest] = args;
  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    return socialHelp("request");
  }
  if (subcommand === "list") {
    const direction = parseDirection(findFlagValue(rest, "--direction") ?? findFlagValue(rest, "-d"));
    const status = parseRequestStatus(findFlagValue(rest, "--status"));
    const peerHandle = findFlagValue(rest, "--peer");
    const result = await kernel.request<SocialRequestListResult>("social.request.list", {
      ...(direction ? { direction } : {}),
      ...(status ? { status } : {}),
      ...(peerHandle ? { peerHandle } : {}),
      limit: parseLimit(rest, 50),
    });
    if (hasFlag(rest, "--json")) {
      return `${JSON.stringify(result, null, 2)}\n`;
    }
    if (result.requests.length === 0) {
      return "No social requests.\n";
    }
    return `${result.requests.map(formatRequestLine).join("\n")}\n`;
  }
  if (subcommand === "get") {
    const requestId = firstPositional(rest);
    if (!requestId) {
      throw new Error("Usage: social request get <request-id> [--json]");
    }
    const result = await kernel.request<SocialRequestGetResult>("social.request.get", { requestId });
    if (hasFlag(rest, "--json")) {
      return `${JSON.stringify(result, null, 2)}\n`;
    }
    if (!result.request) {
      return `Request not found: ${requestId}\n`;
    }
    return formatRequestDetail(result.request);
  }
  if (subcommand === "respond") {
    const requestId = firstPositional(rest);
    const status = parseResponseStatus(requireFlagValue(rest, "--status", "social request respond requires --status"));
    const text = findFlagValue(rest, "--text");
    const body = parseOptionalJsonFlag(rest, "--body");
    if (!requestId) {
      throw new Error("Usage: social request respond <request-id> --status STATUS [--text TEXT] [--body JSON]");
    }
    const result = await kernel.request<SocialRequestRespondResult>("social.request.respond", {
      requestId,
      status,
      ...(text ? { text } : {}),
      ...(body === undefined ? {} : { body }),
    });
    if (hasFlag(rest, "--json")) {
      return `${JSON.stringify(result, null, 2)}\n`;
    }
    return `updated ${result.request.requestId}: ${result.request.status}\n`;
  }
  if (subcommand === "create") {
    const toHandle = firstPositional(rest) ?? requireFlagValue(rest, "--to", "social request create requires a handle");
    const kind = parseRequestKind(findFlagValue(rest, "--kind") ?? "question");
    const title = requireFlagValue(rest, "--title", "social request create requires --title");
    const body = parseOptionalJsonFlag(rest, "--body");
    const threadId = findFlagValue(rest, "--thread");
    const result = await kernel.request<SocialRequestCreateResult>("social.request.create", {
      toHandle,
      kind,
      title,
      ...(threadId ? { threadId } : {}),
      ...(body === undefined ? {} : { body }),
    });
    if (hasFlag(rest, "--json")) {
      return `${JSON.stringify(result, null, 2)}\n`;
    }
    return `created ${result.request.requestId} in ${result.thread.threadId}\n`;
  }
  throw new Error(`Unknown social request subcommand: ${subcommand}`);
}

async function runMessageCommand(kernel: KernelClientLike, args: string[]): Promise<string> {
  const [subcommand = "send", ...rest] = args;
  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    return socialHelp("message");
  }
  if (subcommand !== "send") {
    throw new Error(`Unknown social message subcommand: ${subcommand}`);
  }
  const positionals = positionalArgs(rest);
  const toHandle = findFlagValue(rest, "--to") ?? positionals[0];
  const text = findFlagValue(rest, "--text") ?? positionals.slice(1).join(" ");
  const body = parseOptionalJsonFlag(rest, "--body");
  if (!toHandle || !text.trim()) {
    throw new Error("Usage: social message send <handle> <text> [--body JSON]");
  }
  const result = await kernel.request<SocialMessageSendResult>("social.message.send", {
    toHandle,
    text: text.trim(),
    ...(body === undefined ? {} : { body }),
  });
  if (hasFlag(rest, "--json")) {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  return `sent ${result.message.messageId} in ${result.thread.threadId}\n`;
}

async function runThreadCommand(kernel: KernelClientLike, args: string[]): Promise<string> {
  const [subcommand = "list", ...rest] = args;
  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    return socialHelp("thread");
  }
  if (subcommand === "list") {
    const result = await kernel.request<SocialThreadListResult>("social.thread.list", {
      limit: parseLimit(rest, 50),
    });
    if (hasFlag(rest, "--json")) {
      return `${JSON.stringify(result, null, 2)}\n`;
    }
    if (result.threads.length === 0) {
      return "No social threads.\n";
    }
    return `${result.threads.map((thread) =>
      `- ${thread.threadId}: ${thread.peerHandle}${thread.topic ? ` - ${thread.topic}` : ""}`
    ).join("\n")}\n`;
  }
  if (subcommand === "read" || subcommand === "get") {
    const threadId = firstPositional(rest);
    if (!threadId) {
      throw new Error("Usage: social thread read <thread-id> [--json]");
    }
    const result = await kernel.request<SocialThreadGetResult>("social.thread.get", { threadId });
    if (hasFlag(rest, "--json")) {
      return `${JSON.stringify(result, null, 2)}\n`;
    }
    if (!result.thread) {
      return `Thread not found: ${threadId}\n`;
    }
    const lines = [
      `${result.thread.threadId}: ${result.thread.peerHandle}${result.thread.topic ? ` - ${result.thread.topic}` : ""}`,
      "",
      ...result.messages.map((message) => {
        const text = message.text ?? (message.body === undefined ? "" : JSON.stringify(message.body));
        return `[${message.direction}] ${message.fromHandle}: ${text}`;
      }),
    ];
    return `${lines.join("\n")}\n`;
  }
  throw new Error(`Unknown social thread subcommand: ${subcommand}`);
}

function formatRequestLine(request: SocialRequestSummary): string {
  return `- ${request.requestId} [${request.direction}/${request.status}] ${request.kind} ${request.fromHandle} -> ${request.toHandle}: ${request.title}`;
}

function formatRequestLineWithActions(request: SocialRequestSummary): string {
  return [
    formatRequestLine(request),
    `  inspect: social request get ${request.requestId}`,
    `  respond: social request respond ${request.requestId} --status agent-replied --text "..."`,
    `  escalate: social request respond ${request.requestId} --status needs-human --text "..."`,
  ].join("\n");
}

function formatRequestDetail(request: SocialRequestSummary): string {
  const lines = [
    `Request: ${request.requestId}`,
    `Direction: ${request.direction}`,
    `Status: ${request.status}`,
    `Kind: ${request.kind}`,
    `From: ${request.fromHandle}`,
    `To: ${request.toHandle}`,
    `Title: ${request.title}`,
  ];
  if (request.threadId) {
    lines.push(`Thread: ${request.threadId}`);
  }
  if (request.expiresAt) {
    lines.push(`Expires: ${request.expiresAt}`);
  }
  if (request.body !== undefined) {
    lines.push("", JSON.stringify(request.body, null, 2));
  }
  if (request.direction === "inbound" && ACTIVE_INBOX_STATUSES.has(request.status)) {
    lines.push(
      "",
      `Respond: social request respond ${request.requestId} --status agent-replied --text "..."`,
      `Escalate: social request respond ${request.requestId} --status needs-human --text "..."`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function socialHelp(topic?: string): string {
  if (topic === "request") {
    return [
      "Usage:",
      "  social request list [--direction inbound|outbound|all] [--status STATUS] [--peer HANDLE] [--limit N]",
      "  social request get <request-id> [--json]",
      "  social request create <handle> --kind question --title TEXT [--body JSON] [--thread THREAD]",
      "  social request respond <request-id> --status STATUS [--text TEXT] [--body JSON]",
      "",
    ].join("\n");
  }
  if (topic === "message") {
    return "Usage:\n  social message send <handle> <text> [--body JSON]\n\n";
  }
  if (topic === "thread") {
    return "Usage:\n  social thread list [--limit N]\n  social thread read <thread-id> [--json]\n\n";
  }
  return [
    "Usage:",
    "  social identity",
    "  social friends",
    "  social inbox [--limit N]",
    "  social request list|get|create|respond ...",
    "  social message send <handle> <text>",
    "  social thread list|read ...",
    "",
  ].join("\n");
}

function parseDirection(value: string | undefined): SocialRequestDirection | "all" | undefined {
  if (!value || value === "all") {
    return value === "all" ? "all" : undefined;
  }
  if (value !== "inbound" && value !== "outbound") {
    throw new Error("--direction must be inbound, outbound, or all");
  }
  return value;
}

function parseRequestKind(value: string): SocialRequestKind {
  if (!REQUEST_KINDS.has(value as SocialRequestKind)) {
    throw new Error(`Invalid request kind: ${value}`);
  }
  return value as SocialRequestKind;
}

function parseRequestStatus(value: string | undefined): SocialRequestStatus | undefined {
  if (!value) {
    return undefined;
  }
  const allowed: SocialRequestStatus[] = [
    "pending",
    "agent-replied",
    "needs-human",
    "accepted",
    "declined",
    "completed",
    "expired",
  ];
  if (!allowed.includes(value as SocialRequestStatus)) {
    throw new Error(`Invalid request status: ${value}`);
  }
  return value as SocialRequestStatus;
}

function parseResponseStatus(value: string): SocialRequestRespondArgs["status"] {
  if (!RESPONSE_STATUSES.has(value as SocialRequestRespondArgs["status"])) {
    throw new Error(`Invalid response status: ${value}`);
  }
  return value as SocialRequestRespondArgs["status"];
}

function parseLimit(args: string[], fallback: number): number {
  const raw = findFlagValue(args, "--limit");
  if (!raw) {
    return fallback;
  }
  const limit = Number.parseInt(raw, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("--limit must be an integer between 1 and 200");
  }
  return limit;
}

function parseOptionalJsonFlag(args: string[], flag: string): unknown {
  const raw = findFlagValue(args, flag);
  if (raw === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${flag} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function findFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function requireFlagValue(args: string[], flag: string, message: string): string {
  const value = findFlagValue(args, flag);
  if (!value) {
    throw new Error(message);
  }
  return value;
}

function firstPositional(args: string[]): string | undefined {
  return positionalArgs(args)[0];
}

function positionalArgs(args: string[]): string[] {
  const valueFlags = new Set(["--body", "--direction", "-d", "--kind", "--limit", "--peer", "--status", "--text", "--thread", "--title", "--to"]);
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("-")) {
      if (valueFlags.has(arg)) {
        index += 1;
      }
      continue;
    }
    result.push(arg);
  }
  return result;
}
