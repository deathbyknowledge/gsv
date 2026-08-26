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
    expect(KERNEL_MIGRATIONS).toHaveLength(33);
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
      name: "remove_package_runtime",
    });
    expect(KERNEL_MIGRATIONS[15]).toMatchObject({
      id: 16,
      name: "remove_process_context",
    });
    expect(KERNEL_MIGRATIONS[16]).toMatchObject({
      id: 17,
      name: "reorder_system_context",
    });
    expect(KERNEL_MIGRATIONS[17]).toMatchObject({
      id: 18,
      name: "remove_conversation_registry",
    });
    expect(KERNEL_MIGRATIONS[18]).toMatchObject({
      id: 19,
      name: "remove_notifications",
    });
    expect(KERNEL_MIGRATIONS[19]).toMatchObject({
      id: 20,
      name: "add_mailboxes",
    });
    expect(KERNEL_MIGRATIONS[20]).toMatchObject({
      id: 21,
      name: "isolate_mail_notifications",
    });
    expect(KERNEL_MIGRATIONS[21]).toMatchObject({
      id: 22,
      name: "add_outbound_mail",
    });
    expect(KERNEL_MIGRATIONS[22]).toMatchObject({
      id: 23,
      name: "add_personal_controller_slot",
    });
    expect(KERNEL_MIGRATIONS[23]).toMatchObject({
      id: 24,
      name: "add_surface_route_modes",
    });
    expect(KERNEL_MIGRATIONS[24]).toMatchObject({
      id: 25,
      name: "add_private_adapter_destinations",
    });
    expect(KERNEL_MIGRATIONS[25]).toMatchObject({
      id: 26,
      name: "add_conversations",
    });
    expect(KERNEL_MIGRATIONS[26]).toMatchObject({
      id: 27,
      name: "own_durable_tasks",
    });
    expect(KERNEL_MIGRATIONS[27]).toMatchObject({
      id: 28,
      name: "rename_home_conversation_to_ship",
    });
    expect(KERNEL_MIGRATIONS[28]).toMatchObject({
      id: 29,
      name: "add_responsibilities",
    });
    expect(KERNEL_MIGRATIONS[29]).toMatchObject({
      id: 30,
      name: "link_ipc_responsibilities",
    });
    expect(KERNEL_MIGRATIONS[30]).toMatchObject({
      id: 31,
      name: "add_responsibility_source_policies",
    });
    expect(KERNEL_MIGRATIONS[31]).toMatchObject({
      id: 32,
      name: "fence_adapter_run_routes",
    });
    expect(KERNEL_MIGRATIONS[32]).toMatchObject({
      id: 33,
      name: "add_federation",
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
      "mailboxes",
      "mail_messages",
      "mail_intakes",
      "mail_outbound",
      "cf_agents_schedules",
      "cf_agents_mcp_servers",
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

  it("removes obsolete process context metadata", () => {
    expect(normalizedStatements()).toContain("ALTER TABLE processes DROP COLUMN context_files_json");
  });

  it("adds one personal controller slot per process owner", () => {
    const statements = normalizedStatements();
    expect(statements).toContain(
      "ALTER TABLE processes ADD COLUMN is_personal_controller INTEGER NOT NULL DEFAULT 0 CHECK (is_personal_controller IN (0, 1))",
    );
    expect(statements).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_processes_personal_controller_owner ON processes(owner_uid) WHERE is_personal_controller = 1",
    );
  });

  it("classifies existing surface routes for the DM cutover", () => {
    const statements = normalizedStatements();
    expect(statements).toContain(
      "ALTER TABLE surface_routes ADD COLUMN route_mode TEXT NOT NULL DEFAULT 'legacy' CHECK (route_mode IN ('legacy', 'work', 'surface'))",
    );
    expect(statements).toContain(
      "UPDATE surface_routes SET route_mode = 'surface' WHERE surface_kind != 'dm'",
    );
    expect(statements).toContain(
      "CREATE INDEX IF NOT EXISTS idx_surface_routes_mode_pid ON surface_routes(route_mode, pid)",
    );
  });

  it("stores one last-active private adapter destination per owner", () => {
    expect(normalizedStatements()).toContain(
      "CREATE TABLE private_adapter_destinations ( uid INTEGER PRIMARY KEY, adapter TEXT NOT NULL, account_id TEXT NOT NULL, actor_id TEXT NOT NULL, surface_id TEXT NOT NULL, thread_id TEXT NOT NULL DEFAULT '', message_id TEXT NOT NULL, updated_at INTEGER NOT NULL )",
    );
  });

  it("records locally ordered pairing attempts from the first federation schema", () => {
    const statements = normalizedStatements();
    expect(statements.some((statement) => (
      statement.startsWith("CREATE TABLE federation_pairing_attempts")
      && statement.includes("token_hash TEXT PRIMARY KEY")
      && statement.includes("state TEXT NOT NULL CHECK (state IN ('pending', 'committed', 'terminal'))")
      && statement.includes("remote_public_key_json TEXT NOT NULL")
    ))).toBe(true);
    expect(statements.some((statement) => (
      statement.startsWith("CREATE UNIQUE INDEX federation_pairing_attempts_pending_remote_idx")
      && statement.includes("WHERE state = 'pending'")
    ))).toBe(true);
  });

  it("adds canonical conversations independently of process history", () => {
    const statements = normalizedStatements();
    expect(statements.some((statement) => (
      statement.startsWith("CREATE TABLE conversations")
      && statement.includes("kind TEXT NOT NULL CHECK (kind IN ('home', 'work', 'group'))")
      && statement.includes("handler_pid TEXT NOT NULL")
    ))).toBe(true);
    expect(statements).toContain(
      "CREATE UNIQUE INDEX conversations_home_owner_idx ON conversations (owner_uid) WHERE kind = 'home'",
    );
    expect(statements.some((statement) => statement.startsWith("CREATE TABLE conversation_members")))
      .toBe(true);
    expect(statements.some((statement) => statement.startsWith("CREATE TABLE conversation_surfaces")))
      .toBe(true);
  });

  it("renames the canonical Home conversation to Ship without losing its address", () => {
    const statements = normalizedStatements();
    expect(statements.some((statement) => (
      statement.startsWith("CREATE TABLE conversations_v028")
      && statement.includes("kind TEXT NOT NULL CHECK (kind IN ('ship', 'work', 'group'))")
    ))).toBe(true);
    expect(statements.some((statement) => (
      statement.startsWith("INSERT INTO conversations_v028")
      && statement.includes("CASE kind WHEN 'home' THEN 'ship' ELSE kind END")
      && statement.includes("CASE WHEN kind = 'home' AND title = 'Home' THEN 'Ship' ELSE title END")
    ))).toBe(true);
    expect(statements).toContain(
      "CREATE UNIQUE INDEX conversations_ship_owner_idx ON conversations (owner_uid) WHERE kind = 'ship'",
    );
  });

  it("stores responsibilities, transition history, and recoverable wake state", () => {
    const statements = normalizedStatements();
    const responsibilities = statements.find((statement) => (
      statement.startsWith("CREATE TABLE responsibilities ")
    ));
    expect(responsibilities).toContain("change_pending INTEGER NOT NULL DEFAULT 0");
    expect(responsibilities).toContain("wake_retry_at INTEGER");
    expect(statements.some((statement) => (
      statement.startsWith("CREATE TABLE responsibility_transitions ")
    ))).toBe(true);
    expect(statements.some((statement) => (
      statement.startsWith("CREATE TABLE responsibility_wake_batches ")
    ))).toBe(true);
  });

  it("links delegated IPC calls to their responsibility", () => {
    const statements = normalizedStatements();
    expect(statements).toContain(
      "ALTER TABLE ipc_calls ADD COLUMN responsibility_id TEXT",
    );
  });

  it("stores per-owner responsibility source policy overrides", () => {
    const statements = normalizedStatements();
    expect(statements.some((statement) => (
      statement.startsWith("CREATE TABLE responsibility_source_policies ")
      && statement.includes("PRIMARY KEY (owner_uid, source_id)")
      && statement.includes("enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))")
    ))).toBe(true);
  });

  it("binds adapter run routes to a managed peer generation", () => {
    expect(normalizedStatements()).toContain(
      "ALTER TABLE run_routes ADD COLUMN route_generation TEXT",
    );
  });

  it("removes the parallel conversation registry", () => {
    expect(normalizedStatements()).toContain("DROP TABLE conversations");
    expect(normalizedStatements()).toContain(
      "ALTER TABLE processes DROP COLUMN active_conversation_id",
    );
  });

  it("removes notification storage", () => {
    const statements = normalizedStatements();
    expect(statements).toContain(
      "DELETE FROM group_capabilities WHERE capability LIKE 'notification.%'",
    );
    expect(statements).toContain(
      "DELETE FROM signal_watches WHERE signal LIKE 'notification.%'",
    );
    expect(statements).toContain("DROP TABLE notifications");
  });

  it("adds installation-local mailbox indexes", () => {
    const statements = normalizedStatements();
    const mailboxes = createTableStatement("mailboxes");
    const messages = createTableStatement("mail_messages");
    const intakes = createTableStatement("mail_intakes");

    expect(mailboxes).toContain("owner_uid INTEGER NOT NULL");
    expect(mailboxes).toContain("address TEXT NOT NULL UNIQUE");
    expect(mailboxes).toContain("notification_pid TEXT");
    expect(messages).toContain("UNIQUE(mailbox_id, digest)");
    expect(messages).toContain("raw_path TEXT NOT NULL");
    expect(messages).toContain("event_delivered_at INTEGER");
    expect(intakes).toContain("intake_id TEXT PRIMARY KEY");
    expect(intakes).toContain("message_id TEXT NOT NULL");
    expect(statements).toContain(
      "CREATE INDEX IF NOT EXISTS idx_mail_messages_mailbox_received ON mail_messages(mailbox_id, received_at DESC, message_id DESC)",
    );
  });

  it("adds replay-safe outbound mail intents", () => {
    const statements = normalizedStatements();
    const outbound = createTableStatement("mail_outbound");

    expect(outbound).toContain("outbound_id TEXT PRIMARY KEY");
    expect(outbound).toContain("UNIQUE(owner_uid, delivery_id)");
    expect(outbound).toContain("fingerprint TEXT NOT NULL");
    expect(outbound).toContain("body_digest TEXT NOT NULL");
    expect(outbound).toContain("body_path TEXT NOT NULL");
    expect(outbound).toContain("state TEXT NOT NULL");
    expect(outbound).toContain("'staging', 'queued', 'accepted', 'failed', 'unknown'");
    expect(statements).toContain(
      "CREATE INDEX IF NOT EXISTS idx_mail_outbound_owner_created ON mail_outbound(owner_uid, created_at DESC, outbound_id DESC)",
    );
  });

  it("moves explicit system context overrides to the new lexical order", () => {
    const statements = normalizedStatements();
    expect(statements.some((statement) => (
      statement.startsWith("INSERT OR IGNORE INTO config_kv (key, value)")
      && statement.includes("'config/ai/context.d/00-runtime.md'")
      && statement.includes("'config/ai/context.d/10-runtime.md'")
    ))).toBe(true);
    expect(statements.some((statement) => (
      statement.startsWith("INSERT OR IGNORE INTO config_kv (key, value)")
      && statement.includes("'config/ai/context.d/01-gsv.md'")
      && statement.includes("'config/ai/context.d/00-gsv.md'")
    ))).toBe(true);
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

  it("adds sovereign contact federation state", () => {
    const statements = normalizedStatements();
    expect(statements.some((statement) => (
      statement.startsWith("CREATE TABLE conversations_v033")
      && statement.includes("'ship', 'work', 'group', 'contact'")
    ))).toBe(true);
    expect(statements.some((statement) => (
      statement.startsWith("CREATE TABLE federation_contacts")
      && statement.includes("shared_secret TEXT NOT NULL")
      && statement.includes("generation TEXT NOT NULL")
    ))).toBe(true);
    expect(statements.some((statement) => (
      statement.startsWith("CREATE TABLE federation_outbox")
      && statement.includes("fingerprint TEXT NOT NULL")
      && statement.includes("UNIQUE (owner_uid, idempotency_key)")
    ))).toBe(true);
    expect(statements.some((statement) => (
      statement.startsWith("CREATE TABLE federation_inbox")
      && statement.includes("contact_generation TEXT NOT NULL")
      && statement.includes("PRIMARY KEY (contact_id, contact_generation, delivery_id)")
    ))).toBe(true);
    expect(statements.some((statement) => (
      statement.startsWith("CREATE TABLE federation_resource_grants")
      && statement.includes("contact_generation TEXT NOT NULL")
    ))).toBe(true);
    expect(statements.some((statement) => (
      statement.startsWith("CREATE TABLE federation_requests")
      && statement.includes("remote_request_id TEXT")
      && statement.includes("contact_generation TEXT NOT NULL")
      && statement.includes("revision INTEGER NOT NULL")
    ))).toBe(true);
    expect(statements.some((statement) => (
      statement.startsWith("CREATE TABLE federation_invites")
      && statement.includes("issuing_ship_id TEXT NOT NULL")
      && statement.includes("issuing_origin TEXT NOT NULL")
      && statement.includes("state TEXT NOT NULL CHECK (state IN ('issued', 'accepted', 'cancelled'))")
      && statement.includes("accepted_generation TEXT")
      && statement.includes("accepted_thread_id TEXT")
      && statement.includes("accepted_response_json TEXT")
    ))).toBe(true);
  });

  it("removes package runtime state and keeps process signal watches", () => {
    const statements = normalizedStatements();
    expect(statements).toContain("DROP TABLE app_session_client_keys");
    expect(statements).toContain("DROP TABLE app_session_clients");
    expect(statements).toContain("DROP TABLE app_sessions");
    expect(statements).toContain("DROP TABLE packages");
    expect(statements).toContain(
      "DELETE FROM group_capabilities WHERE capability = 'app.*' OR capability LIKE 'pkg.%' OR gid IN (SELECT passwd.gid FROM passwd JOIN config_kv ON config_kv.key = 'users/' || passwd.uid || '/pkg/owner')",
    );
    expect(statements).toContain(
      "DELETE FROM processes WHERE uid IN (SELECT passwd.uid FROM passwd JOIN config_kv ON config_kv.key = 'users/' || passwd.uid || '/pkg/owner')",
    );
    expect(statements.some((statement) => /^DELETE FROM (?:passwd|conversations)\b/.test(statement)))
      .toBe(false);
    expect(statements.some((statement) => (
      statement.startsWith("CREATE TABLE signal_watches")
      && statement.includes("target_process_id TEXT NOT NULL")
      && !statement.includes("package_id")
      && !statement.includes("app_session_id")
    ))).toBe(true);
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
