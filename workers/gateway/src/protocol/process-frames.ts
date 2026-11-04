import { z } from "zod";
import type {
  InteractionOrigin,
  JsonObject,
  ProcMediaInput,
  ProcHistoryEvent,
  ProcHistoryEventPayload,
  ProcHistoryMessageQuote,
  ProcessIdentity,
  ResourceBlock,
} from "@humansandmachines/gsv/protocol";
import type { Frame, RequestFrame, SignalFrame } from "./frames";
import type { SyscallName } from "../syscalls";
import type { TargetDescriptor } from "../kernel/targets";

/** Kernel-derived ownership for operations composed beneath a dispatched agent tool. */
export type ProcessToolOwner = { runId: string; requestId: string };

export const processMemoryReviewSchema = z.object({
  segmentId: z.string().uuid(),
  archivePath: z.string().min(1),
  generation: z.number().int().nonnegative(),
  afterMessageId: z.number().int().nonnegative(),
  throughMessageId: z.number().int().positive(),
});
export type ProcessMemoryReview = z.infer<typeof processMemoryReviewSchema>;

/** Kernel-resolved approval scope, carried outside model-controlled syscall frames. */
export type ProcessApprovalTarget = Pick<TargetDescriptor, "targetId" | "ownerUid" | "platform" | "route">;
export type ProcessApprovalTargetRef = { targetId: string } | { sessionId: string };

export const processApprovalTargetSchema: z.ZodType<ProcessApprovalTarget> = z.object({
  targetId: z.string(), ownerUid: z.number(), platform: z.string(),
  route: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("machine"), targetId: z.string() }),
    z.object({ kind: z.literal("instance"), instanceId: z.string() }),
    z.object({
      kind: z.literal("adapter"), adapter: z.string(), accountId: z.string(), actorId: z.string(),
      adapterTargetId: z.string(), routeGeneration: z.string().optional(),
    }),
  ]),
});

export type ProcessToolAuthorizeArgs = ProcessToolOwner & {
  syscall: SyscallName;
  args: JsonObject;
  /** Derived from the Kernel's resolved route, never from syscall arguments. */
  target?: ProcessApprovalTarget;
};

/** What a delivered event does to its Process, declared once per event type. */
export type ProcessEventAdmission = {
  /** With no active run: start one, or only record the event in history. */
  idle: "start" | "record";
  /** During a run: join it, take its own run once it ends, stop it and start this one, or only record the event. */
  busy: "join" | "after" | "interrupt" | "record";
  /** Joins only this run; during another, the event takes its own run after it. */
  joinRun?: string;
};

/** A message for a process to act on, from a person or from another process. */
export type ProcessInput = {
  message: string;
  media?: Array<ResourceBlock | ProcMediaInput>;
  origin?: InteractionOrigin;
  /** The Conversation message it was committed as, when it has one. */
  interaction?: { conversationId: string; messageId: string };
  selectedTarget?: string;
  /** Present only when the person quoted a message. */
  quote?: ProcHistoryMessageQuote;
  /** The run it takes when its producer recorded one first, as a Conversation does; otherwise the delivery's id. */
  runId?: string;
};

/** Another process's message or call, as its target records it. */
export type ProcessIpcMessage = {
  sourcePid: string;
  source: ProcessIdentity;
  message: string;
  metadata?: JsonObject;
  origin: Extract<InteractionOrigin, { kind: "process" }>;
  sentAt: number;
  /** A call's final answer returns to its caller. */
  call?: { callId: string; deadlineAt: number; supervised?: boolean };
};

/** What a Kernel event hands its Process: a history event, or another process's message. */
export type ProcessEventDelivery =
  | {
      event: Extract<ProcHistoryEvent, {
        kind: "target.connection" | "owner.notified" | "contact.message" | "responsibility.ready" | "schedule.fired"
          | "ipc.reply" | "ipc.overdue" | "ipc.timeout" | "adapter.work.returned" | "delivery.failed";
      }>;
      admission: ProcessEventAdmission;
      /** Responsibilities the event hands its run, which the run settles before it yields. */
      responsibilities?: { ledgerRevision: number; ids: string[] };
      /** Resources the event carries, retained as this Process's own media before admission. */
      attachments?: ResourceBlock[];
      /** The approval request a failed delivery carried, which the failure concerns only while it is pending. */
      approvalRequestId?: string;
    }
  | { message: ProcessIpcMessage; admission: ProcessEventAdmission }
  | { input: ProcessInput; admission: ProcessEventAdmission };

/** Kernel-derived registered events; this call is never available to public peers. */
export type ProcessEventDeliverArgs = ProcessEventDelivery & { eventId: string };

export type ProcessEventDeliverResult = {
  eventId: string;
  runId: string | null;
  queued: boolean;
  messageId?: number;
  ignored?: boolean;
  /** Why the Process can never take this delivery, such as media that is gone; it is not retried. */
  refused?: string;
};

/** What a schedule's firing tells its process: the `schedule.fired` payload, which `prompts/schedule-events.ts` formats. */
export type ProcessScheduleDeliverArgs = ProcHistoryEventPayload<"schedule.fired">;

export type ProcessRunAttachArgs = {
  runId: string;
  media: ResourceBlock[];
  /** The tool call staging these files. */
  requestId?: string;
};

export type ProcessRunAttachResult =
  | {
      ok: true;
      runId: string;
      media: ResourceBlock[];
    }
  | { ok: false; error: string };

/**
 * Asked before a send elsewhere without files: counts the files staged for the run's next
 * current-conversation message. With none, the tool calls running alongside `requestId` may no
 * longer stage any, so a parallel `message attach` cannot reach the owner instead of `destination`.
 */
export type ProcessRunStagedArgs = { runId: string; requestId?: string; destination: string };
export type ProcessRunStagedResult = { ok: true; count: number };

export type ProcessResourcesRetainArgs = {
  batchId: string;
  resources: ResourceBlock[];
};

export type ProcessResourceWriteArgs = {
  resourceId: string;
  mediaType: NonNullable<ResourceBlock["mediaType"]>;
  contentType: string;
  filename?: string;
  duration?: number;
  transcription?: string;
};

export type ProcessMessageCommitArgs = {
  runId: string;
  actionId: string;
  conversationId?: string;
  text: string;
  media?: ResourceBlock[];
  /** Replies the person can tap, already normalized by the Process. */
  choices?: string[];
  /** Time from the person's message reaching the Process to this commit; only on a run's first reply. */
  replyMs?: number;
};

/**
 * What a typed internal Process call answers instead of its result while the
 * Process is killed or changing lifecycle. Other failures are thrown.
 */
export type ProcessUnavailable = { unavailable: "killed" | "transitioning"; message: string };

/** A typed internal call's result, where an unavailable Process is a failure. */
export function processResult<T extends object>(result: T | ProcessUnavailable): T {
  if ("unavailable" in result) throw new Error(result.message);
  return result;
}

export function processMessageDraftId(runId: string, actionId: string): string {
  return `draft:${runId}:${actionId}`;
}

export type ProcessMessageStreamSignal = SignalFrame<{
  pid: string;
  runId: string;
  conversationId?: string;
  messageId: string;
  phase: "started" | "delta" | "aborted" | "silenced";
  delta?: string;
  reason?: string;
  timestamp: number;
}> & { signal: "proc.message.stream" };

export type ProcessRequestFrame = RequestFrame & { toolOwner?: ProcessToolOwner };
export type ProcessInboundFrame = Exclude<Frame, { type: "req" }> | ProcessRequestFrame;
export type ProcessOutboundFrame = Frame | ProcessMessageStreamSignal;
