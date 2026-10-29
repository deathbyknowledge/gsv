import { cancelBinaryBody } from "@humansandmachines/gsv/protocol";
import type { JsonObject, PhoneCall } from "@humansandmachines/gsv/protocol";
import { phoneCallArgsSchema, type InstallationPhone, type PhoneActor, type PhoneCallRequest } from "@humansandmachines/gsv/services/phone";
import { principalOf, type KernelContext } from "../context";
import { hasCapability } from "../capabilities";
import type { RequestFrame, ResponseFrame } from "../../protocol/frames";
import { authorizeNestedOperation } from "../tool-approval";
import { acquirePhone, phoneActor, withPhone } from "../phone-service";
import { phoneCallBlocker } from "../phone-runtime";
import { handleResponsibilityUpdate, requireWritableResponsibility } from "../responsibilities";
import { renderPhoneInstructions } from "../../prompts/phone";
import { phoneOwnerName } from "../profiles";
import { raceWithAbort } from "../../shared/abort";
import { withByteStreamFinalizer } from "../../shared/streams";

export type PhoneRequest = Extract<RequestFrame, { call: `sys.phone.${string}` }>;

/** Live audio and the take-over credential belong to the signed-in owner, never to a Process. */
const HUMAN_ONLY = new Set<string>(["sys.phone.watch", "sys.phone.join"]);

export async function handlePhoneRequest(frame: PhoneRequest, ctx: KernelContext): Promise<ResponseFrame> {
  await cancelBinaryBody(frame.body, "Phone requests have no body");
  const actor = phoneActor(ctx);
  if (HUMAN_ONLY.has(frame.call) && !actor.human) throw new Error("This phone action requires the signed-in human owner");
  if (!hasCapability(principalOf(ctx)?.calls ?? [], frame.call)) throw new Error(`EACCES: permission denied: ${frame.call}`);
  if (frame.call === "sys.phone.watch") return watch(frame, actor, ctx);
  if (frame.call === "sys.phone.call") return { type: "res", id: frame.id, ok: true, data: await placeCall(frame.args, frame.id, actor, ctx) };
  return withPhone(ctx, async (service) => {
    let data: Extract<ResponseFrame, { ok: true }>["data"];
    switch (frame.call) {
      case "sys.phone.get": {
        const result = await service.get(actor, frame.args.callId);
        assertCallVisible(result.call, ctx);
        data = result;
        break;
      }
      case "sys.phone.list": {
        const result = await service.list(actor, frame.args);
        data = { ...result, calls: result.calls.filter((call) => callVisible(call, ctx)) };
        break;
      }
      case "sys.phone.answer":
        await requireVisibleCall(service, actor, frame.args.callId, ctx);
        data = await service.answer(actor, frame.args);
        break;
      case "sys.phone.note":
        await requireVisibleCall(service, actor, frame.args.callId, ctx);
        data = await service.note(actor, frame.args);
        break;
      case "sys.phone.end":
        await requireVisibleCall(service, actor, frame.args.callId, ctx);
        data = await service.end(actor, frame.args.callId);
        break;
      case "sys.phone.join":
        data = await service.join(actor, frame.args.callId);
        break;
    }
    return { type: "res", id: frame.id, ok: true, data };
  });
}

/**
 * The owner approves the brief before anything dials. An agent's call keeps the
 * promise it serves: the responsibility waits on the call until it ends.
 */
async function placeCall(raw: unknown, frameId: string, actor: PhoneActor, ctx: KernelContext) {
  if (ctx.processId && !ctx.toolOwner) throw new Error("A Process places calls only from an approved tool call");
  const parsed = phoneCallArgsSchema.safeParse(raw);
  if (!parsed.success) throw new Error(parsed.error.issues.map(readableIssue).join("\n"));
  const input = parsed.data;
  if (ctx.processId && !input.responsibilityId) throw new Error("Agent phone calls require the responsibilityId of the work they serve");
  const onBehalfOf = input.brief.onBehalfOf ?? phoneOwnerName(actor.ownerUid, ctx);
  if (!onBehalfOf) {
    throw new Error("brief.onBehalfOf: your owner has not set a name. Ask them which name the call should give, then pass it as onBehalfOf");
  }
  const args: PhoneCallRequest = {
    requestId: input.requestId ?? await toolRequestId(ctx) ?? frameId,
    brief: { ...input.brief, onBehalfOf },
    ...(input.responsibilityId ? { responsibilityId: input.responsibilityId } : {}),
  };
  const work = args.responsibilityId ? requireWritableResponsibility(args.responsibilityId, ctx) : undefined;
  if (work && (work.state === "resolved" || work.state === "cancelled")) throw new Error(`Responsibility ${work.id} is already ${work.state}`);
  // SAFETY: phoneCallArgsSchema produced plain JSON from JSON syscall arguments.
  await authorizeNestedOperation(ctx, "sys.phone.call", args as JsonObject);
  ctx.requestSignal?.throwIfAborted();
  const instructions = renderPhoneInstructions(args.brief);
  const result = await withPhone(ctx, (service) => service.call(actor, args, instructions), 60000);
  const { call } = result;
  ctx.broadcastToUserUid(call.ownerUid, "phone.changed", { callId: call.callId, revision: call.revision, state: call.state });
  // A call that already ended was settled by its notification, which reopened the work.
  if (!work || call.state === "ended" || ctx.phoneCalls.get(call.callId)?.settledAt) return result;
  const current = requireWritableResponsibility(work.id, ctx);
  if (current.state === "resolved" || current.state === "cancelled") return result;
  await handleResponsibilityUpdate({ id: current.id, expectedRevision: current.revision, patch: {
    state: "waiting", blocker: phoneCallBlocker(call.callId),
    details: { ...current.details, phoneCall: { callId: call.callId } },
  } }, ctx);
  return result;
}

/** One tool call places at most one call, so its owning identity is the retry key. */
async function toolRequestId(ctx: KernelContext): Promise<string | undefined> {
  if (!ctx.processId || !ctx.toolOwner) return undefined;
  const input = new TextEncoder().encode(`${ctx.processId}\n${ctx.toolOwner.runId}\n${ctx.toolOwner.requestId}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return `tool:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** One short line per problem, so an agent can correct the brief. */
function readableIssue(issue: { path: PropertyKey[]; message: string; code: string }): string {
  const path = issue.path.map(String).join(".") || "arguments";
  const missing = issue.code === "invalid_type" && /received undefined/.test(issue.message);
  return `${path}: ${missing ? "required" : issue.message}`;
}

async function watch(frame: Extract<PhoneRequest, { call: "sys.phone.watch" }>, actor: PhoneActor, ctx: KernelContext): Promise<ResponseFrame> {
  const timeout = AbortSignal.timeout(30000);
  const signal = ctx.requestSignal ? AbortSignal.any([ctx.requestSignal, timeout]) : timeout;
  const service = await acquirePhone(ctx, signal);
  let transferred = false;
  try {
    signal.throwIfAborted();
    const invocation = service.watch(actor, frame.args.callId);
    const result = await raceWithAbort(invocation, signal, { onAbort: () => {
      transferred = true;
      ctx.defer(Promise.allSettled([invocation.then((late) => cancelBinaryBody(late.body, "Call view cancelled before admission"))])
        .finally(() => service[Symbol.dispose]?.()));
    } });
    transferred = true;
    return { type: "res", id: frame.id, ok: true, data: result.data,
      body: { ...result.body, stream: withByteStreamFinalizer(result.body.stream, () => service[Symbol.dispose]?.()) } };
  } finally { if (!transferred) service[Symbol.dispose]?.(); }
}

/** The owner and Ship see every call; any other Process sees the calls it placed. */
function callVisible(call: PhoneCall, ctx: KernelContext): boolean {
  if (!ctx.processId || ctx.procs.get(ctx.processId)?.isPersonalController === true) return true;
  return call.processId === ctx.processId;
}

function assertCallVisible(call: PhoneCall, ctx: KernelContext): void {
  if (!callVisible(call, ctx)) throw new Error(`Unknown call: ${call.callId}`);
}

async function requireVisibleCall(service: InstallationPhone, actor: PhoneActor, callId: string, ctx: KernelContext): Promise<void> {
  if (!ctx.processId) return;
  assertCallVisible((await service.get(actor, callId)).call, ctx);
}
