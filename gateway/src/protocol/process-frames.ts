import type {
  AdapterInteractionOrigin,
  EventReplyTarget,
  ManagedMailSummaryCategory,
  ProcMediaInput,
  ProcSendResult,
} from "@humansandmachines/gsv/protocol";
import type { Frame, RequestFrame, ResponseErrFrame } from "./frames";

export type ProcessMailReceivedRuntimeEvent = {
  type: "mail.received";
  mailboxId: string;
  messageId: string;
  receivedAt: number;
  envelopeFrom: string;
  displayFrom?: string;
  subject?: string;
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
  data?: Record<string, unknown>;
  replyTo?: EventReplyTarget;
  scheduledAtMs?: number | null;
  firedAtMs: number;
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
  media?: ProcMediaInput[];
  origin: AdapterInteractionOrigin;
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
  media: Array<ProcMediaInput & { key: string; path: string; size: number }>;
  /** Media created by this command and safe to remove if registration fails. */
  stagedKeys?: string[];
};

export type ProcessRunAttachResult =
  | {
      ok: true;
      runId: string;
      media: Array<ProcMediaInput & { key: string; path: string; size: number }>;
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

export type ProcessRequestFrame =
  | RequestFrame
  | ProcessRuntimeEventDeliverRequestFrame
  | ProcessScheduleDeliverRequestFrame
  | ProcessAdapterDeliverRequestFrame
  | ProcessRunAttachRequestFrame;
export type ProcessInboundFrame =
  | Frame
  | ProcessRuntimeEventDeliverRequestFrame
  | ProcessScheduleDeliverRequestFrame
  | ProcessAdapterDeliverRequestFrame
  | ProcessRunAttachRequestFrame;
