import { defineCommand } from "just-bash";
import type { ExecResult } from "just-bash";
import type { KernelContext } from "../../../kernel/context";
import { resolveCallerOwnerUid } from "../../../kernel/context";
import {
  handleProcIpcCall,
  handleProcIpcSend,
  handleProcSpawn,
} from "../../../kernel/proc-handlers";
import { handleAccountList } from "../../../kernel/agents";
import type { SyscallName } from "../../../syscalls";
import type { ProcSpawnArgs } from "../../../syscalls/proc";
import type { Frame } from "../../../protocol/frames";
import { sendFrameToProcess } from "../../../shared/utils";
import { parseDurationMs, requireCommandCapability, requireShellOptionValue } from "./common";

export function buildProcCommand(ctx: KernelContext) {
  return defineCommand("proc", async (args): Promise<ExecResult> => {
    try {
      return await runProcCommand(args, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        stdout: "",
        stderr: `proc: ${message}\n`,
        exitCode: 1,
      };
    }
  });
}

async function runProcCommand(args: string[], ctx: KernelContext): Promise<ExecResult> {
  const [subcommand = "help", ...rest] = args;

  switch (subcommand) {
    case "help":
    case "--help":
    case "-h":
      return { stdout: procUsage(), stderr: "", exitCode: 0 };
    case "self": {
      if (!ctx.processId) {
        return { stdout: "", stderr: "proc self: no current process\n", exitCode: 1 };
      }
      return { stdout: `${ctx.processId}\n`, stderr: "", exitCode: 0 };
    }
    case "list": {
      requireCommandCapability(ctx, "proc.list");
      // Visibility is keyed on the owning human, not the run-as account: an
      // agent-backed shell must list its owner's processes, not the agent uid's.
      const list = ctx.procs.list(resolveCallerOwnerUid(ctx));
      const lines = ["PID\tSTATE\tRUN-AS\tLABEL"];
      for (const proc of list) {
        lines.push(`${proc.processId}\t${proc.state}\t${proc.username}\t${proc.label ?? ""}`);
      }
      return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
    }
    case "agents": {
      requireCommandCapability(ctx, "account.list");
      const json = rest.includes("--json");
      const unexpected = rest.find((arg) => arg !== "--json");
      if (unexpected) {
        throw new Error(`unexpected argument: ${unexpected}`);
      }
      const result = handleAccountList({}, ctx);
      if (json) {
        return { stdout: `${JSON.stringify(result, null, 2)}\n`, stderr: "", exitCode: 0 };
      }
      const lines = ["UID\tUSERNAME\tRELATION\tNAME"];
      for (const account of result.accounts) {
        lines.push([
          String(account.uid),
          account.username,
          account.relation,
          account.displayName,
        ].join("\t"));
      }
      return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
    }
    case "spawn": {
      requireCommandCapability(ctx, "proc.spawn");
      const parsed = parseProcSpawnCommand(rest);
      const result = await handleProcSpawn(parsed, ctx);
      if (!result.ok) {
        return { stdout: "", stderr: `proc spawn: ${result.error}\n`, exitCode: 1 };
      }
      return {
        stdout: [
          `pid=${result.pid}`,
          result.label ? `label=${quoteShellField(result.label)}` : "",
          `cwd=${quoteShellField(result.cwd)}`,
        ].filter(Boolean).join(" ") + "\n",
        stderr: "",
        exitCode: 0,
      };
    }
    case "segments": {
      requireCommandCapability(ctx, "proc.conversation.segments");
      const parsed = parseProcSegmentsCommand(rest, ctx);
      const result = await runProcConversationSyscall(ctx, parsed.pid, "proc.conversation.segments", {
        pid: parsed.pid,
        conversationId: parsed.conversationId,
      });
      if (!result.ok) {
        return { stdout: "", stderr: `proc segments: ${result.error}\n`, exitCode: 1 };
      }
      const lines = ["ID\tGEN\tFROM\tTO\tSUMMARY\tARCHIVE"];
      for (const segment of result.segments) {
        lines.push([
          segment.id,
          String(segment.generation),
          String(segment.fromMessageId),
          String(segment.toMessageId),
          segment.summaryMessageId === null ? "-" : String(segment.summaryMessageId),
          segment.archivePath,
        ].join("\t"));
      }
      return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
    }
    case "policy": {
      const parsed = parseProcPolicyCommand(rest, ctx);
      const call = parsed.set
        ? "proc.conversation.policy.set"
        : "proc.conversation.policy.get";
      requireCommandCapability(ctx, call);
      const result = await runProcConversationSyscall(ctx, parsed.pid, call, parsed);
      if (!result.ok) {
        return { stdout: "", stderr: `proc policy: ${result.error}\n`, exitCode: 1 };
      }
      const policy = result.policy;
      return {
        stdout: [
          `conversation=${policy.conversationId}`,
          `overflow=${policy.overflow}`,
          `compact_at=${policy.compactAtPressure}`,
          `keep_last=${policy.keepLast}`,
        ].join(" ") + "\n",
        stderr: "",
        exitCode: 0,
      };
    }
    case "segment": {
      requireCommandCapability(ctx, "proc.conversation.segment.read");
      const parsed = parseProcSegmentReadCommand(rest, ctx);
      const result = await runProcConversationSyscall(ctx, parsed.pid, "proc.conversation.segment.read", parsed);
      if (!result.ok) {
        return { stdout: "", stderr: `proc segment: ${result.error}\n`, exitCode: 1 };
      }
      return {
        stdout: formatProcSegmentReadResult(result, parsed.json),
        stderr: "",
        exitCode: 0,
      };
    }
    case "compact": {
      requireCommandCapability(ctx, "proc.conversation.compact");
      const parsed = parseProcCompactCommand(rest, ctx);
      const result = await runProcConversationSyscall(ctx, parsed.pid, "proc.conversation.compact", parsed);
      if (!result.ok) {
        return { stdout: "", stderr: `proc compact: ${result.error}\n`, exitCode: 1 };
      }
      return {
        stdout: [
          `segment_id=${result.segment.id}`,
          `archived=${result.archivedMessages}`,
          `archive=${result.archivedTo}`,
          `summary_message_id=${result.summaryMessageId}`,
        ].join(" ") + "\n",
        stderr: "",
        exitCode: 0,
      };
    }
    case "fork": {
      requireCommandCapability(ctx, "proc.conversation.fork");
      const parsed = parseProcForkCommand(rest, ctx);
      const result = await runProcConversationSyscall(ctx, parsed.pid, "proc.conversation.fork", parsed);
      if (!result.ok) {
        return { stdout: "", stderr: `proc fork: ${result.error}\n`, exitCode: 1 };
      }
      return {
        stdout: [
          `conversation_id=${result.targetConversation.id}`,
          `restored=${result.restoredMessages}`,
          `segment_id=${result.segment.id}`,
          `included_live_suffix=${result.includedLiveSuffix}`,
        ].join(" ") + "\n",
        stderr: "",
        exitCode: 0,
      };
    }
    case "send": {
      requireCommandCapability(ctx, "proc.ipc.send");
      const parsed = parseProcMessageCommand(rest, false);
      const result = await handleProcIpcSend(parsed, ctx);
      if (!result.ok) {
        return { stdout: "", stderr: `proc send: ${result.error}\n`, exitCode: 1 };
      }
      return {
        stdout: `accepted run_id=${result.runId} queued=${result.queued === true}\n`,
        stderr: "",
        exitCode: 0,
      };
    }
    case "call": {
      requireCommandCapability(ctx, "proc.ipc.call");
      const parsed = parseProcMessageCommand(rest, true);
      const result = await handleProcIpcCall(parsed, ctx);
      if (!result.ok) {
        return { stdout: "", stderr: `proc call: ${result.error}\n`, exitCode: 1 };
      }
      return {
        stdout: [
          `call_id=${result.callId}`,
          `run_id=${result.runId}`,
          `queued=${result.queued === true}`,
          `deadline=${new Date(result.deadlineAt).toISOString()}`,
        ].join(" ") + "\n",
        stderr: "",
        exitCode: 0,
      };
    }
    default:
      return { stdout: "", stderr: `proc: unknown command: ${subcommand}\n${procUsage()}`, exitCode: 1 };
  }
}

async function runProcConversationSyscall(
  ctx: KernelContext,
  pid: string,
  call: SyscallName,
  args: Record<string, unknown>,
): Promise<any> {
  const identity = ctx.identity!;
  const proc = ctx.procs.get(pid);
  if (!proc) {
    throw new Error(`Process not found: ${pid}`);
  }
  if (proc.uid !== identity.process.uid && identity.process.uid !== 0) {
    throw new Error(`Permission denied: cannot access process ${pid}`);
  }

  const frame = {
    type: "req",
    id: crypto.randomUUID(),
    call,
    args,
  } as Frame;
  const response = await sendFrameToProcess(pid, frame);
  if (!response || response.type !== "res") {
    throw new Error("invalid process response");
  }
  if (!response.ok) {
    throw new Error(response.error.message);
  }
  return response.data;
}

function parseProcSpawnCommand(args: string[]): ProcSpawnArgs {
  let runAs: string | undefined;
  let label: string | undefined;
  let prompt: string | undefined;
  let parentPid: string | undefined;
  let cwd: string | undefined;
  let assignment: ProcSpawnArgs["assignment"];
  let mounts: ProcSpawnArgs["mounts"];
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--json") {
      return JSON.parse(requireShellOptionValue(args[index + 1], current)) as ProcSpawnArgs;
    }
    if (current === "--as" || current === "--run-as") {
      index += 1;
      runAs = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--label") {
      index += 1;
      label = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--prompt") {
      index += 1;
      prompt = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--parent" || current === "--parent-pid") {
      index += 1;
      parentPid = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--cwd") {
      index += 1;
      cwd = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--assignment-json") {
      index += 1;
      assignment = JSON.parse(requireShellOptionValue(args[index], current)) as ProcSpawnArgs["assignment"];
      continue;
    }
    if (current === "--mounts-json") {
      index += 1;
      mounts = JSON.parse(requireShellOptionValue(args[index], current)) as ProcSpawnArgs["mounts"];
      continue;
    }
    positional.push(current);
  }

  const positionalPrompt = positional.join(" ").trim();
  const finalPrompt = prompt ?? (positionalPrompt || undefined);
  return {
    ...(runAs ? { runAs } : {}),
    ...(label ? { label } : {}),
    ...(finalPrompt ? { prompt: finalPrompt } : {}),
    ...(parentPid ? { parentPid } : {}),
    ...(cwd ? { cwd } : {}),
    ...(assignment ? { assignment } : {}),
    ...(mounts ? { mounts } : {}),
  };
}

function quoteShellField(value: string): string {
  return JSON.stringify(value);
}

function parseProcSegmentsCommand(args: string[], ctx: KernelContext): {
  pid: string;
  conversationId?: string;
} {
  const parsed = parseProcConversationOptions(args, ctx);
  if (parsed.positional.length > 0) {
    throw new Error(`unexpected argument: ${parsed.positional[0]}`);
  }
  return {
    pid: parsed.pid,
    ...(parsed.conversationId ? { conversationId: parsed.conversationId } : {}),
  };
}

function parseProcPolicyCommand(args: string[], ctx: KernelContext): {
  pid: string;
  conversationId?: string;
  overflow?: string;
  compactAtPressure?: number;
  keepLast?: number;
  set: boolean;
} {
  let pid: string | undefined;
  let conversationId: string | undefined;
  let overflow: string | undefined;
  let compactAtPressure: number | undefined;
  let keepLast: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--pid") {
      index += 1;
      pid = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--conversation") {
      index += 1;
      conversationId = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--overflow") {
      index += 1;
      overflow = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--compact-at") {
      index += 1;
      compactAtPressure = parsePressureShellNumber(requireShellOptionValue(args[index], current), current);
      continue;
    }
    if (current === "--keep-last") {
      index += 1;
      keepLast = parseNonNegativeShellInteger(requireShellOptionValue(args[index], current), current);
      continue;
    }
    throw new Error(`unexpected argument: ${current}`);
  }

  return {
    pid: pid ?? requireCurrentProcessId(ctx),
    ...(conversationId ? { conversationId } : {}),
    ...(overflow ? { overflow } : {}),
    ...(compactAtPressure !== undefined ? { compactAtPressure } : {}),
    ...(keepLast !== undefined ? { keepLast } : {}),
    set: overflow !== undefined || compactAtPressure !== undefined || keepLast !== undefined,
  };
}

function parseProcSegmentReadCommand(args: string[], ctx: KernelContext): {
  pid: string;
  conversationId?: string;
  segmentId: string;
  limit?: number;
  offset?: number;
  json?: boolean;
} {
  let pid: string | undefined;
  let conversationId: string | undefined;
  let limit: number | undefined;
  let offset: number | undefined;
  let json = false;
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--pid") {
      index += 1;
      pid = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--conversation") {
      index += 1;
      conversationId = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--limit") {
      index += 1;
      limit = parsePositiveShellInteger(requireShellOptionValue(args[index], current), current);
      continue;
    }
    if (current === "--offset") {
      index += 1;
      offset = parseNonNegativeShellInteger(requireShellOptionValue(args[index], current), current);
      continue;
    }
    if (current === "--json") {
      json = true;
      continue;
    }
    positional.push(current);
  }

  const segmentId = positional.shift();
  if (!segmentId) {
    throw new Error("missing segment id");
  }
  if (positional.length > 0) {
    throw new Error(`unexpected argument: ${positional[0]}`);
  }

  return {
    pid: pid ?? requireCurrentProcessId(ctx),
    segmentId,
    ...(conversationId ? { conversationId } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(offset !== undefined ? { offset } : {}),
    ...(json ? { json } : {}),
  };
}

function parseProcCompactCommand(args: string[], ctx: KernelContext): {
  pid: string;
  conversationId?: string;
  summary?: string;
  generateSummary?: boolean;
  keepLast?: number;
  throughMessageId?: number;
} {
  let pid: string | undefined;
  let conversationId: string | undefined;
  let summary: string | undefined;
  let generateSummary = false;
  let keepLast: number | undefined;
  let throughMessageId: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--pid") {
      index += 1;
      pid = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--conversation") {
      index += 1;
      conversationId = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--summary") {
      index += 1;
      summary = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--generate-summary") {
      generateSummary = true;
      continue;
    }
    if (current === "--keep-last") {
      index += 1;
      keepLast = parseNonNegativeShellInteger(requireShellOptionValue(args[index], current), current);
      continue;
    }
    if (current === "--through-message-id") {
      index += 1;
      throughMessageId = parsePositiveShellInteger(requireShellOptionValue(args[index], current), current);
      continue;
    }
    throw new Error(`unexpected argument: ${current}`);
  }

  if (summary && generateSummary) {
    throw new Error("use either --summary or --generate-summary, not both");
  }
  if ((keepLast === undefined) === (throughMessageId === undefined)) {
    throw new Error("provide exactly one of --keep-last or --through-message-id");
  }

  return {
    pid: pid ?? requireCurrentProcessId(ctx),
    ...(conversationId ? { conversationId } : {}),
    ...(summary ? { summary } : { generateSummary: true }),
    ...(keepLast !== undefined ? { keepLast } : {}),
    ...(throughMessageId !== undefined ? { throughMessageId } : {}),
  };
}

function parseProcForkCommand(args: string[], ctx: KernelContext): {
  pid: string;
  conversationId?: string;
  segmentId?: string;
  throughMessageId?: number;
  targetConversationId?: string;
  title?: string;
  includeLiveSuffix?: boolean;
} {
  let pid: string | undefined;
  let conversationId: string | undefined;
  let throughMessageId: number | undefined;
  let targetConversationId: string | undefined;
  let title: string | undefined;
  let includeLiveSuffix = true;
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--pid") {
      index += 1;
      pid = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--conversation") {
      index += 1;
      conversationId = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--message-id") {
      index += 1;
      throughMessageId = parsePositiveShellInteger(requireShellOptionValue(args[index], current), current);
      continue;
    }
    if (current === "--target") {
      index += 1;
      targetConversationId = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--title") {
      index += 1;
      title = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--segment-only") {
      includeLiveSuffix = false;
      continue;
    }
    positional.push(current);
  }

  const segmentId = positional.shift();
  if (Boolean(segmentId) === (throughMessageId !== undefined)) {
    throw new Error("provide exactly one of segment id or --message-id");
  }
  if (positional.length > 0) {
    throw new Error(`unexpected argument: ${positional[0]}`);
  }

  return {
    pid: pid ?? requireCurrentProcessId(ctx),
    ...(segmentId ? { segmentId } : {}),
    ...(throughMessageId !== undefined ? { throughMessageId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(targetConversationId ? { targetConversationId } : {}),
    ...(title ? { title } : {}),
    ...(includeLiveSuffix ? {} : { includeLiveSuffix: false }),
  };
}

function parseProcConversationOptions(args: string[], ctx: KernelContext): {
  pid: string;
  conversationId?: string;
  positional: string[];
} {
  let pid: string | undefined;
  let conversationId: string | undefined;
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--pid") {
      index += 1;
      pid = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--conversation") {
      index += 1;
      conversationId = requireShellOptionValue(args[index], current);
      continue;
    }
    positional.push(current);
  }

  return {
    pid: pid ?? requireCurrentProcessId(ctx),
    ...(conversationId ? { conversationId } : {}),
    positional,
  };
}

function requireCurrentProcessId(ctx: KernelContext): string {
  if (!ctx.processId) {
    throw new Error("missing --pid outside a process");
  }
  return ctx.processId;
}

function parseNonNegativeShellInteger(value: string, option: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== value.trim()) {
    throw new Error(`${option} must be a non-negative integer`);
  }
  return parsed;
}

function parsePositiveShellInteger(value: string, option: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== value.trim()) {
    throw new Error(`${option} must be a positive integer`);
  }
  return parsed;
}

function parsePressureShellNumber(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    throw new Error(`${option} must be > 0 and <= 1`);
  }
  return parsed;
}

function parseProcMessageCommand(args: string[], allowTimeout: boolean): {
  pid: string;
  conversationId?: string;
  message: string;
  metadata?: Record<string, unknown>;
  timeoutMs?: number;
} {
  let conversationId: string | undefined;
  let metadata: Record<string, unknown> | undefined;
  let timeoutMs: number | undefined;
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--conversation") {
      index += 1;
      conversationId = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--metadata-json") {
      index += 1;
      const parsed = JSON.parse(requireShellOptionValue(args[index], current));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("--metadata-json must be a JSON object");
      }
      metadata = parsed as Record<string, unknown>;
      continue;
    }
    if (current === "--timeout") {
      if (!allowTimeout) {
        throw new Error("--timeout is only valid for proc call");
      }
      index += 1;
      timeoutMs = parseDurationMs(requireShellOptionValue(args[index], current));
      continue;
    }
    positional.push(current);
  }

  const pid = positional.shift();
  if (!pid) {
    throw new Error("missing pid");
  }
  const message = positional.join(" ").trim();
  if (!message) {
    throw new Error("missing message");
  }
  return {
    pid,
    message,
    ...(conversationId ? { conversationId } : {}),
    ...(metadata ? { metadata } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

function formatProcSegmentReadResult(result: any, json: boolean | undefined): string {
  if (json) {
    return `${JSON.stringify(result, null, 2)}\n`;
  }

  const lines = [
    `Segment ${result.segment.id}`,
    `Conversation: ${result.conversationId}`,
    `Messages: ${result.messages.length}/${result.messageCount}${result.truncated ? " (truncated)" : ""}`,
    "",
  ];
  for (let index = 0; index < result.messages.length; index += 1) {
    const message = result.messages[index];
    const timestamp = typeof message.timestamp === "number"
      ? new Date(message.timestamp).toISOString()
      : "-";
    lines.push(`[${index + 1}] ${message.role} ${timestamp}`);
    lines.push(formatProcHistoryContent(message.content));
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function formatProcHistoryContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text;
    }
    if (typeof record.output === "string") {
      return record.output;
    }
  }
  return JSON.stringify(content, null, 2);
}

function procUsage(): string {
  return [
    "Usage:",
    "  proc self",
    "  proc list",
    "  proc agents [--json]",
    "  proc spawn [--as ACCOUNT] [--label LABEL] [--prompt TEXT] [--parent PID] [--cwd PATH] <prompt>",
    "  proc spawn --json JSON",
    "  proc segments [--pid PID] [--conversation id]",
    "  proc policy [--pid PID] [--conversation id] [--overflow auto-compact|fail] [--compact-at N] [--keep-last N]",
    "  proc segment <segment-id> [--pid PID] [--conversation id] [--limit N] [--offset N] [--json]",
    "  proc compact [--pid PID] [--conversation id] (--keep-last N | --through-message-id ID) [--summary TEXT | --generate-summary]",
    "  proc fork (<segment-id> | --message-id ID) [--pid PID] [--conversation id] [--target id] [--title TITLE] [--segment-only]",
    "  proc send <pid> [--conversation id] [--metadata-json json] <message>",
    "  proc call <pid> [--conversation id] [--metadata-json json] [--timeout 60s] <message>",
    "",
    "proc compact archives a conversation prefix and records a segment. Without",
    "--summary, it asks the process model to generate the visible summary.",
    "proc fork branches a conversation from a message or restores a compacted segment.",
    "",
    "proc send is asynchronous mail. proc call is bounded: the caller receives",
    "an ipc.reply or ipc.timeout message in its default conversation.",
    "",
  ].join("\n");
}
