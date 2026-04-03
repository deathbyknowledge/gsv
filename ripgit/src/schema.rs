use worker::SqlStorage;

/// Initialize all tables and indexes. Called once from DurableObject::new.
/// Uses IF NOT EXISTS throughout so it's safe to call on every instantiation.
pub fn init(sql: &SqlStorage) {
    sql.exec(
        "CREATE TABLE IF NOT EXISTS refs (
            name        TEXT PRIMARY KEY,
            commit_hash TEXT NOT NULL
        )",
        None,
    )
    .expect("create refs");

    sql.exec(
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
        None,
    )
    .expect("create commits");

    sql.exec(
        "CREATE TABLE IF NOT EXISTS commit_parents (
            commit_hash TEXT NOT NULL,
            parent_hash TEXT NOT NULL,
            ordinal     INTEGER NOT NULL,
            PRIMARY KEY (commit_hash, ordinal)
        )",
        None,
    )
    .expect("create commit_parents");

    sql.exec(
        "CREATE TABLE IF NOT EXISTS commit_graph (
            commit_hash   TEXT NOT NULL,
            level         INTEGER NOT NULL,
            ancestor_hash TEXT NOT NULL,
            PRIMARY KEY (commit_hash, level)
        )",
        None,
    )
    .expect("create commit_graph");

    sql.exec(
        "CREATE TABLE IF NOT EXISTS trees (
            tree_hash  TEXT NOT NULL,
            name       TEXT NOT NULL,
            mode       INTEGER NOT NULL,
            entry_hash TEXT NOT NULL,
            PRIMARY KEY (tree_hash, name)
        )",
        None,
    )
    .expect("create trees");

    sql.exec(
        "CREATE TABLE IF NOT EXISTS blob_groups (
            group_id       INTEGER PRIMARY KEY AUTOINCREMENT,
            path_hint      TEXT,
            latest_version INTEGER NOT NULL DEFAULT 0
        )",
        None,
    )
    .expect("create blob_groups");

    sql.exec(
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
        None,
    )
    .expect("create blobs");

    // Overflow table for blobs whose compressed data exceeds the 2 MB
    // per-row SQLite limit in Cloudflare DOs.  The blobs table stores an
    // empty sentinel for the data column; actual bytes live here in chunks.
    sql.exec(
        "CREATE TABLE IF NOT EXISTS blob_chunks (
            group_id         INTEGER NOT NULL,
            version_in_group INTEGER NOT NULL,
            chunk_index      INTEGER NOT NULL,
            data             BLOB NOT NULL,
            PRIMARY KEY (group_id, version_in_group, chunk_index)
        )",
        None,
    )
    .expect("create blob_chunks");

    // Raw object bytes for commits and trees. Stored verbatim so we can
    // return them byte-for-byte identical during fetch (preserving timezone,
    // entry order, etc. that the parsed tables lose).
    // Blobs are NOT stored here — they're reconstructed from xpatch chains.
    sql.exec(
        "CREATE TABLE IF NOT EXISTS raw_objects (
            hash TEXT PRIMARY KEY,
            data BLOB NOT NULL
        )",
        None,
    )
    .expect("create raw_objects");

    // -- Indexes --

    sql.exec(
        "CREATE INDEX IF NOT EXISTS idx_commits_time
         ON commits(commit_time DESC)",
        None,
    )
    .expect("create idx_commits_time");

    sql.exec(
        "CREATE INDEX IF NOT EXISTS idx_commit_parents_parent
         ON commit_parents(parent_hash)",
        None,
    )
    .expect("create idx_commit_parents_parent");

    sql.exec(
        "CREATE INDEX IF NOT EXISTS idx_trees_entry
         ON trees(entry_hash)",
        None,
    )
    .expect("create idx_trees_entry");

    sql.exec(
        "CREATE INDEX IF NOT EXISTS idx_blobs_group
         ON blobs(group_id, version_in_group)",
        None,
    )
    .expect("create idx_blobs_group");

    sql.exec(
        "CREATE INDEX IF NOT EXISTS idx_blob_groups_path
         ON blob_groups(path_hint)",
        None,
    )
    .expect("create idx_blob_groups_path");

    // -- Config --
    sql.exec(
        "CREATE TABLE IF NOT EXISTS config (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )",
        None,
    )
    .expect("create config");

    // -- FTS5 --
    // FTS5 virtual tables don't support IF NOT EXISTS in all SQLite builds.
    // Wrap in a check against sqlite_master to be safe.
    sql.exec(
        "CREATE VIRTUAL TABLE IF NOT EXISTS fts_head USING fts5(path, content)",
        None,
    )
    .expect("create fts_head");

    // FTS5 for commit message search
    sql.exec(
        "CREATE VIRTUAL TABLE IF NOT EXISTS fts_commits USING fts5(hash UNINDEXED, message, author)",
        None,
    )
    .expect("create fts_commits");

    // -- Issues and pull requests --

    sql.exec(
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
        None,
    )
    .expect("create issues");

    sql.exec(
        "CREATE TABLE IF NOT EXISTS issue_comments (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            issue_id    INTEGER NOT NULL,
            author_id   TEXT NOT NULL,
            author_name TEXT NOT NULL,
            body        TEXT NOT NULL,
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL
        )",
        None,
    )
    .expect("create issue_comments");

    sql.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_number ON issues(number)",
        None,
    )
    .expect("create idx_issues_number");

    sql.exec(
        "CREATE INDEX IF NOT EXISTS idx_issues_kind_state ON issues(kind, state)",
        None,
    )
    .expect("create idx_issues_kind_state");

    sql.exec(
        "CREATE INDEX IF NOT EXISTS idx_issue_comments_issue ON issue_comments(issue_id)",
        None,
    )
    .expect("create idx_issue_comments_issue");
}
