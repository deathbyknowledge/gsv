import type {
  ResponsibilityAssignee,
  ResponsibilityAudience,
  ResponsibilityChangesArgs,
  ResponsibilityChangesResult,
  ResponsibilityCreateArgs,
  ResponsibilityCreateResult,
  ResponsibilityGetArgs,
  ResponsibilityGetResult,
  ResponsibilityListArgs,
  ResponsibilityListResult,
  ResponsibilitySourceListArgs,
  ResponsibilitySourceListResult,
  ResponsibilitySourceUpdateArgs,
  ResponsibilitySourceUpdateResult,
  ResponsibilityPatch,
  ResponsibilityPriority,
  ResponsibilitySource,
  ResponsibilityState,
  ResponsibilityUpdateArgs,
  ResponsibilityUpdateResult,
} from "@humansandmachines/gsv/protocol";
import type { JsonObject } from "@humansandmachines/gsv/protocol";
import { principalOf, resolveCallerOwnerUid, type KernelContext } from "./context";

const MAX_TITLE_BYTES = 240;
const MAX_TEXT_BYTES = 2_000;
const MAX_DEDUPE_KEY_BYTES = 200;
const MAX_DETAILS_BYTES = 32 * 1_024;
const MAX_AUDIENCE_CONVERSATIONS = 16;
const MAX_LIST_IDS = 500;
const RESPONSIBILITY_ID_PATTERN = /^r12y:[0-9a-f-]{36}$/;
const STATES: readonly ResponsibilityState[] = [
  "open",
  "active",
  "waiting",
  "resolved",
  "cancelled",
];
const PRIORITIES: readonly ResponsibilityPriority[] = [
  "low",
  "normal",
  "high",
  "critical",
];

export function handleResponsibilityList(
  args: ResponsibilityListArgs,
  ctx: KernelContext,
): ResponsibilityListResult {
  const ownerUid = resolveCallerOwnerUid(ctx);
  const restrictedProcessId = restrictedCallerProcessId(ctx);
  const ids = normalizeResponsibilityIds(args.ids);
  const states = normalizeStates(args.states);
  const assigneeProcessId = normalizeOptionalProcessId(args.assigneeProcessId);
  if (assigneeProcessId) assertOwnedProcess(ownerUid, assigneeProcessId, ctx);
  if (restrictedProcessId && assigneeProcessId && assigneeProcessId !== restrictedProcessId) {
    throw new Error("A child process can list only its assigned responsibilities");
  }
  const parentId = normalizeOptionalResponsibilityId(args.parentId);
  const result = restrictedProcessId && !assigneeProcessId
    ? ctx.responsibilities.listVisibleToProcess({
        ownerUid,
        processId: restrictedProcessId,
        ids,
        states,
        parentId,
        includeTerminal: args.includeTerminal === true,
        limit: args.limit,
        offset: args.offset,
      })
    : ctx.responsibilities.list({
        ownerUid,
        ids,
        states,
        assigneeProcessId: restrictedProcessId ?? assigneeProcessId,
        parentId,
        includeTerminal: args.includeTerminal === true,
        limit: args.limit,
        offset: args.offset,
      });
  return {
    responsibilities: result.records,
    count: result.count,
    revision: result.revision,
  };
}

export function handleResponsibilityGet(
  args: ResponsibilityGetArgs,
  ctx: KernelContext,
): ResponsibilityGetResult {
  const ownerUid = resolveCallerOwnerUid(ctx);
  const id = normalizeResponsibilityId(args.id);
  const restrictedProcessId = restrictedCallerProcessId(ctx);
  if (
    restrictedProcessId
    && !ctx.responsibilities.isVisibleToProcess(ownerUid, id, restrictedProcessId)
  ) {
    throw new Error(`Responsibility not found: ${id}`);
  }
  const responsibility = ctx.responsibilities.get(ownerUid, id);
  if (!responsibility) throw new Error(`Responsibility not found: ${id}`);
  return {
    responsibility,
    revision: ctx.responsibilities.revision(ownerUid),
  };
}

export async function handleResponsibilityCreate(
  args: ResponsibilityCreateArgs,
  ctx: KernelContext,
): Promise<ResponsibilityCreateResult> {
  const ownerUid = resolveCallerOwnerUid(ctx);
  const actor = responsibilityActor(ctx);
  const restrictedProcessId = restrictedCallerProcessId(ctx);
  if (restrictedProcessId && args.audience) {
    throw new Error("A child process cannot grant itself a conversation audience");
  }
  const assignee = normalizeAssignee(
    args.assignee ?? (restrictedProcessId
      ? { kind: "process", processId: restrictedProcessId }
      : undefined),
  );
  if (
    restrictedProcessId
    && assignee.kind === "process"
    && assignee.processId !== restrictedProcessId
  ) {
    throw new Error("A child process cannot assign responsibility to another child");
  }
  assertAssignee(ownerUid, assignee, ctx);
  const audience = normalizeAudience(args.audience, ownerUid, ctx);
  const parentId = normalizeOptionalResponsibilityId(args.parentId);
  if (
    restrictedProcessId
    && parentId
    && !ctx.responsibilities.isVisibleToProcess(ownerUid, parentId, restrictedProcessId)
  ) {
    throw new Error(`Responsibility parent is not visible: ${parentId}`);
  }
  const outcome = ctx.responsibilities.create({
    ownerUid,
    title: normalizeText(args.title, "title", MAX_TITLE_BYTES),
    details: normalizeDetails(args.details, "details"),
    parentId,
    source: actor,
    audience,
    assignee,
    state: "open",
    priority: normalizePriority(args.priority),
    dueAtMs: normalizeOptionalTimestamp(args.dueAtMs, "dueAtMs"),
    nextCheckAtMs: normalizeOptionalTimestamp(args.nextCheckAtMs, "nextCheckAtMs"),
    blocker: normalizeOptionalText(args.blocker, "blocker", MAX_TEXT_BYTES),
    leaseExpiresAtMs: normalizeOptionalTimestamp(args.leaseExpiresAtMs, "leaseExpiresAtMs"),
    dedupeKey: normalizeOptionalText(args.dedupeKey, "dedupeKey", MAX_DEDUPE_KEY_BYTES),
    actor,
    observedByShip: callerIsShip(ctx),
    now: Date.now(),
  });
  await ctx.reconcileResponsibilityWake(ownerUid);
  return {
    responsibility: outcome.record,
    created: outcome.created,
    revision: outcome.revision,
  };
}

export async function handleResponsibilityUpdate(
  args: ResponsibilityUpdateArgs,
  ctx: KernelContext,
): Promise<ResponsibilityUpdateResult> {
  const ownerUid = resolveCallerOwnerUid(ctx);
  const id = normalizeResponsibilityId(args.id);
  const restrictedProcessId = restrictedCallerProcessId(ctx);
  if (restrictedProcessId) {
    const current = ctx.responsibilities.get(ownerUid, id);
    if (
      !current
      || current.assignee.kind !== "process"
      || current.assignee.processId !== restrictedProcessId
    ) {
      throw new Error(`Responsibility not found: ${id}`);
    }
  }
  const patch = normalizePatch(args.patch, ownerUid, ctx);
  if (restrictedProcessId && patch.audience !== undefined) {
    throw new Error("A child process cannot change its conversation audience");
  }
  if (
    restrictedProcessId
    && patch.parentId !== undefined
    && patch.parentId !== null
    && !ctx.responsibilities.isVisibleToProcess(ownerUid, patch.parentId, restrictedProcessId)
  ) {
    throw new Error(`Responsibility parent is not visible: ${patch.parentId}`);
  }
  if (
    restrictedProcessId
    && patch.assignee?.kind === "process"
    && patch.assignee.processId !== restrictedProcessId
  ) {
    throw new Error("A child process cannot assign responsibility to another child");
  }
  if (Object.keys(patch).length === 0) {
    throw new Error("Responsibility update patch is empty");
  }
  const expectedRevision = args.expectedRevision === undefined
    ? undefined
    : normalizeRevision(args.expectedRevision, "expectedRevision");
  const outcome = ctx.responsibilities.update({
    ownerUid,
    id,
    expectedRevision,
    patch,
    actor: responsibilityActor(ctx),
    observedByShip: callerIsShip(ctx),
    now: Date.now(),
  });
  await ctx.reconcileResponsibilityWake(ownerUid);
  return {
    responsibility: outcome.record,
    revision: outcome.revision,
  };
}

export function handleResponsibilityChanges(
  args: ResponsibilityChangesArgs,
  ctx: KernelContext,
): ResponsibilityChangesResult {
  const ownerUid = resolveCallerOwnerUid(ctx);
  const afterRevision = normalizeRevision(args.afterRevision, "afterRevision");
  return ctx.responsibilities.changes(
    ownerUid,
    afterRevision,
    args.limit,
    restrictedCallerProcessId(ctx),
  );
}

export function handleResponsibilitySourceList(
  _args: ResponsibilitySourceListArgs,
  ctx: KernelContext,
): ResponsibilitySourceListResult {
  return {
    sources: ctx.responsibilitySources.list(resolveCallerOwnerUid(ctx)),
  };
}

export function handleResponsibilitySourceUpdate(
  args: ResponsibilitySourceUpdateArgs,
  ctx: KernelContext,
): ResponsibilitySourceUpdateResult {
  return {
    source: ctx.responsibilitySources.set(
      resolveCallerOwnerUid(ctx),
      args.id,
      args.enabled,
    ),
  };
}

function normalizePatch(
  input: ResponsibilityPatch,
  ownerUid: number,
  ctx: KernelContext,
): ResponsibilityPatch {
  const patch: ResponsibilityPatch = {};
  if (input.title !== undefined) {
    patch.title = normalizeText(input.title, "title", MAX_TITLE_BYTES);
  }
  if (input.details !== undefined) {
    patch.details = input.details === null
      ? null
      : normalizeDetails(input.details, "details");
  }
  if (input.parentId !== undefined) {
    patch.parentId = input.parentId === null
      ? null
      : normalizeResponsibilityId(input.parentId);
  }
  if (input.audience !== undefined) {
    patch.audience = input.audience === null
      ? null
      : normalizeAudience(input.audience, ownerUid, ctx);
  }
  if (input.assignee !== undefined) {
    patch.assignee = normalizeAssignee(input.assignee);
    assertAssignee(ownerUid, patch.assignee, ctx);
  }
  if (input.state !== undefined) patch.state = normalizeState(input.state);
  if (input.priority !== undefined) patch.priority = normalizePriority(input.priority);
  if (input.dueAtMs !== undefined) {
    patch.dueAtMs = input.dueAtMs === null
      ? null
      : normalizeTimestamp(input.dueAtMs, "dueAtMs");
  }
  if (input.nextCheckAtMs !== undefined) {
    patch.nextCheckAtMs = input.nextCheckAtMs === null
      ? null
      : normalizeTimestamp(input.nextCheckAtMs, "nextCheckAtMs");
  }
  if (input.blocker !== undefined) {
    patch.blocker = input.blocker === null
      ? null
      : normalizeText(input.blocker, "blocker", MAX_TEXT_BYTES);
  }
  if (input.leaseExpiresAtMs !== undefined) {
    patch.leaseExpiresAtMs = input.leaseExpiresAtMs === null
      ? null
      : normalizeTimestamp(input.leaseExpiresAtMs, "leaseExpiresAtMs");
  }
  if (input.resolution !== undefined) {
    patch.resolution = input.resolution === null
      ? null
      : normalizeDetails(input.resolution, "resolution");
  }
  if (
    patch.resolution !== undefined
    && patch.resolution !== null
    && patch.state !== "resolved"
    && patch.state !== "cancelled"
  ) {
    throw new Error("resolution requires a resolved or cancelled state transition");
  }
  return patch;
}

function responsibilityActor(ctx: KernelContext): ResponsibilitySource {
  if (ctx.processId) {
    const source: Extract<ResponsibilitySource, { kind: "process" }> = {
      kind: "process",
      processId: ctx.processId,
    };
    if (ctx.processRunId) source.runId = ctx.processRunId;
    return source;
  }
  const identity = principalOf(ctx)!;
  return {
    kind: "account",
    uid: identity.account.uid,
    username: identity.account.username,
  };
}

function callerIsShip(ctx: KernelContext): boolean {
  if (!ctx.processId) return false;
  return ctx.procs.get(ctx.processId)?.isPersonalController === true;
}

function restrictedCallerProcessId(ctx: KernelContext): string | undefined {
  if (!ctx.processId || callerIsShip(ctx)) return undefined;
  return ctx.processId;
}

function normalizeAssignee(value: ResponsibilityAssignee | undefined): ResponsibilityAssignee {
  if (!value || value.kind === "ship") return { kind: "ship" };
  if (value.kind !== "process") throw new Error("Responsibility assignee is invalid");
  return { kind: "process", processId: normalizeProcessId(value.processId) };
}

function assertAssignee(
  ownerUid: number,
  assignee: ResponsibilityAssignee,
  ctx: KernelContext,
): void {
  if (assignee.kind === "process") {
    assertOwnedProcess(ownerUid, assignee.processId, ctx);
    if (ctx.procs.get(assignee.processId)?.isPersonalController === true) {
      throw new Error("The personal controller must be assigned as ship, not process");
    }
  }
}

function assertOwnedProcess(ownerUid: number, processId: string, ctx: KernelContext): void {
  const process = ctx.procs.get(processId);
  if (!process || process.ownerUid !== ownerUid) {
    throw new Error(`Responsibility assignee is not an owned process: ${processId}`);
  }
}

function normalizeAudience(
  value: ResponsibilityAudience | undefined,
  ownerUid: number,
  ctx: KernelContext,
): ResponsibilityAudience | undefined {
  if (!value) return undefined;
  if (!Array.isArray(value.conversationIds)) {
    throw new Error("Responsibility audience conversationIds must be an array");
  }
  const ids = Array.from(new Set(value.conversationIds.map((id) => normalizeConversationId(id))));
  if (ids.length === 0 || ids.length > MAX_AUDIENCE_CONVERSATIONS) {
    throw new Error(
      `Responsibility audience must contain 1-${MAX_AUDIENCE_CONVERSATIONS} conversations`,
    );
  }
  for (const id of ids) {
    const conversation = ctx.conversations.get(id);
    if (!conversation || conversation.ownerUid !== ownerUid) {
      throw new Error(`Responsibility audience conversation is not owned: ${id}`);
    }
  }
  return { conversationIds: ids };
}

function normalizeStates(values: ResponsibilityState[] | undefined): ResponsibilityState[] | undefined {
  if (!values) return undefined;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("Responsibility states must be a non-empty array");
  }
  return Array.from(new Set(values.map(normalizeState)));
}

function normalizeResponsibilityIds(values: string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_LIST_IDS) {
    throw new Error(`Responsibility ids must contain 1-${MAX_LIST_IDS} values`);
  }
  return Array.from(new Set(values.map(normalizeResponsibilityId)));
}

function normalizeState(value: ResponsibilityState): ResponsibilityState {
  if (!STATES.includes(value)) throw new Error(`Invalid responsibility state: ${value}`);
  return value;
}

function normalizePriority(
  value: ResponsibilityPriority | undefined,
): ResponsibilityPriority {
  const priority = value ?? "normal";
  if (!PRIORITIES.includes(priority)) {
    throw new Error(`Invalid responsibility priority: ${priority}`);
  }
  return priority;
}

function normalizeResponsibilityId(value: string): string {
  const id = normalizeText(value, "responsibility id", 64);
  if (!RESPONSIBILITY_ID_PATTERN.test(id)) {
    throw new Error(`Invalid responsibility id: ${id}`);
  }
  return id;
}

function normalizeOptionalResponsibilityId(
  value: string | undefined,
): string | undefined {
  return value === undefined ? undefined : normalizeResponsibilityId(value);
}

function normalizeProcessId(value: string): string {
  const id = normalizeText(value, "process id", 200);
  if (!id.startsWith("proc:")) throw new Error(`Invalid process id: ${id}`);
  return id;
}

function normalizeOptionalProcessId(value: string | undefined): string | undefined {
  return value === undefined ? undefined : normalizeProcessId(value);
}

function normalizeConversationId(value: string): string {
  const id = normalizeText(value, "conversation id", 200);
  if (!id.startsWith("conv:")) throw new Error(`Invalid conversation id: ${id}`);
  return id;
}

function normalizeText(value: string, label: string, maxBytes: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Responsibility ${label} is required`);
  if (encodedBytes(normalized) > maxBytes || containsControl(normalized)) {
    throw new Error(`Responsibility ${label} is invalid`);
  }
  return normalized;
}

function normalizeOptionalText(
  value: string | undefined,
  label: string,
  maxBytes: number,
): string | undefined {
  return value === undefined ? undefined : normalizeText(value, label, maxBytes);
}

function normalizeDetails(value: JsonObject | undefined, label: string): JsonObject | undefined {
  if (value === undefined) return undefined;
  const json = JSON.stringify(value);
  if (encodedBytes(json) > MAX_DETAILS_BYTES) {
    throw new Error(`Responsibility ${label} exceeds ${MAX_DETAILS_BYTES} bytes`);
  }
  return value;
}

function normalizeOptionalTimestamp(value: number | undefined, label: string): number | undefined {
  return value === undefined ? undefined : normalizeTimestamp(value, label);
}

function normalizeTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Responsibility ${label} must be a non-negative integer timestamp`);
  }
  return value;
}

function normalizeRevision(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function encodedBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function containsControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}
