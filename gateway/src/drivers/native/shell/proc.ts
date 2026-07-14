import { defineCommand } from "just-bash";
import type { ExecResult } from "just-bash";
import type { KernelContext } from "../../../kernel/context";
import { resolveCallerOwnerUid } from "../../../kernel/context";
import {
  forwardToProcess,
  handleProcIpcCall,
  handleProcIpcSend,
  handleProcSpawn,
} from "../../../kernel/proc-handlers";
import { handleAccountList } from "../../../kernel/agents";
import type { ArgsOf, ResultOf, SyscallName } from "../../../syscalls";
import type { ProcSpawnArgs } from "@humansandmachines/gsv/protocol";
import type { Frame, RequestFrame } from "../../../protocol/frames";
import { sendFrameToProcess } from "../../../shared/utils";
import { parseDurationMs, requireCommandCapability, requireShellOptionValue } from "./common";

const DEFAULT_HISTORY_CONTENT_CHARS = 4000;

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
    case "reset": {
      requireCommandCapability(ctx, "proc.reset");
      const result = await runProcLifecycleSyscall(
        ctx,
        "proc.reset",
        parseProcResetCommand(rest, ctx),
      );
      if (!result.ok) {
        return { stdout: "", stderr: `proc reset: ${result.error}\n`, exitCode: 1 };
      }
      return {
        stdout: formatProcLifecycleResult(result),
        stderr: "",
        exitCode: 0,
      };
    }
    case "kill": {
      requireCommandCapability(ctx, "proc.kill");
      const result = await runProcLifecycleSyscall(
        ctx,
        "proc.kill",
        parseProcKillCommand(rest),
      );
      if (!result.ok) {
        return { stdout: "", stderr: `proc kill: ${result.error}\n`, exitCode: 1 };
      }
      return {
        stdout: formatProcLifecycleResult(result),
        stderr: "",
        exitCode: 0,
      };
    }
    case "delegate": {
      requireCommandCapability(ctx, "proc.spawn");
      requireCommandCapability(ctx, "proc.ipc.call");
      if (!ctx.processId) {
        return {
          stdout: "",
          stderr: "proc delegate: proc.ipc.call requires a process caller\n",
          exitCode: 1,
        };
      }
      const parsed = parseProcDelegateCommand(rest, ctx);
      const label = parsed.label ?? summarizeDelegateLabel(parsed.message);
      const spawned = await handleProcSpawn({
        ...(parsed.runAs ? { runAs: parsed.runAs } : {}),
        interactive: false,
        label,
        ...(parsed.parentPid ? { parentPid: parsed.parentPid } : {}),
        ...(parsed.cwd ? { cwd: parsed.cwd } : {}),
      }, ctx);
      if (!spawned.ok) {
        return { stdout: "", stderr: `proc delegate: ${spawned.error}\n`, exitCode: 1 };
      }
      let result: Awaited<ReturnType<typeof handleProcIpcCall>>;
      try {
        result = await handleProcIpcCall({
          pid: spawned.pid,
          message: parsed.message,
          ...(parsed.conversationId ? { conversationId: parsed.conversationId } : {}),
          ...(parsed.timeoutMs !== undefined ? { timeoutMs: parsed.timeoutMs } : {}),
        }, ctx);
      } catch (error) {
        return delegateFailureResult(ctx, spawned.pid, error);
      }
      if (!result.ok) {
        return delegateFailureResult(ctx, spawned.pid, result.error);
      }
      return {
        stdout: [
          "status=in_progress",
          `task=${result.callId}`,
          `pid=${result.pid}`,
          `run_id=${result.runId}`,
          `queued=${result.queued === true}`,
          `deadline=${new Date(result.deadlineAt).toISOString()}`,
          `label=${quoteShellField(label)}`,
        ].join(" ") + "\n",
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
    case "history": {
      requireCommandCapability(ctx, "proc.history");
      const parsed = parseProcHistoryCommand(rest, ctx);
      const result = await runProcConversationSyscall(ctx, parsed.pid, "proc.history", {
        pid: parsed.pid,
        ...(parsed.conversationId ? { conversationId: parsed.conversationId } : {}),
        ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
        ...(parsed.offset !== undefined ? { offset: parsed.offset } : {}),
        ...(parsed.beforeMessageId !== undefined ? { beforeMessageId: parsed.beforeMessageId } : {}),
        ...(parsed.afterMessageId !== undefined ? { afterMessageId: parsed.afterMessageId } : {}),
        ...(parsed.tail ? { tail: true } : {}),
      });
      if (!result.ok) {
        return { stdout: "", stderr: `proc history: ${result.error}\n`, exitCode: 1 };
      }
      return {
        stdout: formatProcHistoryResult(result, {
          json: parsed.json,
          full: parsed.full,
          maxContentChars: parsed.maxContentChars,
        }),
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
  const processOwnerUid = proc.ownerUid ?? proc.uid;
  const callerOwnerUid = resolveCallerOwnerUid(ctx);
  if (processOwnerUid !== callerOwnerUid && identity.process.uid !== 0) {
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

type ProcLifecycleCall = "proc.reset" | "proc.kill";

async function runProcLifecycleSyscall<S extends ProcLifecycleCall>(
  ctx: KernelContext,
  call: S,
  args: ArgsOf<S>,
): Promise<ResultOf<S>> {
  const frame = {
    type: "req",
    id: crypto.randomUUID(),
    call,
    args,
  } as RequestFrame;
  const response = await forwardToProcess(frame, ctx);
  return response.data as ResultOf<S>;
}

async function delegateFailureResult(
  ctx: KernelContext,
  pid: string,
  originalError: unknown,
): Promise<ExecResult> {
  let error = originalError instanceof Error ? originalError.message : String(originalError);
  const rollbackErrors: string[] = [];
  let conversationId: string | null = null;
  try {
    const conversation = ctx.conversations.getByActivePid(pid);
    conversationId = conversation?.conversationId ?? null;
  } catch (lookupError) {
    rollbackErrors.push(
      `conversation lookup failed: ${lookupError instanceof Error ? lookupError.message : String(lookupError)}`,
    );
  }

  let killed = false;
  try {
    const rollback = await runProcLifecycleSyscall(ctx, "proc.kill", {
      pid,
      archive: false,
    });
    if (!rollback.ok) {
      throw new Error(rollback.error);
    }
    killed = true;
  } catch (killError) {
    rollbackErrors.push(killError instanceof Error ? killError.message : String(killError));
  }

  if (killed && conversationId) {
    try {
      if (!ctx.conversations.remove(conversationId)) {
        throw new Error(`failed to remove conversation ${conversationId}`);
      }
    } catch (conversationError) {
      rollbackErrors.push(
        conversationError instanceof Error ? conversationError.message : String(conversationError),
      );
    }
  }

  if (rollbackErrors.length > 0) {
    error += `; rollback failed: ${rollbackErrors.join("; ")}`;
  }
  return { stdout: "", stderr: `proc delegate: ${error}\n`, exitCode: 1 };
}

function parseProcSpawnCommand(args: string[]): ProcSpawnArgs {
  let runAs: string | undefined;
  let label: string | undefined;
  let prompt: string | undefined;
  let parentPid: string | undefined;
  let cwd: string | undefined;
  let interactive: boolean | undefined;
  let assignment: ProcSpawnArgs["assignment"];
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--") {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (current === "--json") {
      if (index !== 0 || args.length !== 2) {
        throw new Error("--json must be the only proc spawn option");
      }
      return {
        ...JSON.parse(requireShellOptionValue(args[index + 1], current)) as ProcSpawnArgs,
        fresh: true,
      };
    }
    if (current === "--as" || current === "--run-as") {
      index += 1;
      runAs = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--profile") {
      throw new Error("--profile is no longer supported; use --as ACCOUNT");
    }
    if (current === "--non-interactive" || current === "--background") {
      interactive = false;
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
      parentPid = normalizeProcPid(requireShellOptionValue(args[index], current));
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
    if (current.startsWith("-")) {
      throw new Error(`unexpected option: ${current}`);
    }
    positional.push(current);
  }

  const positionalPrompt = positional.join(" ").trim();
  const finalPrompt = prompt ?? (positionalPrompt || undefined);
  return {
    fresh: true,
    ...(runAs ? { runAs } : {}),
    ...(label ? { label } : {}),
    ...(finalPrompt ? { prompt: finalPrompt } : {}),
    ...(parentPid ? { parentPid } : {}),
    ...(cwd ? { cwd } : {}),
    ...(interactive !== undefined ? { interactive } : {}),
    ...(assignment ? { assignment } : {}),
  };
}

function parseProcResetCommand(
  args: string[],
  ctx: KernelContext,
): ArgsOf<"proc.reset"> {
  let pid = ctx.processId;
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--pid") {
      index += 1;
      pid = normalizeProcPid(requireShellOptionValue(args[index], current));
      continue;
    }
    throw new Error(`unexpected argument: ${current}`);
  }
  return pid ? { pid } : {};
}

function parseProcKillCommand(args: string[]): ArgsOf<"proc.kill"> {
  let archive = true;
  const positional: string[] = [];
  for (const current of args) {
    if (current === "--no-archive") {
      archive = false;
      continue;
    }
    positional.push(current);
  }
  const pid = positional.shift();
  if (!pid) {
    throw new Error("missing pid");
  }
  if (positional.length > 0) {
    throw new Error(`unexpected argument: ${positional[0]}`);
  }
  return { pid: normalizeProcPid(pid), archive };
}

function quoteShellField(value: string): string {
  return JSON.stringify(value);
}

function formatProcLifecycleResult(result: {
  pid: string;
  archivedMessages: number;
  archivedTo?: string;
}): string {
  return [
    `pid=${result.pid}`,
    `archived=${result.archivedMessages}`,
    result.archivedTo ? `archive=${quoteShellField(result.archivedTo)}` : "",
  ].filter(Boolean).join(" ") + "\n";
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

function parseProcHistoryCommand(args: string[], ctx: KernelContext): {
  pid: string;
  conversationId?: string;
  limit?: number;
  offset?: number;
  beforeMessageId?: number;
  afterMessageId?: number;
  tail?: boolean;
  json?: boolean;
  full?: boolean;
  maxContentChars: number;
} {
  let pid: string | undefined;
  let conversationId: string | undefined;
  let limit: number | undefined;
  let offset: number | undefined;
  let beforeMessageId: number | undefined;
  let afterMessageId: number | undefined;
  let tail = false;
  let json = false;
  let full = false;
  let maxContentChars = DEFAULT_HISTORY_CONTENT_CHARS;

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
    if (current === "--before-message-id") {
      index += 1;
      beforeMessageId = parsePositiveShellInteger(requireShellOptionValue(args[index], current), current);
      continue;
    }
    if (current === "--after-message-id") {
      index += 1;
      afterMessageId = parsePositiveShellInteger(requireShellOptionValue(args[index], current), current);
      continue;
    }
    if (current === "--tail") {
      tail = true;
      continue;
    }
    if (current === "--json") {
      json = true;
      continue;
    }
    if (current === "--full") {
      full = true;
      continue;
    }
    if (current === "--max-content-chars") {
      index += 1;
      maxContentChars = parsePositiveShellInteger(requireShellOptionValue(args[index], current), current);
      continue;
    }
    throw new Error(`unexpected argument: ${current}`);
  }

  return {
    pid: pid ?? requireCurrentProcessId(ctx),
    ...(conversationId ? { conversationId } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(offset !== undefined ? { offset } : {}),
    ...(beforeMessageId !== undefined ? { beforeMessageId } : {}),
    ...(afterMessageId !== undefined ? { afterMessageId } : {}),
    ...(tail ? { tail } : {}),
    ...(json ? { json } : {}),
    ...(full ? { full } : {}),
    maxContentChars,
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
    pid: normalizeProcPid(pid),
    message,
    ...(conversationId ? { conversationId } : {}),
    ...(metadata ? { metadata } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

function parseProcDelegateCommand(args: string[], ctx: KernelContext): {
  runAs?: string;
  label?: string;
  parentPid?: string;
  cwd?: string;
  conversationId?: string;
  timeoutMs?: number;
  message: string;
} {
  let runAs: string | undefined;
  let label: string | undefined;
  let parentPid: string | undefined = ctx.processId;
  let cwd: string | undefined;
  let conversationId: string | undefined;
  let timeoutMs: number | undefined;
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
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
    if (current === "--parent" || current === "--parent-pid") {
      index += 1;
      parentPid = normalizeProcPid(requireShellOptionValue(args[index], current));
      continue;
    }
    if (current === "--cwd") {
      index += 1;
      cwd = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--conversation") {
      index += 1;
      conversationId = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--timeout") {
      index += 1;
      timeoutMs = parseDurationMs(requireShellOptionValue(args[index], current));
      continue;
    }
    positional.push(current);
  }

  const message = positional.join(" ").trim();
  if (!message) {
    throw new Error("missing delegated task");
  }
  return {
    ...(runAs ? { runAs } : {}),
    ...(label ? { label } : {}),
    ...(parentPid ? { parentPid } : {}),
    ...(cwd ? { cwd } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    message,
  };
}

function normalizeProcPid(pid: string): string {
  const trimmed = pid.trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)
    ? `proc:${trimmed}`
    : trimmed;
}

function summarizeDelegateLabel(message: string): string {
  const firstLine = message.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return firstLine.length <= 48 ? firstLine || "delegated task" : `${firstLine.slice(0, 45)}...`;
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

function formatProcHistoryResult(
  result: any,
  options: { json?: boolean; full?: boolean; maxContentChars: number },
): string {
  if (options.json) {
    return `${JSON.stringify(result, null, 2)}\n`;
  }

  const lines = [
    `History ${result.pid}`,
    `Conversation: ${result.conversationId ?? "default"}`,
    `Messages: ${result.messages.length}/${result.messageCount}${result.truncated ? " (truncated)" : ""}`,
  ];
  if (result.activeRunId) {
    lines.push(`Active run: ${result.activeRunId} (${result.activeConversationId ?? "default"})`);
  }
  if (result.pendingHil) {
    lines.push(`Pending HIL: ${result.pendingHil.requestId} ${result.pendingHil.toolName}`);
  }
  if (result.context) {
    const context = result.context;
    const pressure = typeof context.pressure === "number"
      ? `${Math.round(context.pressure * 100)}%`
      : "unknown";
    lines.push(`Context: ${context.level ?? "unknown"} pressure=${pressure}`);
  }
  lines.push("");

  for (let index = 0; index < result.messages.length; index += 1) {
    const message = result.messages[index];
    const timestamp = typeof message.timestamp === "number"
      ? new Date(message.timestamp).toISOString()
      : "-";
    const id = message.id === undefined ? String(index + 1) : `#${message.id}`;
    const run = typeof message.runId === "string" ? ` run=${message.runId}` : "";
    lines.push(`[${id}] ${message.role} ${timestamp}${run}`);
    const content = formatProcHistoryContent(message.content);
    lines.push(options.full ? content : truncateProcHistoryContent(content, options.maxContentChars));
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
    if (typeof record.text === "string" && record.text.trim()) {
      return record.text;
    }
    if (typeof record.output === "string") {
      return record.output;
    }
  }
  return JSON.stringify(content, null, 2);
}

function truncateProcHistoryContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }
  return `${content.slice(0, maxChars)}\n...[truncated ${content.length - maxChars} chars; use --full or --json to inspect all content]`;
}

function procUsage(): string {
  return [
    "Usage:",
    "  proc self",
    "  proc list",
    "  proc agents [--json]",
    "  proc spawn [--as ACCOUNT] [--non-interactive] [--label LABEL] [--prompt TEXT] [--parent PID] [--cwd PATH] [--] [prompt]",
    "  proc spawn --json JSON",
    "  proc reset [--pid PID]",
    "  proc kill PID [--no-archive]",
    "  proc delegate [--as ACCOUNT] [--label LABEL] [--parent PID] [--cwd PATH] [--timeout 10m] <task>",
    "  proc segments [--pid PID] [--conversation id]",
    "  proc policy [--pid PID] [--conversation id] [--overflow auto-compact|fail] [--compact-at N] [--keep-last N]",
    "  proc history [--pid PID] [--conversation id] [--tail] [--limit N] [--offset N] [--json] [--full]",
    "  proc segment <segment-id> [--pid PID] [--conversation id] [--limit N] [--offset N] [--json]",
    "  proc compact [--pid PID] [--conversation id] (--keep-last N | --through-message-id ID) [--summary TEXT | --generate-summary]",
    "  proc fork (<segment-id> | --message-id ID) [--pid PID] [--conversation id] [--target id] [--title TITLE] [--segment-only]",
    "  proc send <pid> [--conversation id] [--metadata-json json] <message>",
    "  proc call <pid> [--conversation id] [--metadata-json json] [--timeout 60s] <message>",
    "",
    "proc compact archives a conversation prefix and records a segment. Without",
    "--summary, it asks the process model to generate the visible summary.",
    "proc fork branches a conversation from a message or restores a compacted segment.",
    "proc history reads the live transcript for this process or another visible process.",
    "",
    "proc delegate creates a child process for bounded work and returns a task",
    "handle immediately. proc send is asynchronous mail. proc call sends bounded",
    "work to an existing process; replies arrive as delegated task events.",
    "",
  ].join("\n");
}
