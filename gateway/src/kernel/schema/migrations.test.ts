import { describe, expect, it } from "vitest";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT } from "./migrations";

function normalizedStatements(): string[] {
  return KERNEL_MIGRATIONS.flatMap((migration) => migration.statements)
    .map((statement) => statement.trim().replace(/\s+/g, " "));
}

function createdTables(): string[] {
  return normalizedStatements()
    .map((statement) => statement.match(/^CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)/)?.[1])
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
    || candidate.startsWith(`CREATE TABLE ${name} `)
  ));
  if (!statement) {
    throw new Error(`missing CREATE TABLE statement for ${name}`);
  }
  return statement;
}

describe("kernel schema migrations", () => {
  it("starts the kernel component at a v1 baseline", () => {
    expect(KERNEL_SCHEMA_COMPONENT).toBe("kernel");
    expect(KERNEL_MIGRATIONS).toHaveLength(23);
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
      name: "restrict_system_bootstrap",
    });
    expect(KERNEL_MIGRATIONS[9]).toMatchObject({
      id: 10,
      name: "restrict_wildcard_capability",
    });
    expect(KERNEL_MIGRATIONS[10]).toMatchObject({
      id: 11,
      name: "privatize_device_owner_access",
    });
    expect(KERNEL_MIGRATIONS[11]).toMatchObject({
      id: 12,
      name: "rate_limit_link_challenges",
    });
    expect(KERNEL_MIGRATIONS[12]).toMatchObject({
      id: 13,
      name: "add_unix_id_allocator",
    });
    expect(KERNEL_MIGRATIONS[13]).toMatchObject({
      id: 14,
      name: "internalize_conversation_archives",
    });
    expect(KERNEL_MIGRATIONS[14]).toMatchObject({
      id: 15,
      name: "rate_limit_logins",
    });
    expect(KERNEL_MIGRATIONS[15]).toMatchObject({
      id: 16,
      name: "add_user_kernels",
    });
    expect(KERNEL_MIGRATIONS[16]).toMatchObject({
      id: 17,
      name: "bind_adapter_routes",
    });
    expect(KERNEL_MIGRATIONS[17]).toMatchObject({
      id: 18,
      name: "fence_auth_token_sessions",
    });
    expect(KERNEL_MIGRATIONS[18]).toMatchObject({
      id: 19,
      name: "bind_process_kernel_generation",
    });
    expect(KERNEL_MIGRATIONS[19]).toMatchObject({
      id: 20,
      name: "bind_package_security_revisions",
    });
    expect(KERNEL_MIGRATIONS[20]).toMatchObject({
      id: 21,
      name: "fence_user_kernel_projections",
    });
    expect(KERNEL_MIGRATIONS[21]).toMatchObject({
      id: 22,
      name: "register_app_runtimes",
    });
    expect(KERNEL_MIGRATIONS[22]).toMatchObject({
      id: 23,
      name: "bind_oauth_flow_kernel_owner",
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
      "link_challenge_attempts",
      "unix_id_allocator",
      "auth_login_attempts",
      "account_identities",
      "user_kernels",
      "identity_link_generations",
      "auth_token_revocation_outbox",
      "auth_token_revocation_tombstones",
      "kernel_projection_state",
      "app_runtime_runners",
      "app_runtime_lifecycle_fences",
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

  it("binds process executors to a nullable user-Kernel generation", () => {
    expect(normalizedStatements()).toContain(
      "ALTER TABLE processes ADD COLUMN kernel_generation INTEGER CHECK (kernel_generation IS NULL OR kernel_generation > 0)",
    );
  });

  it("binds package security revisions to processes and schedules", () => {
    expect(normalizedStatements()).toContain(
      "ALTER TABLE processes ADD COLUMN package_security_revision TEXT",
    );
    expect(normalizedStatements()).toContain(
      "ALTER TABLE schedules ADD COLUMN package_security_revision TEXT",
    );
  });

  it("registers AppRunners by actor and owning Kernel identity", () => {
    const runners = createTableStatement("app_runtime_runners");

    expect(runners).toContain("owner_uid INTEGER");
    expect(runners).toContain("owner_username TEXT");
    expect(runners).toContain("kernel_owner_uid INTEGER");
    expect(runners).toContain("kernel_owner_username TEXT");
    expect(normalizedStatements()).toContain(
      "CREATE INDEX app_runtime_runners_kernel_owner ON app_runtime_runners ( kernel_owner_uid, kernel_owner_username, owner_uid, runner_name )",
    );
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

  it("removes system bootstrap from the shared users group", () => {
    expect(normalizedStatements()).toContain(
      "DELETE FROM group_capabilities WHERE gid = 100 AND capability = 'sys.bootstrap'",
    );
  });

  it("removes wildcard authority from every non-root group", () => {
    expect(normalizedStatements()).toContain(
      "DELETE FROM group_capabilities WHERE gid <> 0 AND capability = '*'",
    );
  });

  it("moves legacy device owner access off the shared users group", () => {
    const statements = normalizedStatements();
    expect(statements).toContain(
      "INSERT OR IGNORE INTO device_access (device_id, gid) SELECT device_id, owner_uid FROM devices WHERE owner_uid >= 1000",
    );
    expect(statements).toContain(
      "DELETE FROM device_access WHERE gid = 100 AND device_id IN ( SELECT device_id FROM devices WHERE owner_uid >= 1000 )",
    );
  });

  it("adds a durable high-water allocator for the shared UID/GID space", () => {
    const allocator = createTableStatement("unix_id_allocator");
    const statements = normalizedStatements();

    expect(allocator).toContain("singleton INTEGER PRIMARY KEY CHECK (singleton = 1)");
    expect(allocator).toContain("high_water INTEGER NOT NULL CHECK (high_water >= 0)");
    expect(statements.some((statement) => (
      statement.startsWith("INSERT OR IGNORE INTO unix_id_allocator")
      && statement.includes("SELECT MAX(uid) FROM passwd")
      && statement.includes("SELECT MAX(gid) FROM passwd")
      && statement.includes("SELECT MAX(gid) FROM groups")
    ))).toBe(true);
  });

  it("invalidates legacy shared-home archives and removes their stored locator", () => {
    const statements = normalizedStatements();
    expect(statements).toContain("UPDATE conversations SET latest_archive = NULL");
    expect(statements).toContain("ALTER TABLE conversations DROP COLUMN archive_base");
  });

  it("adds durable login attempt budgets without storing credential material", () => {
    const attempts = createTableStatement("auth_login_attempts");

    expect(attempts).toContain("scope TEXT PRIMARY KEY");
    expect(attempts).toContain("attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0)");
    expect(attempts).not.toMatch(/username|password|token|credential|address/);
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
      "idx_auth_login_attempts_expiry",
      "idx_auth_token_revocation_outbox_due",
    ]));
  });

  it("keeps live credential fences free of raw authentication material", () => {
    const outbox = createTableStatement("auth_token_revocation_outbox");
    const tombstones = createTableStatement("auth_token_revocation_tombstones");

    expect(outbox).toContain("token_id TEXT PRIMARY KEY");
    expect(outbox).toContain("attempt_count INTEGER NOT NULL DEFAULT 0");
    expect(tombstones).toContain("token_id TEXT PRIMARY KEY");
    expect(`${outbox} ${tombstones}`).not.toMatch(/token_hash|token_prefix|password|credential/);
  });
});
