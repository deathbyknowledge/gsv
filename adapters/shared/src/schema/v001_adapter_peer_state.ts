export const ADAPTER_PEER_V001_STATE = {
  id: 1,
  name: "adapter peer state",
  statements: [
    `CREATE TABLE IF NOT EXISTS adapter_peer_deliveries (
      delivery_id TEXT PRIMARY KEY,
      state       TEXT    NOT NULL CHECK (state IN ('pending', 'reporting', 'completed')),
      record_json TEXT    NOT NULL,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS adapter_peer_deliveries_pending
       ON adapter_peer_deliveries (state, created_at, delivery_id)`,
    `CREATE INDEX IF NOT EXISTS adapter_peer_deliveries_expiry
       ON adapter_peer_deliveries (state, expires_at)`,
    `CREATE TABLE IF NOT EXISTS adapter_peer_delivery_stages (
      stage_id    TEXT PRIMARY KEY,
      delivery_id TEXT    NOT NULL,
      created_at  INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS adapter_peer_delivery_stages_created
       ON adapter_peer_delivery_stages (created_at, stage_id)`,
    `CREATE TABLE IF NOT EXISTS adapter_peer_delivery_chunks (
      stage_id    TEXT    NOT NULL,
      chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
      content     BLOB    NOT NULL,
      PRIMARY KEY (stage_id, chunk_index)
    ) WITHOUT ROWID`,
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
