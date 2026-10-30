type Migration = { id: number; statements: string[] };

/** One coordinator per installation: admission, the owner's call index and pending Kernel notifications. */
const coordinatorMigrations: Migration[] = [{
  id: 1,
  statements: [
    `CREATE TABLE calls (
      id TEXT PRIMARY KEY, owner_uid INTEGER NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      record TEXT NOT NULL, revision INTEGER NOT NULL, active INTEGER NOT NULL, created_at INTEGER NOT NULL,
      location_hint TEXT, UNIQUE(owner_uid, request_id)
    )`,
    "CREATE INDEX calls_active ON calls(active)",
    "CREATE INDEX calls_created ON calls(created_at)",
    "CREATE INDEX calls_owner ON calls(owner_uid, created_at)",
    `CREATE TABLE pending_changes (
      call_id TEXT NOT NULL, event TEXT NOT NULL, owner_uid INTEGER NOT NULL, revision INTEGER NOT NULL,
      PRIMARY KEY(call_id, event)
    )`,
    "CREATE TABLE diagnostics (id TEXT PRIMARY KEY, call_id TEXT, occurred_at INTEGER NOT NULL, detail TEXT NOT NULL)",
  ],
}];

/** One object per call: the transcript until the Kernel files it, and the call's diagnostics. */
const callMigrations: Migration[] = [{
  id: 1,
  statements: [
    "CREATE TABLE transcript (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, speaker TEXT NOT NULL, text TEXT NOT NULL)",
    "CREATE TABLE diagnostics (id TEXT PRIMARY KEY, occurred_at INTEGER NOT NULL, detail TEXT NOT NULL)",
  ],
}];

function apply(storage: DurableObjectStorage, migrations: Migration[]): void {
  storage.transactionSync(() => {
    storage.sql.exec("CREATE TABLE IF NOT EXISTS calls_schema (id INTEGER PRIMARY KEY)");
    const applied = new Set(storage.sql.exec<{ id: number }>("SELECT id FROM calls_schema").toArray().map(row => row.id));
    for (const migration of migrations) {
      if (applied.has(migration.id)) continue;
      for (const statement of migration.statements) storage.sql.exec(statement);
      storage.sql.exec("INSERT INTO calls_schema (id) VALUES (?)", migration.id);
    }
  });
}

export const migrateCoordinator = (storage: DurableObjectStorage): void => apply(storage, coordinatorMigrations);
export const migrateCall = (storage: DurableObjectStorage): void => apply(storage, callMigrations);

/** Bounded, private diagnostic text; never call content. */
export function diagnosticDetail(cause: unknown): string {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  const chain: string[] = [];
  for (let current: unknown = error; current instanceof Error && chain.length < 4; current = current.cause) {
    chain.push(`${current.name}: ${current.message}`);
  }
  return chain.join("\ncaused by ").slice(0, 2000);
}
