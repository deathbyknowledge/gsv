import { defineCommand } from "@gsv/package/cli";
import type { KernelClientLike, PackageCommandContext } from "@gsv/package/cli";
import type {
  SocialFriendListResult,
  SocialIdentityGetResult,
  SocialIdentityRepublishResult,
  SocialMessageSendResult,
  SocialMessageStatusListResult,
  SocialMessageStatusState,
  SocialMessageStatusSummary,
  SocialThreadGetResult,
  SocialThreadListResult,
} from "@gsv/protocol/syscalls/social";

type CommandContext = Pick<PackageCommandContext, "argv" | "kernel" | "stdout">;

const ACTIVE_STATUS_STATES = new Set<SocialMessageStatusState>([
  "received",
  "triaged",
  "in_progress",
  "needs_human",
]);

const STATUS_STATES = new Set<SocialMessageStatusState>([
  "received",
  "triaged",
  "in_progress",
  "needs_human",
  "completed",
  "declined",
  "failed",
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
  if (command === "status" || command === "statuses") {
    return runStatusCommand(ctx.kernel, rest);
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
  const [subcommand] = args;
  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    return socialHelp("identity");
  }
  if (subcommand === "republish" || subcommand === "repair") {
    const result = await kernel.request<SocialIdentityRepublishResult>("social.identity.republish", {});
    if (hasFlag(args, "--json")) {
      return `${JSON.stringify(result, null, 2)}\n`;
    }
    return `republished social records for ${result.identity.handle}\n`;
  }
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
  const result = await kernel.request<SocialMessageStatusListResult>("social.message.status.list", {
    direction: "inbound",
    limit: parseLimit(args, 25),
  });
  const requestedState = parseOptionalStatusState(findFlagValue(args, "--state"));
  const statuses = result.statuses.filter((status) =>
    requestedState ? status.state === requestedState : ACTIVE_STATUS_STATES.has(status.state)
  );
  if (hasFlag(args, "--json")) {
    return `${JSON.stringify({ statuses }, null, 2)}\n`;
  }
  if (statuses.length === 0) {
    return "No active inbound social messages.\n";
  }
  return `${statuses.map(formatStatusLineWithActions).join("\n")}\n`;
}

async function runStatusCommand(kernel: KernelClientLike, args: string[]): Promise<string> {
  const [subcommand = "list", ...rest] = args;
  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    return socialHelp("status");
  }
  if (subcommand === "list") {
    const state = parseOptionalStatusState(findFlagValue(rest, "--state"));
    const peerHandle = findFlagValue(rest, "--peer");
    const direction = parseDirection(findFlagValue(rest, "--direction") ?? findFlagValue(rest, "-d"));
    const result = await kernel.request<SocialMessageStatusListResult>("social.message.status.list", {
      ...(state ? { state } : {}),
      ...(peerHandle ? { peerHandle } : {}),
      ...(direction ? { direction } : {}),
      limit: parseLimit(rest, 50),
    });
    if (hasFlag(rest, "--json")) {
      return `${JSON.stringify(result, null, 2)}\n`;
    }
    if (result.statuses.length === 0) {
      return "No social message statuses.\n";
    }
    return `${result.statuses.map(formatStatusLine).join("\n")}\n`;
  }
  if (subcommand === "update") {
    const messageId = firstPositional(rest);
    const state = parseRequiredStatusState(requireFlagValue(rest, "--state", "social status update requires --state"));
    const summary = findFlagValue(rest, "--summary");
    const needsHumanReason = findFlagValue(rest, "--reason");
    if (!messageId) {
      throw new Error("Usage: social status update <message-id> --state STATE [--summary TEXT] [--reason TEXT]");
    }
    const result = await kernel.request("social.message.status.update", {
      messageId,
      state,
      ...(summary ? { summary } : {}),
      ...(needsHumanReason ? { needsHumanReason } : {}),
    });
    if (hasFlag(rest, "--json")) {
      return `${JSON.stringify(result, null, 2)}\n`;
    }
    return `updated ${messageId}: ${state}\n`;
  }
  throw new Error(`Unknown social status subcommand: ${subcommand}`);
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
  const threadId = findFlagValue(rest, "--thread");
  if (!toHandle || !text.trim()) {
    throw new Error("Usage: social message send <handle> <text> [--thread THREAD] [--body JSON]");
  }
  const result = await kernel.request<SocialMessageSendResult>("social.message.send", {
    toHandle,
    text: text.trim(),
    ...(threadId ? { threadId } : {}),
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
      `- ${thread.threadId}: ${thread.peerHandle}`
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
    const statusByMessage = new Map(result.statuses.map((status) => [status.messageId, status]));
    const lines = [
      `${result.thread.threadId}: ${result.thread.peerHandle}`,
      "",
      ...result.messages.map((message) => {
        const text = message.text ?? (message.body === undefined ? "" : JSON.stringify(message.body));
        const status = statusByMessage.get(message.messageId);
        return `[${message.direction}] ${message.fromHandle}: ${text}${status ? ` (${status.state})` : ""}`;
      }),
    ];
    return `${lines.join("\n")}\n`;
  }
  throw new Error(`Unknown social thread subcommand: ${subcommand}`);
}

function formatStatusLine(status: SocialMessageStatusSummary): string {
  const peer = status.direction === "inbound" ? status.fromHandle : status.toHandle;
  return `- ${status.messageId} [${status.direction}/${status.state}] ${peer}: ${status.summary ?? ""}`.trimEnd();
}

function formatStatusLineWithActions(status: SocialMessageStatusSummary): string {
  return [
    formatStatusLine(status),
    `  inspect: social thread read ${status.threadId}`,
    `  done: social status update ${status.messageId} --state completed --summary "..."`,
    `  escalate: social status update ${status.messageId} --state needs_human --reason "..."`,
  ].join("\n");
}

function socialHelp(topic?: string): string {
  if (topic === "identity") {
    return "Usage:\n  social identity [--json]\n  social identity republish [--json]\n\n";
  }
  if (topic === "status") {
    return [
      "Usage:",
      "  social status list [--direction inbound|outbound|all] [--state STATE] [--peer HANDLE] [--limit N]",
      "  social status update <message-id> --state STATE [--summary TEXT] [--reason TEXT]",
      "",
    ].join("\n");
  }
  if (topic === "message") {
    return "Usage:\n  social message send <handle> <text> [--thread THREAD] [--body JSON]\n\n";
  }
  if (topic === "thread") {
    return "Usage:\n  social thread list [--limit N]\n  social thread read <thread-id> [--json]\n\n";
  }
  return [
    "Usage:",
    "  social identity",
    "  social identity republish",
    "  social friends",
    "  social inbox [--state STATE] [--limit N]",
    "  social status list|update ...",
    "  social message send <handle> <text>",
    "  social thread list|read ...",
    "",
  ].join("\n");
}

function parseDirection(value: string | undefined): "inbound" | "outbound" | "all" | undefined {
  if (!value || value === "all") {
    return value === "all" ? "all" : undefined;
  }
  if (value !== "inbound" && value !== "outbound") {
    throw new Error("--direction must be inbound, outbound, or all");
  }
  return value;
}

function parseOptionalStatusState(value: string | undefined): SocialMessageStatusState | undefined {
  if (!value) {
    return undefined;
  }
  return parseRequiredStatusState(value);
}

function parseRequiredStatusState(value: string): SocialMessageStatusState {
  if (!STATUS_STATES.has(value as SocialMessageStatusState)) {
    throw new Error(`Invalid message status state: ${value}`);
  }
  return value as SocialMessageStatusState;
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
  const valueFlags = new Set([
    "--body",
    "--direction",
    "-d",
    "--limit",
    "--peer",
    "--reason",
    "--state",
    "--summary",
    "--text",
    "--thread",
    "--to",
  ]);
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
