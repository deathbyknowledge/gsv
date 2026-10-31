import { z } from "zod";
import type {
  AdapterInteractionOrigin,
  ConversationMessage,
  EventReplyTarget,
  JsonObject,
  ProcMediaInput,
  ProcSendResult,
  ProcHistoryEvent,
  ProcHistoryMessageQuote,
  ResourceBlock,
  ResponseErrEnvelope,
  TypedRequest,
  TypedResponseOk,
} from "@humansandmachines/gsv/protocol";
import type { Frame, FrameBody, RequestFrame, SignalFrame } from "./frames";
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

export type ProcessAdapterWorkReturnedRuntimeEvent = {
  type: "adapter.work.returned";
  workPid: string;
};

export type ProcessResponsibilityReadyRuntimeEvent = {
  type: "r12y.ready";
  batchId: string;
  ledgerRevision: number;
  responsibilityIds: string[];
};

/** One contact message for Ship, with its attachments as references to the contact's Ship. */
export type ProcessContactMessageRuntimeEvent = {
  type: "contact.message";
  contactId: string;
  contactGeneration: string;
  conversationId: string;
  messageId: string;
  from: string;
  text: string;
  media?: ResourceBlock[];
  responsibilityId: string;
  ledgerRevision: number;
};

export type ProcessRuntimeEvent =
  | ProcessAdapterWorkReturnedRuntimeEvent
  | ProcessResponsibilityReadyRuntimeEvent
  | ProcessContactMessageRuntimeEvent;

export type ProcessRuntimeEventDeliverArgs = {
  eventId: string;
  event: ProcessRuntimeEvent;
};

export type ProcessRuntimeEventDeliverResult = {
  eventId: string;
  runId: string;
  queued: boolean;
};

/** Kernel-derived registered events; this call is never available to public peers. */
export type ProcessEventDeliverArgs = {
  eventId: string;
  event: Extract<ProcHistoryEvent, { kind: "target.connection" | "owner.notified" }>;
};

export type ProcessEventDeliverResult = {
  eventId: string;
  runId: string | null;
  queued: boolean;
  messageId?: number;
  ignored?: boolean;
};

export const processEventDeliverResultSchema: z.ZodType<ProcessEventDeliverResult> = z.strictObject({
  eventId: z.string(),
  runId: z.string().nullable(),
  queued: z.boolean(),
  messageId: z.number().int().positive().optional(),
  ignored: z.boolean().optional(),
});

type ProcessScheduleDataValue =
  | string
  | number
  | boolean
  | null
  | ProcessScheduleDataValue[]
  | { [key: string]: ProcessScheduleDataValue };

export type ProcessScheduleData = {
  [key: string]: ProcessScheduleDataValue;
};

export type ProcessScheduleDeliverArgs = {
  runId: string;
  scheduleId: string;
  scheduleName?: string;
  message: string;
  data?: ProcessScheduleData;
  replyTo?: EventReplyTarget;
  scheduledAtMs?: number | null;
  firedAtMs: number;
};

export type ProcessScheduleDeliverResult = {
  runId: string;
  queued: boolean;
};

export type ProcessAdapterDeliverArgs = {
  runId: string;
  pid: string;
  message: string;
  media?: Array<ResourceBlock | ProcMediaInput>;
  origin: AdapterInteractionOrigin;
  interaction: {
    conversationId: string;
    messageId: string;
  };
  /** Present only when the person quoted a message. */
  quote?: ProcHistoryMessageQuote;
};

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
  /** Time from the person's message reaching the Process to this commit; only on a run's first reply. */
  replyMs?: number;
};

/**
 * Kernel-to-Process and Process-to-Kernel calls that never cross a public
 * carrier. They share the public frame envelope but have their own contract table.
 */
export type InternalSyscallDomains = {
  "proc.tool.authorize": { args: ProcessToolAuthorizeArgs; result: { approved: boolean } };
  "proc.event.deliver": { args: ProcessEventDeliverArgs; result: ProcessEventDeliverResult };
  "proc.runtime.event.deliver": {
    args: ProcessRuntimeEventDeliverArgs;
    result: ProcessRuntimeEventDeliverResult;
  };
  "proc.schedule.deliver": {
    args: ProcessScheduleDeliverArgs;
    result: ProcessScheduleDeliverResult;
  };
  "proc.adapter.deliver": { args: ProcessAdapterDeliverArgs; result: ProcSendResult };
  "proc.run.attach": { args: ProcessRunAttachArgs; result: ProcessRunAttachResult };
  "proc.run.staged": { args: ProcessRunStagedArgs; result: ProcessRunStagedResult };
  "proc.resources.retain": {
    args: ProcessResourcesRetainArgs;
    result: { resources: ResourceBlock[] };
  };
  "proc.resource.write": { args: ProcessResourceWriteArgs; result: { resource: ResourceBlock } };
  "proc.message.commit": { args: ProcessMessageCommitArgs; result: { message: ConversationMessage } };
};

export type InternalSyscallName = keyof InternalSyscallDomains;

/** `proc.resource.write` carries its bytes as a mandatory body. */
type InternalRequestOf<S extends InternalSyscallName> = S extends "proc.resource.write"
  ? TypedRequest<InternalSyscallDomains, S, FrameBody> & { body: FrameBody }
  : TypedRequest<InternalSyscallDomains, S, FrameBody>;

export type InternalRequestFrame<S extends InternalSyscallName = InternalSyscallName> = {
  [K in S]: InternalRequestOf<K>;
}[S];

/** Internal calls always answer with their result; only public frames may omit data. */
export type InternalResponseFrame<S extends InternalSyscallName = InternalSyscallName> =
  | (TypedResponseOk<InternalSyscallDomains, S, FrameBody> & {
      data: InternalSyscallDomains[S]["result"];
    })
  | ResponseErrEnvelope;

/** Internal calls the Kernel sends to a Process. */
export type ProcessInternalCall = Exclude<InternalSyscallName, "proc.message.commit">;

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

export type ProcessRequestFrame = (RequestFrame | InternalRequestFrame<ProcessInternalCall>) & { toolOwner?: ProcessToolOwner };
export type ProcessInboundFrame = Exclude<Frame, { type: "req" }> | ProcessRequestFrame;
export type ProcessOutboundFrame =
  | Frame
  | InternalRequestFrame<"proc.message.commit">
  | ProcessMessageStreamSignal;
