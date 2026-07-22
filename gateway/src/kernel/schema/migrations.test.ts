import { describe, expect, it } from "vitest";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT } from "./migrations";

function normalizedStatements(): string[] {
  return KERNEL_MIGRATIONS.flatMap((migration) => migration.statements)
    .map((statement) => statement.trim().replace(/\s+/g, " "));
}

function createdTables(): string[] {
  return normalizedStatements()
    .map((statement) => statement.match(/^CREATE TABLE IF NOT EXISTS ([a-z_]+)/)?.[1])
    .filter((name): name is string => Boolean(name));
}

function createdIndexes(): string[] {
  return normalizedStatements()
    .map((statement) => statement.match(/^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS ([a-z_]+)/)?.[1])
    .filter((name): name is string => Boolean(name));
}

function createTableStatement(name: string): string {
  const statement = normalizedStatements().find((candidate) => (
    candidate.startsWith(`CREATE TABLE IF NOT EXISTS ${name} `)
  ));
  if (!statement) {
    throw new Error(`missing CREATE TABLE statement for ${name}`);
  }
  return statement;
}

describe("kernel schema migrations", () => {
  it("starts the kernel component at a v1 baseline", () => {
    expect(KERNEL_SCHEMA_COMPONENT).toBe("kernel");
    expect(KERNEL_MIGRATIONS).toHaveLength(15);
    expect(KERNEL_MIGRATIONS[0]).toMatchObject({
      id: 1,
      name: "initial_kernel_schema",
    });
    expect(KERNEL_MIGRATIONS[1]).toMatchObject({
      id: 2,
      name: "remove_device_lifecycle",
    });
    expect(KERNEL_MIGRATIONS[2]).toMatchObject({
      id: 3,
      name: "remove_process_mounts",
    });
    expect(KERNEL_MIGRATIONS[3]).toMatchObject({
      id: 4,
      name: "remove_legacy_signal_watches",
    });
    expect(KERNEL_MIGRATIONS[4]).toMatchObject({
      id: 5,
      name: "add_adapter_status_owner",
    });
    expect(KERNEL_MIGRATIONS[5]).toMatchObject({
      id: 6,
      name: "add_ipc_delivery_state",
    });
    expect(KERNEL_MIGRATIONS[6]).toMatchObject({
      id: 7,
      name: "remove_cli_mirror",
    });
    expect(KERNEL_MIGRATIONS[7]).toMatchObject({
      id: 8,
      name: "bind_routes_to_driver_connections",
    });
    expect(KERNEL_MIGRATIONS[8]).toMatchObject({
      id: 9,
      name: "bind_run_reply_routes",
    });
    expect(KERNEL_MIGRATIONS[9]).toMatchObject({
      id: 10,
      name: "scope_adapter_destinations",
    });
    expect(KERNEL_MIGRATIONS[10]).toMatchObject({
      id: 11,
      name: "add_schedule_occurrence_id",
    });
    expect(KERNEL_MIGRATIONS[11]).toMatchObject({
      id: 12,
      name: "add_schedule_attempt_count",
    });
    expect(KERNEL_MIGRATIONS[12]).toMatchObject({
      id: 13,
      name: "add_adapter_ingress_receipts",
    });
    expect(KERNEL_MIGRATIONS[13]).toMatchObject({
      id: 14,
      name: "add_adapter_ingress_delivery_id",
    });
    expect(KERNEL_MIGRATIONS[14]).toMatchObject({
      id: 15,
      name: "harden_identity_authority",
    });
  });

  it("creates the current kernel table set", () => {
    expect(createdTables()).toEqual([
      "passwd",
      "shadow",
      "groups",
      "auth_tokens",
      "personal_agents",
      "group_capabilities",
      "config_kv",
      "devices",
      "device_access",
      "routing_table",
      "shell_sessions",
      "processes",
      "conversations",
      "identity_links",
      "surface_routes",
      "link_challenges",
      "adapter_status",
      "run_routes",
      "signal_watches",
      "ipc_calls",
      "notifications",
      "schedules",
      "schedule_runs",
      "cron_files",
      "cron_file_schedules",
      "app_sessions",
      "app_session_clients",
      "app_session_client_keys",
      "packages",
      "oauth_flows",
      "oauth_accounts",
      "user_mcp_servers",
      "adapter_ingress_receipts",
      "identity_id_allocator",
    ]);
  });

  it("keeps the processes baseline on the post-profile schema", () => {
    const processes = createTableStatement("processes");

    expect(processes).not.toMatch(/\bprofile\b/);
    expect(processes).toContain("owner_uid INTEGER");
    expect(processes).toContain("cwd TEXT NOT NULL");
    expect(processes).toContain("context_files_json TEXT NOT NULL DEFAULT '[]'");
    expect(processes).toContain("active_conversation_id TEXT");
  });

  it("removes obsolete process mount metadata", () => {
    expect(normalizedStatements()).toContain("ALTER TABLE processes DROP COLUMN mounts");
  });

  it("removes deprecated signal watches", () => {
    expect(normalizedStatements()).toContain(
      "DELETE FROM signal_watches WHERE dedupe_key LIKE 'live:%' OR dedupe_key LIKE '__gsv_live__:%'",
    );
  });

  it("adds adapter account ownership without rewriting the baseline", () => {
    const statements = normalizedStatements();
    expect(statements).toContain(
      "ALTER TABLE adapter_status ADD COLUMN owner_uid INTEGER",
    );
    expect(statements).toContain(
      "UPDATE adapter_status SET adapter = LOWER(TRIM(adapter))",
    );
    expect(statements.some((statement) => (
      statement.startsWith("DELETE FROM adapter_status AS candidate WHERE EXISTS")
      && statement.includes("winner.updated_at = candidate.updated_at AND winner.rowid > candidate.rowid")
    ))).toBe(true);
    expect(statements).toContain(
      "UPDATE adapter_status SET owner_uid = COALESCE( ( SELECT CASE WHEN COUNT(DISTINCT identity_links.uid) = 1 THEN MIN(identity_links.uid) END FROM identity_links WHERE identity_links.adapter = adapter_status.adapter AND identity_links.account_id = adapter_status.account_id ), 0 )",
    );
    expect(createTableStatement("adapter_status")).not.toContain("owner_uid");
  });

  it("adds run correlation and retires legacy IPC calls", () => {
    const statements = normalizedStatements();
    expect(statements).toContain(
      "ALTER TABLE ipc_calls ADD COLUMN source_run_id TEXT",
    );
    expect(statements).toContain(
      "ALTER TABLE ipc_calls ADD COLUMN delivery_started_at INTEGER",
    );
    expect(statements).toContain("DELETE FROM ipc_calls");
    expect(createTableStatement("ipc_calls")).not.toContain("source_run_id");
  });

  it("removes retired CLI mirror state", () => {
    const statements = normalizedStatements();
    expect(statements).toContain(
      "DELETE FROM group_capabilities WHERE capability = 'sys.update'",
    );
    expect(statements).toContain(
      "DELETE FROM config_kv WHERE key LIKE 'config/downloads/cli/%'",
    );
  });

  it("binds routed requests to the driver connection that received them", () => {
    expect(normalizedStatements()).toContain(
      "ALTER TABLE routing_table ADD COLUMN driver_connection_id TEXT",
    );
    expect(createTableStatement("routing_table")).not.toContain("driver_connection_id");
  });

  it("binds reply routes to the process and linked adapter actor", () => {
    const statements = normalizedStatements();
    expect(statements).toContain(
      "ALTER TABLE run_routes ADD COLUMN process_id TEXT",
    );
    expect(statements).toContain(
      "ALTER TABLE run_routes ADD COLUMN actor_id TEXT",
    );
    expect(statements).toContain("DELETE FROM run_routes");
    expect(createTableStatement("run_routes")).not.toContain("process_id");
    expect(createTableStatement("run_routes")).not.toContain("actor_id");
  });

  it("scopes observed adapter destinations to their linked actor", () => {
    const statements = normalizedStatements();
    expect(statements).toContain("DROP TABLE surface_routes");
    expect(statements.some((statement) => (
      statement.startsWith("CREATE TABLE surface_routes")
      && statement.includes("actor_id TEXT NOT NULL")
      && statement.includes("thread_id TEXT NOT NULL DEFAULT ''")
      && statement.includes("PRIMARY KEY (adapter, account_id, actor_id, surface_kind, surface_id, thread_id)")
    ))).toBe(true);
    expect(statements).toContain(
      "ALTER TABLE run_routes ADD COLUMN reply_to_id TEXT",
    );
  });

  it("adds durable occurrence identity for armed one-shot schedules", () => {
    const statements = normalizedStatements();
    expect(statements).toContain(
      "ALTER TABLE schedules ADD COLUMN one_shot_occurrence_id TEXT",
    );
    expect(statements).toContain(
      "UPDATE schedules SET one_shot_occurrence_id = 'legacy:' || schedule_id WHERE enabled = 1 AND next_run_at IS NOT NULL AND json_extract(expression_json, '$.kind') IN ('at', 'after')",
    );
    expect(createTableStatement("schedules")).not.toContain("one_shot_occurrence_id");
  });

  it("adds a per-occurrence one-shot attempt counter", () => {
    expect(normalizedStatements()).toContain(
      "ALTER TABLE schedules ADD COLUMN one_shot_attempt_count INTEGER NOT NULL DEFAULT 0",
    );
    expect(createTableStatement("schedules")).not.toContain("one_shot_attempt_count");
  });

  it("claims normalized adapter ingress before side effects", () => {
    const receiptTable = createTableStatement("adapter_ingress_receipts");
    expect(receiptTable).toContain("receipt_id TEXT NOT NULL UNIQUE");
    expect(receiptTable).not.toContain("provider_delivery_id");
    expect(receiptTable).toContain("state TEXT NOT NULL CHECK (state IN ('in_progress', 'completed'))");
    expect(receiptTable).toContain(
      "PRIMARY KEY ( adapter, account_id, actor_id, surface_kind, surface_id, thread_id, provider_message_id )",
    );
    expect(normalizedStatements()).toContain(
      "ALTER TABLE adapter_ingress_receipts ADD COLUMN provider_delivery_id TEXT",
    );
  });

  it("revokes persisted root-only capabilities from non-root groups", () => {
    const statements = normalizedStatements();
    expect(statements).toContain(
      "DELETE FROM group_capabilities WHERE gid = 100 AND capability = 'sys.bootstrap'",
    );
    expect(statements).toContain(
      "DELETE FROM group_capabilities WHERE gid <> 0 AND capability = '*'",
    );
  });

  it("initializes one shared identity allocator above every persisted uid and gid", () => {
    const allocator = createTableStatement("identity_id_allocator");
    expect(allocator).toContain("singleton INTEGER PRIMARY KEY CHECK (singleton = 1)");
    expect(allocator).toContain("next_id INTEGER NOT NULL CHECK (next_id >= 1000)");
    expect(normalizedStatements()).toContain(
      "INSERT INTO identity_id_allocator (singleton, next_id) SELECT 1, MAX(1000, COALESCE(MAX(id), 999) + 1) FROM ( SELECT uid AS id FROM passwd UNION ALL SELECT gid AS id FROM passwd UNION ALL SELECT gid AS id FROM groups )",
    );
  });

  it("includes current indexes owned by the kernel stores", () => {
    expect(createdIndexes()).toEqual(expect.arrayContaining([
      "idx_auth_tokens_uid",
      "shell_sessions_device_idx",
      "conversations_owner",
      "idx_signal_watches_target_key",
      "idx_packages_scope_name_runtime",
      "idx_oauth_accounts_identity",
      "idx_user_mcp_servers_uid",
      "idx_adapter_status_owner",
      "idx_ipc_calls_source_run",
    ]));
  });
});
