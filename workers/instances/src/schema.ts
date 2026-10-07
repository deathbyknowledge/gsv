const migrations = [{
  id: 1,
  statements: [
    `CREATE TABLE instances (
      id TEXT PRIMARY KEY, owner_uid INTEGER NOT NULL, request_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, record TEXT NOT NULL, active INTEGER NOT NULL,
      period_start INTEGER NOT NULL, reservation INTEGER NOT NULL, charged INTEGER NOT NULL DEFAULT 0,
      session_id TEXT, acquire_at INTEGER, runtime TEXT,
      UNIQUE(owner_uid, request_id)
    )`,
    `CREATE TABLE profiles (
      id TEXT PRIMARY KEY, owner_uid INTEGER NOT NULL, request_id TEXT NOT NULL,
      record TEXT NOT NULL, key BLOB, object_key TEXT, saved_revision INTEGER NOT NULL DEFAULT 0,
      UNIQUE(owner_uid, request_id)
    )`,
    `CREATE TABLE handoffs (
      instance_id TEXT NOT NULL, request_id TEXT NOT NULL, record TEXT NOT NULL,
      PRIMARY KEY(instance_id, request_id)
    )`,
    `CREATE TABLE files (instance_id TEXT NOT NULL, path TEXT NOT NULL, entry BLOB NOT NULL, PRIMARY KEY(instance_id, path))`,
    `CREATE TABLE diagnostics (id TEXT PRIMARY KEY, instance_id TEXT, occurred_at INTEGER NOT NULL, detail TEXT NOT NULL)`,
  ],
}, {
  id: 2,
  statements: ["CREATE TABLE cancelled_starts (owner_uid INTEGER NOT NULL, request_id TEXT NOT NULL, PRIMARY KEY(owner_uid, request_id))"],
}, {
  id: 3,
  statements: [
    "CREATE TABLE retirement (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), operation_id TEXT NOT NULL, phase TEXT NOT NULL, updated_at INTEGER NOT NULL)",
    `UPDATE instances SET record = json_set(record, '$.implements', json('["shell.exec","fs.read","fs.write","fs.edit","fs.delete","fs.search","fs.copy","fs.transfer.stat","fs.transfer.send","fs.transfer.receive"]')) WHERE json_extract(record, '$.implements') IS NULL`,
  ],
}, {
  id: 4,
  statements: [
    `CREATE TABLE start_requests (owner_uid INTEGER NOT NULL, request_id TEXT NOT NULL,
      instance_id TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(owner_uid, request_id))`,
    `INSERT INTO start_requests SELECT owner_uid, request_id, id, json_insert(fingerprint, '$[#]', json('false')) FROM instances`,
  ],
}, {
  id: 5,
  statements: ["ALTER TABLE instances ADD COLUMN provider_failed_at INTEGER"],
}, {
  id: 6,
  statements: ["CREATE TABLE obsolete_profile_objects (object_key TEXT PRIMARY KEY)"],
}, {
  id: 7,
  statements: [
    "ALTER TABLE files ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'",
    `UPDATE files SET metadata = CASE WHEN json_extract(entry, '$.kind') = 'file' THEN
      json_set(json_remove(entry, '$.content'), '$.size',
        length(json_extract(entry, '$.content')) / 4 * 3 - CASE
          WHEN substr(json_extract(entry, '$.content'), -2) = '==' THEN 2
          WHEN substr(json_extract(entry, '$.content'), -1) = '=' THEN 1 ELSE 0 END)
      ELSE CAST(entry AS TEXT) END`,
  ],
}, {
  id: 8,
  statements: [
    "CREATE TABLE file_chunks (instance_id TEXT NOT NULL, path TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(instance_id, path, part))",
    `INSERT INTO file_chunks (instance_id, path, part, data)
      WITH RECURSIVE parts(instance_id, path, part) AS (
        SELECT instance_id, path, 0 FROM files
        UNION ALL SELECT p.instance_id, p.path, p.part + 1 FROM parts p
        JOIN files f ON f.instance_id = p.instance_id AND f.path = p.path
        WHERE (p.part + 1) * 1048576 < length(f.entry)
      ) SELECT p.instance_id, p.path, p.part, substr(f.entry, p.part * 1048576 + 1, 1048576)
        FROM parts p JOIN files f ON f.instance_id = p.instance_id AND f.path = p.path`,
    "ALTER TABLE files ADD COLUMN encoded_size INTEGER NOT NULL DEFAULT 0",
    "UPDATE files SET encoded_size = length(entry)",
    "ALTER TABLE files DROP COLUMN entry",
  ],
}, {
  id: 9,
  statements: [
    "CREATE INDEX diagnostics_instance_detail ON diagnostics(instance_id, detail)",
    "CREATE INDEX diagnostics_recent ON diagnostics(occurred_at)",
  ],
}, {
  id: 10,
  statements: [
    "CREATE INDEX handoffs_live ON handoffs(instance_id, json_extract(record, '$.state'))",
    "CREATE TABLE handoff_receipts (instance_id TEXT NOT NULL, request_id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(instance_id, request_id))",
    `INSERT INTO handoff_receipts SELECT instance_id, request_id,
      json_remove(record, '$.diagnosticRef', '$.reason', '$.activeTabId') FROM handoffs
      WHERE json_extract(record, '$.state') NOT IN ('pending', 'active') AND rowid NOT IN (
        SELECT rowid FROM handoffs WHERE json_extract(record, '$.state') NOT IN ('pending', 'active')
        ORDER BY COALESCE(json_extract(record, '$.completedAt'), json_extract(record, '$.createdAt')) DESC, rowid DESC LIMIT 64
      )`,
    "DELETE FROM handoffs WHERE EXISTS (SELECT 1 FROM handoff_receipts r WHERE r.instance_id = handoffs.instance_id AND r.request_id = handoffs.request_id)",
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
