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
    expect(KERNEL_MIGRATIONS).toHaveLength(6);
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
