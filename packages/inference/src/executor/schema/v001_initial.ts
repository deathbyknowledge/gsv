export const EXECUTOR_V001_INITIAL = {
  id: 1,
  name: "initial_executor",
  statements: [
    `CREATE TABLE executor_identity (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      installation_id TEXT NOT NULL
    )`,
    `CREATE TABLE executor_requests (
      request_id TEXT PRIMARY KEY,
      local_uid INTEGER,
      state TEXT NOT NULL,
      accepted_at INTEGER NOT NULL,
      deadline_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      month TEXT,
      reserved_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX executor_requests_expiry ON executor_requests(expires_at)`,
    `CREATE TABLE executor_usage (
      month TEXT PRIMARY KEY,
      requests INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reserved_tokens INTEGER NOT NULL DEFAULT 0
    )`,
  ],
} as const;
