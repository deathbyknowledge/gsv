import type {
  AdapterInteractionOrigin,
  EventReplyTarget,
  ManagedMailSummaryCategory,
  ProcMediaInput,
  ProcSendResult,
  ConversationMessage,
  ResourceBlock,
} from "@humansandmachines/gsv/protocol";
import type { Frame, FrameBody, RequestFrame, ResponseErrFrame, SignalFrame } from "./frames";

export type ProcessMailReceivedRuntimeEvent = {
  type: "mail.received";
  messageId: string;
  receivedAt: number;
  summary: string;
  category: ManagedMailSummaryCategory;
  requiresAttention: boolean;
  confidence?: number;
};

export type ProcessAdapterWorkReturnedRuntimeEvent = {
  type: "adapter.work.returned";
  workPid: string;
};

export type ProcessRuntimeEvent =
  | ProcessMailReceivedRuntimeEvent
  | ProcessAdapterWorkReturnedRuntimeEvent;

export type ProcessRuntimeEventDeliverArgs = {
  eventId: string;
  event: ProcessRuntimeEvent;
};

export type ProcessRuntimeEventDeliverRequestFrame = {
  type: "req";
  id: string;
  call: "proc.runtime.event.deliver";
  args: ProcessRuntimeEventDeliverArgs;
  body?: undefined;
};

export type ProcessRuntimeEventDeliverResult = {
  eventId: string;
  runId: string;
  queued: boolean;
};

export type ProcessRuntimeEventDeliverResponseFrame =
  | {
      type: "res";
      id: string;
      ok: true;
      data: ProcessRuntimeEventDeliverResult;
    }
  | ResponseErrFrame;

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

export type ProcessScheduleDeliverRequestFrame = {
  type: "req";
  id: string;
  call: "proc.schedule.deliver";
  args: ProcessScheduleDeliverArgs;
  body?: undefined;
};

export type ProcessScheduleDeliverResult = {
  runId: string;
  queued: boolean;
};

export type ProcessScheduleDeliverResponseFrame =
  | {
      type: "res";
      id: string;
      ok: true;
      data: ProcessScheduleDeliverResult;
    }
  | ResponseErrFrame;

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

export type ProcessAdapterDeliverRequestFrame = {
  type: "req";
  id: string;
  call: "proc.adapter.deliver";
  args: ProcessAdapterDeliverArgs;
  body?: undefined;
};

export type ProcessAdapterDeliverResponseFrame =
  | {
      type: "res";
      id: string;
      ok: true;
      data: ProcSendResult;
    }
  | ResponseErrFrame;

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

export type ProcessRunAttachRequestFrame = {
  type: "req";
  id: string;
  call: "proc.run.attach";
  args: ProcessRunAttachArgs;
  body?: undefined;
};

export type ProcessRunAttachResponseFrame =
  | {
      type: "res";
      id: string;
      ok: true;
      data: ProcessRunAttachResult;
    }
  | ResponseErrFrame;

export type ProcessResourceRetainRequestFrame = {
  type: "req";
  id: string;
  call: "proc.resource.retain";
  args: { resource: ResourceBlock };
  body?: undefined;
};

export type ProcessResourceWriteRequestFrame = {
  type: "req";
  id: string;
  call: "proc.resource.write";
  args: {
    resourceId: string;
    mediaType: NonNullable<ResourceBlock["mediaType"]>;
    contentType: string;
    filename?: string;
    duration?: number;
    transcription?: string;
  };
  body: FrameBody;
};

export type ProcessResourceResponseFrame =
  | {
      type: "res";
      id: string;
      ok: true;
      data: { resource: ResourceBlock };
    }
  | ResponseErrFrame;

export type ProcessMessageCommitArgs = {
  runId: string;
  conversationId?: string;
  text: string;
  media?: ResourceBlock[];
};

export type ProcessMessageCommitRequestFrame = {
  type: "req";
  id: string;
  call: "proc.message.commit";
  args: ProcessMessageCommitArgs;
  body?: undefined;
};

export type ProcessMessageCommitResponseFrame =
  | {
      type: "res";
      id: string;
      ok: true;
      data: { message: ConversationMessage };
    }
  | ResponseErrFrame;

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

export type ProcessRequestFrame =
  | RequestFrame
  | ProcessRuntimeEventDeliverRequestFrame
  | ProcessScheduleDeliverRequestFrame
  | ProcessAdapterDeliverRequestFrame
  | ProcessRunAttachRequestFrame
  | ProcessResourceRetainRequestFrame
  | ProcessResourceWriteRequestFrame;
export type ProcessInboundFrame =
  | Frame
  | ProcessRuntimeEventDeliverRequestFrame
  | ProcessScheduleDeliverRequestFrame
  | ProcessAdapterDeliverRequestFrame
  | ProcessRunAttachRequestFrame
  | ProcessResourceRetainRequestFrame
  | ProcessResourceWriteRequestFrame;

export type ProcessOutboundFrame =
  | Frame
  | ProcessMessageCommitRequestFrame
  | ProcessMessageStreamSignal;
