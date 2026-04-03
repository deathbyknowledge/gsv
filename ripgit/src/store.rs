//! Storage layer: parsing and persisting git objects into SQLite,
//! with xpatch delta compression for blobs.

use crate::pack;
use std::collections::{HashMap, HashSet, VecDeque};
use worker::*;

pub const ZERO_HASH: &str = "0000000000000000000000000000000000000000";

/// Cloudflare DO SQLite limit: 2 MB per row. We stay safely under it.
const MAX_BLOB_ROW_SIZE: usize = 1_900_000;

/// Blobs larger than this skip zlib/xpatch and are stored raw + chunked.
/// Keeps peak memory well within the 128 MB DO limit (pack body + raw blob
/// + working memory must all fit). 50 MB is conservative.
const MAX_COMPRESS_SIZE: usize = 50_000_000;

// ---------------------------------------------------------------------------
// Parsed types
// ---------------------------------------------------------------------------

pub struct ParsedCommit {
    pub tree_hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub author_email: String,
    pub author_time: i64,
    pub committer: String,
    pub committer_email: String,
    pub commit_time: i64,
    pub message: String,
}

pub struct TreeEntry {
    pub mode: u32,
    pub name: String,
    pub hash: String, // 40-char hex SHA-1
}

// ---------------------------------------------------------------------------
// Object parsing
// ---------------------------------------------------------------------------

/// Parse a git commit object's raw data into structured fields.
///
/// Format:
///   tree <hex>\n
///   parent <hex>\n        (zero or more)
///   author <name> <<email>> <ts> <tz>\n
///   committer <name> <<email>> <ts> <tz>\n
///   \n
///   <message>
pub fn parse_commit(data: &[u8]) -> std::result::Result<ParsedCommit, String> {
    // Lossy conversion: old commits may use Latin-1 or other encodings for
    // author names. The raw bytes are preserved in raw_objects for fetch;
    // we only need displayable strings for the parsed commits table.
    let text = String::from_utf8_lossy(data).into_owned();

    let mut tree_hash = String::new();
    let mut parents = Vec::new();
    let mut author = String::new();
    let mut author_email = String::new();
    let mut author_time: i64 = 0;
    let mut committer = String::new();
    let mut committer_email = String::new();
    let mut commit_time: i64 = 0;

    // Split at the first blank line: headers vs message body
    let (header_block, message) = match text.find("\n\n") {
        Some(pos) => (&text[..pos], text[pos + 2..].to_string()),
        None => (text.as_str(), String::new()),
    };

    for line in header_block.lines() {
        if let Some(hash) = line.strip_prefix("tree ") {
            tree_hash = hash.to_string();
        } else if let Some(hash) = line.strip_prefix("parent ") {
            parents.push(hash.to_string());
        } else if let Some(rest) = line.strip_prefix("author ") {
            let (name, email, time) = parse_identity(rest)?;
            author = name;
            author_email = email;
            author_time = time;
        } else if let Some(rest) = line.strip_prefix("committer ") {
            let (name, email, time) = parse_identity(rest)?;
            committer = name;
            committer_email = email;
            commit_time = time;
        }
        // gpgsig, mergetag, etc. are silently ignored
    }

    if tree_hash.is_empty() {
        return Err("commit missing tree header".into());
    }

    Ok(ParsedCommit {
        tree_hash,
        parents,
        author,
        author_email,
        author_time,
        committer,
        committer_email,
        commit_time,
        message,
    })
}

/// Parse an identity line: "Name <email> timestamp timezone"
fn parse_identity(s: &str) -> std::result::Result<(String, String, i64), String> {
    // Work backwards: timezone is last token, timestamp is second-to-last,
    // everything before that is "name <email>"
    let parts: Vec<&str> = s.rsplitn(3, ' ').collect();
    if parts.len() < 3 {
        return Err(format!("malformed identity: {}", s));
    }
    let _timezone = parts[0];
    let timestamp: i64 = parts[1]
        .parse()
        .map_err(|e| format!("bad timestamp: {}", e))?;
    let name_email = parts[2];

    // Split "Name <email>" at the last '<'
    let (name, email) = match name_email.rfind('<') {
        Some(pos) => {
            let name = name_email[..pos].trim().to_string();
            let email = name_email[pos + 1..]
                .trim_end_matches('>')
                .trim()
                .to_string();
            (name, email)
        }
        None => (name_email.to_string(), String::new()),
    };

    Ok((name, email, timestamp))
}

/// Parse a git tree object's binary data into entries.
///
/// Binary format (repeated):
///   <mode-ascii-digits> SP <name> NUL <20-byte-raw-hash>
pub fn parse_tree_data(data: &[u8]) -> std::result::Result<Vec<TreeEntry>, String> {
    let mut entries = Vec::new();
    let mut pos = 0;

    while pos < data.len() {
        // Mode: ASCII digits until space
        let space_pos = data[pos..]
            .iter()
            .position(|&b| b == b' ')
            .ok_or("tree: missing space after mode")?;
        let mode_str = std::str::from_utf8(&data[pos..pos + space_pos])
            .map_err(|e| format!("tree mode: {}", e))?;
        let mode =
            u32::from_str_radix(mode_str, 8).map_err(|e| format!("tree mode parse: {}", e))?;
        pos += space_pos + 1;

        // Name: bytes until NUL
        let nul_pos = data[pos..]
            .iter()
            .position(|&b| b == 0)
            .ok_or("tree: missing NUL after name")?;
        let name = String::from_utf8_lossy(&data[pos..pos + nul_pos]);
        pos += nul_pos + 1;

        // 20-byte raw SHA-1
        if pos + 20 > data.len() {
            return Err("tree: truncated hash".into());
        }
        let hash = pack::hex_encode(&data[pos..pos + 20]);
        pos += 20;

        entries.push(TreeEntry {
            mode,
            name: name.to_string(),
            hash,
        });
    }

    Ok(entries)
}

// ---------------------------------------------------------------------------
// Object storage
// ---------------------------------------------------------------------------

/// Store a parsed commit, its parent edges, and the raw object bytes.
/// Skips if already stored. When `bulk_mode` is true, skips commit graph
/// building and fts_commits indexing (rebuild via admin endpoints after).
pub fn store_commit(
    sql: &SqlStorage,
    hash: &str,
    c: &ParsedCommit,
    raw_data: &[u8],
    bulk_mode: bool,
) -> Result<()> {
    // Fast existence check: indexed PK lookup, single row
    #[derive(serde::Deserialize)]
    #[allow(dead_code)]
    struct Exists {
        x: i64,
    }
    let exists: Vec<Exists> = sql
        .exec(
            "SELECT 1 AS x FROM commits WHERE hash = ? LIMIT 1",
            vec![SqlStorageValue::from(hash.to_string())],
        )?
        .to_array()?;
    if !exists.is_empty() {
        return Ok(());
    }

    sql.exec(
        "INSERT INTO commits
            (hash, tree_hash, author, author_email, author_time,
             committer, committer_email, commit_time, message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        vec![
            SqlStorageValue::from(hash.to_string()),
            SqlStorageValue::from(c.tree_hash.clone()),
            SqlStorageValue::from(c.author.clone()),
            SqlStorageValue::from(c.author_email.clone()),
            SqlStorageValue::from(c.author_time),
            SqlStorageValue::from(c.committer.clone()),
            SqlStorageValue::from(c.committer_email.clone()),
            SqlStorageValue::from(c.commit_time),
            SqlStorageValue::from(c.message.clone()),
        ],
    )?;

    // Batch parent inserts: up to 33 parents per statement (3 params each, 100 max)
    for chunk in c.parents.chunks(33) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "(?, ?, ?)").collect();
        let sql_str = format!(
            "INSERT INTO commit_parents (commit_hash, parent_hash, ordinal) VALUES {}",
            placeholders.join(", ")
        );
        let mut params = Vec::new();
        for (i, parent) in chunk.iter().enumerate() {
            params.push(SqlStorageValue::from(hash.to_string()));
            params.push(SqlStorageValue::from(parent.clone()));
            params.push(SqlStorageValue::from(i as i64));
        }
        sql.exec(&sql_str, params)?;
    }

    // Store raw bytes for byte-identical fetch
    store_raw_object(sql, hash, raw_data)?;

    if !bulk_mode {
        // Build binary lifting table
        build_commit_graph(sql, hash, c.parents.first().map(|s| s.as_str()))?;

        // Index commit message for FTS search
        sql.exec(
            "INSERT OR IGNORE INTO fts_commits (hash, message, author) VALUES (?, ?, ?)",
            vec![
                SqlStorageValue::from(hash.to_string()),
                SqlStorageValue::from(c.message.clone()),
                SqlStorageValue::from(c.author.clone()),
            ],
        )?;
    }

    Ok(())
}

/// Load raw object bytes for fetch.
fn load_raw_object(sql: &SqlStorage, hash: &str) -> Result<Option<Vec<u8>>> {
    #[derive(serde::Deserialize)]
    struct Row {
        #[serde(with = "serde_bytes")]
        data: Vec<u8>,
    }
    let rows: Vec<Row> = sql
        .exec(
            "SELECT data FROM raw_objects WHERE hash = ?",
            vec![SqlStorageValue::from(hash.to_string())],
        )?
        .to_array()?;
    Ok(rows.into_iter().next().map(|r| r.data))
}

/// Load raw object bytes — public wrapper for thin pack resolution.
pub fn load_raw_object_pub(sql: &SqlStorage, hash: &str) -> Result<Option<Vec<u8>>> {
    load_raw_object(sql, hash)
}

/// Reconstruct a blob by hash for thin pack resolution. Looks up the blob's
/// group and version, then reconstructs from the delta chain.
/// Returns None if the hash isn't in the blobs table.
pub fn reconstruct_blob_by_hash(sql: &SqlStorage, hash: &str) -> Result<Option<Vec<u8>>> {
    #[derive(serde::Deserialize)]
    struct BlobInfo {
        group_id: i64,
        version_in_group: i64,
    }
    let rows: Vec<BlobInfo> = sql
        .exec(
            "SELECT group_id, version_in_group FROM blobs WHERE blob_hash = ? LIMIT 1",
            vec![SqlStorageValue::from(hash.to_string())],
        )?
        .to_array()?;
    match rows.into_iter().next() {
        Some(info) => Ok(Some(reconstruct_blob(
            sql,
            info.group_id,
            info.version_in_group,
        )?)),
        None => Ok(None),
    }
}

/// Detect the git object type by checking which table contains the hash.
/// More reliable than parsing raw bytes (which can have edge cases).
pub fn detect_object_type(sql: &SqlStorage, hash: &str) -> crate::pack::ObjectType {
    #[derive(serde::Deserialize)]
    #[allow(dead_code)]
    struct Exists {
        x: i64,
    }

    let in_commits: bool = sql
        .exec(
            "SELECT 1 AS x FROM commits WHERE hash = ? LIMIT 1",
            vec![SqlStorageValue::from(hash.to_string())],
        )
        .map(|c| {
            c.to_array::<Exists>()
                .map(|r| !r.is_empty())
                .unwrap_or(false)
        })
        .unwrap_or(false);
    if in_commits {
        return crate::pack::ObjectType::Commit;
    }

    let in_trees: bool = sql
        .exec(
            "SELECT 1 AS x FROM trees WHERE tree_hash = ? LIMIT 1",
            vec![SqlStorageValue::from(hash.to_string())],
        )
        .map(|c| {
            c.to_array::<Exists>()
                .map(|r| !r.is_empty())
                .unwrap_or(false)
        })
        .unwrap_or(false);
    if in_trees {
        return crate::pack::ObjectType::Tree;
    }

    // Blobs aren't stored in raw_objects, but default to Blob as fallback
    crate::pack::ObjectType::Blob
}

/// Store raw object bytes (for commits and trees) so we can return them
/// byte-for-byte identical during fetch.
fn store_raw_object(sql: &SqlStorage, hash: &str, data: &[u8]) -> Result<()> {
    sql.exec(
        "INSERT OR IGNORE INTO raw_objects (hash, data) VALUES (?, ?)",
        vec![
            SqlStorageValue::from(hash.to_string()),
            SqlStorageValue::Blob(data.to_vec()),
        ],
    )?;
    Ok(())
}

/// Populate the binary lifting table for O(log N) ancestor queries.
///
/// Level 0 = first parent.
/// Level k = the level k-1 ancestor of the level k-1 ancestor.
fn build_commit_graph(
    sql: &SqlStorage,
    commit_hash: &str,
    first_parent: Option<&str>,
) -> Result<()> {
    let parent = match first_parent {
        Some(p) => p,
        None => return Ok(()), // root commit, no ancestors
    };

    // Level 0: direct parent
    sql.exec(
        "INSERT OR IGNORE INTO commit_graph (commit_hash, level, ancestor_hash)
         VALUES (?, 0, ?)",
        vec![
            SqlStorageValue::from(commit_hash.to_string()),
            SqlStorageValue::from(parent.to_string()),
        ],
    )?;

    // Higher levels: the level k-1 ancestor of our level k-1 ancestor
    #[derive(serde::Deserialize)]
    struct Ancestor {
        ancestor_hash: String,
    }

    let mut level = 1;
    let mut prev_ancestor = parent.to_string();

    loop {
        // Look up prev_ancestor's level-1 entry
        let rows: Vec<Ancestor> = sql
            .exec(
                "SELECT ancestor_hash FROM commit_graph
                 WHERE commit_hash = ? AND level = ?",
                vec![
                    SqlStorageValue::from(prev_ancestor.clone()),
                    SqlStorageValue::from(level - 1),
                ],
            )?
            .to_array()?;

        match rows.first() {
            Some(row) => {
                sql.exec(
                    "INSERT OR IGNORE INTO commit_graph (commit_hash, level, ancestor_hash)
                     VALUES (?, ?, ?)",
                    vec![
                        SqlStorageValue::from(commit_hash.to_string()),
                        SqlStorageValue::from(level),
                        SqlStorageValue::from(row.ancestor_hash.clone()),
                    ],
                )?;
                prev_ancestor = row.ancestor_hash.clone();
                level += 1;
            }
            None => break, // no more ancestors at this depth
        }
    }

    Ok(())
}

/// Store tree entries. Skips if tree already exists.
pub fn store_tree(sql: &SqlStorage, tree_hash: &str, data: &[u8]) -> Result<()> {
    // Fast existence check: indexed PK lookup, single row
    #[derive(serde::Deserialize)]
    #[allow(dead_code)]
    struct Exists {
        x: i64,
    }
    let exists: Vec<Exists> = sql
        .exec(
            "SELECT 1 AS x FROM trees WHERE tree_hash = ? LIMIT 1",
            vec![SqlStorageValue::from(tree_hash.to_string())],
        )?
        .to_array()?;
    if !exists.is_empty() {
        return Ok(());
    }

    let entries = parse_tree_data(data).map_err(|e| Error::RustError(e))?;

    // Batch INSERTs: 25 entries per statement (4 params each, 100 max)
    for chunk in entries.chunks(25) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "(?, ?, ?, ?)").collect();
        let sql_str = format!(
            "INSERT OR IGNORE INTO trees (tree_hash, name, mode, entry_hash) VALUES {}",
            placeholders.join(", ")
        );
        let mut params = Vec::new();
        for entry in chunk {
            params.push(SqlStorageValue::from(tree_hash.to_string()));
            params.push(SqlStorageValue::from(entry.name.clone()));
            params.push(SqlStorageValue::from(entry.mode as i64));
            params.push(SqlStorageValue::from(entry.hash.clone()));
        }
        sql.exec(&sql_str, params)?;
    }

    // Store raw bytes for byte-identical fetch
    store_raw_object(sql, tree_hash, data)?;

    Ok(())
}

/// Store a blob with xpatch delta compression. Groups blobs by path for
/// good delta ratios (same file across commits shares a group).
pub fn store_blob(
    sql: &SqlStorage,
    hash: &str,
    raw_data: &[u8],
    path: &str,
    keyframe_interval: i64,
) -> Result<()> {
    // Fast existence check: indexed PK lookup
    #[derive(serde::Deserialize)]
    #[allow(dead_code)]
    struct Exists {
        x: i64,
    }
    let exists: Vec<Exists> = sql
        .exec(
            "SELECT 1 AS x FROM blobs WHERE blob_hash = ? LIMIT 1",
            vec![SqlStorageValue::from(hash.to_string())],
        )?
        .to_array()?;
    if !exists.is_empty() {
        return Ok(());
    }

    // Find or create a blob group for this path
    #[derive(serde::Deserialize)]
    struct GroupRow {
        group_id: i64,
        latest_version: i64,
    }

    let groups: Vec<GroupRow> = sql
        .exec(
            "SELECT group_id, latest_version FROM blob_groups
             WHERE path_hint = ? LIMIT 1",
            vec![SqlStorageValue::from(path.to_string())],
        )?
        .to_array()?;

    let (group_id, latest_version) = if let Some(g) = groups.first() {
        (g.group_id, g.latest_version)
    } else {
        sql.exec(
            "INSERT INTO blob_groups (path_hint, latest_version) VALUES (?, 0)",
            vec![SqlStorageValue::from(path.to_string())],
        )?;
        // Get the auto-incremented id
        #[derive(serde::Deserialize)]
        struct LastId {
            id: i64,
        }
        let row: LastId = sql.exec("SELECT last_insert_rowid() AS id", None)?.one()?;
        (row.id, 0i64)
    };

    let new_version = latest_version + 1;

    // Large blobs: store raw + chunked, no compression. Avoids OOM from
    // zlib/xpatch needing 2x blob size in memory. is_keyframe=2 marks raw.
    if raw_data.len() > MAX_COMPRESS_SIZE {
        let raw_len = raw_data.len() as i64;
        sql.exec(
            "INSERT INTO blobs
                (blob_hash, group_id, version_in_group, is_keyframe, data, raw_size, stored_size)
             VALUES (?, ?, ?, 2, ?, ?, ?)",
            vec![
                SqlStorageValue::from(hash.to_string()),
                SqlStorageValue::from(group_id),
                SqlStorageValue::from(new_version),
                SqlStorageValue::Blob(Vec::new()), // empty sentinel — data in chunks
                SqlStorageValue::from(raw_len),
                SqlStorageValue::from(raw_len),
            ],
        )?;
        for (i, chunk) in raw_data.chunks(MAX_BLOB_ROW_SIZE).enumerate() {
            sql.exec(
                "INSERT INTO blob_chunks
                    (group_id, version_in_group, chunk_index, data)
                 VALUES (?, ?, ?, ?)",
                vec![
                    SqlStorageValue::from(group_id),
                    SqlStorageValue::from(new_version),
                    SqlStorageValue::from(i as i64),
                    SqlStorageValue::Blob(chunk.to_vec()),
                ],
            )?;
        }
        sql.exec(
            "UPDATE blob_groups SET latest_version = ? WHERE group_id = ?",
            vec![
                SqlStorageValue::from(new_version),
                SqlStorageValue::from(group_id),
            ],
        )?;
        return Ok(());
    }

    let is_keyframe = new_version == 1 || (new_version % keyframe_interval == 1);

    let stored_data = if is_keyframe {
        // Compress keyframes with zlib to reduce storage and stay under
        // the 2 MB per-row DO SQLite limit for most files.
        blob_zlib_compress(raw_data)
    } else {
        // Reconstruct the latest version and delta-encode against it.
        // Deltas are already compact (xpatch uses zstd internally).
        let prev = reconstruct_blob(sql, group_id, latest_version)?;
        xpatch::delta::encode(0, &prev, raw_data, true)
    };

    let stored_len = stored_data.len() as i64;

    if stored_data.len() <= MAX_BLOB_ROW_SIZE {
        // Fits in a single row
        sql.exec(
            "INSERT INTO blobs
                (blob_hash, group_id, version_in_group, is_keyframe, data, raw_size, stored_size)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            vec![
                SqlStorageValue::from(hash.to_string()),
                SqlStorageValue::from(group_id),
                SqlStorageValue::from(new_version),
                SqlStorageValue::from(if is_keyframe { 1i64 } else { 0i64 }),
                SqlStorageValue::Blob(stored_data),
                SqlStorageValue::from(raw_data.len() as i64),
                SqlStorageValue::from(stored_len),
            ],
        )?;
    } else {
        // Too large for one row even after compression — store empty
        // sentinel in blobs and actual data in blob_chunks.
        sql.exec(
            "INSERT INTO blobs
                (blob_hash, group_id, version_in_group, is_keyframe, data, raw_size, stored_size)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            vec![
                SqlStorageValue::from(hash.to_string()),
                SqlStorageValue::from(group_id),
                SqlStorageValue::from(new_version),
                SqlStorageValue::from(if is_keyframe { 1i64 } else { 0i64 }),
                SqlStorageValue::Blob(Vec::new()), // empty sentinel
                SqlStorageValue::from(raw_data.len() as i64),
                SqlStorageValue::from(stored_len),
            ],
        )?;
        for (i, chunk) in stored_data.chunks(MAX_BLOB_ROW_SIZE).enumerate() {
            sql.exec(
                "INSERT INTO blob_chunks
                    (group_id, version_in_group, chunk_index, data)
                 VALUES (?, ?, ?, ?)",
                vec![
                    SqlStorageValue::from(group_id),
                    SqlStorageValue::from(new_version),
                    SqlStorageValue::from(i as i64),
                    SqlStorageValue::Blob(chunk.to_vec()),
                ],
            )?;
        }
    }

    sql.exec(
        "UPDATE blob_groups SET latest_version = ? WHERE group_id = ?",
        vec![
            SqlStorageValue::from(new_version),
            SqlStorageValue::from(group_id),
        ],
    )?;

    Ok(())
}

/// Reconstruct a blob from its delta chain within a group.
pub fn reconstruct_blob(sql: &SqlStorage, group_id: i64, target_version: i64) -> Result<Vec<u8>> {
    #[derive(serde::Deserialize)]
    struct BlobRow {
        version_in_group: i64,
        #[serde(with = "serde_bytes")]
        data: Vec<u8>,
    }

    // Check if the target version is a raw keyframe (is_keyframe=2).
    // These are large blobs stored without compression — return directly.
    #[derive(serde::Deserialize)]
    struct KeyframeInfo {
        version_in_group: i64,
        is_keyframe: i64,
        #[serde(with = "serde_bytes")]
        data: Vec<u8>,
    }

    // Find nearest keyframe (is_keyframe IN (1,2))
    let mut keyframes: Vec<KeyframeInfo> = sql
        .exec(
            "SELECT version_in_group, is_keyframe, data FROM blobs
             WHERE group_id = ? AND version_in_group <= ? AND is_keyframe >= 1
             ORDER BY version_in_group DESC LIMIT 1",
            vec![
                SqlStorageValue::from(group_id),
                SqlStorageValue::from(target_version),
            ],
        )?
        .to_array()?;

    let keyframe = keyframes
        .pop()
        .ok_or_else(|| Error::RustError("no keyframe found in blob group".into()))?;

    let keyframe_version = keyframe.version_in_group;

    // Decompress/reassemble the keyframe based on type.
    let mut content = if keyframe.is_keyframe == 2 {
        // Raw keyframe (is_keyframe=2): stored uncompressed in blob_chunks.
        if keyframe.data.is_empty() {
            reassemble_chunks(sql, group_id, keyframe_version)?
        } else {
            keyframe.data
        }
    } else {
        // Normal keyframe (is_keyframe=1): zlib-compressed.
        let compressed = if keyframe.data.is_empty() {
            reassemble_chunks(sql, group_id, keyframe_version)?
        } else {
            keyframe.data
        };
        blob_zlib_decompress(&compressed)?
    };

    if keyframe_version < target_version {
        let cursor = sql.exec(
            "SELECT version_in_group, data FROM blobs
             WHERE group_id = ? AND version_in_group > ? AND version_in_group <= ?
             ORDER BY version_in_group ASC",
            vec![
                SqlStorageValue::from(group_id),
                SqlStorageValue::from(keyframe_version),
                SqlStorageValue::from(target_version),
            ],
        )?;

        for row in cursor.next::<BlobRow>() {
            let row = row?;
            // Reassemble chunked deltas (empty sentinel means data is in blob_chunks)
            let delta_data = if row.data.is_empty() {
                reassemble_chunks(sql, group_id, row.version_in_group)?
            } else {
                row.data
            };
            content = xpatch::delta::decode(&content, &delta_data).map_err(|e| {
                Error::RustError(format!(
                    "delta decode group {} v{}: {}",
                    group_id, row.version_in_group, e
                ))
            })?;
        }
    }

    Ok(content)
}

/// Update a ref, validating the old hash matches (basic fast-forward check).
pub fn update_ref(sql: &SqlStorage, name: &str, old_hash: &str, new_hash: &str) -> Result<()> {
    if new_hash == ZERO_HASH {
        // Delete ref
        sql.exec(
            "DELETE FROM refs WHERE name = ?",
            vec![SqlStorageValue::from(name.to_string())],
        )?;
        return Ok(());
    }

    if old_hash == ZERO_HASH {
        // Create new ref — verify it doesn't already exist
        sql.exec(
            "INSERT INTO refs (name, commit_hash) VALUES (?, ?)",
            vec![
                SqlStorageValue::from(name.to_string()),
                SqlStorageValue::from(new_hash.to_string()),
            ],
        )?;
    } else {
        // Update existing ref — validate old hash
        #[derive(serde::Deserialize)]
        struct RefRow {
            commit_hash: String,
        }
        let current: Vec<RefRow> = sql
            .exec(
                "SELECT commit_hash FROM refs WHERE name = ?",
                vec![SqlStorageValue::from(name.to_string())],
            )?
            .to_array()?;

        match current.first() {
            Some(r) if r.commit_hash != old_hash => {
                return Err(Error::RustError(format!(
                    "ref {}: expected {}, found {}",
                    name, old_hash, r.commit_hash
                )));
            }
            None => {
                return Err(Error::RustError(format!(
                    "ref {}: expected {} but ref does not exist",
                    name, old_hash
                )));
            }
            _ => {}
        }

        sql.exec(
            "UPDATE refs SET commit_hash = ? WHERE name = ?",
            vec![
                SqlStorageValue::from(new_hash.to_string()),
                SqlStorageValue::from(name.to_string()),
            ],
        )?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Path resolution: walk trees to map blob_hash → file path
// ---------------------------------------------------------------------------

/// Walk commit trees to build a mapping from blob hash to file path.
/// Checks `pack_trees` (from the current push) first, falls back to the DB.
pub fn resolve_blob_paths(
    sql: &SqlStorage,
    pack_trees: &HashMap<String, Vec<TreeEntry>>,
    root_tree_hashes: &[String],
) -> Result<HashMap<String, String>> {
    let mut blob_paths: HashMap<String, String> = HashMap::new();
    let mut visited_trees: HashMap<String, bool> = HashMap::new();

    for root_hash in root_tree_hashes {
        walk_tree(
            sql,
            pack_trees,
            root_hash,
            "",
            &mut blob_paths,
            &mut visited_trees,
        )?;
    }

    Ok(blob_paths)
}

fn walk_tree(
    sql: &SqlStorage,
    pack_trees: &HashMap<String, Vec<TreeEntry>>,
    tree_hash: &str,
    prefix: &str,
    blob_paths: &mut HashMap<String, String>,
    visited: &mut HashMap<String, bool>,
) -> Result<()> {
    if visited.contains_key(tree_hash) {
        return Ok(());
    }
    visited.insert(tree_hash.to_string(), true);

    // Try pack-local trees first, then DB
    let owned_entries;
    let entries = if let Some(entries) = pack_trees.get(tree_hash) {
        entries.as_slice()
    } else {
        owned_entries = load_tree_from_db(sql, tree_hash)?;
        owned_entries.as_slice()
    };

    for entry in entries {
        let full_path = if prefix.is_empty() {
            entry.name.clone()
        } else {
            format!("{}/{}", prefix, entry.name)
        };

        if entry.mode == 0o040000 {
            // Subdirectory: recurse
            walk_tree(
                sql,
                pack_trees,
                &entry.hash,
                &full_path,
                blob_paths,
                visited,
            )?;
        } else {
            // File (blob or symlink): record path if not already seen
            blob_paths.entry(entry.hash.clone()).or_insert(full_path);
        }
    }

    Ok(())
}

pub fn load_tree_from_db(sql: &SqlStorage, tree_hash: &str) -> Result<Vec<TreeEntry>> {
    #[derive(serde::Deserialize)]
    struct Row {
        mode: i64,
        name: String,
        entry_hash: String,
    }

    let rows: Vec<Row> = sql
        .exec(
            "SELECT mode, name, entry_hash FROM trees WHERE tree_hash = ?",
            vec![SqlStorageValue::from(tree_hash.to_string())],
        )?
        .to_array()?;

    Ok(rows
        .into_iter()
        .map(|r| TreeEntry {
            mode: r.mode as u32,
            name: r.name,
            hash: r.entry_hash,
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Object collection for git-upload-pack (fetch / clone)
// ---------------------------------------------------------------------------

/// Collect all objects reachable from `wants` that are not reachable from
/// `haves`. Returns PackObjects ready for pack generation.
///
/// Walks the commit graph via BFS, collecting commits, trees, and blobs.
/// Blobs are reconstructed from xpatch delta chains.
pub fn collect_objects(
    sql: &SqlStorage,
    wants: &[String],
    haves: &HashSet<String>,
) -> Result<Vec<pack::PackObject>> {
    let mut objects: Vec<pack::PackObject> = Vec::new();
    let mut visited: HashSet<String> = HashSet::new();
    let mut commit_queue: VecDeque<String> = VecDeque::new();

    // Seed the walk with wanted commits
    for want in wants {
        if !haves.contains(want) {
            commit_queue.push_back(want.clone());
        }
    }

    // BFS over commit graph
    while let Some(commit_hash) = commit_queue.pop_front() {
        if visited.contains(&commit_hash) || haves.contains(&commit_hash) {
            continue;
        }
        visited.insert(commit_hash.clone());

        // Load commit metadata (for tree_hash and parents)
        #[derive(serde::Deserialize)]
        struct CommitRow {
            tree_hash: String,
        }
        let commits: Vec<CommitRow> = sql
            .exec(
                "SELECT tree_hash FROM commits WHERE hash = ?",
                vec![SqlStorageValue::from(commit_hash.clone())],
            )?
            .to_array()?;

        let commit = match commits.into_iter().next() {
            Some(c) => c,
            None => continue,
        };

        // Load raw bytes — byte-identical to what was pushed
        let raw_data = load_raw_object(sql, &commit_hash)?;
        let raw_data = match raw_data {
            Some(d) => d,
            None => continue,
        };

        objects.push(pack::PackObject {
            obj_type: pack::ObjectType::Commit,
            data: raw_data,
        });

        // Enqueue parents for traversal
        #[derive(serde::Deserialize)]
        struct ParentRow {
            parent_hash: String,
        }
        let parents: Vec<ParentRow> = sql
            .exec(
                "SELECT parent_hash FROM commit_parents
                 WHERE commit_hash = ? ORDER BY ordinal ASC",
                vec![SqlStorageValue::from(commit_hash.clone())],
            )?
            .to_array()?;

        for p in &parents {
            if !visited.contains(&p.parent_hash) && !haves.contains(&p.parent_hash) {
                commit_queue.push_back(p.parent_hash.clone());
            }
        }

        // Collect the tree (and all subtrees/blobs) for this commit
        collect_tree_objects(sql, &commit.tree_hash, &mut objects, &mut visited)?;
    }

    Ok(objects)
}

/// Recursively collect a tree and all its referenced blobs and subtrees.
fn collect_tree_objects(
    sql: &SqlStorage,
    tree_hash: &str,
    objects: &mut Vec<pack::PackObject>,
    visited: &mut HashSet<String>,
) -> Result<()> {
    if visited.contains(tree_hash) {
        return Ok(());
    }
    visited.insert(tree_hash.to_string());

    let entries = load_tree_from_db(sql, tree_hash)?;
    if entries.is_empty() {
        return Ok(()); // tree not found
    }

    // Load raw bytes — byte-identical to what was pushed
    if let Some(raw_data) = load_raw_object(sql, tree_hash)? {
        objects.push(pack::PackObject {
            obj_type: pack::ObjectType::Tree,
            data: raw_data,
        });
    }

    for entry in &entries {
        if entry.mode == 0o040000 {
            // Subtree
            collect_tree_objects(sql, &entry.hash, objects, visited)?;
        } else if !visited.contains(&entry.hash) {
            // Blob (or symlink)
            visited.insert(entry.hash.clone());
            let blob_data = load_blob_content(sql, &entry.hash)?;
            if let Some(data) = blob_data {
                objects.push(pack::PackObject {
                    obj_type: pack::ObjectType::Blob,
                    data,
                });
            }
        }
    }

    Ok(())
}

/// Load and reconstruct a blob's full content by hash.
fn load_blob_content(sql: &SqlStorage, blob_hash: &str) -> Result<Option<Vec<u8>>> {
    #[derive(serde::Deserialize)]
    struct BlobInfo {
        group_id: i64,
        version_in_group: i64,
    }

    let rows: Vec<BlobInfo> = sql
        .exec(
            "SELECT group_id, version_in_group FROM blobs WHERE blob_hash = ?",
            vec![SqlStorageValue::from(blob_hash.to_string())],
        )?
        .to_array()?;

    match rows.into_iter().next() {
        Some(info) => {
            let content = reconstruct_blob(sql, info.group_id, info.version_in_group)?;
            Ok(Some(content))
        }
        None => Ok(None),
    }
}

// NOTE: build_raw_commit / build_raw_tree / hex_decode were removed.
// We store raw object bytes in `raw_objects` during push and return them
// verbatim during fetch, so we never need to re-serialize commits or trees.

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

pub fn get_config(sql: &SqlStorage, key: &str) -> Result<Option<String>> {
    #[derive(serde::Deserialize)]
    struct Row {
        value: String,
    }
    let rows: Vec<Row> = sql
        .exec(
            "SELECT value FROM config WHERE key = ?",
            vec![SqlStorageValue::from(key.to_string())],
        )?
        .to_array()?;
    Ok(rows.into_iter().next().map(|r| r.value))
}

pub fn set_config(sql: &SqlStorage, key: &str, value: &str) -> Result<()> {
    sql.exec(
        "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)",
        vec![
            SqlStorageValue::from(key.to_string()),
            SqlStorageValue::from(value.to_string()),
        ],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// FTS5 index rebuild (incremental when possible)
// ---------------------------------------------------------------------------

/// Rebuild the FTS5 code search index. If a previous indexed commit exists,
/// uses the diff engine to only update changed files. Otherwise does a full
/// tree walk.
pub fn rebuild_fts_index(sql: &SqlStorage, new_commit_hash: &str) -> Result<()> {
    let new_tree = match commit_tree_hash(sql, new_commit_hash)? {
        Some(h) => h,
        None => return Ok(()),
    };

    let prev_commit = get_config(sql, "fts_indexed_commit")?;

    if let Some(ref prev_hash) = prev_commit {
        if let Some(old_tree) = commit_tree_hash(sql, prev_hash)? {
            // Incremental rebuild: only touch changed files
            let changes = crate::diff::diff_trees(sql, Some(&old_tree), Some(&new_tree))?;

            for file in &changes {
                match file.status {
                    crate::diff::DiffStatus::Deleted => {
                        sql.exec(
                            "DELETE FROM fts_head WHERE path = ?",
                            vec![SqlStorageValue::from(file.path.clone())],
                        )?;
                    }
                    crate::diff::DiffStatus::Added => {
                        if let Some(hash) = &file.new_hash {
                            index_file_for_fts(sql, &file.path, hash)?;
                        }
                    }
                    crate::diff::DiffStatus::Modified => {
                        sql.exec(
                            "DELETE FROM fts_head WHERE path = ?",
                            vec![SqlStorageValue::from(file.path.clone())],
                        )?;
                        if let Some(hash) = &file.new_hash {
                            index_file_for_fts(sql, &file.path, hash)?;
                        }
                    }
                }
            }
        } else {
            // Previous commit lost — fall back to full rebuild
            full_fts_rebuild(sql, &new_tree)?;
        }
    } else {
        // First index — full rebuild
        full_fts_rebuild(sql, &new_tree)?;
    }

    set_config(sql, "fts_indexed_commit", new_commit_hash)?;
    Ok(())
}

/// Full rebuild: wipe the index and re-index every file in the tree.
fn full_fts_rebuild(sql: &SqlStorage, tree_hash: &str) -> Result<()> {
    sql.exec("DELETE FROM fts_head", None)?;

    let empty_pack_trees = HashMap::new();
    let mut visited = HashMap::new();
    let mut blob_paths = HashMap::new();

    walk_tree(
        sql,
        &empty_pack_trees,
        tree_hash,
        "",
        &mut blob_paths,
        &mut visited,
    )?;

    for (blob_hash, path) in &blob_paths {
        index_file_for_fts(sql, path, blob_hash)?;
    }

    Ok(())
}

/// Index a single file into fts_head. Skips binary, large (>1 MiB), and
/// non-UTF-8 files.
fn index_file_for_fts(sql: &SqlStorage, path: &str, blob_hash: &str) -> Result<()> {
    let content = match load_blob_content(sql, blob_hash)? {
        Some(c) => c,
        None => return Ok(()),
    };

    let check_len = content.len().min(8192);
    if content[..check_len].contains(&0) {
        return Ok(()); // binary
    }
    if content.len() > 1_048_576 {
        return Ok(()); // too large
    }

    let text = match std::str::from_utf8(&content) {
        Ok(t) => t,
        Err(_) => return Ok(()), // not UTF-8
    };

    sql.exec(
        "INSERT INTO fts_head (path, content) VALUES (?, ?)",
        vec![
            SqlStorageValue::from(path.to_string()),
            SqlStorageValue::from(text.to_string()),
        ],
    )?;
    Ok(())
}

/// Get the tree hash for a commit.
fn commit_tree_hash(sql: &SqlStorage, commit_hash: &str) -> Result<Option<String>> {
    #[derive(serde::Deserialize)]
    struct Row {
        tree_hash: String,
    }
    let rows: Vec<Row> = sql
        .exec(
            "SELECT tree_hash FROM commits WHERE hash = ?",
            vec![SqlStorageValue::from(commit_hash.to_string())],
        )?
        .to_array()?;
    Ok(rows.into_iter().next().map(|r| r.tree_hash))
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

pub struct CodeSearchResult {
    pub path: String,
    pub matches: Vec<LineMatch>,
}

pub struct LineMatch {
    pub line_number: usize,
    pub line_text: String,
}

pub struct CommitSearchResult {
    pub hash: String,
    pub message: String,
    pub author: String,
    pub commit_time: i64,
}

/// Search code in the FTS index. Auto-detects whether to use FTS5 MATCH
/// (for word queries) or INSTR (for literal/symbol queries).
/// Returns all matching lines with line numbers, not just one snippet per file.
pub fn search_code(
    sql: &SqlStorage,
    query: &str,
    path_filter: Option<&str>,
    ext_filter: Option<&str>,
    limit: usize,
) -> Result<Vec<CodeSearchResult>> {
    let (search_term, literal) = if let Some(stripped) = query.strip_prefix("lit:") {
        (stripped, true)
    } else {
        (query, needs_literal_search(query))
    };

    let files = if literal {
        search_files_literal(sql, search_term, path_filter, ext_filter, limit)?
    } else {
        search_files_fts(sql, search_term, path_filter, ext_filter, limit)?
    };

    // Scan each file for matching lines
    let mut results = Vec::new();
    let mut total_matches = 0usize;
    let max_matches = 500;
    let term_lower = search_term.to_lowercase();

    for (path, content) in files {
        if total_matches >= max_matches {
            break;
        }

        let mut line_matches = Vec::new();
        for (i, line) in content.lines().enumerate() {
            let found = if literal {
                line.contains(search_term)
            } else {
                line.to_lowercase().contains(&term_lower)
            };

            if found {
                line_matches.push(LineMatch {
                    line_number: i + 1,
                    line_text: line.to_string(),
                });
                total_matches += 1;
                if total_matches >= max_matches {
                    break;
                }
            }
        }

        if !line_matches.is_empty() {
            results.push(CodeSearchResult {
                path,
                matches: line_matches,
            });
        }
    }

    Ok(results)
}

/// Search commit messages via FTS5.
pub fn search_commits(
    sql: &SqlStorage,
    query: &str,
    limit: usize,
) -> Result<Vec<CommitSearchResult>> {
    #[derive(serde::Deserialize)]
    struct Row {
        hash: String,
        message: String,
        author: String,
    }

    let rows: Vec<Row> = sql
        .exec(
            "SELECT hash, message, author FROM fts_commits
             WHERE fts_commits MATCH ?
             ORDER BY rank
             LIMIT ?",
            vec![
                SqlStorageValue::from(query.to_string()),
                SqlStorageValue::from(limit as i64),
            ],
        )?
        .to_array()?;

    let mut results = Vec::new();
    for row in rows {
        // Look up commit_time from the commits table
        #[derive(serde::Deserialize)]
        struct TimeRow {
            commit_time: i64,
        }
        let time_rows: Vec<TimeRow> = sql
            .exec(
                "SELECT commit_time FROM commits WHERE hash = ?",
                vec![SqlStorageValue::from(row.hash.clone())],
            )?
            .to_array()?;

        let commit_time = time_rows
            .into_iter()
            .next()
            .map(|r| r.commit_time)
            .unwrap_or(0);

        results.push(CommitSearchResult {
            hash: row.hash,
            message: row.message,
            author: row.author,
            commit_time,
        });
    }

    Ok(results)
}

/// Detect if a query needs literal (INSTR) search instead of FTS5 MATCH.
/// Triggers on any character that would break or confuse FTS5 tokenization:
/// dots, underscores, parens, colons, angle brackets, etc.
fn needs_literal_search(query: &str) -> bool {
    query
        .bytes()
        .any(|b| !matches!(b, b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b' ' | b'"' | b'*'))
}

/// FTS5 MATCH search — returns (path, content) pairs for files that match.
fn search_files_fts(
    sql: &SqlStorage,
    query: &str,
    path_filter: Option<&str>,
    ext_filter: Option<&str>,
    limit: usize,
) -> Result<Vec<(String, String)>> {
    // Use {content} column filter so we don't match on filenames,
    // unless the user already specified a column (e.g. content:foo or path:bar).
    let has_column_spec = query.contains("content:") || query.contains("path:");
    let fts_match = if has_column_spec {
        query.to_string()
    } else {
        format!("{{content}}: {}", query)
    };
    let mut where_parts = vec!["fts_head MATCH ?".to_string()];
    let mut params: Vec<SqlStorageValue> = vec![SqlStorageValue::from(fts_match)];

    if let Some(path) = path_filter {
        where_parts.push("path LIKE ?".to_string());
        params.push(SqlStorageValue::from(format!("{}%", path)));
    }
    if let Some(ext) = ext_filter {
        where_parts.push("path LIKE ?".to_string());
        params.push(SqlStorageValue::from(format!("%.{}", ext)));
    }

    params.push(SqlStorageValue::from(limit as i64));

    let sql_str = format!(
        "SELECT path, content FROM fts_head WHERE {} ORDER BY rank LIMIT ?",
        where_parts.join(" AND "),
    );

    #[derive(serde::Deserialize)]
    struct Row {
        path: String,
        content: String,
    }

    let rows: Vec<Row> = sql.exec(&sql_str, params)?.to_array()?;
    Ok(rows.into_iter().map(|r| (r.path, r.content)).collect())
}

/// Literal substring search via INSTR — full table scan, but bounded by repo size.
fn search_files_literal(
    sql: &SqlStorage,
    query: &str,
    path_filter: Option<&str>,
    ext_filter: Option<&str>,
    limit: usize,
) -> Result<Vec<(String, String)>> {
    let mut where_parts = vec!["INSTR(content, ?) > 0".to_string()];
    let mut params: Vec<SqlStorageValue> = vec![SqlStorageValue::from(query.to_string())];

    if let Some(path) = path_filter {
        where_parts.push("path LIKE ?".to_string());
        params.push(SqlStorageValue::from(format!("{}%", path)));
    }
    if let Some(ext) = ext_filter {
        where_parts.push("path LIKE ?".to_string());
        params.push(SqlStorageValue::from(format!("%.{}", ext)));
    }

    params.push(SqlStorageValue::from(limit as i64));

    let sql_str = format!(
        "SELECT path, content FROM fts_head WHERE {} LIMIT ?",
        where_parts.join(" AND "),
    );

    #[derive(serde::Deserialize)]
    struct Row {
        path: String,
        content: String,
    }

    let rows: Vec<Row> = sql.exec(&sql_str, params)?.to_array()?;
    Ok(rows.into_iter().map(|r| (r.path, r.content)).collect())
}

// ---------------------------------------------------------------------------
// Blob compression helpers
// ---------------------------------------------------------------------------

/// Zlib-compress data (used for keyframe storage).
fn blob_zlib_compress(data: &[u8]) -> Vec<u8> {
    use flate2::write::ZlibEncoder;
    use flate2::Compression;
    use std::io::Write;

    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(data).expect("zlib compress write");
    encoder.finish().expect("zlib compress finish")
}

/// Zlib-decompress data (used when reading keyframes).
fn blob_zlib_decompress(data: &[u8]) -> Result<Vec<u8>> {
    use flate2::read::ZlibDecoder;
    use std::io::Read;

    let mut decoder = ZlibDecoder::new(data);
    let mut output = Vec::new();
    decoder
        .read_to_end(&mut output)
        .map_err(|e| Error::RustError(format!("blob zlib decompress: {}", e)))?;
    Ok(output)
}

/// Reassemble a chunked blob from the blob_chunks table.
fn reassemble_chunks(sql: &SqlStorage, group_id: i64, version: i64) -> Result<Vec<u8>> {
    #[derive(serde::Deserialize)]
    struct ChunkRow {
        #[serde(with = "serde_bytes")]
        data: Vec<u8>,
    }

    let cursor = sql.exec(
        "SELECT data FROM blob_chunks
         WHERE group_id = ? AND version_in_group = ?
         ORDER BY chunk_index ASC",
        vec![
            SqlStorageValue::from(group_id),
            SqlStorageValue::from(version),
        ],
    )?;

    let mut result = Vec::new();
    for row in cursor.next::<ChunkRow>() {
        let row = row?;
        result.extend_from_slice(&row.data);
    }

    Ok(result)
}
