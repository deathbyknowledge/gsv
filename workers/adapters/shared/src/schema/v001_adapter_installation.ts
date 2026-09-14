export const ADAPTER_INSTALLATION_V001_STATE = {
  id: 1,
  name: "adapter installation retirement",
  statements: [
    `CREATE TABLE adapter_installation_retirement (
      id INTEGER PRIMARY KEY CHECK(id = 1), installation_id TEXT NOT NULL,
      self_name TEXT NOT NULL, self_object_id TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('active', 'importing', 'quiescing', 'quiesced', 'erasing', 'live-erased', 'erased')),
      operation_id TEXT, discovery_sha256 TEXT, manifest_sha256 TEXT,
      manifest_count INTEGER NOT NULL DEFAULT 0, import_cursor INTEGER NOT NULL DEFAULT 0,
      inventory_complete INTEGER NOT NULL DEFAULT 0, status_cursor INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL, backup_expires_at INTEGER
    )`,
    `CREATE TABLE adapter_installation_resources (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, name TEXT NOT NULL,
      object_id TEXT NOT NULL, namespace_id TEXT, generation TEXT,
      state TEXT NOT NULL DEFAULT 'live' CHECK(state IN ('live', 'quiesced', 'live-erased', 'erased')),
      receipt_json TEXT, UNIQUE(kind, object_id)
    )`,
    `CREATE INDEX adapter_installation_resources_state ON adapter_installation_resources(state, seq)`,
  ],
} as const;
