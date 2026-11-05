import { z } from "zod";
import {
  jsonValueSchema, resourceBlockSchema, type JsonObject, type JsonValue, type ProcessIdentity, type ResourceBlock,
} from "@humansandmachines/gsv/protocol";
import type { ProcessEventAdmission } from "../protocol/process-frames";
import { processIdentitySchema } from "../protocol/peer-schemas";
import type { KernelContext } from "./context";
import { processConsumer } from "./events/consumers";
import type { EventDefinition, Withdrawn } from "./events/registry";
import type { EventActor, EventInput } from "./events/store";
import type { IpcCallRecord } from "./ipc-calls";

export const IPC_MESSAGE = "ipc.message";
export const IPC_CALL = "ipc.call";
export const IPC_REPLY = "ipc.reply";
export const IPC_TIMEOUT = "ipc.timeout";
export const IPC_OVERDUE = "ipc.overdue";

/** What a caller hears when its call's deadline passes before its target answers. */
export const IPC_TIMED_OUT = "IPC call timed out";

/** One exchange's events share a subject: a message, or a call with its check-ins and its end. */
export function ipcSubject(id: string): string {
  return `ipc:${id}`;
}

const forwardSchema = z.strictObject({
  targetPid: z.string(),
  sourcePid: z.string(),
  source: processIdentitySchema,
  message: z.string(),
  metadata: z.record(z.string(), z.json()).optional(),
  call: z.strictObject({ callId: z.string(), deadlineAt: z.number(), supervised: z.literal(true).optional() }).optional(),
});

/** What the log keeps of a process's message or call until its target takes it. */
export type IpcForward = {
  targetPid: string;
  sourcePid: string;
  source: ProcessIdentity;
  message: string;
  metadata?: JsonObject;
  call?: { callId: string; deadlineAt: number; supervised?: true };
};

const answerSchema = z.strictObject({
  sourcePid: z.string(),
  callId: z.string(),
  targetPid: z.string(),
  sourceRunId: z.string().optional(),
  createdAt: z.number(),
  deadlineAt: z.number(),
  response: z.optional(jsonValueSchema),
  error: z.string().optional(),
  attachments: z.optional(z.array(resourceBlockSchema)),
});
const checkInSchema = z.strictObject({
  callId: z.string(),
  sourcePid: z.string(),
  checkedAt: z.number(),
  nextCheckAt: z.number(),
  checkInCount: z.number().int().positive(),
});

/** A check-in's moment: when it was made, when the next is due, and how many came before. */
export type IpcCheckIn = Pick<z.infer<typeof checkInSchema>, "checkedAt" | "nextCheckAt" | "checkInCount">;

/** A process's message or call to another process of its owner; a message's id is fresh, a call's is its call id. */
export function ipcForward(ownerUid: number, forward: IpcForward): EventInput {
  const id = forward.call?.callId ?? crypto.randomUUID();
  return {
    type: forward.call ? IPC_CALL : IPC_MESSAGE,
    ownerUid,
    subject: ipcSubject(id),
    actor: { kind: "process", pid: forward.sourcePid },
    key: id,
    body: forward,
  };
}

/** How a call ended: its target's answer, or why there is none. */
export type IpcCallEnd = {
  type: typeof IPC_REPLY | typeof IPC_TIMEOUT;
  /** How the target's run ended, when its run answered. */
  runStatus?: "ok" | "error" | "aborted";
  response?: JsonValue;
  error?: string;
  /** The file that holds an answer too large for its event. */
  attachments?: ResourceBlock[];
};

/** A call's end for the process that asked, carrying the whole answer. */
export function ipcAnswer(call: IpcCallRecord, end: IpcCallEnd, actor: EventActor): EventInput {
  const { type, response, error, attachments } = end;
  return {
    type,
    ownerUid: call.ownerUid,
    subject: ipcSubject(call.callId),
    actor,
    key: call.callId,
    body: {
      sourcePid: call.sourcePid,
      ...callPayload(call),
      deadlineAt: call.deadlineAt,
      ...(response === undefined ? undefined : { response }),
      ...(error ? { error } : undefined),
      ...(attachments ? { attachments } : undefined),
    } satisfies z.input<typeof answerSchema>,
  };
}

/** Withdraws the answer of a call whose caller hears in the call itself, and returns the error it carried. */
export function withdrawIpcAnswer(ctx: Pick<KernelContext, "events">, callId: string): string | null {
  const [answer] = [IPC_TIMEOUT, IPC_REPLY].flatMap((type) => ctx.events.pending(type, ipcSubject(callId)));
  if (!answer) return null;
  ctx.events.withdraw(answer, "its caller heard when it asked");
  return answerSchema.parse(answer.event.body).error ?? null;
}

/** A supervised call's check-in for the process that asked. */
export function ipcCheckIn(call: IpcCallRecord, checkIn: IpcCheckIn): EventInput {
  return {
    type: IPC_OVERDUE,
    ownerUid: call.ownerUid,
    subject: ipcSubject(call.callId),
    actor: { kind: "kernel" },
    key: `${call.callId}:${checkIn.checkInCount}`,
    body: { callId: call.callId, sourcePid: call.sourcePid, ...checkIn },
  };
}

/** The call an event is about while it is still in flight, or why the event no longer goes. */
function pendingCall(callId: string, ctx: KernelContext): IpcCallRecord | Withdrawn {
  return ctx.ipcCalls.get(callId) ?? { withdrawn: "the call already ended" };
}

function reason(found: IpcCallRecord | Withdrawn): string | null {
  return "withdrawn" in found ? found.withdrawn : null;
}

/** An answer joins the run that asked, or takes a run of its own after another one. */
function answerAdmission(sourceRunId: string | null | undefined): ProcessEventAdmission {
  return { idle: "start", busy: "join", ...(sourceRunId ? { joinRun: sourceRunId } : undefined) };
}

/** What the asking process records about its call. */
function callPayload(call: IpcCallRecord) {
  return {
    callId: call.callId,
    targetPid: call.targetPid,
    ...(call.sourceRunId ? { sourceRunId: call.sourceRunId } : undefined),
    createdAt: call.createdAt,
  };
}

/**
 * Another process's message or call, which takes a run of its own, now or after the
 * active one. A call no longer pending, because it timed out or its caller cancelled it,
 * is withdrawn before its target sees it.
 */
const forwardDefinition: EventDefinition = {
  routes: (event) => [{ consumer: processConsumer(forwardSchema.parse(event.body).targetPid), lane: "background" }],
  withdrawal(event, ctx) {
    const { call } = forwardSchema.parse(event.body);
    return call ? reason(pendingCall(call.callId, ctx)) : null;
  },
  admit(event) {
    const { sourcePid, source, message, metadata, call } = forwardSchema.parse(event.body);
    return {
      message: {
        sourcePid, source, message,
        ...(metadata === undefined ? undefined : { metadata }),
        origin: { kind: "process", sourcePid, uid: source.uid },
        sentAt: event.createdAt,
        ...(call === undefined ? undefined : { call }),
      },
      admission: { idle: "start", busy: "after" },
    };
  },
};

/** A call's end, which carries its answer. A caller that was reset or whose asking run was aborted drops it. */
function answerDefinition(type: typeof IPC_REPLY | typeof IPC_TIMEOUT): EventDefinition {
  return {
    routes: (event) => [{ consumer: processConsumer(answerSchema.parse(event.body).sourcePid), lane: "background" }],
    admit(event) {
      const { sourcePid: _sourcePid, attachments, ...payload } = answerSchema.parse(event.body);
      return {
        event: { kind: type, severity: type === IPC_TIMEOUT || payload.error ? "error" : "info", audience: "model", payload },
        admission: answerAdmission(payload.sourceRunId),
        ...(attachments ? { attachments } : undefined),
      };
    },
  };
}

/** A supervised call's check-in, withdrawn once the call has ended: its answer says more. */
const checkInDefinition: EventDefinition = {
  routes: (event) => [{ consumer: processConsumer(checkInSchema.parse(event.body).sourcePid), lane: "background" }],
  withdrawal: (event, ctx) => reason(pendingCall(checkInSchema.parse(event.body).callId, ctx)),
  admit(event, _prepared, ctx) {
    const { callId, checkedAt, nextCheckAt, checkInCount } = checkInSchema.parse(event.body);
    const call = pendingCall(callId, ctx);
    if ("withdrawn" in call) return call;
    return {
      event: {
        kind: IPC_OVERDUE,
        severity: "info",
        audience: "model",
        payload: { ...callPayload(call), deadlineAt: checkedAt, nextCheckAt, checkInCount },
      },
      admission: answerAdmission(call.sourceRunId),
    };
  },
};

export const ipcEventDefinitions = {
  [IPC_MESSAGE]: forwardDefinition,
  [IPC_CALL]: forwardDefinition,
  [IPC_REPLY]: answerDefinition(IPC_REPLY),
  [IPC_TIMEOUT]: answerDefinition(IPC_TIMEOUT),
  [IPC_OVERDUE]: checkInDefinition,
};
