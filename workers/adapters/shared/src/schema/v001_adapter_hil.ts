export const ADAPTER_HIL_V001_STATE = {
  id: 1,
  name: "adapter HIL state",
  statements: [
    `CREATE TABLE IF NOT EXISTS adapter_hil_approvals (
      provider    TEXT    NOT NULL,
      token       TEXT    NOT NULL,
      state       TEXT    NOT NULL CHECK (state IN ('pending', 'processing', 'resolved')),
      record_json TEXT    NOT NULL,
      expires_at  INTEGER NOT NULL,
      PRIMARY KEY (provider, token)
    ) WITHOUT ROWID`,
    `CREATE INDEX IF NOT EXISTS adapter_hil_approvals_expiry
       ON adapter_hil_approvals (expires_at)`,
  ],
} as const;
