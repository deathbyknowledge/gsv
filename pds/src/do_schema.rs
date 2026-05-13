//! SQLite schema for the repository Durable Object.

pub const CREATE_REPO_STATE: &str = "CREATE TABLE IF NOT EXISTS repo_state (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    did           TEXT NOT NULL,
    latest_commit TEXT NOT NULL,
    latest_rev    TEXT NOT NULL
)";

pub const CREATE_REPO_IDENTITY: &str = "CREATE TABLE IF NOT EXISTS repo_identity (
    id                    INTEGER PRIMARY KEY CHECK (id = 1),
    handle                TEXT NOT NULL,
    signing_key_p256_hex  TEXT NOT NULL,
    public_key_multibase  TEXT NOT NULL
)";

pub const CREATE_REPO_BLOCKS: &str = "CREATE TABLE IF NOT EXISTS repo_blocks (
    cid        TEXT PRIMARY KEY,
    bytes      BLOB NOT NULL,
    byte_len   INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
)";

pub const CREATE_REPO_BLOBS: &str = "CREATE TABLE IF NOT EXISTS repo_blobs (
    cid          TEXT PRIMARY KEY,
    mime_type    TEXT NOT NULL,
    bytes        BLOB NOT NULL,
    byte_len     INTEGER NOT NULL,
    storage_kind TEXT NOT NULL DEFAULT 'sqlite',
    storage_key  TEXT,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch())
)";

pub const CREATE_REPO_BLOBS_CREATED_INDEX: &str =
    "CREATE INDEX IF NOT EXISTS idx_repo_blobs_created_at
     ON repo_blobs(created_at, cid)";

pub const CREATE_RECORD_INDEX: &str = "CREATE TABLE IF NOT EXISTS record_index (
    path       TEXT PRIMARY KEY,
    collection TEXT NOT NULL,
    rkey       TEXT NOT NULL,
    cid        TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
)";

pub const CREATE_RECORD_COLLECTION_INDEX: &str =
    "CREATE INDEX IF NOT EXISTS idx_record_index_collection_path
     ON record_index(collection, path)";

pub const CREATE_REPO_BLOB_REFS: &str = "CREATE TABLE IF NOT EXISTS repo_blob_refs (
    path       TEXT NOT NULL,
    cid        TEXT NOT NULL,
    record_cid TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (path, cid)
)";

pub const CREATE_REPO_BLOB_REFS_CID_INDEX: &str =
    "CREATE INDEX IF NOT EXISTS idx_repo_blob_refs_cid_path
     ON repo_blob_refs(cid, path)";

pub const CREATE_REPO_COMMIT_EVENTS: &str = "CREATE TABLE IF NOT EXISTS repo_commit_events (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    rev        TEXT NOT NULL UNIQUE,
    since      TEXT,
    prev_data  TEXT,
    commit_cid TEXT NOT NULL,
    blocks     BLOB NOT NULL,
    ops_json   TEXT NOT NULL DEFAULT '[]',
    blobs_json TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
)";

pub const CREATE_REPO_COMMIT_EVENTS_REV_INDEX: &str =
    "CREATE INDEX IF NOT EXISTS idx_repo_commit_events_rev
     ON repo_commit_events(rev)";

pub const CREATE_REPO_LEXICONS: &str = "CREATE TABLE IF NOT EXISTS repo_lexicons (
    nsid         TEXT PRIMARY KEY,
    lexicon_json TEXT NOT NULL,
    source       TEXT NOT NULL,
    updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
)";

pub const ALL_SCHEMA_STATEMENTS: &[&str] = &[
    CREATE_REPO_STATE,
    CREATE_REPO_IDENTITY,
    CREATE_REPO_BLOCKS,
    CREATE_REPO_BLOBS,
    CREATE_REPO_BLOBS_CREATED_INDEX,
    CREATE_RECORD_INDEX,
    CREATE_RECORD_COLLECTION_INDEX,
    CREATE_REPO_BLOB_REFS,
    CREATE_REPO_BLOB_REFS_CID_INDEX,
    CREATE_REPO_COMMIT_EVENTS,
    CREATE_REPO_COMMIT_EVENTS_REV_INDEX,
    CREATE_REPO_LEXICONS,
];

pub const CREATE_DIRECTORY_REPOS: &str = "CREATE TABLE IF NOT EXISTS directory_repos (
    did        TEXT PRIMARY KEY,
    handle     TEXT NOT NULL,
    repo_name  TEXT NOT NULL,
    head       TEXT NOT NULL,
    rev        TEXT NOT NULL,
    active     INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
)";

pub const CREATE_DIRECTORY_REPOS_UPDATED_INDEX: &str =
    "CREATE INDEX IF NOT EXISTS idx_directory_repos_updated_at
     ON directory_repos(updated_at, did)";

pub const CREATE_DIRECTORY_REPO_RECORDS: &str =
    "CREATE TABLE IF NOT EXISTS directory_repo_records (
    did        TEXT NOT NULL,
    path       TEXT NOT NULL,
    collection TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (did, path)
)";

pub const CREATE_DIRECTORY_REPO_RECORDS_COLLECTION_INDEX: &str =
    "CREATE INDEX IF NOT EXISTS idx_directory_repo_records_collection_did
     ON directory_repo_records(collection, did)";

pub const CREATE_DIRECTORY_EVENTS: &str = "CREATE TABLE IF NOT EXISTS directory_events (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    did        TEXT NOT NULL,
    event_type TEXT NOT NULL,
    commit_cid TEXT,
    rev        TEXT,
    since      TEXT,
    prev_data  TEXT,
    blocks     BLOB,
    ops_json   TEXT NOT NULL DEFAULT '[]',
    blobs_json TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
)";

pub const CREATE_DIRECTORY_EVENTS_DID_INDEX: &str =
    "CREATE INDEX IF NOT EXISTS idx_directory_events_did_seq
     ON directory_events(did, seq)";

pub const CREATE_DIRECTORY_ACCOUNTS: &str = "CREATE TABLE IF NOT EXISTS directory_accounts (
    did                  TEXT PRIMARY KEY,
    handle               TEXT NOT NULL UNIQUE,
    email                TEXT,
    email_confirmed      INTEGER NOT NULL DEFAULT 0,
    invites_disabled     INTEGER NOT NULL DEFAULT 0,
    invite_note          TEXT,
    password_hash        TEXT NOT NULL,
    repo_name            TEXT NOT NULL UNIQUE,
    public_key_multibase TEXT NOT NULL,
    active               INTEGER NOT NULL DEFAULT 1,
    status               TEXT,
    created_at           INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at           INTEGER NOT NULL DEFAULT (unixepoch())
)";

pub const CREATE_DIRECTORY_ACCOUNTS_HANDLE_INDEX: &str =
    "CREATE INDEX IF NOT EXISTS idx_directory_accounts_handle
     ON directory_accounts(handle)";

pub const CREATE_DIRECTORY_SESSIONS: &str = "CREATE TABLE IF NOT EXISTS directory_sessions (
    session_id         TEXT PRIMARY KEY,
    did                TEXT NOT NULL,
    refresh_jti        TEXT NOT NULL UNIQUE,
    active             INTEGER NOT NULL DEFAULT 1,
    client_auth_method TEXT NOT NULL DEFAULT 'none',
    client_auth_kid    TEXT,
    client_auth_alg    TEXT,
    client_auth_jkt    TEXT,
    created_at         INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at         INTEGER NOT NULL DEFAULT (unixepoch())
)";

pub const CREATE_DIRECTORY_SESSIONS_DID_INDEX: &str =
    "CREATE INDEX IF NOT EXISTS idx_directory_sessions_did
     ON directory_sessions(did)";

pub const CREATE_DIRECTORY_APP_PASSWORDS: &str =
    "CREATE TABLE IF NOT EXISTS directory_app_passwords (
    did           TEXT NOT NULL,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    privileged    INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (did, name)
)";

pub const CREATE_DIRECTORY_INVITE_CODES: &str =
    "CREATE TABLE IF NOT EXISTS directory_invite_codes (
    code        TEXT PRIMARY KEY,
    available   INTEGER NOT NULL,
    disabled    INTEGER NOT NULL DEFAULT 0,
    for_account TEXT NOT NULL,
    created_by  TEXT NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
)";

pub const CREATE_DIRECTORY_INVITE_CODES_ACCOUNT_INDEX: &str =
    "CREATE INDEX IF NOT EXISTS idx_directory_invite_codes_account
     ON directory_invite_codes(for_account, created_at)";

pub const CREATE_DIRECTORY_INVITE_CODES_CREATED_INDEX: &str =
    "CREATE INDEX IF NOT EXISTS idx_directory_invite_codes_created_at
     ON directory_invite_codes(created_at, code)";

pub const CREATE_DIRECTORY_INVITE_CODE_USES: &str =
    "CREATE TABLE IF NOT EXISTS directory_invite_code_uses (
    code      TEXT NOT NULL,
    used_by   TEXT NOT NULL,
    used_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (code, used_by)
)";

pub const CREATE_DIRECTORY_INVITE_CODE_USES_CODE_INDEX: &str =
    "CREATE INDEX IF NOT EXISTS idx_directory_invite_code_uses_code
     ON directory_invite_code_uses(code, used_at)";

pub const CREATE_DIRECTORY_INVITE_CODE_USES_USED_BY_INDEX: &str =
    "CREATE INDEX IF NOT EXISTS idx_directory_invite_code_uses_used_by
     ON directory_invite_code_uses(used_by, used_at)";

pub const CREATE_DIRECTORY_RESERVED_SIGNING_KEYS: &str =
    "CREATE TABLE IF NOT EXISTS directory_reserved_signing_keys (
    signing_key           TEXT PRIMARY KEY,
    public_key_multibase  TEXT NOT NULL UNIQUE,
    signing_key_p256_hex  TEXT NOT NULL,
    did                   TEXT,
    consumed_at           INTEGER,
    created_at            INTEGER NOT NULL DEFAULT (unixepoch())
)";

pub const CREATE_DIRECTORY_RESERVED_SIGNING_KEYS_DID_INDEX: &str =
    "CREATE INDEX IF NOT EXISTS idx_directory_reserved_signing_keys_did
     ON directory_reserved_signing_keys(did, created_at)";

pub const CREATE_DIRECTORY_ACTION_TOKENS: &str =
    "CREATE TABLE IF NOT EXISTS directory_action_tokens (
    token_digest TEXT PRIMARY KEY,
    did          TEXT NOT NULL,
    purpose      TEXT NOT NULL,
    email        TEXT,
    expires_at   INTEGER NOT NULL,
    consumed_at  INTEGER,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch())
)";

pub const CREATE_DIRECTORY_ACTION_TOKENS_DID_INDEX: &str =
    "CREATE INDEX IF NOT EXISTS idx_directory_action_tokens_did_purpose
     ON directory_action_tokens(did, purpose, created_at)";

pub const CREATE_DIRECTORY_ACTION_TOKENS_EXPIRES_INDEX: &str =
    "CREATE INDEX IF NOT EXISTS idx_directory_action_tokens_expires_at
     ON directory_action_tokens(expires_at)";

pub const CREATE_DIRECTORY_OAUTH_PAR_REQUESTS: &str =
    "CREATE TABLE IF NOT EXISTS directory_oauth_par_requests (
    request_uri           TEXT PRIMARY KEY,
    client_id             TEXT NOT NULL,
    redirect_uri          TEXT NOT NULL,
    scope                 TEXT NOT NULL,
    state                 TEXT NOT NULL,
    code_challenge        TEXT NOT NULL,
    code_challenge_method TEXT NOT NULL,
    login_hint            TEXT,
    dpop_jkt              TEXT NOT NULL DEFAULT '',
    dpop_nonce            TEXT NOT NULL,
    client_auth_method    TEXT NOT NULL DEFAULT 'none',
    client_auth_kid       TEXT,
    client_auth_alg       TEXT,
    client_auth_jkt       TEXT,
    params_json           TEXT NOT NULL,
    expires_at            INTEGER NOT NULL,
    created_at            INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE (client_id, state)
)";

pub const CREATE_DIRECTORY_OAUTH_PAR_EXPIRES_INDEX: &str =
    "CREATE INDEX IF NOT EXISTS idx_directory_oauth_par_expires_at
     ON directory_oauth_par_requests(expires_at)";

pub const CREATE_DIRECTORY_OAUTH_AUTHORIZATION_CODES: &str =
    "CREATE TABLE IF NOT EXISTS directory_oauth_authorization_codes (
    code                  TEXT PRIMARY KEY,
    request_uri           TEXT NOT NULL UNIQUE,
    client_id             TEXT NOT NULL,
    redirect_uri          TEXT NOT NULL,
    scope                 TEXT NOT NULL,
    state                 TEXT NOT NULL,
    code_challenge        TEXT NOT NULL,
    code_challenge_method TEXT NOT NULL,
    did                   TEXT NOT NULL,
    handle                TEXT NOT NULL,
    dpop_jkt              TEXT NOT NULL DEFAULT '',
    dpop_nonce            TEXT NOT NULL,
    client_auth_method    TEXT NOT NULL DEFAULT 'none',
    client_auth_kid       TEXT,
    client_auth_alg       TEXT,
    client_auth_jkt       TEXT,
    expires_at            INTEGER NOT NULL,
    consumed_at           INTEGER,
    created_at            INTEGER NOT NULL DEFAULT (unixepoch())
)";

pub const CREATE_DIRECTORY_OAUTH_AUTHORIZATION_CODES_EXPIRES_INDEX: &str =
    "CREATE INDEX IF NOT EXISTS idx_directory_oauth_authorization_codes_expires_at
     ON directory_oauth_authorization_codes(expires_at)";

pub const CREATE_DIRECTORY_OAUTH_AUTHORIZATION_CODES_DID_INDEX: &str =
    "CREATE INDEX IF NOT EXISTS idx_directory_oauth_authorization_codes_did
     ON directory_oauth_authorization_codes(did)";

pub const CREATE_DIRECTORY_DPOP_JTIS: &str = "CREATE TABLE IF NOT EXISTS directory_dpop_jtis (
    jkt        TEXT NOT NULL,
    jti        TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (jkt, jti)
)";

pub const CREATE_DIRECTORY_DPOP_JTIS_EXPIRES_INDEX: &str =
    "CREATE INDEX IF NOT EXISTS idx_directory_dpop_jtis_expires_at
     ON directory_dpop_jtis(expires_at)";

pub const CREATE_DIRECTORY_OAUTH_CLIENT_JTIS: &str =
    "CREATE TABLE IF NOT EXISTS directory_oauth_client_jtis (
    client_id  TEXT NOT NULL,
    jti        TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (client_id, jti)
)";

pub const CREATE_DIRECTORY_OAUTH_CLIENT_JTIS_EXPIRES_INDEX: &str =
    "CREATE INDEX IF NOT EXISTS idx_directory_oauth_client_jtis_expires_at
     ON directory_oauth_client_jtis(expires_at)";

pub const DIRECTORY_SCHEMA_STATEMENTS: &[&str] = &[
    CREATE_DIRECTORY_REPOS,
    CREATE_DIRECTORY_REPOS_UPDATED_INDEX,
    CREATE_DIRECTORY_REPO_RECORDS,
    CREATE_DIRECTORY_REPO_RECORDS_COLLECTION_INDEX,
    CREATE_DIRECTORY_EVENTS,
    CREATE_DIRECTORY_EVENTS_DID_INDEX,
    CREATE_DIRECTORY_ACCOUNTS,
    CREATE_DIRECTORY_ACCOUNTS_HANDLE_INDEX,
    CREATE_DIRECTORY_SESSIONS,
    CREATE_DIRECTORY_SESSIONS_DID_INDEX,
    CREATE_DIRECTORY_APP_PASSWORDS,
    CREATE_DIRECTORY_INVITE_CODES,
    CREATE_DIRECTORY_INVITE_CODES_ACCOUNT_INDEX,
    CREATE_DIRECTORY_INVITE_CODES_CREATED_INDEX,
    CREATE_DIRECTORY_INVITE_CODE_USES,
    CREATE_DIRECTORY_INVITE_CODE_USES_CODE_INDEX,
    CREATE_DIRECTORY_INVITE_CODE_USES_USED_BY_INDEX,
    CREATE_DIRECTORY_RESERVED_SIGNING_KEYS,
    CREATE_DIRECTORY_RESERVED_SIGNING_KEYS_DID_INDEX,
    CREATE_DIRECTORY_ACTION_TOKENS,
    CREATE_DIRECTORY_ACTION_TOKENS_DID_INDEX,
    CREATE_DIRECTORY_ACTION_TOKENS_EXPIRES_INDEX,
    CREATE_DIRECTORY_OAUTH_PAR_REQUESTS,
    CREATE_DIRECTORY_OAUTH_PAR_EXPIRES_INDEX,
    CREATE_DIRECTORY_OAUTH_AUTHORIZATION_CODES,
    CREATE_DIRECTORY_OAUTH_AUTHORIZATION_CODES_EXPIRES_INDEX,
    CREATE_DIRECTORY_OAUTH_AUTHORIZATION_CODES_DID_INDEX,
    CREATE_DIRECTORY_DPOP_JTIS,
    CREATE_DIRECTORY_DPOP_JTIS_EXPIRES_INDEX,
    CREATE_DIRECTORY_OAUTH_CLIENT_JTIS,
    CREATE_DIRECTORY_OAUTH_CLIENT_JTIS_EXPIRES_INDEX,
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_creates_expected_tables() {
        let joined = ALL_SCHEMA_STATEMENTS.join("\n");

        assert!(joined.contains("repo_state"));
        assert!(joined.contains("repo_identity"));
        assert!(joined.contains("repo_blocks"));
        assert!(joined.contains("repo_blobs"));
        assert!(joined.contains("record_index"));
        assert!(joined.contains("repo_blob_refs"));
        assert!(joined.contains("repo_commit_events"));
        assert!(joined.contains("repo_lexicons"));
        assert!(joined.contains("idx_record_index_collection_path"));
    }

    #[test]
    fn repo_state_is_singleton_table() {
        assert!(CREATE_REPO_STATE.contains("CHECK (id = 1)"));
        assert!(CREATE_REPO_STATE.contains("latest_commit TEXT NOT NULL"));
    }

    #[test]
    fn repo_identity_stores_signing_metadata() {
        assert!(CREATE_REPO_IDENTITY.contains("CHECK (id = 1)"));
        assert!(CREATE_REPO_IDENTITY.contains("handle                TEXT NOT NULL"));
        assert!(CREATE_REPO_IDENTITY.contains("signing_key_p256_hex  TEXT NOT NULL"));
        assert!(CREATE_REPO_IDENTITY.contains("public_key_multibase  TEXT NOT NULL"));
    }

    #[test]
    fn repo_blocks_store_bytes_by_cid() {
        assert!(CREATE_REPO_BLOCKS.contains("cid        TEXT PRIMARY KEY"));
        assert!(CREATE_REPO_BLOCKS.contains("bytes      BLOB NOT NULL"));
    }

    #[test]
    fn repo_blobs_store_raw_bytes_by_cid() {
        assert!(CREATE_REPO_BLOBS.contains("cid          TEXT PRIMARY KEY"));
        assert!(CREATE_REPO_BLOBS.contains("mime_type    TEXT NOT NULL"));
        assert!(CREATE_REPO_BLOBS.contains("bytes        BLOB NOT NULL"));
        assert!(CREATE_REPO_BLOBS.contains("storage_kind TEXT NOT NULL DEFAULT 'sqlite'"));
    }

    #[test]
    fn blob_refs_track_record_references() {
        assert!(CREATE_REPO_BLOB_REFS.contains("PRIMARY KEY (path, cid)"));
        assert!(CREATE_REPO_BLOB_REFS.contains("record_cid TEXT NOT NULL"));
    }

    #[test]
    fn commit_events_store_diff_car_payloads() {
        assert!(CREATE_REPO_COMMIT_EVENTS.contains("rev        TEXT NOT NULL UNIQUE"));
        assert!(CREATE_REPO_COMMIT_EVENTS.contains("blocks     BLOB NOT NULL"));
        assert!(CREATE_REPO_COMMIT_EVENTS.contains("blobs_json TEXT NOT NULL DEFAULT '[]'"));
    }

    #[test]
    fn repo_lexicons_cache_schema_documents_by_nsid() {
        assert!(CREATE_REPO_LEXICONS.contains("nsid         TEXT PRIMARY KEY"));
        assert!(CREATE_REPO_LEXICONS.contains("lexicon_json TEXT NOT NULL"));
        assert!(CREATE_REPO_LEXICONS.contains("source       TEXT NOT NULL"));
    }

    #[test]
    fn directory_schema_indexes_repos_and_events() {
        let joined = DIRECTORY_SCHEMA_STATEMENTS.join("\n");

        assert!(joined.contains("directory_repos"));
        assert!(joined.contains("did        TEXT PRIMARY KEY"));
        assert!(joined.contains("idx_directory_repos_updated_at"));
        assert!(joined.contains("directory_repo_records"));
        assert!(joined.contains("PRIMARY KEY (did, path)"));
        assert!(joined.contains("directory_events"));
        assert!(joined.contains("seq        INTEGER PRIMARY KEY AUTOINCREMENT"));
        assert!(joined.contains("blocks     BLOB"));
        assert!(joined.contains("ops_json   TEXT NOT NULL DEFAULT '[]'"));
        assert!(joined.contains("idx_directory_events_did_seq"));
        assert!(joined.contains("directory_accounts"));
        assert!(joined.contains("password_hash        TEXT NOT NULL"));
        assert!(joined.contains("email_confirmed      INTEGER NOT NULL DEFAULT 0"));
        assert!(joined.contains("invites_disabled     INTEGER NOT NULL DEFAULT 0"));
        assert!(joined.contains("directory_sessions"));
        assert!(joined.contains("refresh_jti        TEXT NOT NULL UNIQUE"));
        assert!(joined.contains("client_auth_method TEXT NOT NULL DEFAULT 'none'"));
        assert!(joined.contains("directory_invite_codes"));
        assert!(joined.contains("available   INTEGER NOT NULL"));
        assert!(joined.contains("directory_invite_code_uses"));
        assert!(joined.contains("PRIMARY KEY (code, used_by)"));
        assert!(joined.contains("directory_reserved_signing_keys"));
        assert!(joined.contains("signing_key_p256_hex  TEXT NOT NULL"));
        assert!(joined.contains("directory_action_tokens"));
        assert!(joined.contains("token_digest TEXT PRIMARY KEY"));
        assert!(joined.contains("idx_directory_action_tokens_did_purpose"));
        assert!(joined.contains("directory_oauth_par_requests"));
        assert!(joined.contains("UNIQUE (client_id, state)"));
        assert!(joined.contains("directory_oauth_authorization_codes"));
        assert!(joined.contains("request_uri           TEXT NOT NULL UNIQUE"));
        assert!(joined.contains("consumed_at           INTEGER"));
        assert!(joined.contains("dpop_jkt"));
        assert!(joined.contains("directory_dpop_jtis"));
        assert!(joined.contains("directory_oauth_client_jtis"));
    }
}
