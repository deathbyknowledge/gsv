import type { FileResourceReference, ProcessScope, ProcessScopePolicy } from "@humansandmachines/gsv/protocol";
import type { RequestFrame } from "../protocol/frames";
import { hasCapability } from "./capabilities";
import { principalOf, resolveCallerOwnerUid, type KernelContext } from "./context";

const SCOPED_CALLS = [
  "fs.read", "fs.search", "fs.transfer.send", "shell.exec", "codemode.exec", "codemode.run", "ai.text.generate",
  "conversation.history", "conversation.search", "conversation.media.read", "contact.send",
  "proc.list", "proc.spawn", "proc.fork", "proc.ipc.call", "proc.ipc.send", "proc.history",
  "proc.history.segments", "proc.history.segment.read", "proc.history.compact", "proc.history.policy.get",
  "proc.stats", "proc.abort", "proc.kill", "proc.reset", "proc.scope.get",
  "r12y.list", "r12y.get", "r12y.changes",
] as const;
const INTERNAL_SCOPED_CALLS = new Set(["ai.config", "ai.context", "ai.tools"]);

export function scopedCapabilities(accountCalls: readonly string[]): string[] {
  return SCOPED_CALLS.filter((call) => hasCapability(accountCalls, call));
}

/** Captured Shell and CodeMode contexts may outlive a capability change. */
export function effectiveProcessCapabilities(ctx: KernelContext): readonly string[] {
  const original = principalOf(ctx)?.calls ?? [];
  if (!currentProcessScope(ctx)) return original;
  const identity = ctx.procs.getIdentity(ctx.processId!);
  if (!identity) throw new Error("Scoped process no longer exists");
  const current = ctx.caps.resolve(identity.gids);
  return scopedCapabilities(original).filter((call) => hasCapability(current, call));
}

/** A fresh read on every boundary; never trust a model argument or an old context. */
export function currentProcessScope(ctx: KernelContext): ProcessScope | null {
  if (!ctx.processScopeId) return null;
  if (!ctx.processId || ctx.procs.get(ctx.processId)?.scopeId !== ctx.processScopeId) throw new Error("Scoped process no longer exists");
  const scope = ctx.procs.scopes.requireActive(ctx.processScopeId);
  if (scope.ownerUid !== resolveCallerOwnerUid(ctx)) throw new Error("Process scope owner changed");
  for (const grant of scope.policy.conversations) {
    const contact = ctx.federation.get(grant.contactId);
    if (!contact || contact.ownerUid !== scope.ownerUid || contact.state !== "active" || contact.generation !== grant.generation
      || contact.conversationId !== grant.conversationId) throw new Error("Process scope connection is no longer active");
  }
  return scope;
}

export function isProcessScopeCurrent(ctx: KernelContext): boolean {
  try { currentProcessScope(ctx); return true; } catch { return false; }
}

export function validateScopePolicy(policy: ProcessScopePolicy, ownerUid: number, ctx: KernelContext): void {
  for (const grant of policy.conversations) {
    const contact = ctx.federation.get(grant.contactId);
    if (!contact || contact.ownerUid !== ownerUid || contact.state !== "active" || contact.generation !== grant.generation
      || contact.conversationId !== grant.conversationId) throw new Error("Review the current conversation before granting helper access");
  }
  if (policy.automatic && policy.conversations.some((grant) => {
    const contact = ctx.federation.get(grant.contactId);
    return contact?.protocol?.version !== 2 || !contact.protocol.features.includes("messages") || contact.preferences.muted;
  })) throw new Error("Automatic help requires an unmuted conversation with v2 human-message attribution");
  for (const resource of policy.resources) {
    if (!policy.conversations.some((grant) => grant.contactId === resource.target)
      || !/^\/resources\/[^/]+$/.test(resource.path) || resource.expiresAt !== undefined) {
      throw new Error("Helper resources must be exact immutable attachments from its selected contacts");
    }
  }
}

export function assertScopedProcess(ctx: KernelContext, pid: string): void {
  const scope = currentProcessScope(ctx);
  if (scope && ctx.procs.scopes.forProcess(pid)?.id !== scope.id) throw new Error("Process is outside this helper's scope");
}

export function assertScopedConversation(ctx: KernelContext, conversationId: string): void {
  const scope = currentProcessScope(ctx);
  if (scope && !scope.policy.conversations.some((grant) => grant.conversationId === conversationId && grant.read)) {
    throw new Error("Conversation is outside this helper's read scope");
  }
}

export function scopedResource(ctx: KernelContext, target: string, path: string): FileResourceReference | null {
  const scope = currentProcessScope(ctx);
  if (!scope) return null;
  const resource = scope.policy.resources.find((ref) => ref.target === target && ref.path === path);
  if (!resource) throw new Error("Resource is outside this helper's scope");
  return resource;
}

export function assertScopedSend(ctx: KernelContext, contactId: string): ProcessScope | null {
  const scope = currentProcessScope(ctx);
  if (scope && !hasCapability(effectiveProcessCapabilities(ctx), "contact.send")) throw new Error("Process scope denies contact.send");
  if (scope && !scope.policy.conversations.some((grant) => grant.contactId === contactId && grant.send)) {
    throw new Error("This helper cannot send to that recipient; prepare a draft for the owner instead");
  }
  return scope;
}

/** Dispatcher check precedes approval and routing. Owning effects recheck after awaits. */
export function assertScopedRequest(frame: RequestFrame, ctx: KernelContext): void {
  const scope = currentProcessScope(ctx);
  if (!scope) return;
  if (!INTERNAL_SCOPED_CALLS.has(frame.call)
    && !effectiveProcessCapabilities(ctx).includes(frame.call)) throw new Error(`Process scope denies ${frame.call}`);
  if (INTERNAL_SCOPED_CALLS.has(frame.call) && ctx.processRunId) throw new Error("Internal Process configuration is not a model capability");
  if (frame.call === "fs.read" || frame.call === "fs.transfer.send" || frame.call === "shell.exec" || frame.call === "ai.text.generate") {
    const target = frame.args.target;
    if (target && target !== "gsv") {
      if (frame.call !== "fs.read" && frame.call !== "fs.transfer.send") throw new Error("Target is outside this helper's scope");
      scopedResource(ctx, target, frame.args.path);
    }
  }
  if (frame.call === "shell.exec" && (frame.args.sessionId || frame.args.start)) throw new Error("Helper scope does not include device shell sessions");
  if (frame.call === "conversation.history" || frame.call === "conversation.search" || frame.call === "conversation.media.read") assertScopedConversation(ctx, frame.args.conversationId);
  if (frame.call === "contact.send") assertScopedSend(ctx, frame.args.contactId);
  if (frame.call.startsWith("proc.") && frame.args && "pid" in frame.args && frame.args.pid) assertScopedProcess(ctx, frame.args.pid);
}
