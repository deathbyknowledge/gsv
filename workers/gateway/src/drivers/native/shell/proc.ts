import { defineCommand } from "./command";
import type { ExecResult } from "just-bash";
import type { KernelContext } from "../../../kernel/context";
import { resolveCallerOwnerUid } from "../../../kernel/context";
import {
  forwardToProcess,
  handleProcFork,
  handleProcIpcCall,
  handleProcIpcSend,
  handleProcSpawn,
  resolveIpcCallTimeoutMs,
} from "../../../kernel/proc-handlers";
import {
  handleResponsibilityGet,
  handleResponsibilityUpdate,
} from "../../../kernel/responsibilities";
import { handleAccountList } from "../../../kernel/agents";
import type { ArgsOf, ResultOf } from "../../../syscalls";
import type {
  JsonObject,
  JsonValue,
  ProcHistoryMessage,
  ProcHistoryOverflowPolicy,
  ProcSpawnArgs,
  ResponsibilityRecord,
} from "@humansandmachines/gsv/protocol";
import {
  jsonObjectSchema,
  jsonValueSchema,
} from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import type { RequestFrame } from "../../../protocol/frames";
import { parseDurationMs, requireCommandCapability, requireShellOptionValue } from "./common";

const DEFAULT_HISTORY_CONTENT_CHARS = 4000;

const procSpawnArgsSchema = z.strictObject({
  runAs: z.string().optional(),
  interactive: z.boolean().optional(),
  label: z.string().optional(),
  prompt: z.string().optional(),
  parentPid: z.string().optional(),
  cwd: z.string().optional(),
});
const historyDisplayObjectSchema = z.object({
  text: z.string().optional(),
  output: z.string().optional(),
});

type ProcHistoryOk = Extract<ResultOf<"proc.history">, { ok: true }>;
type ProcSegmentReadOk = Extract<
  ResultOf<"proc.history.segment.read">,
  { ok: true }
>;
type ParsedProcSegments = { pid: string };
type ParsedProcPolicy = {
  pid: string;
  overflow?: ProcHistoryOverflowPolicy;
  compactAtPressure?: number;
  compactToPressure?: number;
  set: boolean;
};
type ParsedProcSegmentRead = {
  pid: string;
  segmentId: string;
  limit?: number;
  offset?: number;
  json?: boolean;
};
type ParsedProcHistory = {
  pid: string;
  limit?: number;
  offset?: number;
  beforeMessageId?: number;
  afterMessageId?: number;
  tail?: boolean;
  json?: boolean;
  full?: boolean;
  maxContentChars: number;
};
type ParsedProcCompact = {
  pid: string;
  summary?: string;
  generateSummary?: boolean;
  targetPressure?: number;
  keepLast?: number;
  throughMessageId?: number;
};
type ParsedProcFork = {
  pid: string;
  segmentId?: string;
  throughMessageId?: number;
  label?: string;
  includeLiveSuffix?: boolean;
};
type ParsedProcProcessOptions = {
  pid: string;
  positional: string[];
};
type ParsedProcDelegate = {
  runAs?: string;
  label?: string;
  parentPid?: string;
  cwd?: string;
  checkInMs?: number;
  responsibilityId?: string;
  message: string;
};
type DelegatedResponsibilityRollback = {
  original: ResponsibilityRecord;
  delegatedRevision?: number;
};

const DEFAULT_DELEGATION_CHECK_IN_MS = 10 * 60_000;
type ProcHistoryFormatOptions = {
  json?: boolean;
  full?: boolean;
  maxContentChars: number;
};
type ProcLifecycleSuccess = {
  pid: string;
  archivedMessages: number;
  archivedTo?: string;
};

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
      let responsibilityRollback: DelegatedResponsibilityRollback | undefined;
      if (parsed.responsibilityId) {
        requireCommandCapability(ctx, "r12y.get");
        requireCommandCapability(ctx, "r12y.update");
        responsibilityRollback = {
          original: handleResponsibilityGet({ id: parsed.responsibilityId }, ctx)
            .responsibility,
        };
      }
      const label = parsed.label ?? summarizeDelegateLabel(parsed.message);
      const spawnArgs: ProcSpawnArgs = {
        interactive: false,
        label,
      };
      if (parsed.runAs) spawnArgs.runAs = parsed.runAs;
      if (parsed.parentPid) spawnArgs.parentPid = parsed.parentPid;
      if (parsed.cwd) spawnArgs.cwd = parsed.cwd;
      const spawned = await handleProcSpawn(spawnArgs, ctx);
      if (!spawned.ok) {
        return { stdout: "", stderr: `proc delegate: ${spawned.error}\n`, exitCode: 1 };
      }
      const checkInMs = resolveIpcCallTimeoutMs(
        parsed.checkInMs ?? DEFAULT_DELEGATION_CHECK_IN_MS,
      );
      let result: Awaited<ReturnType<typeof handleProcIpcCall>>;
      try {
        const callArgs: ArgsOf<"proc.ipc.call"> = {
          pid: spawned.pid,
          message: parsed.message,
          timeoutMs: checkInMs,
        };
        if (parsed.responsibilityId) {
          callArgs.metadata = { responsibilityId: parsed.responsibilityId };
        }
        const callOptions: NonNullable<Parameters<typeof handleProcIpcCall>[2]> = {
          superviseAfterTimeout: true,
          responsibilityId: parsed.responsibilityId,
        };
        if (responsibilityRollback) {
          callOptions.onSupervisionScheduled = async (deadlineAt) => {
            const delegated = await handleResponsibilityUpdate({
              id: responsibilityRollback.original.id,
              expectedRevision: responsibilityRollback.original.revision,
              patch: {
                assignee: { kind: "process", processId: spawned.pid },
                state: "active",
                blocker: null,
                nextCheckAtMs: null,
                leaseExpiresAtMs: deadlineAt,
              },
            }, ctx);
            responsibilityRollback.delegatedRevision = delegated.responsibility.revision;
          };
        }
        result = await handleProcIpcCall(callArgs, ctx, callOptions);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return delegateFailureResult(ctx, spawned.pid, message, responsibilityRollback);
      }
      if (!result.ok) {
        return delegateFailureResult(ctx, spawned.pid, result.error, responsibilityRollback);
      }
      return {
        stdout: [
          "status=in_progress",
          `task=${result.callId}`,
          `pid=${result.pid}`,
          `run_id=${result.runId}`,
          `queued=${result.queued === true}`,
          `check_in=${new Date(result.deadlineAt).toISOString()}`,
          `label=${quoteShellField(label)}`,
          ...(parsed.responsibilityId
            ? [`responsibility=${parsed.responsibilityId}`]
            : []),
        ].join(" ") + "\n",
        stderr: "",
        exitCode: 0,
      };
    }
    case "segments": {
      requireCommandCapability(ctx, "proc.history.segments");
      const parsed = parseProcSegmentsCommand(rest, ctx);
      const result = await runProcessSyscall(ctx, "proc.history.segments", parsed);
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
      if (result.epochs.length > 0) {
        lines.push("", "EPOCH\tGEN\tSTATE\tR12Y\tARCHIVE");
        for (const epoch of result.epochs) {
          lines.push([
            epoch.id,
            String(epoch.generation),
            epoch.state,
            `${epoch.r12yRevision}->${epoch.observedR12yRevision}`,
            epoch.archivePath ?? "-",
          ].join("\t"));
        }
      }
      return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
    }
    case "policy": {
      const parsed = parseProcPolicyCommand(rest, ctx);
      const call = parsed.set
        ? "proc.history.policy.set"
        : "proc.history.policy.get";
      requireCommandCapability(ctx, call);
      let result: ResultOf<"proc.history.policy.set"> | ResultOf<"proc.history.policy.get">;
      if (parsed.set) {
        const policyArgs: ArgsOf<"proc.history.policy.set"> = { pid: parsed.pid };
        if (parsed.overflow) policyArgs.overflow = parsed.overflow;
        if (parsed.compactAtPressure !== undefined) {
          policyArgs.compactAtPressure = parsed.compactAtPressure;
        }
        if (parsed.compactToPressure !== undefined) {
          policyArgs.compactToPressure = parsed.compactToPressure;
        }
        result = await runProcessSyscall(ctx, "proc.history.policy.set", policyArgs);
      } else {
        result = await runProcessSyscall(ctx, "proc.history.policy.get", { pid: parsed.pid });
      }
      if (!result.ok) {
        return { stdout: "", stderr: `proc policy: ${result.error}\n`, exitCode: 1 };
      }
      const policy = result.policy;
      return {
        stdout: [
          `overflow=${policy.overflow}`,
          `compact_at=${policy.compactAtPressure}`,
          `compact_to=${policy.compactToPressure}`,
        ].join(" ") + "\n",
        stderr: "",
        exitCode: 0,
      };
    }
    case "history": {
      requireCommandCapability(ctx, "proc.history");
      const parsed = parseProcHistoryCommand(rest, ctx);
      const historyArgs: ArgsOf<"proc.history"> = { pid: parsed.pid };
      if (parsed.limit !== undefined) historyArgs.limit = parsed.limit;
      if (parsed.offset !== undefined) historyArgs.offset = parsed.offset;
      if (parsed.beforeMessageId !== undefined) {
        historyArgs.beforeMessageId = parsed.beforeMessageId;
      }
      if (parsed.afterMessageId !== undefined) {
        historyArgs.afterMessageId = parsed.afterMessageId;
      }
      if (parsed.tail) historyArgs.tail = true;
      const result = await runProcessSyscall(ctx, "proc.history", historyArgs);
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
      requireCommandCapability(ctx, "proc.history.segment.read");
      const parsed = parseProcSegmentReadCommand(rest, ctx);
      const segmentArgs: ArgsOf<"proc.history.segment.read"> = {
        pid: parsed.pid,
        segmentId: parsed.segmentId,
      };
      if (parsed.limit !== undefined) segmentArgs.limit = parsed.limit;
      if (parsed.offset !== undefined) segmentArgs.offset = parsed.offset;
      const result = await runProcessSyscall(ctx, "proc.history.segment.read", segmentArgs);
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
      requireCommandCapability(ctx, "proc.history.compact");
      const parsed = parseProcCompactCommand(rest, ctx);
      const result = await runProcessSyscall(ctx, "proc.history.compact", parsed);
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
      requireCommandCapability(ctx, "proc.fork");
      const parsed = parseProcForkCommand(rest, ctx);
      const result = await handleProcFork(parsed, ctx);
      if (!result.ok) {
        return { stdout: "", stderr: `proc fork: ${result.error}\n`, exitCode: 1 };
      }
      return {
        stdout: [
          `pid=${result.pid}`,
          `source_pid=${result.sourcePid}`,
          `restored=${result.restoredMessages}`,
          result.segment ? `segment_id=${result.segment.id}` : "",
          result.throughMessageId !== undefined
            ? `through_message_id=${result.throughMessageId}`
            : "",
          `included_live_suffix=${result.includedLiveSuffix}`,
        ].filter(Boolean).join(" ") + "\n",
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

type DirectProcessCall =
  | "proc.history"
  | "proc.history.policy.get"
  | "proc.history.policy.set"
  | "proc.history.compact"
  | "proc.history.segment.read"
  | "proc.history.segments";

async function runProcessSyscall<S extends DirectProcessCall>(
  ctx: KernelContext,
  call: S,
  args: ArgsOf<S>,
): Promise<ResultOf<S>> {
  // SAFETY: `call` and `args` share the same syscall-map key through S.
  const frame = {
    type: "req",
    id: crypto.randomUUID(),
    call,
    args,
  } as RequestFrame<S>;
  // SAFETY: RequestFrame<S> is a member of the complete RequestFrame union.
  const response = await forwardToProcess(frame as RequestFrame, ctx);
  // SAFETY: forwardToProcess preserves the request syscall when typing response data.
  return response.data as ResultOf<S>;
}

type ProcLifecycleCall = "proc.reset" | "proc.kill";

async function runProcLifecycleSyscall<S extends ProcLifecycleCall>(
  ctx: KernelContext,
  call: S,
  args: ArgsOf<S>,
): Promise<ResultOf<S>> {
  // SAFETY: `call` and `args` share the same lifecycle syscall-map key through S.
  const frame = {
    type: "req",
    id: crypto.randomUUID(),
    call,
    args,
  } as RequestFrame;
  const response = await forwardToProcess(frame, ctx);
  // SAFETY: forwardToProcess preserves the request syscall when typing response data.
  return response.data as ResultOf<S>;
}

async function delegateFailureResult(
  ctx: KernelContext,
  pid: string,
  originalError: string,
  responsibilityRollback?: DelegatedResponsibilityRollback,
): Promise<ExecResult> {
  let error = originalError;
  const rollbackErrors: string[] = [];
  if (responsibilityRollback) {
    try {
      const current = handleResponsibilityGet({
        id: responsibilityRollback.original.id,
      }, ctx).responsibility;
      const stillDelegated = current.assignee.kind === "process"
        && current.assignee.processId === pid;
      const unchangedSinceDelegation = responsibilityRollback.delegatedRevision === undefined
        || current.revision === responsibilityRollback.delegatedRevision;
      if (stillDelegated && unchangedSinceDelegation) {
        const original = responsibilityRollback.original;
        await handleResponsibilityUpdate({
          id: original.id,
          expectedRevision: current.revision,
          patch: {
            assignee: original.assignee,
            state: original.state,
            blocker: original.blocker ?? null,
            nextCheckAtMs: original.nextCheckAtMs ?? null,
            leaseExpiresAtMs: original.leaseExpiresAtMs ?? null,
          },
        }, ctx);
      }
    } catch (responsibilityError) {
      rollbackErrors.push(
        responsibilityError instanceof Error
          ? responsibilityError.message
          : String(responsibilityError),
      );
    }
  }
  try {
    const rollback = await runProcLifecycleSyscall(ctx, "proc.kill", {
      pid,
      archive: false,
    });
    if (!rollback.ok) {
      throw new Error(rollback.error);
    }
  } catch (killError) {
    rollbackErrors.push(killError instanceof Error ? killError.message : String(killError));
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
      return procSpawnArgsSchema.parse(JSON.parse(
        requireShellOptionValue(args[index + 1], current),
      ));
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
    if (current.startsWith("-")) {
      throw new Error(`unexpected option: ${current}`);
    }
    positional.push(current);
  }

  const positionalPrompt = positional.join(" ").trim();
  const finalPrompt = prompt ?? (positionalPrompt || undefined);
  const parsed: ProcSpawnArgs = {};
  if (runAs) parsed.runAs = runAs;
  if (label) parsed.label = label;
  if (finalPrompt) parsed.prompt = finalPrompt;
  if (parentPid) parsed.parentPid = parentPid;
  if (cwd) parsed.cwd = cwd;
  if (interactive !== undefined) parsed.interactive = interactive;
  return parsed;
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

function formatProcLifecycleResult(result: ProcLifecycleSuccess): string {
  return [
    `pid=${result.pid}`,
    `archived=${result.archivedMessages}`,
    result.archivedTo ? `archive=${quoteShellField(result.archivedTo)}` : "",
  ].filter(Boolean).join(" ") + "\n";
}

function parseProcSegmentsCommand(args: string[], ctx: KernelContext): ParsedProcSegments {
  const parsed = parseProcProcessOptions(args, ctx);
  if (parsed.positional.length > 0) {
    throw new Error(`unexpected argument: ${parsed.positional[0]}`);
  }
  return { pid: parsed.pid };
}

function parseProcPolicyCommand(args: string[], ctx: KernelContext): ParsedProcPolicy {
  let pid: string | undefined;
  let overflow: ProcHistoryOverflowPolicy | undefined;
  let compactAtPressure: number | undefined;
  let compactToPressure: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--pid") {
      index += 1;
      pid = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--overflow") {
      index += 1;
      const value = requireShellOptionValue(args[index], current);
      if (value !== "auto-compact" && value !== "fail") {
        throw new Error("--overflow must be auto-compact or fail");
      }
      overflow = value;
      continue;
    }
    if (current === "--compact-at") {
      index += 1;
      compactAtPressure = parsePressureShellNumber(requireShellOptionValue(args[index], current), current);
      continue;
    }
    if (current === "--compact-to") {
      index += 1;
      compactToPressure = parsePressureShellNumber(
        requireShellOptionValue(args[index], current),
        current,
      );
      continue;
    }
    throw new Error(`unexpected argument: ${current}`);
  }

  const parsed: ParsedProcPolicy = {
    pid: pid ?? requireCurrentProcessId(ctx),
    set: overflow !== undefined || compactAtPressure !== undefined || compactToPressure !== undefined,
  };
  if (overflow) parsed.overflow = overflow;
  if (compactAtPressure !== undefined) parsed.compactAtPressure = compactAtPressure;
  if (compactToPressure !== undefined) parsed.compactToPressure = compactToPressure;
  return parsed;
}

function parseProcSegmentReadCommand(
  args: string[],
  ctx: KernelContext,
): ParsedProcSegmentRead {
  let pid: string | undefined;
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

  const parsed: ParsedProcSegmentRead = {
    pid: pid ?? requireCurrentProcessId(ctx),
    segmentId,
  };
  if (limit !== undefined) parsed.limit = limit;
  if (offset !== undefined) parsed.offset = offset;
  if (json) parsed.json = true;
  return parsed;
}

function parseProcHistoryCommand(args: string[], ctx: KernelContext): ParsedProcHistory {
  let pid: string | undefined;
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

  const parsed: ParsedProcHistory = {
    pid: pid ?? requireCurrentProcessId(ctx),
    maxContentChars,
  };
  if (limit !== undefined) parsed.limit = limit;
  if (offset !== undefined) parsed.offset = offset;
  if (beforeMessageId !== undefined) parsed.beforeMessageId = beforeMessageId;
  if (afterMessageId !== undefined) parsed.afterMessageId = afterMessageId;
  if (tail) parsed.tail = true;
  if (json) parsed.json = true;
  if (full) parsed.full = true;
  return parsed;
}

function parseProcCompactCommand(args: string[], ctx: KernelContext): ParsedProcCompact {
  let pid: string | undefined;
  let summary: string | undefined;
  let generateSummary = false;
  let targetPressure: number | undefined;
  let keepLast: number | undefined;
  let throughMessageId: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--pid") {
      index += 1;
      pid = requireShellOptionValue(args[index], current);
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
    if (current === "--target-pressure") {
      index += 1;
      targetPressure = parsePressureShellNumber(
        requireShellOptionValue(args[index], current),
        current,
      );
      if (targetPressure >= 1) {
        throw new Error("--target-pressure must be > 0 and < 1");
      }
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
  if (
    Number(targetPressure !== undefined)
      + Number(keepLast !== undefined)
      + Number(throughMessageId !== undefined)
    !== 1
  ) {
    throw new Error(
      "provide exactly one of --target-pressure, --keep-last, or --through-message-id",
    );
  }

  const parsed: ParsedProcCompact = {
    pid: pid ?? requireCurrentProcessId(ctx),
  };
  if (summary) {
    parsed.summary = summary;
  } else {
    parsed.generateSummary = true;
  }
  if (keepLast !== undefined) parsed.keepLast = keepLast;
  if (throughMessageId !== undefined) parsed.throughMessageId = throughMessageId;
  if (targetPressure !== undefined) parsed.targetPressure = targetPressure;
  return parsed;
}

function parseProcForkCommand(args: string[], ctx: KernelContext): ParsedProcFork {
  let pid: string | undefined;
  let throughMessageId: number | undefined;
  let label: string | undefined;
  let includeLiveSuffix = true;
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--pid") {
      index += 1;
      pid = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--message-id") {
      index += 1;
      throughMessageId = parsePositiveShellInteger(requireShellOptionValue(args[index], current), current);
      continue;
    }
    if (current === "--label") {
      index += 1;
      label = requireShellOptionValue(args[index], current);
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

  const parsed: ParsedProcFork = {
    pid: pid ?? requireCurrentProcessId(ctx),
  };
  if (segmentId) parsed.segmentId = segmentId;
  if (throughMessageId !== undefined) parsed.throughMessageId = throughMessageId;
  if (label) parsed.label = label;
  if (!includeLiveSuffix) parsed.includeLiveSuffix = false;
  return parsed;
}

function parseProcProcessOptions(
  args: string[],
  ctx: KernelContext,
): ParsedProcProcessOptions {
  let pid: string | undefined;
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--pid") {
      index += 1;
      pid = requireShellOptionValue(args[index], current);
      continue;
    }
    positional.push(current);
  }

  return {
    pid: pid ?? requireCurrentProcessId(ctx),
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

function parseProcMessageCommand(
  args: string[],
  allowTimeout: boolean,
): ArgsOf<"proc.ipc.call"> {
  let metadata: JsonObject | undefined;
  let timeoutMs: number | undefined;
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--metadata-json") {
      index += 1;
      metadata = jsonObjectSchema.parse(JSON.parse(
        requireShellOptionValue(args[index], current),
      ));
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
  const parsed: ArgsOf<"proc.ipc.call"> = {
    pid: normalizeProcPid(pid),
    message,
  };
  if (metadata) parsed.metadata = metadata;
  if (timeoutMs !== undefined) parsed.timeoutMs = timeoutMs;
  return parsed;
}

function parseProcDelegateCommand(args: string[], ctx: KernelContext): ParsedProcDelegate {
  let runAs: string | undefined;
  let label: string | undefined;
  let parentPid: string | undefined = ctx.processId;
  let cwd: string | undefined;
  let checkInMs: number | undefined;
  let responsibilityId: string | undefined;
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
    if (current === "--check-after" || current === "--timeout") {
      index += 1;
      if (checkInMs !== undefined) {
        throw new Error("delegation check-in may only be specified once");
      }
      checkInMs = parseDurationMs(requireShellOptionValue(args[index], current));
      continue;
    }
    if (current === "--responsibility") {
      index += 1;
      responsibilityId = requireShellOptionValue(args[index], current);
      continue;
    }
    positional.push(current);
  }

  const message = positional.join(" ").trim();
  if (!message) {
    throw new Error("missing delegated task");
  }
  const parsed: ParsedProcDelegate = {
    message,
  };
  if (runAs) parsed.runAs = runAs;
  if (label) parsed.label = label;
  if (parentPid) parsed.parentPid = parentPid;
  if (cwd) parsed.cwd = cwd;
  if (checkInMs !== undefined) parsed.checkInMs = checkInMs;
  if (responsibilityId) parsed.responsibilityId = responsibilityId;
  return parsed;
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

function formatProcSegmentReadResult(
  result: ProcSegmentReadOk,
  json: boolean | undefined,
): string {
  if (json) {
    return `${JSON.stringify(result, null, 2)}\n`;
  }

  const lines = [
    `Segment ${result.segment.id}`,
    `Messages: ${result.messages.length}/${result.messageCount}${result.truncated ? " (truncated)" : ""}`,
    "",
  ];
  for (let index = 0; index < result.messages.length; index += 1) {
    const message = result.messages[index];
    const timestamp = message.timestamp === undefined
      ? "-"
      : new Date(message.timestamp).toISOString();
    lines.push(`[${index + 1}] ${message.role} ${timestamp}`);
    lines.push(formatProcHistoryMessageContent(message));
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function formatProcHistoryResult(
  result: ProcHistoryOk,
  options: ProcHistoryFormatOptions,
): string {
  if (options.json) {
    return `${JSON.stringify(result, null, 2)}\n`;
  }

  const lines = [
    `History ${result.pid}`,
    `Messages: ${result.messages.length}/${result.messageCount}${result.truncated ? " (truncated)" : ""}`,
  ];
  if (result.activeRunId) {
    lines.push(`Active run: ${result.activeRunId}`);
  }
  if (result.pendingHil) {
    lines.push(`Pending HIL: ${result.pendingHil.requestId} ${result.pendingHil.toolName}`);
  }
  if (result.context) {
    const context = result.context;
    const pressure = context.pressure === null
      ? "unknown"
      : `${Math.round(context.pressure * 100)}%`;
    lines.push(`Context: ${context.level ?? "unknown"} pressure=${pressure}`);
  }
  lines.push("");

  for (let index = 0; index < result.messages.length; index += 1) {
    const message = result.messages[index];
    const timestamp = message.timestamp === undefined
      ? "-"
      : new Date(message.timestamp).toISOString();
    const id = message.id === undefined ? String(index + 1) : `#${message.id}`;
    const run = message.runId === undefined ? "" : ` run=${message.runId}`;
    lines.push(`[${id}] ${message.role} ${timestamp}${run}`);
    const content = formatProcHistoryMessageContent(message);
    lines.push(options.full ? content : truncateProcHistoryContent(content, options.maxContentChars));
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function formatProcHistoryMessageContent(message: ProcHistoryMessage): string {
  return formatProcHistoryContent(jsonValueSchema.parse(message.content));
}

function formatProcHistoryContent(content: JsonValue): string {
  const text = z.string().safeParse(content);
  if (text.success) {
    return text.data;
  }
  const display = historyDisplayObjectSchema.safeParse(content);
  if (display.success) {
    if (display.data.text?.trim()) {
      return display.data.text;
    }
    if (display.data.output !== undefined) {
      return display.data.output;
    }
  }
  return JSON.stringify(content, null, 2) ?? "null";
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
    "  proc delegate [--as ACCOUNT] [--label LABEL] [--parent PID] [--cwd PATH] [--check-after 10m] [--responsibility ID] <task>",
    "  proc segments [--pid PID]",
    "  proc policy [--pid PID] [--overflow auto-compact|fail] [--compact-at N] [--compact-to N]",
    "  proc history [--pid PID] [--tail] [--limit N] [--offset N] [--json] [--full]",
    "  proc segment <segment-id> [--pid PID] [--limit N] [--offset N] [--json]",
    "  proc compact [--pid PID] (--target-pressure N | --keep-last N | --through-message-id ID) [--summary TEXT | --generate-summary]",
    "  proc fork (<segment-id> | --message-id ID) [--pid PID] [--label LABEL] [--segment-only]",
    "  proc send <pid> [--metadata-json json] <message>",
    "  proc call <pid> [--metadata-json json] [--timeout 60s] <message>",
    "",
    "proc compact archives a history prefix and records a segment. A target",
    "pressure retains that fraction of the model input budget. Without",
    "--summary, it asks the process model to generate the visible summary.",
    "proc fork branches a new process from a message or restores a compacted segment.",
    "proc history reads the live transcript for this process or another visible process.",
    "",
    "proc delegate creates a durable child process and returns a task handle",
    "immediately. --check-after controls non-destructive supervision (default 10m).",
    "--responsibility assigns the record before the child starts and returns it to",
    "Ship if IPC admission fails. proc send is asynchronous",
    "mail. proc call sends bounded",
    "work to an existing process; replies arrive as delegated task events.",
    "",
  ].join("\n");
}
