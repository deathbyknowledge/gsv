//! Read API: HTTP endpoints for browsing repository content.

use serde::Serialize;
use worker::*;

// Re-use the Url type from worker's dependency
type Url = worker::Url;

// ---------------------------------------------------------------------------
// GET /refs — list branches and tags
// ---------------------------------------------------------------------------

pub fn handle_refs(sql: &SqlStorage) -> Result<Response> {
    #[derive(serde::Deserialize)]
    struct Row {
        name: String,
        commit_hash: String,
    }

    let rows: Vec<Row> = sql
        .exec("SELECT name, commit_hash FROM refs ORDER BY name", None)?
        .to_array()?;

    let mut heads = serde_json::Map::new();
    let mut tags = serde_json::Map::new();

    for r in &rows {
        let value = serde_json::Value::String(r.commit_hash.clone());
        if let Some(branch) = r.name.strip_prefix("refs/heads/") {
            heads.insert(branch.to_string(), value);
        } else if let Some(tag) = r.name.strip_prefix("refs/tags/") {
            tags.insert(tag.to_string(), value);
        }
    }

    Response::from_json(&serde_json::json!({
        "heads": heads,
        "tags": tags,
    }))
}

// ---------------------------------------------------------------------------
// GET /log?ref=main&limit=50&offset=0 — commit history
// ---------------------------------------------------------------------------

pub fn handle_log(sql: &SqlStorage, url: &Url) -> Result<Response> {
    let ref_name = get_query(url, "ref").unwrap_or_else(|| "main".to_string());
    let limit: i64 = get_query(url, "limit")
        .and_then(|v| v.parse().ok())
        .unwrap_or(50);
    let offset: i64 = get_query(url, "offset")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    // Resolve ref to commit hash
    let head = resolve_ref(sql, &ref_name)?;
    let head = match head {
        Some(h) => h,
        None => return Response::from_json(&serde_json::json!({ "error": "ref not found" })),
    };

    // Walk the commit chain following first-parent links
    #[derive(serde::Deserialize)]
    struct CommitRow {
        hash: String,
        tree_hash: String,
        author: String,
        author_email: String,
        author_time: i64,
        committer: String,
        committer_email: String,
        commit_time: i64,
        message: String,
    }

    #[derive(serde::Deserialize)]
    struct ParentRow {
        parent_hash: String,
        #[allow(dead_code)]
        ordinal: i64,
    }

    #[derive(Serialize)]
    struct LogEntry {
        hash: String,
        tree_hash: String,
        author: String,
        author_email: String,
        author_time: i64,
        committer: String,
        committer_email: String,
        commit_time: i64,
        message: String,
        parents: Vec<String>,
    }

    let mut entries: Vec<LogEntry> = Vec::new();
    let mut current = Some(head);
    let mut skipped: i64 = 0;

    while let Some(hash) = current {
        if entries.len() as i64 >= limit {
            break;
        }

        let commits: Vec<CommitRow> = sql
            .exec(
                "SELECT hash, tree_hash, author, author_email, author_time,
                        committer, committer_email, commit_time, message
                 FROM commits WHERE hash = ?",
                vec![SqlStorageValue::from(hash.clone())],
            )?
            .to_array()?;

        let commit = match commits.into_iter().next() {
            Some(c) => c,
            None => break,
        };

        let parents: Vec<ParentRow> = sql
            .exec(
                "SELECT parent_hash, ordinal FROM commit_parents
                 WHERE commit_hash = ? ORDER BY ordinal ASC",
                vec![SqlStorageValue::from(hash.clone())],
            )?
            .to_array()?;

        let first_parent = parents.first().map(|p| p.parent_hash.clone());

        if skipped >= offset {
            entries.push(LogEntry {
                hash: commit.hash,
                tree_hash: commit.tree_hash,
                author: commit.author,
                author_email: commit.author_email,
                author_time: commit.author_time,
                committer: commit.committer,
                committer_email: commit.committer_email,
                commit_time: commit.commit_time,
                message: commit.message,
                parents: parents.into_iter().map(|p| p.parent_hash).collect(),
            });
        } else {
            skipped += 1;
        }

        current = first_parent;
    }

    Response::from_json(&entries)
}

// ---------------------------------------------------------------------------
// GET /commit/:hash — single commit detail
// ---------------------------------------------------------------------------

pub fn handle_commit(sql: &SqlStorage, hash: &str) -> Result<Response> {
    #[derive(serde::Deserialize)]
    struct CommitRow {
        tree_hash: String,
        author: String,
        author_email: String,
        author_time: i64,
        committer: String,
        committer_email: String,
        commit_time: i64,
        message: String,
    }

    let commits: Vec<CommitRow> = sql
        .exec(
            "SELECT tree_hash, author, author_email, author_time,
                    committer, committer_email, commit_time, message
             FROM commits WHERE hash = ?",
            vec![SqlStorageValue::from(hash.to_string())],
        )?
        .to_array()?;

    let commit = match commits.into_iter().next() {
        Some(c) => c,
        None => return Response::error("Commit not found", 404),
    };

    #[derive(serde::Deserialize)]
    struct ParentRow {
        parent_hash: String,
    }
    let parents: Vec<ParentRow> = sql
        .exec(
            "SELECT parent_hash FROM commit_parents
             WHERE commit_hash = ? ORDER BY ordinal ASC",
            vec![SqlStorageValue::from(hash.to_string())],
        )?
        .to_array()?;

    Response::from_json(&serde_json::json!({
        "hash": hash,
        "tree_hash": commit.tree_hash,
        "author": commit.author,
        "author_email": commit.author_email,
        "author_time": commit.author_time,
        "committer": commit.committer,
        "committer_email": commit.committer_email,
        "commit_time": commit.commit_time,
        "message": commit.message,
        "parents": parents.iter().map(|p| &p.parent_hash).collect::<Vec<_>>(),
    }))
}

// ---------------------------------------------------------------------------
// GET /tree/:hash — directory listing
// ---------------------------------------------------------------------------

pub fn handle_tree(sql: &SqlStorage, tree_hash: &str) -> Result<Response> {
    #[derive(serde::Deserialize)]
    struct Row {
        name: String,
        mode: i64,
        entry_hash: String,
    }

    let rows: Vec<Row> = sql
        .exec(
            "SELECT name, mode, entry_hash FROM trees
             WHERE tree_hash = ? ORDER BY name",
            vec![SqlStorageValue::from(tree_hash.to_string())],
        )?
        .to_array()?;

    if rows.is_empty() {
        return Response::error("Tree not found", 404);
    }

    #[derive(Serialize)]
    struct Entry {
        name: String,
        mode: String,
        hash: String,
        #[serde(rename = "type")]
        entry_type: String,
    }

    let entries: Vec<Entry> = rows
        .into_iter()
        .map(|r| {
            let entry_type = if r.mode == 0o040000 {
                "tree"
            } else if r.mode == 0o120000 {
                "symlink"
            } else {
                "blob"
            };
            Entry {
                name: r.name,
                mode: format!("{:06o}", r.mode),
                hash: r.entry_hash,
                entry_type: entry_type.to_string(),
            }
        })
        .collect();

    Response::from_json(&entries)
}

// ---------------------------------------------------------------------------
// GET /blob/:hash — raw file content (reconstructed from delta chain)
// ---------------------------------------------------------------------------

pub fn handle_blob(sql: &SqlStorage, blob_hash: &str) -> Result<Response> {
    #[derive(serde::Deserialize)]
    struct BlobInfo {
        group_id: i64,
        version_in_group: i64,
        raw_size: i64,
    }

    let rows: Vec<BlobInfo> = sql
        .exec(
            "SELECT group_id, version_in_group, raw_size FROM blobs WHERE blob_hash = ?",
            vec![SqlStorageValue::from(blob_hash.to_string())],
        )?
        .to_array()?;

    let info = match rows.into_iter().next() {
        Some(i) => i,
        None => return Response::error("Blob not found", 404),
    };

    let content = crate::store::reconstruct_blob(sql, info.group_id, info.version_in_group)?;

    let mut resp = Response::from_bytes(content)?;
    resp.headers_mut()
        .set("Content-Type", "application/octet-stream")?;
    resp.headers_mut()
        .set("X-Blob-Size", &info.raw_size.to_string())?;
    Ok(resp)
}

// ---------------------------------------------------------------------------
// GET /file?ref=main&path=src/lib.rs — file content at ref + path
// ---------------------------------------------------------------------------

pub fn handle_file(sql: &SqlStorage, url: &Url) -> Result<Response> {
    let ref_name = get_query(url, "ref").unwrap_or_else(|| "main".to_string());
    let path = match get_query(url, "path") {
        Some(p) => p,
        None => return Response::error("missing 'path' query parameter", 400),
    };

    // Resolve ref → commit → tree_hash
    let commit_hash = match resolve_ref(sql, &ref_name)? {
        Some(h) => h,
        None => return Response::error("ref not found", 404),
    };

    #[derive(serde::Deserialize)]
    struct CommitRow {
        tree_hash: String,
    }
    let commits: Vec<CommitRow> = sql
        .exec(
            "SELECT tree_hash FROM commits WHERE hash = ?",
            vec![SqlStorageValue::from(commit_hash)],
        )?
        .to_array()?;

    let root_tree = match commits.into_iter().next() {
        Some(c) => c.tree_hash,
        None => return Response::error("commit not found", 404),
    };

    // Walk the tree path segment by segment
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let mut current_tree = root_tree;

    for (i, segment) in segments.iter().enumerate() {
        #[derive(serde::Deserialize)]
        struct TreeRow {
            mode: i64,
            entry_hash: String,
        }

        let entries: Vec<TreeRow> = sql
            .exec(
                "SELECT mode, entry_hash FROM trees
                 WHERE tree_hash = ? AND name = ?",
                vec![
                    SqlStorageValue::from(current_tree.clone()),
                    SqlStorageValue::from(segment.to_string()),
                ],
            )?
            .to_array()?;

        let entry = match entries.into_iter().next() {
            Some(e) => e,
            None => return Response::error(format!("path not found: {}", path), 404),
        };

        if i < segments.len() - 1 {
            // Intermediate segment: must be a tree
            if entry.mode != 0o040000 {
                return Response::error(format!("not a directory: {}", segment), 404);
            }
            current_tree = entry.entry_hash;
        } else {
            // Final segment: could be blob or tree
            if entry.mode == 0o040000 {
                // It's a directory — return tree listing
                return handle_tree(sql, &entry.entry_hash);
            }
            // It's a file — return blob content
            return handle_blob(sql, &entry.entry_hash);
        }
    }

    // Path was empty or root — return root tree
    handle_tree(sql, &current_tree)
}

// ---------------------------------------------------------------------------
// GET /stats — repository statistics
// ---------------------------------------------------------------------------

pub fn handle_stats(sql: &SqlStorage) -> Result<Response> {
    #[derive(serde::Deserialize)]
    struct Count {
        n: i64,
    }

    let commits: Count = sql.exec("SELECT COUNT(*) AS n FROM commits", None)?.one()?;
    let blobs: Count = sql.exec("SELECT COUNT(*) AS n FROM blobs", None)?.one()?;
    let refs: Count = sql.exec("SELECT COUNT(*) AS n FROM refs", None)?.one()?;
    let groups: Count = sql
        .exec("SELECT COUNT(*) AS n FROM blob_groups", None)?
        .one()?;

    #[derive(serde::Deserialize)]
    struct BlobStats {
        total_stored: i64,
        total_raw: i64,
        keyframes: i64,
    }

    let blob_stats: Vec<BlobStats> = sql
        .exec(
            "SELECT
                COALESCE(SUM(stored_size), 0) AS total_stored,
                COALESCE(SUM(raw_size), 0) AS total_raw,
                COALESCE(SUM(is_keyframe), 0) AS keyframes
             FROM blobs",
            None,
        )?
        .to_array()?;

    let bs = blob_stats.into_iter().next().unwrap_or(BlobStats {
        total_stored: 0,
        total_raw: 0,
        keyframes: 0,
    });

    let compression_ratio = if bs.total_stored > 0 {
        bs.total_raw as f64 / bs.total_stored as f64
    } else {
        1.0
    };

    Response::from_json(&serde_json::json!({
        "database_size_bytes": sql.database_size(),
        "commits": commits.n,
        "blobs": blobs.n,
        "blob_groups": groups.n,
        "refs": refs.n,
        "storage": {
            "raw_bytes": bs.total_raw,
            "stored_bytes": bs.total_stored,
            "keyframes": bs.keyframes,
            "deltas": blobs.n - bs.keyframes,
            "compression_ratio": compression_ratio,
        }
    }))
}

// ---------------------------------------------------------------------------
// Query parsing: @prefix: syntax
// ---------------------------------------------------------------------------

/// Parsed representation of a user search query after extracting `@prefix:` tokens.
pub struct ParsedQuery {
    /// The query to pass to FTS5 MATCH (with `@` stripped from column prefixes).
    pub fts_query: String,
    /// Extracted from `@path:value` — maps to a SQL `path LIKE 'value%'` filter.
    pub path_filter: Option<String>,
    /// Extracted from `@ext:value` — maps to a SQL `path LIKE '%.value'` filter.
    pub ext_filter: Option<String>,
    /// Implied scope when commits-only columns (`@author:`, `@message:`) are used.
    pub scope: Option<&'static str>,
}

/// Parse `@prefix:value` tokens from a raw query string.
///
/// Supported prefixes:
///   `@author:name`   → FTS5 `author:name`,  scope = commits
///   `@message:text`  → FTS5 `message:text`, scope = commits
///   `@content:text`  → FTS5 `content:text` (bypasses auto column wrapper)
///   `@path:src/`     → SQL `path LIKE 'src/%'`
///   `@ext:rs`        → SQL `path LIKE '%.rs'`
pub fn parse_search_query(raw: &str) -> ParsedQuery {
    let mut fts_tokens: Vec<String> = Vec::new();
    let mut path_filter: Option<String> = None;
    let mut ext_filter: Option<String> = None;
    let mut commits_implied = false;

    for token in raw.split_whitespace() {
        if let Some(v) = token.strip_prefix("@path:") {
            path_filter = Some(v.to_string());
        } else if let Some(v) = token.strip_prefix("@ext:") {
            ext_filter = Some(v.to_string());
        } else if let Some(v) = token.strip_prefix("@author:") {
            fts_tokens.push(format!("author:{}", v));
            commits_implied = true;
        } else if let Some(v) = token.strip_prefix("@message:") {
            fts_tokens.push(format!("message:{}", v));
            commits_implied = true;
        } else if let Some(v) = token.strip_prefix("@content:") {
            fts_tokens.push(format!("content:{}", v));
        } else {
            fts_tokens.push(token.to_string());
        }
    }

    ParsedQuery {
        fts_query: fts_tokens.join(" "),
        path_filter,
        ext_filter,
        scope: if commits_implied {
            Some("commits")
        } else {
            None
        },
    }
}

// ---------------------------------------------------------------------------
// GET /search?q=TODO&limit=50&scope=code — search
// ---------------------------------------------------------------------------

pub fn handle_search(sql: &SqlStorage, url: &Url) -> Result<Response> {
    let query = match get_query(url, "q") {
        Some(q) => q,
        None => return Response::error("missing 'q' query parameter", 400),
    };
    let limit: usize = get_query(url, "limit")
        .and_then(|v| v.parse().ok())
        .unwrap_or(50);
    let scope = get_query(url, "scope").unwrap_or_else(|| "code".to_string());

    let parsed = parse_search_query(&query);
    let query = parsed.fts_query;
    let scope = parsed.scope.map(|s| s.to_string()).unwrap_or(scope);

    match scope.as_str() {
        "commits" => {
            let results = crate::store::search_commits(sql, &query, limit)?;
            #[derive(Serialize)]
            struct CommitResult {
                hash: String,
                message: String,
                author: String,
                commit_time: i64,
            }
            let items: Vec<CommitResult> = results
                .into_iter()
                .map(|r| CommitResult {
                    hash: r.hash,
                    message: r.message,
                    author: r.author,
                    commit_time: r.commit_time,
                })
                .collect();
            Response::from_json(&serde_json::json!({
                "scope": "commits",
                "query": query,
                "results": items,
            }))
        }
        _ => {
            let results = crate::store::search_code(
                sql,
                &query,
                parsed.path_filter.as_deref(),
                parsed.ext_filter.as_deref(),
                limit,
            )?;
            #[derive(Serialize)]
            struct FileResult {
                path: String,
                matches: Vec<MatchLine>,
            }
            #[derive(Serialize)]
            struct MatchLine {
                line: usize,
                text: String,
            }
            let total_matches: usize = results.iter().map(|r| r.matches.len()).sum();
            let items: Vec<FileResult> = results
                .into_iter()
                .map(|r| FileResult {
                    path: r.path,
                    matches: r
                        .matches
                        .into_iter()
                        .map(|m| MatchLine {
                            line: m.line_number,
                            text: m.line_text,
                        })
                        .collect(),
                })
                .collect();
            Response::from_json(&serde_json::json!({
                "scope": "code",
                "query": query,
                "total_files": items.len(),
                "total_matches": total_matches,
                "results": items,
            }))
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

pub(crate) fn get_query(url: &Url, key: &str) -> Option<String> {
    url.query_pairs()
        .find(|(k, _)| k == key)
        .map(|(_, v): (_, _)| v.to_string())
}

/// Resolve a short ref name ("main") or full ref ("refs/heads/main") to a commit hash.
pub(crate) fn resolve_ref(sql: &SqlStorage, name: &str) -> Result<Option<String>> {
    #[derive(serde::Deserialize)]
    struct Row {
        commit_hash: String,
    }

    // Try exact match first
    let rows: Vec<Row> = sql
        .exec(
            "SELECT commit_hash FROM refs WHERE name = ?",
            vec![SqlStorageValue::from(name.to_string())],
        )?
        .to_array()?;

    if let Some(r) = rows.into_iter().next() {
        return Ok(Some(r.commit_hash));
    }

    // Try refs/heads/<name>
    let rows: Vec<Row> = sql
        .exec(
            "SELECT commit_hash FROM refs WHERE name = ?",
            vec![SqlStorageValue::from(format!("refs/heads/{}", name))],
        )?
        .to_array()?;

    if let Some(r) = rows.into_iter().next() {
        return Ok(Some(r.commit_hash));
    }

    // Try refs/tags/<name>
    let rows: Vec<Row> = sql
        .exec(
            "SELECT commit_hash FROM refs WHERE name = ?",
            vec![SqlStorageValue::from(format!("refs/tags/{}", name))],
        )?
        .to_array()?;

    Ok(rows.into_iter().next().map(|r| r.commit_hash))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_search_query_extracts_commit_scope_and_filters() {
        let parsed = parse_search_query("@author:steve @message:fix @path:src/ @ext:rs parser");

        assert_eq!(parsed.fts_query, "author:steve message:fix parser");
        assert_eq!(parsed.path_filter.as_deref(), Some("src/"));
        assert_eq!(parsed.ext_filter.as_deref(), Some("rs"));
        assert_eq!(parsed.scope, Some("commits"));
    }

    #[test]
    fn parse_search_query_preserves_content_prefix_for_code_search() {
        let parsed = parse_search_query("@content:TODO plain terms");

        assert_eq!(parsed.fts_query, "content:TODO plain terms");
        assert_eq!(parsed.path_filter, None);
        assert_eq!(parsed.ext_filter, None);
        assert_eq!(parsed.scope, None);
    }

    #[test]
    fn parse_search_query_uses_last_path_and_extension_filter() {
        let parsed = parse_search_query("@path:src/ @path:tests/ @ext:rs @ext:toml query");

        assert_eq!(parsed.fts_query, "query");
        assert_eq!(parsed.path_filter.as_deref(), Some("tests/"));
        assert_eq!(parsed.ext_filter.as_deref(), Some("toml"));
    }

    #[test]
    fn get_query_returns_first_match_and_decodes_values() {
        let url = Url::parse("https://ripgit.local/search?q=hello%20world&q=ignored&scope=code")
            .expect("url");

        assert_eq!(get_query(&url, "q").as_deref(), Some("hello world"));
        assert_eq!(get_query(&url, "scope").as_deref(), Some("code"));
        assert_eq!(get_query(&url, "missing"), None);
    }
}
