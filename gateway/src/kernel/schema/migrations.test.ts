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
    expect(KERNEL_MIGRATIONS).toHaveLength(3);
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

  it("includes current indexes owned by the kernel stores", () => {
    expect(createdIndexes()).toEqual(expect.arrayContaining([
      "idx_auth_tokens_uid",
      "shell_sessions_device_idx",
      "conversations_owner",
      "idx_signal_watches_target_key",
      "idx_packages_scope_name_runtime",
      "idx_oauth_accounts_identity",
      "idx_user_mcp_servers_uid",
    ]));
  });
});
