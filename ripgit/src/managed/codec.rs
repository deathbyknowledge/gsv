use std::collections::BTreeSet;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use worker::{SqlStorage, SqlStorageValue};

use super::{validate_identity_part, ManagedError, ManagedResult, RepositoryIdentity};
use crate::store;

pub const SNAPSHOT_FORMAT: &str = "gsv-ripgit-logical-sql-v1";
pub const MAX_SNAPSHOT_ROWS: usize = 250;
const MAX_SNAPSHOT_PAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_SAFE_SQL_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Clone, Copy)]
pub struct TableSpec {
    pub name: &'static str,
    pub columns: &'static [&'static str],
    pub column_types: &'static [&'static str],
    pub order_by: &'static str,
}

pub const TABLES: &[TableSpec] = &[
    TableSpec {
        name: "config",
        columns: &["key", "value"],
        column_types: &["TEXT", "TEXT"],
        order_by: "key",
    },
    TableSpec {
        name: "blob_groups",
        columns: &["group_id", "path_hint", "latest_version"],
        column_types: &["INTEGER", "TEXT", "INTEGER"],
        order_by: "group_id",
    },
    TableSpec {
        name: "commits",
        columns: &[
            "hash",
            "tree_hash",
            "author",
            "author_email",
            "author_time",
            "committer",
            "committer_email",
            "commit_time",
            "message",
        ],
        column_types: &[
            "TEXT", "TEXT", "TEXT", "TEXT", "INTEGER", "TEXT", "TEXT", "INTEGER", "TEXT",
        ],
        order_by: "hash",
    },
    TableSpec {
        name: "commit_parents",
        columns: &["commit_hash", "parent_hash", "ordinal"],
        column_types: &["TEXT", "TEXT", "INTEGER"],
        order_by: "commit_hash, ordinal",
    },
    TableSpec {
        name: "trees",
        columns: &["tree_hash", "name", "mode", "entry_hash"],
        column_types: &["TEXT", "TEXT", "INTEGER", "TEXT"],
        order_by: "tree_hash, name",
    },
    TableSpec {
        name: "blobs",
        columns: &[
            "blob_hash",
            "group_id",
            "version_in_group",
            "is_keyframe",
            "data",
            "raw_size",
            "stored_size",
        ],
        column_types: &[
            "TEXT", "INTEGER", "INTEGER", "INTEGER", "BLOB", "INTEGER", "INTEGER",
        ],
        order_by: "blob_hash",
    },
    TableSpec {
        name: "blob_chunks",
        columns: &["group_id", "version_in_group", "chunk_index", "data"],
        column_types: &["INTEGER", "INTEGER", "INTEGER", "BLOB"],
        order_by: "group_id, version_in_group, chunk_index",
    },
    TableSpec {
        name: "raw_objects",
        columns: &["hash", "data"],
        column_types: &["TEXT", "BLOB"],
        order_by: "hash",
    },
    TableSpec {
        name: "refs",
        columns: &["name", "commit_hash"],
        column_types: &["TEXT", "TEXT"],
        order_by: "name",
    },
    TableSpec {
        name: "issues",
        columns: &[
            "id",
            "number",
            "kind",
            "title",
            "body",
            "author_id",
            "author_name",
            "state",
            "source_branch",
            "target_branch",
            "source_hash",
            "merge_commit_hash",
            "created_at",
            "updated_at",
        ],
        column_types: &[
            "INTEGER", "INTEGER", "TEXT", "TEXT", "TEXT", "TEXT", "TEXT", "TEXT", "TEXT", "TEXT",
            "TEXT", "TEXT", "INTEGER", "INTEGER",
        ],
        order_by: "id",
    },
    TableSpec {
        name: "issue_comments",
        columns: &[
            "id",
            "issue_id",
            "author_id",
            "author_name",
            "body",
            "created_at",
            "updated_at",
        ],
        column_types: &[
            "INTEGER", "INTEGER", "TEXT", "TEXT", "TEXT", "INTEGER", "INTEGER",
        ],
        order_by: "id",
    },
];

const DERIVED_TABLES: &[&str] = &["commit_graph", "fts_head", "fts_commits"];
const CACHE_TABLES: &[&str] = &["package_build_cache", "package_npm_cache"];
const FTS_SHADOW_TABLES: &[&str] = &[
    "fts_head_data",
    "fts_head_idx",
    "fts_head_content",
    "fts_head_docsize",
    "fts_head_config",
    "fts_commits_data",
    "fts_commits_idx",
    "fts_commits_content",
    "fts_commits_docsize",
    "fts_commits_config",
];
const MANAGED_TABLES: &[&str] = &[
    "_gsv_schema_migrations",
    "managed_repository_identity",
    "managed_repository_lifecycle",
    "managed_repository_erasure",
    "managed_restore_journals",
    "managed_restore_pages",
];

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum SnapshotValue {
    Null,
    Boolean(bool),
    Integer(String),
    FloatBits(String),
    String(String),
    BlobBase64(String),
}

impl SnapshotValue {
    fn from_sql(value: SqlStorageValue) -> Self {
        match value {
            SqlStorageValue::Null => Self::Null,
            SqlStorageValue::Boolean(value) => Self::Boolean(value),
            SqlStorageValue::Integer(value) => Self::Integer(value.to_string()),
            SqlStorageValue::Float(value) => Self::FloatBits(format!("{:016x}", value.to_bits())),
            SqlStorageValue::String(value) => Self::String(value),
            SqlStorageValue::Blob(value) => Self::BlobBase64(BASE64.encode(value)),
        }
    }

    fn to_sql(&self) -> ManagedResult<SqlStorageValue> {
        match self {
            Self::Null => Ok(SqlStorageValue::Null),
            Self::Boolean(value) => Ok(SqlStorageValue::Boolean(*value)),
            Self::Integer(value) => parse_snapshot_integer(value).map(SqlStorageValue::Integer),
            Self::FloatBits(value) => {
                if value.len() != 16
                    || !value
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                {
                    return Err(invalid_value("Snapshot float bits are invalid"));
                }
                let bits = u64::from_str_radix(value, 16)
                    .map_err(|_| invalid_value("Snapshot float bits are invalid"))?;
                Ok(SqlStorageValue::Float(f64::from_bits(bits)))
            }
            Self::String(value) => Ok(SqlStorageValue::String(value.clone())),
            Self::BlobBase64(value) => decode_snapshot_blob(value).map(SqlStorageValue::Blob),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SnapshotRepositoryIdentity {
    pub owner: String,
    pub repo: String,
}

impl SnapshotRepositoryIdentity {
    fn from_repository(identity: &RepositoryIdentity) -> Self {
        Self {
            owner: identity.owner.clone(),
            repo: identity.repo.clone(),
        }
    }

    pub fn validate(&self) -> ManagedResult<()> {
        validate_identity_part(&self.owner, "owner")?;
        validate_identity_part(&self.repo, "repository")
    }

    pub fn do_name(&self) -> String {
        format!("{}/{}", self.owner, self.repo)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SnapshotTable {
    pub name: String,
    pub columns: Vec<String>,
    pub column_types: Vec<String>,
    pub row_count: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SnapshotManifestBody {
    pub format: String,
    pub identity: SnapshotRepositoryIdentity,
    pub source_epoch: i64,
    pub tables: Vec<SnapshotTable>,
    pub rebuilt_derived_tables: Vec<String>,
    pub excluded_cache_tables: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SnapshotManifest {
    pub body: SnapshotManifestBody,
    pub manifest_hash: String,
}

impl SnapshotManifest {
    pub fn new(body: SnapshotManifestBody) -> ManagedResult<Self> {
        validate_manifest_shape(&body)?;
        let manifest_hash = hash_json(&body)?;
        Ok(Self {
            body,
            manifest_hash,
        })
    }

    pub fn verify(&self) -> ManagedResult<()> {
        if self.manifest_hash != hash_json(&self.body)? {
            return Err(ManagedError::conflict(
                "snapshot_manifest_hash_mismatch",
                "Snapshot manifest hash does not match its contents",
            ));
        }
        validate_manifest_shape(&self.body)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SnapshotPageBody {
    pub manifest_hash: String,
    pub table_index: usize,
    pub table: String,
    pub offset: i64,
    pub next_offset: i64,
    pub rows: Vec<Vec<SnapshotValue>>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SnapshotPage {
    pub body: SnapshotPageBody,
    pub page_hash: String,
}

impl SnapshotPage {
    fn new(body: SnapshotPageBody) -> ManagedResult<Self> {
        let page_hash = hash_json(&body)?;
        Ok(Self { body, page_hash })
    }

    pub fn verify(&self) -> ManagedResult<()> {
        if self.page_hash != hash_json(&self.body)? {
            return Err(ManagedError::conflict(
                "snapshot_page_hash_mismatch",
                "Snapshot page hash does not match its contents",
            ));
        }
        Ok(())
    }
}

pub fn create_manifest(
    sql: &SqlStorage,
    identity: &RepositoryIdentity,
    epoch: i64,
) -> ManagedResult<SnapshotManifest> {
    validate_repository_schema(sql)?;
    let mut tables = Vec::with_capacity(TABLES.len());
    for spec in TABLES {
        tables.push(SnapshotTable {
            name: spec.name.to_string(),
            columns: spec.columns.iter().map(|value| value.to_string()).collect(),
            column_types: spec
                .column_types
                .iter()
                .map(|value| value.to_string())
                .collect(),
            row_count: table_count(sql, spec.name)?,
        });
    }
    SnapshotManifest::new(SnapshotManifestBody {
        format: SNAPSHOT_FORMAT.to_string(),
        identity: SnapshotRepositoryIdentity::from_repository(identity),
        source_epoch: epoch,
        tables,
        rebuilt_derived_tables: DERIVED_TABLES
            .iter()
            .map(|value| value.to_string())
            .collect(),
        excluded_cache_tables: CACHE_TABLES.iter().map(|value| value.to_string()).collect(),
    })
}

pub fn read_page(
    sql: &SqlStorage,
    manifest: &SnapshotManifest,
    table_index: usize,
    offset: i64,
    limit: usize,
) -> ManagedResult<SnapshotPage> {
    manifest.verify()?;
    if offset < 0 {
        return Err(ManagedError::bad_request(
            "invalid_snapshot_offset",
            "Snapshot offset must be non-negative",
        ));
    }
    let spec = TABLES.get(table_index).ok_or_else(|| {
        ManagedError::bad_request("invalid_snapshot_table", "Snapshot table index is invalid")
    })?;
    let table = &manifest.body.tables[table_index];
    if offset > table.row_count {
        return Err(ManagedError::bad_request(
            "invalid_snapshot_offset",
            "Snapshot offset is beyond the table row count",
        ));
    }
    let limit = limit.clamp(1, MAX_SNAPSHOT_ROWS);
    let query = format!(
        "SELECT {} FROM {} ORDER BY {} LIMIT ? OFFSET ?",
        spec.columns.join(", "),
        spec.name,
        spec.order_by
    );
    let cursor = sql.exec(
        &query,
        vec![
            SqlStorageValue::from(limit as i64),
            SqlStorageValue::from(offset),
        ],
    )?;
    let mut rows = Vec::new();
    let mut encoded_bytes = 0_usize;
    for row in cursor.raw() {
        let row = row?
            .into_iter()
            .map(SnapshotValue::from_sql)
            .collect::<Vec<_>>();
        validate_row_values(spec, &row)?;
        let row_bytes = serde_json::to_vec(&row).map_err(ManagedError::from)?.len();
        if !rows.is_empty()
            && encoded_bytes
                .checked_add(row_bytes)
                .is_none_or(|size| size > MAX_SNAPSHOT_PAGE_BYTES)
        {
            break;
        }
        encoded_bytes = encoded_bytes.checked_add(row_bytes).ok_or_else(|| {
            ManagedError::internal("snapshot_page_size_overflow", "Snapshot page is too large")
        })?;
        rows.push(row);
    }
    let next_offset = offset
        .checked_add(rows.len() as i64)
        .ok_or_else(|| ManagedError::internal("snapshot_offset_overflow", "Offset overflow"))?;
    SnapshotPage::new(SnapshotPageBody {
        manifest_hash: manifest.manifest_hash.clone(),
        table_index,
        table: spec.name.to_string(),
        offset,
        next_offset,
        rows,
    })
}

pub fn validate_restore_page(
    manifest: &SnapshotManifest,
    page: &SnapshotPage,
    expected_table_index: usize,
    expected_offset: i64,
) -> ManagedResult<()> {
    manifest.verify()?;
    page.verify()?;
    if page.body.manifest_hash != manifest.manifest_hash {
        return Err(ManagedError::conflict(
            "restore_manifest_mismatch",
            "Restore page belongs to a different manifest",
        ));
    }
    let spec = TABLES.get(expected_table_index).ok_or_else(|| {
        ManagedError::conflict(
            "restore_already_complete",
            "Restore has no remaining tables",
        )
    })?;
    if page.body.table_index != expected_table_index
        || page.body.table != spec.name
        || page.body.offset != expected_offset
    {
        return Err(ManagedError::conflict(
            "restore_page_out_of_order",
            "Restore page does not match the next expected table and offset",
        ));
    }
    if page.body.rows.is_empty() {
        return Err(ManagedError::bad_request(
            "empty_restore_page",
            "Restore pages must contain at least one row",
        ));
    }
    if page.body.rows.len() > MAX_SNAPSHOT_ROWS {
        return Err(ManagedError::bad_request(
            "restore_page_row_limit_exceeded",
            "Restore pages may contain at most 250 rows",
        ));
    }
    if page
        .body
        .rows
        .iter()
        .any(|row| row.len() != spec.columns.len())
    {
        return Err(ManagedError::bad_request(
            "restore_row_shape_mismatch",
            "Restore row does not match the table schema",
        ));
    }
    for row in &page.body.rows {
        validate_row_values(spec, row)?;
    }
    let expected_next = expected_offset
        .checked_add(page.body.rows.len() as i64)
        .ok_or_else(|| ManagedError::internal("restore_offset_overflow", "Offset overflow"))?;
    let table_count = manifest.body.tables[expected_table_index].row_count;
    if page.body.next_offset != expected_next || expected_next > table_count {
        return Err(ManagedError::conflict(
            "restore_page_range_mismatch",
            "Restore page row range does not match the manifest",
        ));
    }
    Ok(())
}

pub fn insert_page(sql: &SqlStorage, page: &SnapshotPage) -> ManagedResult<()> {
    let spec = TABLES.get(page.body.table_index).ok_or_else(|| {
        ManagedError::bad_request("invalid_snapshot_table", "Snapshot table index is invalid")
    })?;
    let placeholders = std::iter::repeat_n("?", spec.columns.len())
        .collect::<Vec<_>>()
        .join(", ");
    let query = format!(
        "INSERT OR REPLACE INTO {} ({}) VALUES ({})",
        spec.name,
        spec.columns.join(", "),
        placeholders
    );
    let rows = page
        .body
        .rows
        .iter()
        .map(|row| {
            row.iter()
                .map(SnapshotValue::to_sql)
                .collect::<ManagedResult<Vec<_>>>()
        })
        .collect::<ManagedResult<Vec<_>>>()?;
    for bindings in rows {
        sql.exec(&query, bindings)?;
    }
    Ok(())
}

pub fn ensure_fresh_repository(sql: &SqlStorage) -> ManagedResult<()> {
    let mut counts = Vec::new();
    for table in TABLES
        .iter()
        .map(|spec| spec.name)
        .chain(DERIVED_TABLES.iter().copied())
        .chain(CACHE_TABLES.iter().copied())
    {
        counts.push(table_count(sql, table)?);
    }
    ensure_zero_counts(&counts)
}

pub fn clear_rebuildable_tables(sql: &SqlStorage) -> ManagedResult<()> {
    for table in DERIVED_TABLES.iter().chain(CACHE_TABLES.iter()) {
        sql.exec(&format!("DELETE FROM {}", table), None)?;
    }
    Ok(())
}

pub fn delete_repository_contents(sql: &SqlStorage) -> ManagedResult<()> {
    for table in [
        "managed_restore_pages",
        "managed_restore_journals",
        "issue_comments",
        "issues",
        "refs",
        "raw_objects",
        "blob_chunks",
        "blobs",
        "blob_groups",
        "trees",
        "commit_graph",
        "commit_parents",
        "commits",
        "config",
        "fts_head",
        "fts_commits",
        "package_build_cache",
        "package_npm_cache",
    ] {
        sql.exec(&format!("DELETE FROM {}", table), None)?;
    }
    sql.exec("DELETE FROM sqlite_sequence", None)?;
    Ok(())
}

pub fn validate_restored_counts(
    sql: &SqlStorage,
    manifest: &SnapshotManifest,
) -> ManagedResult<()> {
    for (spec, expected) in TABLES.iter().zip(&manifest.body.tables) {
        let actual = table_count(sql, spec.name)?;
        if actual != expected.row_count {
            return Err(ManagedError::conflict(
                "restore_row_count_mismatch",
                format!(
                    "Restored table {} contains {} rows; expected {}",
                    spec.name, actual, expected.row_count
                ),
            ));
        }
    }
    Ok(())
}

pub fn rebuild_derived_tables(sql: &SqlStorage) -> ManagedResult<()> {
    sql.exec("DELETE FROM commit_graph", None)?;
    sql.exec(
        "INSERT INTO commit_graph (commit_hash, level, ancestor_hash)
         SELECT commit_hash, 0, parent_hash FROM commit_parents WHERE ordinal = 0",
        None,
    )?;
    let mut level = 1_i64;
    loop {
        let previous = level - 1;
        let result = sql.exec(
            &format!(
                "INSERT INTO commit_graph (commit_hash, level, ancestor_hash)
                 SELECT graph.commit_hash, {}, ancestor.ancestor_hash
                 FROM commit_graph graph
                 JOIN commit_graph ancestor
                   ON ancestor.commit_hash = graph.ancestor_hash
                  AND ancestor.level = {}
                 WHERE graph.level = {}",
                level, previous, previous
            ),
            None,
        )?;
        if result.rows_written() == 0 {
            break;
        }
        level = level.checked_add(1).ok_or_else(|| {
            ManagedError::internal("commit_graph_depth_overflow", "Commit graph is too deep")
        })?;
    }

    sql.exec("DELETE FROM fts_commits", None)?;
    sql.exec(
        "INSERT INTO fts_commits (hash, message, author)
         SELECT hash, message, author FROM commits",
        None,
    )?;
    sql.exec("DELETE FROM fts_head", None)?;
    if let Some(default_ref) = store::get_config(sql, "default_branch")? {
        #[derive(Deserialize)]
        struct RefRow {
            commit_hash: String,
        }
        let refs: Vec<RefRow> = sql
            .exec(
                "SELECT commit_hash FROM refs WHERE name = ?",
                vec![SqlStorageValue::from(default_ref)],
            )?
            .to_array()?;
        if let Some(reference) = refs.first() {
            store::rebuild_fts_index(sql, &reference.commit_hash)?;
        }
    }
    Ok(())
}

pub fn next_restore_position(
    manifest: &SnapshotManifest,
    table_index: usize,
    offset: i64,
) -> ManagedResult<(usize, i64)> {
    let mut table_index = table_index;
    let mut offset = offset;
    while let Some(table) = manifest.body.tables.get(table_index) {
        if offset < table.row_count {
            break;
        }
        table_index += 1;
        offset = 0;
    }
    Ok((table_index, offset))
}

pub fn assert_replay_hash(existing: &str, supplied: &str) -> ManagedResult<()> {
    if existing != supplied {
        return Err(ManagedError::conflict(
            "restore_page_replay_mismatch",
            "A replayed restore page has different contents",
        ));
    }
    Ok(())
}

fn validate_repository_schema(sql: &SqlStorage) -> ManagedResult<()> {
    #[derive(Deserialize)]
    struct SchemaRow {
        name: String,
    }
    let rows: Vec<SchemaRow> = sql
        .exec(
            "SELECT name FROM sqlite_schema
             WHERE type IN ('table', 'view')
             ORDER BY name",
            None,
        )?
        .to_array()?;
    let allowed = TABLES
        .iter()
        .map(|spec| spec.name)
        .chain(DERIVED_TABLES.iter().copied())
        .chain(CACHE_TABLES.iter().copied())
        .chain(FTS_SHADOW_TABLES.iter().copied())
        .chain(MANAGED_TABLES.iter().copied())
        .chain(["sqlite_sequence"])
        .collect::<BTreeSet<_>>();
    let unknown = rows
        .into_iter()
        .map(|row| row.name)
        .filter(|name| !allowed.contains(name.as_str()) && !name.starts_with("sqlite_"))
        .collect::<Vec<_>>();
    if !unknown.is_empty() {
        return Err(ManagedError::conflict(
            "unsupported_repository_schema",
            format!(
                "Repository has tables not supported by snapshot format {}: {}",
                SNAPSHOT_FORMAT,
                unknown.join(", ")
            ),
        ));
    }

    #[derive(Deserialize)]
    struct ColumnRow {
        name: String,
        #[serde(rename = "type")]
        declared_type: String,
    }
    for spec in TABLES {
        let columns: Vec<ColumnRow> = sql
            .exec(&format!("PRAGMA table_info({})", spec.name), None)?
            .to_array()?;
        let actual = columns
            .into_iter()
            .map(|column| (column.name, column.declared_type))
            .collect::<Vec<_>>();
        let expected = spec
            .columns
            .iter()
            .zip(spec.column_types)
            .map(|(column, declared_type)| (column.to_string(), declared_type.to_string()))
            .collect::<Vec<_>>();
        if actual != expected {
            return Err(ManagedError::conflict(
                "unsupported_repository_schema",
                format!(
                    "Repository table {} has an unsupported column layout",
                    spec.name
                ),
            ));
        }
    }
    Ok(())
}

fn validate_row_values(spec: &TableSpec, row: &[SnapshotValue]) -> ManagedResult<()> {
    for ((column, declared_type), value) in spec
        .columns
        .iter()
        .zip(spec.column_types.iter().copied())
        .zip(row)
    {
        let valid = match (declared_type, value) {
            (_, SnapshotValue::Null) => true,
            ("INTEGER", SnapshotValue::Integer(value)) => parse_snapshot_integer(value)
                .is_ok_and(|value| value.abs_diff(0) <= MAX_SAFE_SQL_INTEGER as u64),
            ("TEXT", SnapshotValue::String(_)) => true,
            ("BLOB", SnapshotValue::BlobBase64(value)) => decode_snapshot_blob(value).is_ok(),
            _ => false,
        };
        if !valid {
            return Err(ManagedError::conflict(
                "unsupported_snapshot_value",
                format!(
                    "Snapshot value for {}.{} cannot be represented losslessly by format {}",
                    spec.name, column, SNAPSHOT_FORMAT
                ),
            ));
        }
    }
    Ok(())
}

fn validate_manifest_shape(body: &SnapshotManifestBody) -> ManagedResult<()> {
    let expected_derived = DERIVED_TABLES
        .iter()
        .map(|value| value.to_string())
        .collect::<Vec<_>>();
    let expected_caches = CACHE_TABLES
        .iter()
        .map(|value| value.to_string())
        .collect::<Vec<_>>();
    if body.format != SNAPSHOT_FORMAT
        || body.source_epoch < 0
        || body.source_epoch > MAX_SAFE_SQL_INTEGER
        || body.tables.len() != TABLES.len()
        || body.rebuilt_derived_tables != expected_derived
        || body.excluded_cache_tables != expected_caches
    {
        return Err(ManagedError::conflict(
            "unsupported_snapshot_format",
            "Snapshot manifest format is not supported by this ripgit worker",
        ));
    }
    body.identity.validate()?;
    let mut total_rows = 0_i64;
    for (actual, expected) in body.tables.iter().zip(TABLES) {
        let columns = expected
            .columns
            .iter()
            .map(|column| column.to_string())
            .collect::<Vec<_>>();
        let column_types = expected
            .column_types
            .iter()
            .map(|column_type| column_type.to_string())
            .collect::<Vec<_>>();
        if actual.name != expected.name
            || actual.columns != columns
            || actual.column_types != column_types
            || actual.row_count < 0
            || actual.row_count > MAX_SAFE_SQL_INTEGER
        {
            return Err(ManagedError::conflict(
                "unsupported_snapshot_format",
                "Snapshot manifest table layout is not supported",
            ));
        }
        total_rows = total_rows
            .checked_add(actual.row_count)
            .filter(|count| *count <= MAX_SAFE_SQL_INTEGER)
            .ok_or_else(|| {
                ManagedError::conflict(
                    "unsupported_snapshot_format",
                    "Snapshot manifest total row count exceeds the cross-runtime safe range",
                )
            })?;
    }
    Ok(())
}

fn table_count(sql: &SqlStorage, table: &str) -> ManagedResult<i64> {
    #[derive(Deserialize)]
    struct CountRow {
        count: i64,
    }
    let row: CountRow = sql
        .exec(&format!("SELECT COUNT(*) AS count FROM {}", table), None)?
        .one()?;
    Ok(row.count)
}

fn ensure_zero_counts(counts: &[i64]) -> ManagedResult<()> {
    if counts.iter().any(|count| *count != 0) {
        return Err(ManagedError::conflict(
            "restore_target_not_empty",
            "Restore target already contains repository data",
        ));
    }
    Ok(())
}

fn invalid_value(message: &str) -> ManagedError {
    ManagedError::bad_request("invalid_snapshot_value", message)
}

fn parse_snapshot_integer(value: &str) -> ManagedResult<i64> {
    let digits = value.strip_prefix('-').unwrap_or(value);
    let canonical = value == "0"
        || (!digits.is_empty()
            && !digits.starts_with('0')
            && digits.bytes().all(|byte| byte.is_ascii_digit()));
    if !canonical {
        return Err(invalid_value("Snapshot integer is invalid"));
    }
    value
        .parse::<i64>()
        .map_err(|_| invalid_value("Snapshot integer is invalid"))
}

fn decode_snapshot_blob(value: &str) -> ManagedResult<Vec<u8>> {
    let decoded = BASE64
        .decode(value)
        .map_err(|_| invalid_value("Snapshot blob encoding is invalid"))?;
    if BASE64.encode(&decoded) != value {
        return Err(invalid_value("Snapshot blob encoding is invalid"));
    }
    Ok(decoded)
}

fn hash_json<T: Serialize>(value: &T) -> ManagedResult<String> {
    let bytes = serde_json::to_vec(value).map_err(ManagedError::from)?;
    let digest = Sha256::digest(bytes);
    Ok(digest.iter().map(|byte| format!("{:02x}", byte)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct GoldenSnapshotFixture {
        manifest: SnapshotManifest,
        page: SnapshotPage,
    }

    fn manifest() -> SnapshotManifest {
        let identity = SnapshotRepositoryIdentity {
            owner: "alice".to_string(),
            repo: "memory".to_string(),
        };
        SnapshotManifest::new(SnapshotManifestBody {
            format: SNAPSHOT_FORMAT.to_string(),
            identity,
            source_epoch: 9,
            tables: TABLES
                .iter()
                .map(|spec| SnapshotTable {
                    name: spec.name.to_string(),
                    columns: spec.columns.iter().map(|value| value.to_string()).collect(),
                    column_types: spec
                        .column_types
                        .iter()
                        .map(|value| value.to_string())
                        .collect(),
                    row_count: i64::from(spec.name == "refs"),
                })
                .collect(),
            rebuilt_derived_tables: DERIVED_TABLES
                .iter()
                .map(|value| value.to_string())
                .collect(),
            excluded_cache_tables: CACHE_TABLES.iter().map(|value| value.to_string()).collect(),
        })
        .unwrap()
    }

    #[test]
    fn manifest_hash_binds_snapshot_epoch_and_counts() {
        let original = manifest();
        original.verify().unwrap();
        let mut changed = original.clone();
        changed.body.source_epoch += 1;
        assert_eq!(
            changed.verify().unwrap_err().code,
            "snapshot_manifest_hash_mismatch"
        );
        let mut changed = original.clone();
        changed.body.tables[0].row_count += 1;
        assert!(changed.verify().is_err());
    }

    #[test]
    fn manifest_epochs_and_counts_stay_in_the_cross_runtime_safe_range() {
        let original = manifest();
        let mut body = original.body.clone();
        body.source_epoch = MAX_SAFE_SQL_INTEGER + 1;
        assert_eq!(
            SnapshotManifest::new(body).unwrap_err().code,
            "unsupported_snapshot_format"
        );

        let mut body = original.body.clone();
        body.tables[0].row_count = MAX_SAFE_SQL_INTEGER + 1;
        assert_eq!(
            SnapshotManifest::new(body).unwrap_err().code,
            "unsupported_snapshot_format"
        );

        let mut body = original.body;
        body.tables[0].row_count = MAX_SAFE_SQL_INTEGER;
        body.tables[1].row_count = 1;
        assert_eq!(
            SnapshotManifest::new(body).unwrap_err().code,
            "unsupported_snapshot_format"
        );
    }

    #[test]
    fn public_typescript_golden_matches_rust_snapshot_hashes() {
        let fixture: GoldenSnapshotFixture = serde_json::from_str(include_str!(
            "../../../packages/portable-archive/test/fixtures/ripgit-v1.json"
        ))
        .unwrap();
        assert_eq!(
            fixture.manifest.manifest_hash,
            "c7c4dbf5d0236e56df800c0ba6083150ba0b0d418be4ef591b8d6552f8da9b10"
        );
        assert_eq!(
            fixture.page.page_hash,
            "74c82318ea5b3780970a9bb05f69ce79ceab2a6639e9f89019bc4dccef5f7de8"
        );
        fixture.manifest.verify().unwrap();
        fixture.page.verify().unwrap();
        validate_restore_page(&fixture.manifest, &fixture.page, 5, 0).unwrap();
    }

    #[test]
    fn portable_snapshot_identity_denies_provider_ids() {
        let identity = serde_json::from_str::<SnapshotRepositoryIdentity>(
            r#"{"owner":"alice","repo":"memory","providerId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#,
        );
        assert!(identity.is_err());
    }

    #[test]
    fn restore_pages_enforce_the_public_row_limit() {
        let original = manifest();
        let mut body = original.body;
        body.tables[0].row_count = (MAX_SNAPSHOT_ROWS + 1) as i64;
        let manifest = SnapshotManifest::new(body).unwrap();
        let row = vec![
            SnapshotValue::String("key".to_string()),
            SnapshotValue::String("value".to_string()),
        ];
        let page = SnapshotPage::new(SnapshotPageBody {
            manifest_hash: manifest.manifest_hash.clone(),
            table_index: 0,
            table: "config".to_string(),
            offset: 0,
            next_offset: (MAX_SNAPSHOT_ROWS + 1) as i64,
            rows: vec![row; MAX_SNAPSHOT_ROWS + 1],
        })
        .unwrap();
        assert_eq!(
            validate_restore_page(&manifest, &page, 0, 0)
                .unwrap_err()
                .code,
            "restore_page_row_limit_exceeded"
        );
    }

    #[test]
    fn replay_requires_the_exact_page_hash() {
        assert_replay_hash(&"a".repeat(64), &"a".repeat(64)).unwrap();
        assert_eq!(
            assert_replay_hash(&"a".repeat(64), &"b".repeat(64))
                .unwrap_err()
                .code,
            "restore_page_replay_mismatch"
        );
    }

    #[test]
    fn nonempty_restore_targets_are_rejected() {
        ensure_zero_counts(&[0, 0, 0]).unwrap();
        assert_eq!(
            ensure_zero_counts(&[0, 1, 0]).unwrap_err().code,
            "restore_target_not_empty"
        );
    }

    #[test]
    fn snapshot_values_preserve_integer_float_and_blob_bits() {
        let values = [
            SqlStorageValue::Integer(MAX_SAFE_SQL_INTEGER),
            SqlStorageValue::Float(f64::from_bits(0x7ff8_0000_0000_0001)),
            SqlStorageValue::Blob(vec![0, 1, 254, 255]),
        ];
        for value in values {
            let encoded = SnapshotValue::from_sql(value.clone());
            let decoded = encoded.to_sql().unwrap();
            match (decoded, value) {
                (SqlStorageValue::Float(actual), SqlStorageValue::Float(expected)) => {
                    assert_eq!(actual.to_bits(), expected.to_bits());
                }
                (actual, expected) => assert_eq!(actual, expected),
            }
        }
    }

    #[test]
    fn snapshot_numeric_strings_are_canonical() {
        for invalid in ["+1", "01", "-0"] {
            assert_eq!(
                SnapshotValue::Integer(invalid.to_string())
                    .to_sql()
                    .unwrap_err()
                    .code,
                "invalid_snapshot_value"
            );
        }
        for invalid in ["1", "000000000000000A", "+0000000000000001"] {
            assert_eq!(
                SnapshotValue::FloatBits(invalid.to_string())
                    .to_sql()
                    .unwrap_err()
                    .code,
                "invalid_snapshot_value"
            );
        }
        SnapshotValue::Integer("-1".to_string()).to_sql().unwrap();
        SnapshotValue::FloatBits("000000000000000a".to_string())
            .to_sql()
            .unwrap();
    }

    #[test]
    fn snapshot_blobs_require_canonical_padded_base64() {
        SnapshotValue::BlobBase64("AAH+/w==".to_string())
            .to_sql()
            .unwrap();
        for invalid in ["AAH-_w", "AAH+/w", "AB=="] {
            assert_eq!(
                SnapshotValue::BlobBase64(invalid.to_string())
                    .to_sql()
                    .unwrap_err()
                    .code,
                "invalid_snapshot_value"
            );
        }
    }

    #[test]
    fn table_values_fail_closed_outside_the_exact_v1_types() {
        let config = &TABLES[0];
        validate_row_values(
            config,
            &[
                SnapshotValue::String("key".to_string()),
                SnapshotValue::String("value".to_string()),
            ],
        )
        .unwrap();
        assert_eq!(
            validate_row_values(
                config,
                &[
                    SnapshotValue::Integer("1".to_string()),
                    SnapshotValue::String("value".to_string()),
                ],
            )
            .unwrap_err()
            .code,
            "unsupported_snapshot_value"
        );

        let blob_groups = &TABLES[1];
        assert_eq!(
            validate_row_values(
                blob_groups,
                &[
                    SnapshotValue::Integer(i64::MAX.to_string()),
                    SnapshotValue::Null,
                    SnapshotValue::Integer("0".to_string()),
                ],
            )
            .unwrap_err()
            .code,
            "unsupported_snapshot_value"
        );
    }
}
