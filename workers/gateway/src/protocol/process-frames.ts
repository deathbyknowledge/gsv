import type {
  AdapterInteractionOrigin,
  ConversationMessage,
  EventReplyTarget,
  ProcMediaInput,
  ProcSendResult,
  ResourceBlock,
  ResponseErrEnvelope,
  TypedRequest,
  TypedResponseOk,
} from "@humansandmachines/gsv/protocol";
import type { Frame, FrameBody, RequestFrame, SignalFrame } from "./frames";

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

export type ProcessRuntimeEvent =
  | ProcessAdapterWorkReturnedRuntimeEvent
  | ProcessResponsibilityReadyRuntimeEvent;

export type ProcessRuntimeEventDeliverArgs = {
  eventId: string;
  event: ProcessRuntimeEvent;
};

export type ProcessRuntimeEventDeliverResult = {
  eventId: string;
  runId: string;
  queued: boolean;
};

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
};

export type ProcessRunAttachArgs = {
  runId: string;
  media: ResourceBlock[];
};

export type ProcessRunAttachResult =
  | {
      ok: true;
      runId: string;
      media: ResourceBlock[];
    }
  | { ok: false; error: string };

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
};

/**
 * Kernel-to-Process and Process-to-Kernel calls that never cross a public
 * carrier. They share the public frame envelope but have their own contract table.
 */
export type InternalSyscallDomains = {
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

export type ProcessRequestFrame = RequestFrame | InternalRequestFrame<ProcessInternalCall>;
export type ProcessInboundFrame = Frame | InternalRequestFrame<ProcessInternalCall>;
export type ProcessOutboundFrame =
  | Frame
  | InternalRequestFrame<"proc.message.commit">
  | ProcessMessageStreamSignal;
