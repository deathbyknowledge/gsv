import type { ProcSpawnAssignment } from "./proc";
import type { AdapterMessageDestination, EventReplyTarget } from "./interaction-origin";

export type ScheduleExpression =
  | { kind: "at"; atMs: number }
  | { kind: "after"; afterMs: number }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; timezone: string };

export type ScheduleTarget =
  | {
      kind: "command.exec";
      command: string;
      cwd?: string;
      timeoutMs?: number;
    }
  | {
      kind: "process.spawn";
      /** Account to run the scheduled process as (username, uid, or `pkg#agent`). Defaults to the schedule's run-as principal. */
      runAs?: string;
      label?: string;
      prompt: string;
      parentPid?: string;
      cwd?: string;
      assignment?: ProcSpawnAssignment;
    }
  | {
      kind: "process.event";
      pid: string;
      conversationId?: string;
      message: string;
      data?: Record<string, unknown>;
      replyTo?: EventReplyTarget;
    }
  | {
      kind: "adapter.send";
      destination: AdapterMessageDestination;
      text: string;
    };

export type SchedulePrincipal = {
  kind: "user" | "process" | "service";
  uid: number;
  username: string;
  pid?: string;
  channel?: string;
};

export type ScheduleRunState = {
  nextRunAtMs: number | null;
  runningAtMs: number | null;
  lastRunAtMs: number | null;
  lastStatus: "ok" | "error" | "skipped" | null;
  lastError: string | null;
  lastDurationMs: number | null;
  runCount: number;
};

export type ScheduleRecord = {
  id: string;
  ownerUid: number;
  creator: SchedulePrincipal;
  runAs: SchedulePrincipal;
  name: string;
  description?: string;
  enabled: boolean;
  expression: ScheduleExpression;
  target: ScheduleTarget;
  overlapPolicy: "skip";
  createdAtMs: number;
  updatedAtMs: number;
  state: ScheduleRunState;
};

export type ScheduleRunHistoryEntry = {
  id: string;
  scheduleId: string;
  scheduledAtMs: number | null;
  startedAtMs: number;
  finishedAtMs: number;
  status: "ok" | "error" | "skipped";
  error?: string;
  result?: unknown;
};

export type SchedulerListArgs = {
  ownerUid?: number;
  includeDisabled?: boolean;
  limit?: number;
  offset?: number;
};

export type SchedulerListResult = {
  schedules: ScheduleRecord[];
  count: number;
};

export type SchedulerAddArgs = {
  name: string;
  description?: string;
  enabled?: boolean;
  expression: ScheduleExpression;
  target: ScheduleTarget;
};

export type SchedulerAddResult = {
  schedule: ScheduleRecord;
};

export type SchedulerUpdateArgs = {
  id: string;
  patch: {
    name?: string;
    description?: string | null;
    enabled?: boolean;
    expression?: ScheduleExpression;
    target?: ScheduleTarget;
  };
};

export type SchedulerUpdateResult = {
  schedule: ScheduleRecord;
};

export type SchedulerRemoveArgs = {
  id: string;
};

export type SchedulerRemoveResult = {
  removed: boolean;
};

export type SchedulerRunArgs = {
  id?: string;
  mode?: "due" | "force";
};

export type SchedulerRunResult = {
  ran: number;
  results: ScheduleRunResult[];
};

export type ScheduleRunResult = {
  scheduleId: string;
  status: "ok" | "error" | "skipped";
  error?: string;
  summary?: string;
  durationMs: number;
  nextRunAtMs?: number | null;
};
