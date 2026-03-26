import type { RequestFrame } from "../protocol/frames";
import type { KernelContext } from "./context";
import type {
  CommandExecutionSpec,
  CommandManifest,
  IssuedCommandRecord,
  SysCommandExecuteArgs,
  SysCommandExecuteResult,
  SysCommandGetArgs,
  SysCommandGetResult,
  SysCommandIssueArgs,
  SysCommandIssueResult,
  SysCommandListArgs,
  SysCommandListResult,
  SysCommandRevokeArgs,
  SysCommandRevokeResult,
  UserIdentity,
} from "../syscalls/system";
import type { ProcSendResult } from "../syscalls/proc";
import { handleProcSpawn, forwardToProcess } from "./proc-handlers";
import { sendFrameToProcess } from "../shared/utils";

export async function handleSysCommandIssue(
  args: SysCommandIssueArgs,
  ctx: KernelContext,
): Promise<SysCommandIssueResult> {
  const identity = requireUserIdentity(ctx);
  const manifest = validateManifest(args.manifest);
  const command = await ctx.commands.issue(identity.process.uid, manifest);
  return {
    command,
    url: `/c/${command.commandId}`,
    cli: `gsv command run ${command.commandId}`,
  };
}

export function handleSysCommandGet(
  args: SysCommandGetArgs,
  ctx: KernelContext,
): SysCommandGetResult {
  const identity = requireUserIdentity(ctx);
  const commandId = normalizeCommandId(args.commandId);
  const command = ctx.commands.get(commandId);
  if (!command || !canViewCommand(identity.process.uid, command)) {
    return { command: null };
  }
  return { command };
}

export function handleSysCommandList(
  args: SysCommandListArgs,
  ctx: KernelContext,
): SysCommandListResult {
  const identity = requireUserIdentity(ctx);
  if (typeof args.issuerUid === "number" && identity.process.uid !== 0 && args.issuerUid !== identity.process.uid) {
    throw new Error("Permission denied");
  }

  const commands = ctx.commands
    .list({
      issuerUid: args.issuerUid,
      includeRevoked: args.includeRevoked,
    })
    .filter((command) => canListCommand(identity.process.uid, command, identity.process.uid === 0));

  return { commands };
}

export function handleSysCommandRevoke(
  args: SysCommandRevokeArgs,
  ctx: KernelContext,
): SysCommandRevokeResult {
  const identity = requireUserIdentity(ctx);
  const commandId = normalizeCommandId(args.commandId);
  const command = ctx.commands.get(commandId);
  if (!command) {
    return { revoked: false };
  }

  if (identity.process.uid !== 0 && command.issuerUid !== identity.process.uid) {
    throw new Error("Permission denied");
  }

  return {
    revoked: ctx.commands.revoke(commandId, args.reason),
  };
}

export async function handleSysCommandExecute(
  args: SysCommandExecuteArgs,
  ctx: KernelContext,
): Promise<SysCommandExecuteResult> {
  const identity = requireUserIdentity(ctx);
  const commandId = normalizeCommandId(args.commandId);
  const command = ctx.commands.get(commandId);
  if (!command || !canViewCommand(identity.process.uid, command)) {
    return { ok: false, error: "Command not found" };
  }

  const subject = command.manifest.subject;
  const executorUid = identity.process.uid;

  if (command.revokedAt !== null) {
    return { ok: false, error: "Command has been revoked" };
  }

  const notBeforeAt = command.manifest.validity?.notBeforeAt;
  if (typeof notBeforeAt === "number" && Date.now() < notBeforeAt) {
    return { ok: false, error: "Command is not active yet" };
  }

  const expiresAt = command.manifest.validity?.expiresAt;
  if (typeof expiresAt === "number" && Date.now() >= expiresAt) {
    return { ok: false, error: "Command has expired" };
  }

  if (command.manifest.validity?.singleUse && command.lastExecutedAt !== null) {
    return { ok: false, error: "Command is single-use and has already been executed" };
  }

  if (subject.kind === "issuer" && executorUid !== command.issuerUid) {
    return { ok: false, error: "Command is restricted to the issuer" };
  }

  if (subject.kind === "uid" && executorUid !== subject.uid) {
    return { ok: false, error: `Command is restricted to uid ${subject.uid}` };
  }

  if (subject.kind === "claim") {
    if (typeof command.claimedByUid === "number" && command.claimedByUid !== executorUid) {
      return { ok: false, error: `Command has already been claimed by uid ${command.claimedByUid}` };
    }
    if (typeof subject.maxClaims === "number" && command.claimCount >= subject.maxClaims) {
      return { ok: false, error: "Command claim limit reached" };
    }
  }

  const requiredCapabilities = command.manifest.policy?.requiredCapabilities ?? [];
  for (const capability of requiredCapabilities) {
    if (!identity.capabilities.includes(capability)) {
      return { ok: false, error: `Missing required capability: ${capability}` };
    }
  }

  const requestedCapabilities = command.manifest.policy?.requestedCapabilities ?? [];
  for (const capability of requestedCapabilities) {
    if (!identity.capabilities.includes(capability)) {
      return { ok: false, error: `Requested capability is not available: ${capability}` };
    }
  }

  const requiredDevices = command.manifest.policy?.requiredDevices ?? [];
  for (const deviceId of requiredDevices) {
    if (!ctx.devices.canAccess(deviceId, identity.process.uid, identity.process.gids)) {
      return { ok: false, error: `Required device is not accessible: ${deviceId}` };
    }
    const device = ctx.devices.get(deviceId);
    if (!device || !device.online) {
      return { ok: false, error: `Required device is offline: ${deviceId}` };
    }
  }

  const pid = await resolveExecutionPid(command.manifest.execution, ctx);
  const sendResult = await sendCommandMessage(command.manifest.execution, pid, ctx);
  if (!sendResult.ok) {
    return { ok: false, error: sendResult.error };
  }

  if (subject.kind === "claim") {
    ctx.commands.markClaim(command.commandId, executorUid);
  }
  ctx.commands.markExecuted(command.commandId);
  ctx.commands.addExecution({
    commandId: command.commandId,
    executorUid,
    pid,
    runId: sendResult.runId,
    routeKind: inferRouteKind(ctx),
    routeRef: inferRouteRef(ctx),
    status: "started",
  });

  return {
    ok: true,
    commandId: command.commandId,
    pid,
    runId: sendResult.runId,
    ...(subject.kind === "claim" ? { claimedByUid: executorUid } : {}),
  };
}

function requireUserIdentity(ctx: KernelContext): UserIdentity {
  const identity = ctx.identity;
  if (!identity || identity.role !== "user") {
    throw new Error("Authentication required");
  }
  return identity;
}

function normalizeCommandId(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("commandId is required");
  }
  return normalized;
}

function validateManifest(manifest: CommandManifest): CommandManifest {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("manifest is required");
  }
  if (manifest.version !== 1) {
    throw new Error("manifest.version must be 1");
  }
  if (manifest.kind !== "gsv.command") {
    throw new Error("manifest.kind must be gsv.command");
  }

  validateSubject(manifest);
  validateExecution(manifest.execution);

  const validity = manifest.validity;
  if (validity) {
    if (typeof validity.notBeforeAt === "number" && !Number.isFinite(validity.notBeforeAt)) {
      throw new Error("manifest.validity.notBeforeAt must be a unix timestamp in milliseconds");
    }
    if (typeof validity.expiresAt === "number" && !Number.isFinite(validity.expiresAt)) {
      throw new Error("manifest.validity.expiresAt must be a unix timestamp in milliseconds");
    }
  }

  return manifest;
}

function validateSubject(manifest: CommandManifest): void {
  const subject = manifest.subject;
  if (!subject || typeof subject !== "object") {
    throw new Error("manifest.subject is required");
  }
  if (!["issuer", "uid", "claim"].includes(subject.kind)) {
    throw new Error("manifest.subject.kind must be issuer, uid, or claim");
  }
  if (subject.kind === "uid" && (!Number.isInteger(subject.uid) || subject.uid < 0)) {
    throw new Error("manifest.subject.uid must be a non-negative integer");
  }
  if (
    subject.kind === "claim" &&
    subject.maxClaims !== undefined &&
    (!Number.isInteger(subject.maxClaims) || subject.maxClaims <= 0)
  ) {
    throw new Error("manifest.subject.maxClaims must be a positive integer");
  }
}

function validateExecution(execution: CommandExecutionSpec): void {
  if (!execution || typeof execution !== "object") {
    throw new Error("manifest.execution is required");
  }

  const process = execution.process;
  if (!process || typeof process !== "object") {
    throw new Error("manifest.execution.process is required");
  }
  if (!["init", "pid", "spawn"].includes(process.kind)) {
    throw new Error("manifest.execution.process.kind must be init, pid, or spawn");
  }
  if (process.kind === "pid" && (!("pid" in process) || typeof process.pid !== "string" || process.pid.trim().length === 0)) {
    throw new Error("manifest.execution.process.pid is required");
  }
  if (
    process.kind === "spawn" &&
    "parentPid" in process &&
    process.parentPid !== undefined &&
    (typeof process.parentPid !== "string" || process.parentPid.trim().length === 0)
  ) {
    throw new Error("manifest.execution.process.parentPid must be a non-empty string");
  }

  const input = execution.input;
  if (!input || typeof input !== "object" || input.kind !== "message") {
    throw new Error("manifest.execution.input.kind must be message");
  }
  if (typeof input.message !== "string" || input.message.trim().length === 0) {
    throw new Error("manifest.execution.input.message is required");
  }
}

function canViewCommand(uid: number, command: IssuedCommandRecord): boolean {
  if (uid === 0) return true;
  if (command.issuerUid === uid) return true;
  if (command.claimedByUid === uid) return true;
  const subject = command.manifest.subject;
  if (subject.kind === "uid" && subject.uid === uid) return true;
  if (subject.kind === "claim") return true;
  return false;
}

function canListCommand(uid: number, command: IssuedCommandRecord, isRoot: boolean): boolean {
  if (isRoot) return true;
  if (command.issuerUid === uid) return true;
  if (command.claimedByUid === uid) return true;
  const subject = command.manifest.subject;
  return subject.kind === "uid" && subject.uid === uid;
}

async function resolveExecutionPid(
  execution: CommandExecutionSpec,
  ctx: KernelContext,
): Promise<string> {
  const process = execution.process;

  if (process.kind === "init") {
    return ensureUserInitProcess(ctx.identity!.process, ctx);
  }

  if (process.kind === "pid") {
    const pid = process.pid.trim();
    const target = ctx.procs.get(pid);
    if (!target) {
      throw new Error(`Process not found: ${pid}`);
    }
    if (target.uid !== ctx.identity!.process.uid && ctx.identity!.process.uid !== 0) {
      throw new Error(`Permission denied: cannot access process ${pid}`);
    }
    return pid;
  }

  const spawned = await handleProcSpawn(
    {
      label: process.label,
      parentPid: process.parentPid,
    },
    ctx,
  );
  if (!spawned.ok) {
    throw new Error(spawned.error);
  }
  return spawned.pid;
}

async function ensureUserInitProcess(identity: UserIdentity["process"], ctx: KernelContext): Promise<string> {
  const { pid, created } = ctx.procs.ensureInit(identity);
  if (created) {
    const frame: RequestFrame<"proc.setidentity"> = {
      type: "req",
      id: crypto.randomUUID(),
      call: "proc.setidentity",
      args: { pid, identity },
    };
    await sendFrameToProcess(pid, frame);
  }
  return pid;
}

async function sendCommandMessage(
  execution: CommandExecutionSpec,
  pid: string,
  ctx: KernelContext,
): Promise<Extract<ProcSendResult, { ok: true }> | Extract<ProcSendResult, { ok: false }>> {
  const frame: RequestFrame<"proc.send"> = {
    type: "req",
    id: crypto.randomUUID(),
    call: "proc.send",
    args: {
      pid,
      message: execution.input.message,
    },
  };
  const result = await forwardToProcess(frame, ctx);
  return result as ProcSendResult;
}

function inferRouteKind(ctx: KernelContext): "connection" | "adapter" | "none" {
  const conn = ctx.connection as { id?: unknown } | null;
  return typeof conn?.id === "string" && conn.id.length > 0 ? "connection" : "none";
}

function inferRouteRef(ctx: KernelContext): Record<string, string> | undefined {
  const conn = ctx.connection as { id?: unknown } | null;
  if (typeof conn?.id === "string" && conn.id.length > 0) {
    return { connectionId: conn.id };
  }
  return undefined;
}
