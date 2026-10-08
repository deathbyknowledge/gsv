const migrations = [{
  id: 1,
  statements: [
    `CREATE TABLE instances (
      id TEXT PRIMARY KEY, owner_uid INTEGER NOT NULL, record TEXT NOT NULL,
      active INTEGER NOT NULL, reservation INTEGER NOT NULL, charged INTEGER NOT NULL DEFAULT 0,
      session_id TEXT, acquire_at INTEGER, runtime TEXT, provider_failed_at INTEGER,
      retained INTEGER NOT NULL DEFAULT 1
    )`,
    "CREATE INDEX instances_active ON instances(active)",
    "CREATE INDEX instances_retained ON instances(owner_uid, active) WHERE retained = 1",
    "CREATE UNIQUE INDEX instances_target ON instances(json_extract(record, '$.targetId'))",
    `CREATE TABLE start_requests (owner_uid INTEGER NOT NULL, request_id TEXT NOT NULL,
      instance_id TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(owner_uid, request_id))`,
    "CREATE TABLE cancelled_starts (owner_uid INTEGER NOT NULL, request_id TEXT NOT NULL, PRIMARY KEY(owner_uid, request_id))",
    "CREATE TABLE instance_usage (instance_id TEXT NOT NULL, period_start INTEGER NOT NULL, charged INTEGER NOT NULL, PRIMARY KEY(instance_id, period_start))",
    "CREATE INDEX instance_usage_period ON instance_usage(period_start)",
    `CREATE TABLE profiles (
      id TEXT PRIMARY KEY, owner_uid INTEGER NOT NULL, request_id TEXT NOT NULL,
      record TEXT NOT NULL, key BLOB, object_key TEXT, saved_revision INTEGER NOT NULL DEFAULT 0,
      UNIQUE(owner_uid, request_id)
    )`,
    "CREATE UNIQUE INDEX profiles_automatic_owner ON profiles(owner_uid) WHERE json_extract(record, '$.automatic') = 1 AND json_extract(record, '$.state') = 'active'",
    "CREATE INDEX profiles_state ON profiles(json_extract(record, '$.state'))",
    "CREATE INDEX profiles_live ON profiles(owner_uid) WHERE json_extract(record, '$.state') != 'deleted'",
    "CREATE TABLE obsolete_profile_objects (object_key TEXT PRIMARY KEY)",
    `CREATE TABLE handoffs (
      instance_id TEXT NOT NULL, request_id TEXT NOT NULL, record TEXT NOT NULL,
      PRIMARY KEY(instance_id, request_id)
    )`,
    "CREATE INDEX handoffs_live ON handoffs(instance_id, json_extract(record, '$.state'))",
    "CREATE TABLE handoff_receipts (instance_id TEXT NOT NULL, request_id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(instance_id, request_id))",
    "CREATE TABLE files (instance_id TEXT NOT NULL, path TEXT NOT NULL, metadata TEXT NOT NULL, encoded_size INTEGER NOT NULL, PRIMARY KEY(instance_id, path))",
    "CREATE TABLE file_chunks (instance_id TEXT NOT NULL, path TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(instance_id, path, part))",
    "CREATE TABLE diagnostics (id TEXT PRIMARY KEY, instance_id TEXT, occurred_at INTEGER NOT NULL, detail TEXT NOT NULL)",
    "CREATE INDEX diagnostics_instance_detail ON diagnostics(instance_id, detail)",
    "CREATE INDEX diagnostics_recent ON diagnostics(occurred_at)",
    "CREATE TABLE retirement (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), operation_id TEXT NOT NULL, phase TEXT NOT NULL, updated_at INTEGER NOT NULL)",
  ],
}];

export function migrate(storage: DurableObjectStorage): void {
  storage.transactionSync(() => {
    storage.sql.exec("CREATE TABLE IF NOT EXISTS instance_schema (id INTEGER PRIMARY KEY)");
    const applied = new Set(storage.sql.exec<{ id: number }>("SELECT id FROM instance_schema").toArray().map(row => row.id));
    for (const migration of migrations) {
      if (applied.has(migration.id)) continue;
      for (const statement of migration.statements) storage.sql.exec(statement);
      storage.sql.exec("INSERT INTO instance_schema (id) VALUES (?)", migration.id);
    }
  });
}
