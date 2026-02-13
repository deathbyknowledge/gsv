export type CronSchedule =
  | { kind: "at"; atMs: number }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string };

/**
 * Cron job mode — determines how the job runs and how results are delivered.
 *
 * "systemEvent": Injects a text message into the agent's main session as a
 *   user message. The agent processes it in the context of the existing
 *   conversation and the response is delivered to the last active channel.
 *   Good for simple reminders and notifications.
 *
 * "task": Runs a full agent turn in an isolated session
 *   (agent:{agentId}:cron:{jobId}). Each run gets a clean conversation —
 *   no carry-over from the user's main chat. Supports explicit delivery
 *   control (channel, to) and model/thinking overrides.
 *   Good for scheduled reports, time-sensitive reminders, and any job that
 *   shouldn't pollute the main conversation.
 */
export type CronMode =
  | { mode: "systemEvent"; text: string }
  | {
      mode: "task";
      message: string;
      model?: string;
      thinking?: string;
      timeoutSeconds?: number;
      deliver?: boolean;
      channel?: string;
      to?: string;
      bestEffortDeliver?: boolean;
    };

/**
 * Patch type for CronMode — same as CronMode but all fields except `mode`
 * are optional (for partial updates).
 */
export type CronModePatch =
  | { mode: "systemEvent"; text?: string }
  | {
      mode: "task";
      message?: string;
      model?: string;
      thinking?: string;
      timeoutSeconds?: number;
      deliver?: boolean;
      channel?: string;
      to?: string;
      bestEffortDeliver?: boolean;
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
  agentId: string;
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

export type CronRun = {
  id: number;
  jobId: string;
  ts: number;
  status: "ok" | "error" | "skipped";
  error?: string;
  summary?: string;
  durationMs?: number;
  nextRunAtMs?: number;
};

export type CronJobCreate = {
  agentId?: string;
  name: string;
  description?: string;
  enabled?: boolean;
  deleteAfterRun?: boolean;
  schedule: CronSchedule;
  spec: CronMode;
};

export type CronJobPatch = {
  agentId?: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  deleteAfterRun?: boolean;
  schedule?: CronSchedule;
  spec?: CronModePatch;
};

export type CronRunResult = {
  jobId: string;
  status: "ok" | "error" | "skipped";
  error?: string;
  summary?: string;
  durationMs: number;
  nextRunAtMs?: number;
};
