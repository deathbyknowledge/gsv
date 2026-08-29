import {
  Bash,
  InMemoryFs,
  defineCommand,
  type BashExecResult,
  type ByteString,
  type ExecResult,
} from "just-bash";
import type {
  ShellExecArgs,
  ShellExecResult,
} from "../../../packages/gsv/src/protocol/syscalls/shell.js";
import {
  addSlackReaction,
  authenticateSlackUser,
  getSlackConversationHistory,
  getSlackConversationReplies,
  getSlackUser,
  listSlackConversations,
  listSlackUsers,
  postSlackMessage,
  type SlackConversationSummary,
  type SlackFetch,
  type SlackMessageSummary,
  type SlackPage,
  type SlackPostMessageResult,
  type SlackUserIdentity,
  type SlackUserSummary,
} from "./slack-api";
import { renderSlackActorAttribution } from "./slack-delivery";

type SlackTargetShellInput = {
  args: ShellExecArgs;
  userToken: string;
  botToken: string;
  actorId: string;
  botUserId: string;
  teamId: string;
  teamName?: string;
  signal: AbortSignal;
  slackFetch: SlackFetch;
  guard: () => Promise<void>;
};

type ListOptions = {
  cursor?: string;
  json: boolean;
  limit: number;
};

type WhoamiOptions = { json: boolean };
type SendOptions = {
  channel: string;
  threadTs?: string;
  message: string;
  json: boolean;
};
type ReactionOptions = {
  channel: string;
  timestamp: string;
  name: string;
  json: boolean;
};
type UserInfoOptions = { actorId: string; json: boolean };
type SlackReactionResult = {
  ok: true;
  channel: string;
  timestamp: string;
  name: string;
};
type SlackTargetIdentity = {
  workspace: { id: string; name?: string };
  reader: { kind: "user"; id: string; name?: string };
  writer: { kind: "app"; id: string };
};
type SlackTargetJsonOutput =
  | SlackTargetIdentity
  | SlackPage<SlackConversationSummary>
  | SlackPage<SlackMessageSummary>
  | SlackPage<SlackUserSummary>
  | SlackPostMessageResult
  | SlackUserSummary
  | SlackReactionResult;

const DEFAULT_LIMIT = 50;
const MAX_OUTPUT_BYTES = 512 * 1024;

export async function executeSlackTargetShell(
  input: SlackTargetShellInput,
): Promise<ShellExecResult> {
  if (input.args.sessionId) {
    return failed("Slack shell session continuation is not supported", input.args.sessionId);
  }
  if (input.args.background) {
    return failed("Slack shell background execution is not supported");
  }
  if (input.args.cwd && input.args.cwd !== "/") {
    return failed("Slack target cwd must be /");
  }
  if (!input.args.input.trim()) return failed("input must not be empty");

  const bash = new Bash({
    fs: new InMemoryFs(),
    cwd: "/",
    env: {
      HOME: "/",
      USER: input.actorId,
      LOGNAME: input.actorId,
      SHELL: "/bin/bash",
      PATH: "/usr/local/bin:/usr/bin:/bin",
      PWD: "/",
      SLACK_TEAM_ID: input.teamId,
      SLACK_TEAM_NAME: input.teamName ?? input.teamId,
      SLACK_USER_ID: input.actorId,
      SLACK_BOT_USER_ID: input.botUserId,
    },
    executionLimits: {
      maxCommandCount: 1_000,
      maxCallDepth: 64,
      maxLoopIterations: 10_000,
      maxOutputSize: MAX_OUTPUT_BYTES,
      maxExecutionTimeMs: Math.max(1, input.args.timeout ?? 120_000),
      maxExtensionCleanupTimeMs: 100,
    },
    customCommands: [buildSlackCommand(input)],
  });

  try {
    const result = await bash.exec(input.args.input, {
      cwd: "/",
      signal: input.signal,
    });
    if (input.signal.aborted) return failed(abortMessage(input.signal));
    return shellResult(result);
  } catch (error) {
    if (input.signal.aborted) return failed(abortMessage(input.signal));
    return failed(error instanceof Error ? error.message : String(error));
  }
}

function buildSlackCommand(input: SlackTargetShellInput) {
  return defineCommand("slack", async (args, commandContext): Promise<ExecResult> => {
    const signal = commandContext.signal ?? input.signal;
    const slackFetch = withSignal(input.slackFetch, signal);
    const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
      await input.guard();
      const result = await operation();
      await input.guard();
      return result;
    };
    const authenticateReader = async (): Promise<SlackUserIdentity> => {
      const identity = await authenticateSlackUser(input.userToken, slackFetch);
      if (identity.teamId !== input.teamId || identity.actorId !== input.actorId) {
        throw new Error("Slack reader authorization no longer matches this target");
      }
      return identity;
    };
    const authorizeMutation = async (): Promise<void> => {
      await authenticateReader();
      await input.guard();
    };

    try {
      if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
        return ok(slackUsage());
      }
      const [group, action, ...rest] = args;
      if (group === "whoami") {
        const options = parseWhoamiOptions(args.slice(1));
        const identity = await guarded(authenticateReader);
        const targetIdentity = slackTargetIdentity(identity, input.botUserId);
        return options.json
          ? json(targetIdentity)
          : ok([
            `workspace: ${identity.teamName ?? identity.teamId} (${identity.teamId})`,
            `reads as: ${identity.actorName ?? identity.actorId} (${identity.actorId})`,
            `writes as: GSV app (${input.botUserId})`,
            "",
          ].join("\n"));
      }
      if ((group === "conversations" || group === "channels") && action === "list") {
        const options = parseConversationListOptions(rest);
        const page = await guarded(() => listSlackConversations(input.userToken, {
          types: options.types,
          limit: options.limit,
          cursor: options.cursor,
          excludeArchived: options.excludeArchived,
        }, slackFetch));
        if (options.json) return json(page);
        const lines = ["ID\tKIND\tMEMBER\tPRIVATE\tNAME"];
        for (const conversation of page.items) {
          lines.push([
            conversation.id,
            conversation.kind,
            conversation.isMember ? "yes" : "no",
            conversation.isPrivate ? "yes" : "no",
            conversation.name ?? conversation.userId ?? "-",
          ].join("\t"));
        }
        appendCursor(lines, page.nextCursor);
        return ok(`${lines.join("\n")}\n`);
      }
      if (
        (group === "conversations" || group === "messages")
        && action === "history"
      ) {
        const options = parseMessagePageOptions(rest, "history");
        const page = await guarded(() => getSlackConversationHistory(input.userToken, {
          channel: options.channel,
          limit: options.limit,
          cursor: options.cursor,
        }, slackFetch));
        return renderMessages(page, options.json);
      }
      if (
        (group === "conversations" || group === "messages")
        && (action === "replies" || action === "thread")
      ) {
        const options = parseMessagePageOptions(rest, "replies");
        const timestamp = options.timestamp;
        if (!timestamp) throw new Error("--timestamp is required");
        const page = await guarded(() => getSlackConversationReplies(input.userToken, {
          channel: options.channel,
          timestamp,
          limit: options.limit,
          cursor: options.cursor,
        }, slackFetch));
        return renderMessages(page, options.json);
      }
      if (group === "messages" && action === "send") {
        const send = parseSendOptions(rest, decodeCommandStdin(commandContext.stdin, 40_001));
        const result = await guarded(async () => {
          await authorizeMutation();
          return await postSlackMessage(input.botToken, {
            channel: send.channel,
            text: renderSlackActorAttribution(input.actorId, send.message),
            threadTs: send.threadTs,
          }, slackFetch);
        });
        return send.json
          ? json(result)
          : ok(`sent ${result.channel} ${result.ts}\n`);
      }
      if (group === "reactions" && action === "add") {
        const reaction = parseReactionOptions(rest);
        await guarded(async () => {
          await authorizeMutation();
          await addSlackReaction(input.botToken, reaction, slackFetch);
        });
        return reaction.json
          ? json({
            ok: true,
            channel: reaction.channel,
            timestamp: reaction.timestamp,
            name: reaction.name,
          })
          : ok(`reacted ${reaction.name} to ${reaction.channel} ${reaction.timestamp}\n`);
      }
      if (group === "users" && action === "list") {
        const options = parseListOptions(rest, 200);
        const page = await guarded(() => listSlackUsers(input.userToken, options, slackFetch));
        if (options.json) return json(page);
        const lines = ["ID\tBOT\tDELETED\tNAME"];
        for (const user of page.items) {
          lines.push([
            user.id,
            user.isBot ? "yes" : "no",
            user.deleted ? "yes" : "no",
            user.displayName ?? user.realName ?? user.name ?? "-",
          ].join("\t"));
        }
        appendCursor(lines, page.nextCursor);
        return ok(`${lines.join("\n")}\n`);
      }
      if (group === "users" && action === "info") {
        const options = parseUserInfoOptions(rest);
        const user = await guarded(() => getSlackUser(input.userToken, options.actorId, slackFetch));
        return options.json
          ? json(user)
          : ok([
            `id: ${user.id}`,
            `name: ${user.name ?? "-"}`,
            `display name: ${user.displayName ?? "-"}`,
            `real name: ${user.realName ?? "-"}`,
            `bot: ${user.isBot ? "yes" : "no"}`,
            `deleted: ${user.deleted ? "yes" : "no"}`,
            "",
          ].join("\n"));
      }
      throw new Error(`unknown command: ${args.join(" ")}`);
    } catch (error) {
      return {
        stdout: "",
        stderr: `slack: ${error instanceof Error ? error.message : String(error)}\n`,
        exitCode: 1,
      };
    }
  });
}

function parseConversationListOptions(args: string[]): ListOptions & {
  excludeArchived: boolean;
  types: string;
} {
  const options = {
    ...parseListOptions(args, 200, new Set(["--types", "--include-archived"])),
    excludeArchived: !args.includes("--include-archived"),
    types: optionValue(args, "--types") ?? "public_channel,private_channel,mpim,im",
  };
  return options;
}

function parseWhoamiOptions(args: string[]): WhoamiOptions {
  assertKnownOptions(args, new Set(["--json"]));
  return { json: args.includes("--json") };
}

function parseMessagePageOptions(args: string[], command: "history" | "replies"): ListOptions & {
  channel: string;
  timestamp?: string;
} {
  const options = parseListOptions(args, 100, new Set(["--channel", "--timestamp"]));
  const channel = optionValue(args, "--channel");
  if (!channel) throw new Error(`${command}: --channel is required`);
  const result: ListOptions & { channel: string; timestamp?: string } = {
    ...options,
    channel,
  };
  const timestamp = optionValue(args, "--timestamp");
  if (timestamp) result.timestamp = timestamp;
  return result;
}

function parseSendOptions(args: string[], stdin: string): SendOptions {
  assertKnownOptions(args, new Set(["--channel", "--thread", "--message", "--json"]));
  const channel = optionValue(args, "--channel");
  const explicitMessage = optionValue(args, "--message");
  const pipedMessage = stdin.replace(/\r?\n$/, "");
  if (!channel) throw new Error("messages send: --channel is required");
  if (explicitMessage !== undefined && pipedMessage) {
    throw new Error("messages send: use either --message or standard input");
  }
  const message = explicitMessage ?? pipedMessage;
  if (!message) {
    throw new Error("messages send: --message or standard input is required");
  }
  const result: SendOptions = { channel, message, json: args.includes("--json") };
  const threadTs = optionValue(args, "--thread");
  if (threadTs) result.threadTs = threadTs;
  return result;
}

function parseReactionOptions(args: string[]): ReactionOptions {
  assertKnownOptions(args, new Set(["--channel", "--timestamp", "--name", "--json"]));
  const channel = optionValue(args, "--channel");
  const timestamp = optionValue(args, "--timestamp");
  const name = optionValue(args, "--name");
  if (!channel || !timestamp || !name) {
    throw new Error("reactions add requires --channel, --timestamp, and --name");
  }
  return { channel, timestamp, name, json: args.includes("--json") };
}

function parseUserInfoOptions(args: string[]): UserInfoOptions {
  assertKnownOptions(args, new Set(["--user", "--json"]));
  const actorId = optionValue(args, "--user");
  if (!actorId) throw new Error("users info: --user is required");
  return { actorId, json: args.includes("--json") };
}

function parseListOptions(
  args: string[],
  maximum: number,
  additional = new Set<string>(),
): ListOptions {
  assertKnownOptions(args, new Set(["--limit", "--cursor", "--json", ...additional]));
  const rawLimit = optionValue(args, "--limit");
  const limit = rawLimit === undefined ? DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new Error(`--limit must be an integer from 1 to ${maximum}`);
  }
  const options: ListOptions = { json: args.includes("--json"), limit };
  const cursor = optionValue(args, "--cursor");
  if (cursor) options.cursor = cursor;
  return options;
}

function assertKnownOptions(args: string[], options: ReadonlySet<string>): void {
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("-")) throw new Error(`unexpected argument: ${value}`);
    if (!options.has(value)) throw new Error(`unknown option: ${value}`);
    if (seen.has(value)) throw new Error(`duplicate option: ${value}`);
    seen.add(value);
    if (value !== "--json" && value !== "--include-archived") {
      index += 1;
      if (args[index] === undefined) throw new Error(`${value} requires a value`);
      if (options.has(args[index])) throw new Error(`${value} requires a value`);
    }
  }
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function renderMessages(
  page: Awaited<ReturnType<typeof getSlackConversationHistory>>,
  jsonOutput: boolean,
): ExecResult {
  if (jsonOutput) return json(page);
  const lines = ["TIMESTAMP\tAUTHOR\tTHREAD\tTEXT"];
  for (const message of page.items) {
    lines.push([
      message.ts,
      message.userId ?? message.botId ?? "-",
      message.threadTs ?? "-",
      message.text.replaceAll("\t", " ").replaceAll("\n", "\\n"),
    ].join("\t"));
  }
  appendCursor(lines, page.nextCursor);
  return ok(`${lines.join("\n")}\n`);
}

function appendCursor(lines: string[], cursor: string | undefined): void {
  if (cursor) lines.push(`next cursor: ${cursor}`);
}

function slackTargetIdentity(
  reader: SlackUserIdentity,
  botUserId: string,
): SlackTargetIdentity {
  return {
    workspace: { id: reader.teamId, name: reader.teamName },
    reader: { kind: "user", id: reader.actorId, name: reader.actorName },
    writer: { kind: "app", id: botUserId },
  };
}

function json(value: SlackTargetJsonOutput): ExecResult {
  return ok(`${JSON.stringify(value, (_key, item) => item === undefined ? undefined : item, 2)}\n`);
}

function ok(stdout: string): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function shellResult(result: BashExecResult): ShellExecResult {
  const output = result.stdout + result.stderr;
  if (result.exitCode === 0) {
    return {
      status: "completed",
      output,
      exitCode: 0,
      ok: true,
      pid: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
  return {
    status: "failed",
    output,
    error: result.stderr.trim() || `Command exited with code ${result.exitCode}`,
    exitCode: result.exitCode,
    ok: true,
    pid: 0,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function failed(error: string, sessionId?: string): ShellExecResult {
  const result: ShellExecResult = { status: "failed", output: "", error };
  if (sessionId) result.sessionId = sessionId;
  return result;
}

function abortMessage(signal: AbortSignal): string {
  return signal.reason instanceof Error ? signal.reason.message : "Slack command cancelled";
}

function withSignal(slackFetch: SlackFetch, signal: AbortSignal): SlackFetch {
  return async (request, init) => {
    const existing = init?.signal;
    return await slackFetch(request, {
      ...init,
      signal: existing ? AbortSignal.any([existing, signal]) : signal,
    });
  };
}

function decodeCommandStdin(value: ByteString, maxBytes: number): string {
  // just-bash's browser bundle represents pipeline bytes as a latin-1 string,
  // but does not export its typed decoding helpers. Decode that boundary here.
  const encoded = String(value);
  if (encoded.length > maxBytes) throw new Error("standard input exceeds Slack's message limit");
  const bytes = new Uint8Array(encoded.length);
  for (let index = 0; index < encoded.length; index += 1) {
    bytes[index] = encoded.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

function slackUsage(): string {
  return [
    "Usage: slack whoami [--json]",
    "Usage: slack conversations list [--types TYPES] [--include-archived] [--limit N] [--cursor CURSOR] [--json]",
    "Usage: slack conversations history --channel ID [--limit N] [--cursor CURSOR] [--json]",
    "Usage: slack conversations replies --channel ID --timestamp TS [--limit N] [--cursor CURSOR] [--json]",
    "Usage: slack messages send --channel ID [--thread TS] [--message TEXT] [--json]",
    "       printf '%s' TEXT | slack messages send --channel ID [--thread TS] [--json]",
    "Usage: slack reactions add --channel ID --timestamp TS --name EMOJI [--json]",
    "Usage: slack users list [--limit N] [--cursor CURSOR] [--json]",
    "Usage: slack users info --user ID [--json]",
    "",
    "Reads use the paired user's Slack visibility.",
    "Messages and reactions are performed by the GSV app.",
    "Messages identify the paired user's GSV.",
    "The app can post to public channels without joining.",
    "Invite GSV before reacting or mutating private channels.",
    "Use --json for scripts and pipelines.",
    "Posting here is external tool activity; `message send` remains canonical GSV delivery.",
    "",
  ].join("\n");
}
