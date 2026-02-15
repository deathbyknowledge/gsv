import { GsvConfig } from ".";

export const DEFAULT_CONFIG: GsvConfig = {
  model: {
    provider: "anthropic",
    id: "claude-sonnet-4-20250514",
  },
  apiKeys: {},
  timeouts: {
    llmMs: 300_000, // 5 minutes
    toolMs: 60_000, // 1 minute
    skillProbeMaxAgeMs: 10 * 60_000, // 10 minutes
  },
  auth: {},
  transcription: {
    provider: "workers-ai",
  },
  channels: {
    whatsapp: { dmPolicy: "pairing", allowFrom: [] },
    discord: { dmPolicy: "open", allowFrom: [] },
  },
  session: {
    defaultResetPolicy: {
      mode: "daily",
      atHour: 4,
    },
    mainKey: "main",
    dmScope: "main",
    identityLinks: {},
  },
  skills: {
    entries: {},
  },
  agents: {
    list: [],
    bindings: [],
    defaultHeartbeat: {
      every: "30m",
      prompt: "Read HEARTBEAT.md if it exists in your workspace. Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
      target: "last",
      activeHours: { start: "08:00", end: "23:00" },
    },
  },
  cron: {
    enabled: true,
    maxJobs: 200,
    maxRunsPerJobHistory: 200,
    maxConcurrentRuns: 4,
  },
  userTimezone: "UTC",
};
