import type { AiContextProfile } from "./ai";
import type {
  ProcSpawnAssignment,
  ProcSpawnMountSpec,
} from "./proc";

export type ScheduleExpression =
  | { kind: "at"; atMs: number }
  | { kind: "after"; afterMs: number }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; timezone: string };

export type ScheduleTarget =
  | {
      kind: "process.spawn";
      profile?: AiContextProfile;
      label?: string;
      prompt: string;
      parentPid?: string;
      cwd?: string;
      mounts?: ProcSpawnMountSpec[];
      assignment?: ProcSpawnAssignment;
    }
  | {
      kind: "process.event";
      pid: string;
      conversationId?: string;
      message: string;
      data?: Record<string, unknown>;
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
