use serde::Deserialize;
use worker::{Error, Result, SqlStorage, SqlStorageValue};

const SCHEMA_COMPONENT: &str = "ripgit";
const MIGRATIONS_TABLE: &str = "_gsv_schema_migrations";

struct SqlMigration {
    id: i64,
    name: &'static str,
    statements: &'static [&'static str],
}

#[derive(Deserialize)]
struct AppliedMigration {
    id: i64,
    name: String,
    checksum: String,
}

const V001_INITIAL_STATEMENTS: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS refs (
        name        TEXT PRIMARY KEY,
        commit_hash TEXT NOT NULL
    )",
    "CREATE TABLE IF NOT EXISTS commits (
        hash            TEXT PRIMARY KEY,
        tree_hash       TEXT NOT NULL,
        author          TEXT NOT NULL,
        author_email    TEXT NOT NULL,
        author_time     INTEGER NOT NULL,
        committer       TEXT NOT NULL,
        committer_email TEXT NOT NULL,
        commit_time     INTEGER NOT NULL,
        message         TEXT NOT NULL
    )",
    "CREATE TABLE IF NOT EXISTS commit_parents (
        commit_hash TEXT NOT NULL,
        parent_hash TEXT NOT NULL,
        ordinal     INTEGER NOT NULL,
        PRIMARY KEY (commit_hash, ordinal)
    )",
    "CREATE TABLE IF NOT EXISTS commit_graph (
        commit_hash   TEXT NOT NULL,
        level         INTEGER NOT NULL,
        ancestor_hash TEXT NOT NULL,
        PRIMARY KEY (commit_hash, level)
    )",
    "CREATE TABLE IF NOT EXISTS trees (
        tree_hash  TEXT NOT NULL,
        name       TEXT NOT NULL,
        mode       INTEGER NOT NULL,
        entry_hash TEXT NOT NULL,
        PRIMARY KEY (tree_hash, name)
    )",
    "CREATE TABLE IF NOT EXISTS blob_groups (
        group_id       INTEGER PRIMARY KEY AUTOINCREMENT,
        path_hint      TEXT,
        latest_version INTEGER NOT NULL DEFAULT 0
    )",
    "CREATE TABLE IF NOT EXISTS blobs (
        blob_hash        TEXT PRIMARY KEY,
        group_id         INTEGER NOT NULL REFERENCES blob_groups(group_id),
        version_in_group INTEGER NOT NULL,
        is_keyframe      INTEGER NOT NULL DEFAULT 0,
        data             BLOB NOT NULL,
        raw_size         INTEGER NOT NULL,
        stored_size      INTEGER NOT NULL DEFAULT 0,
        UNIQUE (group_id, version_in_group)
    )",
    "CREATE TABLE IF NOT EXISTS blob_chunks (
        group_id         INTEGER NOT NULL,
        version_in_group INTEGER NOT NULL,
        chunk_index      INTEGER NOT NULL,
        data             BLOB NOT NULL,
        PRIMARY KEY (group_id, version_in_group, chunk_index)
    )",
    "CREATE TABLE IF NOT EXISTS raw_objects (
        hash TEXT PRIMARY KEY,
        data BLOB NOT NULL
    )",
    "CREATE INDEX IF NOT EXISTS idx_commits_time
     ON commits(commit_time DESC)",
    "CREATE INDEX IF NOT EXISTS idx_commit_parents_parent
     ON commit_parents(parent_hash)",
    "CREATE INDEX IF NOT EXISTS idx_trees_entry
     ON trees(entry_hash)",
    "CREATE INDEX IF NOT EXISTS idx_blobs_group
     ON blobs(group_id, version_in_group)",
    "CREATE INDEX IF NOT EXISTS idx_blob_groups_path
     ON blob_groups(path_hint)",
    "CREATE TABLE IF NOT EXISTS config (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )",
    "CREATE VIRTUAL TABLE IF NOT EXISTS fts_head USING fts5(path, content)",
    "CREATE VIRTUAL TABLE IF NOT EXISTS fts_commits USING fts5(hash UNINDEXED, message, author)",
    "CREATE TABLE IF NOT EXISTS issues (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        number            INTEGER NOT NULL,
        kind              TEXT NOT NULL DEFAULT 'issue',
        title             TEXT NOT NULL,
        body              TEXT NOT NULL DEFAULT '',
        author_id         TEXT NOT NULL,
        author_name       TEXT NOT NULL,
        state             TEXT NOT NULL DEFAULT 'open',
        source_branch     TEXT,
        target_branch     TEXT,
        source_hash       TEXT,
        merge_commit_hash TEXT,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
    )",
    "CREATE TABLE IF NOT EXISTS issue_comments (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id    INTEGER NOT NULL,
        author_id   TEXT NOT NULL,
        author_name TEXT NOT NULL,
        body        TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
    )",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_number ON issues(number)",
    "CREATE INDEX IF NOT EXISTS idx_issues_kind_state ON issues(kind, state)",
    "CREATE INDEX IF NOT EXISTS idx_issue_comments_issue ON issue_comments(issue_id)",
    "CREATE TABLE IF NOT EXISTS package_build_cache (
        cache_key   TEXT PRIMARY KEY,
        build_json  TEXT NOT NULL,
        updated_at  INTEGER NOT NULL
    )",
    "CREATE TABLE IF NOT EXISTS package_npm_cache (
        cache_key     TEXT PRIMARY KEY,
        resolved_url  TEXT NOT NULL,
        integrity     TEXT,
        files_json    TEXT NOT NULL,
        updated_at    INTEGER NOT NULL
    )",
];

const V001_INITIAL_SCHEMA: SqlMigration = SqlMigration {
    id: 1,
    name: "initial_ripgit_schema",
    statements: V001_INITIAL_STATEMENTS,
};

const MIGRATIONS: &[SqlMigration] = &[V001_INITIAL_SCHEMA];

/// Initialize the current repository schema by applying unapplied migrations.
pub fn init(sql: &SqlStorage) -> Result<()> {
    run_migrations(sql, MIGRATIONS)
}

fn run_migrations(sql: &SqlStorage, migrations: &[SqlMigration]) -> Result<()> {
    validate_migrations(migrations)?;
    ensure_migration_table(sql)?;

    let applied_rows: Vec<AppliedMigration> = sql
        .exec(
            &format!(
                "SELECT id, name, checksum
                 FROM {}
                 WHERE component = ?
                 ORDER BY id",
                MIGRATIONS_TABLE
            ),
            vec![SqlStorageValue::from(SCHEMA_COMPONENT.to_string())],
        )?
        .to_array()?;

    for migration in migrations {
        let checksum = migration_checksum(migration);
        if let Some(existing) = applied_rows.iter().find(|row| row.id == migration.id) {
            if existing.name != migration.name || existing.checksum != checksum {
                return Err(Error::RustError(format!(
                    "Schema migration {}:{} has changed after being applied",
                    SCHEMA_COMPONENT, migration.id
                )));
            }
            continue;
        }

        for statement in migration.statements {
            let trimmed = statement.trim();
            if !trimmed.is_empty() {
                sql.exec(trimmed, None)?;
            }
        }

        sql.exec(
            &format!(
                "INSERT INTO {} (component, id, name, checksum, applied_at)
                 VALUES (?, ?, ?, ?, ?)",
                MIGRATIONS_TABLE
            ),
            vec![
                SqlStorageValue::from(SCHEMA_COMPONENT.to_string()),
                SqlStorageValue::from(migration.id),
                SqlStorageValue::from(migration.name.to_string()),
                SqlStorageValue::from(checksum),
                SqlStorageValue::from(worker::Date::now().as_millis() as i64),
            ],
        )?;
    }

    Ok(())
}

fn ensure_migration_table(sql: &SqlStorage) -> Result<()> {
    sql.exec(
        &format!(
            "CREATE TABLE IF NOT EXISTS {} (
                component  TEXT    NOT NULL,
                id         INTEGER NOT NULL,
                name       TEXT    NOT NULL,
                checksum   TEXT    NOT NULL,
                applied_at INTEGER NOT NULL,
                PRIMARY KEY (component, id)
            )",
            MIGRATIONS_TABLE
        ),
        None,
    )?;
    Ok(())
}

fn validate_migrations(migrations: &[SqlMigration]) -> Result<()> {
    let mut previous_id = 0;
    for migration in migrations {
        if migration.id <= 0 {
            return Err(Error::RustError(format!(
                "Invalid schema migration id: {}",
                migration.id
            )));
        }
        if migration.id <= previous_id {
            return Err(Error::RustError(format!(
                "Schema migrations must be sorted by ascending id: {}",
                migration.id
            )));
        }
        if migration.name.trim().is_empty() {
            return Err(Error::RustError(format!(
                "Schema migration {} is missing a name",
                migration.id
            )));
        }
        previous_id = migration.id;
    }
    Ok(())
}

fn migration_checksum(migration: &SqlMigration) -> String {
    let mut input = format!("{}:{}:", migration.id, migration.name);
    for statement in migration.statements {
        input.push_str(statement.trim());
        input.push('\n');
    }

    let mut hash: u32 = 2166136261;
    for byte in input.bytes() {
        hash ^= byte as u32;
        hash = hash.wrapping_mul(16777619);
    }
    format!("{:08x}", hash)
}
