import type { Frame, RequestFrame } from "./frames";

export type ProcessScheduleDeliverArgs = {
  scheduleId: string;
  scheduleName?: string;
  conversationId?: string;
  message: string;
  data?: Record<string, unknown>;
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

export type ProcessRequestFrame = RequestFrame | ProcessScheduleDeliverRequestFrame;
export type ProcessInboundFrame = Frame | ProcessScheduleDeliverRequestFrame;
