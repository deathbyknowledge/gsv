export type CronSchedule =
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "at"; atMs: number }
  | { kind: "cron"; expr: string; tz?: string };

export type CronMode = {
  sessionKey?: string;
  message?: string;
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
  deliver?: boolean;
  channel?: string;
  to?: string;
};

export type CronJobState = {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: "ok" | "error" | "skipped";
  lastError?: string;
  lastDurationMs?: number;
};

export type CronJob = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  schedule: CronSchedule;
  spec: CronMode;
  state: CronJobState;
};

export type CronJobPatch = {
  name?: string;
  description?: string;
  enabled?: boolean;
  deleteAfterRun?: boolean;
  schedule?: CronSchedule;
  spec?: Partial<CronMode>;
};

export type SchedulerListArgs = {
  includeDisabled?: boolean;
  limit?: number;
  offset?: number;
};

export type SchedulerListResult = {
  jobs: CronJob[];
  count: number;
};

export type SchedulerAddArgs = {
  name: string;
  description?: string;
  enabled?: boolean;
  deleteAfterRun?: boolean;
  schedule: CronSchedule;
  spec: CronMode;
};

export type SchedulerRunResult = {
  ran: number;
  results: CronRunResult[];
};

export type CronRunResult = {
  jobId: string;
  status: "ok" | "error" | "skipped";
  error?: string;
  summary?: string;
  durationMs: number;
  nextRunAtMs?: number;
};
