import type { SqlMigration } from "./runner";

// Current Kernel Durable Object SQLite schema for fresh v1 installations.
export const KERNEL_V001_INITIAL_SCHEMA: SqlMigration = {
  id: 1,
  name: "initial_kernel_schema",
  statements: [
    `
      CREATE TABLE IF NOT EXISTS passwd (
        username TEXT PRIMARY KEY,
        uid      INTEGER NOT NULL UNIQUE,
        gid      INTEGER NOT NULL,
        gecos    TEXT NOT NULL DEFAULT '',
        home     TEXT NOT NULL,
        shell    TEXT NOT NULL DEFAULT '/bin/init'
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS shadow (
        username    TEXT PRIMARY KEY,
        hash        TEXT NOT NULL DEFAULT '!',
        lastchanged TEXT NOT NULL DEFAULT '',
        min         TEXT NOT NULL DEFAULT '0',
        max         TEXT NOT NULL DEFAULT '99999',
        warn        TEXT NOT NULL DEFAULT '7',
        inactive    TEXT NOT NULL DEFAULT '',
        expire      TEXT NOT NULL DEFAULT '',
        reserved    TEXT NOT NULL DEFAULT ''
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS groups (
        name    TEXT PRIMARY KEY,
        gid     INTEGER NOT NULL UNIQUE,
        members TEXT NOT NULL DEFAULT ''
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS auth_tokens (
        token_id           TEXT PRIMARY KEY,
        uid                INTEGER NOT NULL,
        kind               TEXT NOT NULL,
        label              TEXT,
        token_hash         TEXT NOT NULL UNIQUE,
        token_prefix       TEXT NOT NULL,
        allowed_role       TEXT,
        allowed_device_id  TEXT,
        created_at         INTEGER NOT NULL,
        last_used_at       INTEGER,
        expires_at         INTEGER,
        revoked_at         INTEGER,
        revoked_reason     TEXT
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_auth_tokens_uid
      ON auth_tokens(uid)
    `,
    `
      CREATE TABLE IF NOT EXISTS personal_agents (
        owner_uid INTEGER PRIMARY KEY,
        agent_uid INTEGER NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS group_capabilities (
        gid        INTEGER NOT NULL,
        capability TEXT    NOT NULL,
        PRIMARY KEY (gid, capability)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS config_kv (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS devices (
        device_id        TEXT    PRIMARY KEY,
        owner_uid        INTEGER NOT NULL,
        label            TEXT    NOT NULL DEFAULT '',
        description      TEXT    NOT NULL DEFAULT '',
        implements       TEXT    NOT NULL DEFAULT '[]',
        platform         TEXT    NOT NULL DEFAULT '',
        version          TEXT    NOT NULL DEFAULT '',
        lifecycle        TEXT    NOT NULL DEFAULT 'persistent',
        online           INTEGER NOT NULL DEFAULT 0,
        first_seen_at    INTEGER NOT NULL,
        last_seen_at     INTEGER NOT NULL,
        connected_at     INTEGER,
        disconnected_at  INTEGER
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS device_access (
        device_id TEXT    NOT NULL,
        gid       INTEGER NOT NULL,
        PRIMARY KEY (device_id, gid)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS routing_table (
        id TEXT PRIMARY KEY,
        call TEXT NOT NULL,
        origin_type TEXT NOT NULL,
        origin_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        schedule_id TEXT
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS shell_sessions (
        session_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        status TEXT NOT NULL,
        exit_code INTEGER,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS shell_sessions_device_idx
      ON shell_sessions (device_id)
    `,
    `
      CREATE TABLE IF NOT EXISTS processes (
        process_id TEXT PRIMARY KEY,
        parent_pid TEXT,
        uid INTEGER NOT NULL,
        owner_uid INTEGER,
        interactive INTEGER NOT NULL DEFAULT 1,
        gid INTEGER NOT NULL,
        gids TEXT NOT NULL,
        username TEXT NOT NULL,
        home TEXT NOT NULL,
        cwd TEXT NOT NULL,
        mounts TEXT NOT NULL DEFAULT '[]',
        context_files_json TEXT NOT NULL DEFAULT '[]',
        state TEXT NOT NULL DEFAULT 'idle',
        active_run_id TEXT,
        active_conversation_id TEXT,
        queued_count INTEGER NOT NULL DEFAULT 0,
        last_active_at INTEGER,
        label TEXT,
        created_at INTEGER NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS conversations (
        conversation_id TEXT PRIMARY KEY,
        owner_uid INTEGER NOT NULL,
        agent_uid INTEGER NOT NULL,
        title TEXT,
        is_default INTEGER NOT NULL DEFAULT 0,
        active_pid TEXT,
        archive_base TEXT NOT NULL,
        latest_archive TEXT,
        created_at INTEGER NOT NULL,
        last_active_at INTEGER
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS conversations_owner
      ON conversations (owner_uid, agent_uid)
    `,
    `
      CREATE INDEX IF NOT EXISTS conversations_active_pid
      ON conversations (active_pid)
    `,
    `
      CREATE TABLE IF NOT EXISTS identity_links (
        adapter       TEXT NOT NULL,
        account_id    TEXT NOT NULL,
        actor_id      TEXT NOT NULL,
        uid           INTEGER NOT NULL,
        created_at    INTEGER NOT NULL,
        linked_by_uid INTEGER NOT NULL,
        metadata_json TEXT,
        PRIMARY KEY (adapter, account_id, actor_id)
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_identity_links_uid
      ON identity_links(uid)
    `,
    `
      CREATE TABLE IF NOT EXISTS surface_routes (
        adapter        TEXT NOT NULL,
        account_id     TEXT NOT NULL,
        surface_kind   TEXT NOT NULL,
        surface_id     TEXT NOT NULL,
        uid            INTEGER NOT NULL,
        pid            TEXT NOT NULL,
        updated_at     INTEGER NOT NULL,
        updated_by_uid INTEGER NOT NULL,
        PRIMARY KEY (adapter, account_id, surface_kind, surface_id)
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_surface_routes_uid
      ON surface_routes(uid)
    `,
    `
      CREATE TABLE IF NOT EXISTS link_challenges (
        code         TEXT PRIMARY KEY,
        adapter      TEXT NOT NULL,
        account_id   TEXT NOT NULL,
        actor_id     TEXT NOT NULL,
        surface_kind TEXT NOT NULL,
        surface_id   TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL,
        used_at      INTEGER,
        used_by_uid  INTEGER
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_link_challenges_lookup
      ON link_challenges(adapter, account_id, actor_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_link_challenges_expires
      ON link_challenges(expires_at)
    `,
    `
      CREATE TABLE IF NOT EXISTS adapter_status (
        adapter        TEXT NOT NULL,
        account_id     TEXT NOT NULL,
        connected      INTEGER NOT NULL,
        authenticated  INTEGER NOT NULL,
        mode           TEXT,
        last_activity  INTEGER,
        error          TEXT,
        extra_json     TEXT,
        updated_at     INTEGER NOT NULL,
        PRIMARY KEY (adapter, account_id)
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_adapter_status_adapter
      ON adapter_status(adapter)
    `,
    `
      CREATE TABLE IF NOT EXISTS run_routes (
        run_id        TEXT PRIMARY KEY,
        route_kind    TEXT NOT NULL,
        uid           INTEGER NOT NULL,
        connection_id TEXT,
        adapter       TEXT,
        account_id    TEXT,
        surface_kind  TEXT,
        surface_id    TEXT,
        thread_id     TEXT,
        created_at    INTEGER NOT NULL,
        expires_at    INTEGER NOT NULL
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_run_routes_expires
      ON run_routes(expires_at)
    `,
    `
      CREATE TABLE IF NOT EXISTS signal_watches (
        watch_id TEXT PRIMARY KEY,
        uid INTEGER NOT NULL,
        package_id TEXT NOT NULL,
        package_name TEXT NOT NULL,
        entrypoint_name TEXT NOT NULL,
        route_base TEXT NOT NULL,
        signal TEXT NOT NULL,
        process_id TEXT,
        dedupe_key TEXT,
        state_json TEXT NOT NULL DEFAULT 'null',
        once_only INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER,
        target_type TEXT NOT NULL DEFAULT 'app',
        target_process_id TEXT,
        app_session_id TEXT,
        app_client_id TEXT
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_signal_watches_active
      ON signal_watches (uid, signal, status, process_id, expires_at)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_signal_watches_key
      ON signal_watches (uid, package_id, entrypoint_name, dedupe_key, status)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_signal_watches_target_key
      ON signal_watches (uid, target_type, target_process_id, package_id, entrypoint_name, dedupe_key, status)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_signal_watches_app_owner
      ON signal_watches (uid, app_session_id, app_client_id, status)
    `,
    `
      CREATE TABLE IF NOT EXISTS ipc_calls (
        call_id TEXT PRIMARY KEY,
        uid INTEGER NOT NULL,
        source_pid TEXT NOT NULL,
        target_pid TEXT NOT NULL,
        target_run_id TEXT,
        status TEXT NOT NULL,
        deadline_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        response_json TEXT NOT NULL DEFAULT 'null',
        error TEXT
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_ipc_calls_target_run
      ON ipc_calls(uid, target_pid, target_run_id, status)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_ipc_calls_deadline
      ON ipc_calls(status, deadline_at)
    `,
    `
      CREATE TABLE IF NOT EXISTS notifications (
        notification_id TEXT PRIMARY KEY,
        uid INTEGER NOT NULL,
        title TEXT NOT NULL,
        body TEXT,
        level TEXT NOT NULL,
        source_json TEXT NOT NULL,
        actions_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        read_at INTEGER,
        dismissed_at INTEGER,
        expires_at INTEGER
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_notifications_uid_created
      ON notifications (uid, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_notifications_uid_expires
      ON notifications (uid, expires_at)
    `,
    `
      CREATE TABLE IF NOT EXISTS schedules (
        schedule_id TEXT PRIMARY KEY,
        owner_uid INTEGER NOT NULL,
        creator_json TEXT NOT NULL,
        run_as_json TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        enabled INTEGER NOT NULL,
        expression_json TEXT NOT NULL,
        target_json TEXT NOT NULL,
        overlap_policy TEXT NOT NULL,
        wake_schedule_id TEXT,
        next_run_at INTEGER,
        running_at INTEGER,
        last_run_at INTEGER,
        last_status TEXT,
        last_error TEXT,
        last_duration_ms INTEGER,
        run_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_schedules_owner
      ON schedules (owner_uid, updated_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_schedules_due
      ON schedules (enabled, next_run_at, schedule_id)
    `,
    `
      CREATE TABLE IF NOT EXISTS schedule_runs (
        run_id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL,
        owner_uid INTEGER NOT NULL,
        scheduled_at INTEGER,
        started_at INTEGER NOT NULL,
        finished_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        result_json TEXT NOT NULL
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule
      ON schedule_runs (schedule_id, started_at DESC)
    `,
    `
      CREATE TABLE IF NOT EXISTS cron_files (
        path       TEXT PRIMARY KEY,
        owner_uid  INTEGER,
        content    TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS cron_file_schedules (
        path        TEXT NOT NULL,
        schedule_id TEXT NOT NULL,
        PRIMARY KEY (path, schedule_id)
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_cron_files_owner
      ON cron_files (owner_uid, path)
    `,
    `
      CREATE TABLE IF NOT EXISTS app_sessions (
        session_id TEXT PRIMARY KEY,
        uid INTEGER NOT NULL,
        username TEXT NOT NULL,
        package_id TEXT NOT NULL,
        package_name TEXT NOT NULL,
        entrypoint_name TEXT NOT NULL,
        route_base TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        expires_at INTEGER NOT NULL,
        closed_at INTEGER
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_app_sessions_uid_pkg
      ON app_sessions (uid, package_id, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_app_sessions_expires
      ON app_sessions (expires_at)
    `,
    `
      CREATE TABLE IF NOT EXISTS app_session_clients (
        session_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        expires_at INTEGER NOT NULL,
        closed_at INTEGER,
        PRIMARY KEY (session_id, client_id)
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_app_session_clients_session
      ON app_session_clients (session_id, expires_at)
    `,
    `
      CREATE TABLE IF NOT EXISTS app_session_client_keys (
        key_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_app_session_client_keys_session
      ON app_session_client_keys (session_id, client_id, expires_at)
    `,
    `
      CREATE TABLE IF NOT EXISTS packages (
        package_id         TEXT    NOT NULL,
        scope_key          TEXT    NOT NULL,
        scope_kind         TEXT    NOT NULL,
        scope_uid          INTEGER,
        name               TEXT    NOT NULL,
        version            TEXT    NOT NULL,
        runtime            TEXT    NOT NULL,
        enabled            INTEGER NOT NULL DEFAULT 1,
        manifest_json      TEXT    NOT NULL,
        artifact_hash      TEXT    NOT NULL,
        artifact_meta_json TEXT    NOT NULL,
        grants_json        TEXT,
        installed_at       INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL,
        review_required    INTEGER NOT NULL DEFAULT 0,
        reviewed_at        INTEGER,
        UNIQUE(package_id, scope_key)
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_packages_name_runtime
      ON packages (name, runtime, updated_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_packages_enabled
      ON packages (enabled, name, updated_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_packages_scope_name_runtime
      ON packages (scope_key, name, runtime, updated_at DESC)
    `,
    `
      CREATE TABLE IF NOT EXISTS oauth_flows (
        flow_id                TEXT PRIMARY KEY,
        state_hash             TEXT NOT NULL UNIQUE,
        uid                    INTEGER NOT NULL,
        kind                   TEXT NOT NULL,
        provider               TEXT NOT NULL,
        account_key            TEXT NOT NULL,
        label                  TEXT,
        authorization_endpoint TEXT NOT NULL,
        token_endpoint         TEXT NOT NULL,
        client_id              TEXT NOT NULL,
        redirect_uri           TEXT NOT NULL,
        scope                  TEXT,
        resource               TEXT,
        extra_auth_params_json TEXT,
        code_verifier          TEXT NOT NULL,
        created_at             INTEGER NOT NULL,
        expires_at             INTEGER NOT NULL
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_oauth_flows_uid
      ON oauth_flows(uid)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_oauth_flows_expires_at
      ON oauth_flows(expires_at)
    `,
    `
      CREATE TABLE IF NOT EXISTS oauth_accounts (
        account_id    TEXT PRIMARY KEY,
        uid           INTEGER NOT NULL,
        kind          TEXT NOT NULL,
        provider      TEXT NOT NULL,
        account_key   TEXT NOT NULL,
        label         TEXT,
        scope         TEXT,
        resource      TEXT,
        client_id     TEXT NOT NULL,
        token_type    TEXT NOT NULL,
        access_token  TEXT NOT NULL,
        refresh_token TEXT,
        expires_at    INTEGER,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        last_used_at  INTEGER,
        metadata_json TEXT
      )
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_accounts_identity
      ON oauth_accounts(uid, kind, provider, account_key)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_oauth_accounts_uid
      ON oauth_accounts(uid)
    `,
    `
      CREATE TABLE IF NOT EXISTS user_mcp_servers (
        server_id    TEXT PRIMARY KEY NOT NULL,
        uid          INTEGER NOT NULL,
        display_name TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_user_mcp_servers_uid
      ON user_mcp_servers(uid)
    `,
  ],
};
