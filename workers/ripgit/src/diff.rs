//! Diff engine: tree comparison and line-level file diffs.
//!
//! Provides recursive tree diffing (which files changed between two commits)
//! and line-level unified diffs via the `similar` crate.

use crate::store;
use serde::Serialize;
use std::collections::HashMap;
use worker::*;

type Url = worker::Url;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffStatus {
    Added,
    Deleted,
    Modified,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileDiff {
    pub path: String,
    pub status: DiffStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hunks: Option<Vec<Hunk>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Hunk {
    pub old_start: usize,
    pub old_count: usize,
    pub new_start: usize,
    pub new_count: usize,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiffLine {
    pub tag: &'static str, // "context", "add", "delete", "binary"
    pub content: String,
}

#[derive(Debug, Serialize)]
pub struct DiffStats {
    pub files_changed: usize,
    pub additions: usize,
    pub deletions: usize,
}

#[derive(Debug, Serialize)]
pub struct CommitDiff {
    pub commit_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_hash: Option<String>,
    pub files: Vec<FileDiff>,
    pub stats: DiffStats,
}

#[derive(Debug, Serialize)]
pub struct Comparison {
    pub base_hash: String,
    pub head_hash: String,
    pub files: Vec<FileDiff>,
    pub stats: DiffStats,
}

// ---------------------------------------------------------------------------
// Tree diff: recursive comparison of two trees
// ---------------------------------------------------------------------------

/// Compare two trees and return a flat list of file-level changes.
/// If `old_tree` is None, all files in `new_tree` are treated as added (root commit).
/// If `new_tree` is None, all files in `old_tree` are treated as deleted.
pub fn diff_trees(
    sql: &SqlStorage,
    old_tree: Option<&str>,
    new_tree: Option<&str>,
) -> Result<Vec<FileDiff>> {
    let mut diffs = Vec::new();
    diff_trees_recursive(sql, old_tree, new_tree, "", &mut diffs)?;
    diffs.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(diffs)
}

fn diff_trees_recursive(
    sql: &SqlStorage,
    old_tree: Option<&str>,
    new_tree: Option<&str>,
    prefix: &str,
    diffs: &mut Vec<FileDiff>,
) -> Result<()> {
    let old_entries = match old_tree {
        Some(hash) => load_tree_entries(sql, hash)?,
        None => HashMap::new(),
    };
    let new_entries = match new_tree {
        Some(hash) => load_tree_entries(sql, hash)?,
        None => HashMap::new(),
    };

    // Collect all entry names, sorted for deterministic output
    let all_names: Vec<String> = {
        let mut set = std::collections::BTreeSet::new();
        for k in old_entries.keys() {
            set.insert(k.clone());
        }
        for k in new_entries.keys() {
            set.insert(k.clone());
        }
        set.into_iter().collect()
    };

    for name in &all_names {
        let full_path = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", prefix, name)
        };

        let old = old_entries.get(name);
        let new = new_entries.get(name);

        match (old, new) {
            // Same hash — nothing changed in this subtree/file
            (Some(o), Some(n)) if o.hash == n.hash => continue,

            // Both exist, different hashes
            (Some(o), Some(n)) => {
                let o_is_tree = o.mode == 0o040000;
                let n_is_tree = n.mode == 0o040000;

                match (o_is_tree, n_is_tree) {
                    (true, true) => {
                        // Both subtrees — recurse
                        diff_trees_recursive(sql, Some(&o.hash), Some(&n.hash), &full_path, diffs)?;
                    }
                    (false, false) => {
                        // Both blobs — file modified
                        diffs.push(FileDiff {
                            path: full_path,
                            status: DiffStatus::Modified,
                            old_hash: Some(o.hash.clone()),
                            new_hash: Some(n.hash.clone()),
                            hunks: None,
                        });
                    }
                    (true, false) => {
                        // Was subtree, now blob: delete old tree contents, add new blob
                        diff_trees_recursive(sql, Some(&o.hash), None, &full_path, diffs)?;
                        diffs.push(FileDiff {
                            path: full_path,
                            status: DiffStatus::Added,
                            old_hash: None,
                            new_hash: Some(n.hash.clone()),
                            hunks: None,
                        });
                    }
                    (false, true) => {
                        // Was blob, now subtree: delete old blob, add new tree contents
                        diffs.push(FileDiff {
                            path: full_path.clone(),
                            status: DiffStatus::Deleted,
                            old_hash: Some(o.hash.clone()),
                            new_hash: None,
                            hunks: None,
                        });
                        diff_trees_recursive(sql, None, Some(&n.hash), &full_path, diffs)?;
                    }
                }
            }

            // Only in old tree — deleted
            (Some(o), None) => {
                if o.mode == 0o040000 {
                    diff_trees_recursive(sql, Some(&o.hash), None, &full_path, diffs)?;
                } else {
                    diffs.push(FileDiff {
                        path: full_path,
                        status: DiffStatus::Deleted,
                        old_hash: Some(o.hash.clone()),
                        new_hash: None,
                        hunks: None,
                    });
                }
            }

            // Only in new tree — added
            (None, Some(n)) => {
                if n.mode == 0o040000 {
                    diff_trees_recursive(sql, None, Some(&n.hash), &full_path, diffs)?;
                } else {
                    diffs.push(FileDiff {
                        path: full_path,
                        status: DiffStatus::Added,
                        old_hash: None,
                        new_hash: Some(n.hash.clone()),
                        hunks: None,
                    });
                }
            }

            (None, None) => unreachable!(),
        }
    }

    Ok(())
}

struct TreeEntryInfo {
    mode: u32,
    hash: String,
}

fn load_tree_entries(sql: &SqlStorage, tree_hash: &str) -> Result<HashMap<String, TreeEntryInfo>> {
    #[derive(serde::Deserialize)]
    struct Row {
        name: String,
        mode: i64,
        entry_hash: String,
    }

    let rows: Vec<Row> = sql
        .exec(
            "SELECT name, mode, entry_hash FROM trees WHERE tree_hash = ?",
            vec![SqlStorageValue::from(tree_hash.to_string())],
        )?
        .to_array()?;

    let mut map = HashMap::with_capacity(rows.len());
    for row in rows {
        map.insert(
            row.name,
            TreeEntryInfo {
                mode: row.mode as u32,
                hash: row.entry_hash,
            },
        );
    }
    Ok(map)
}

// ---------------------------------------------------------------------------
// Line-level diff using `similar`
// ---------------------------------------------------------------------------

/// Compute a line-level diff between two blobs. Returns hunks with context.
pub fn diff_blobs(old_content: &[u8], new_content: &[u8], context_lines: usize) -> Vec<Hunk> {
    if is_binary(old_content) || is_binary(new_content) {
        return vec![Hunk {
            old_start: 0,
            old_count: 0,
            new_start: 0,
            new_count: 0,
            lines: vec![DiffLine {
                tag: "binary",
                content: "Binary files differ".to_string(),
            }],
        }];
    }

    let old_text = String::from_utf8_lossy(old_content);
    let new_text = String::from_utf8_lossy(new_content);

    let diff = similar::TextDiff::from_lines(old_text.as_ref(), new_text.as_ref());
    let mut hunks = Vec::new();

    for group in diff.grouped_ops(context_lines) {
        if group.is_empty() {
            continue;
        }

        let old_range_start = group.first().unwrap().old_range().start;
        let old_range_end = group.last().unwrap().old_range().end;
        let new_range_start = group.first().unwrap().new_range().start;
        let new_range_end = group.last().unwrap().new_range().end;

        let mut lines = Vec::new();
        for op in &group {
            for change in diff.iter_changes(op) {
                let tag = match change.tag() {
                    similar::ChangeTag::Equal => "context",
                    similar::ChangeTag::Insert => "add",
                    similar::ChangeTag::Delete => "delete",
                };
                lines.push(DiffLine {
                    tag,
                    content: change.value().to_string(),
                });
            }
        }

        hunks.push(Hunk {
            old_start: if old_range_start == old_range_end {
                0
            } else {
                old_range_start + 1
            },
            old_count: old_range_end - old_range_start,
            new_start: if new_range_start == new_range_end {
                0
            } else {
                new_range_start + 1
            },
            new_count: new_range_end - new_range_start,
            lines,
        });
    }

    hunks
}

/// Check for null bytes in the first 8 KiB — heuristic for binary content.
fn is_binary(data: &[u8]) -> bool {
    let check_len = data.len().min(8192);
    data[..check_len].contains(&0)
}

// ---------------------------------------------------------------------------
// High-level diff operations
// ---------------------------------------------------------------------------

/// Diff a commit against its first parent. Root commits diff against empty tree.
/// When `with_content` is true, line-level hunks are computed for each file.
pub fn diff_commit(
    sql: &SqlStorage,
    commit_hash: &str,
    with_content: bool,
    context_lines: usize,
) -> Result<CommitDiff> {
    let (tree_hash, parents) = load_commit_info(sql, commit_hash)?;

    let parent_tree = if let Some(parent_hash) = parents.first() {
        let (pt, _) = load_commit_info(sql, parent_hash)?;
        Some(pt)
    } else {
        None // root commit — everything is new
    };

    let mut files = diff_trees(sql, parent_tree.as_deref(), Some(&tree_hash))?;

    if with_content {
        populate_hunks(sql, &mut files, context_lines)?;
    }

    let stats = compute_stats(&files);

    Ok(CommitDiff {
        commit_hash: commit_hash.to_string(),
        parent_hash: parents.into_iter().next(),
        files,
        stats,
    })
}

/// Diff two commits by comparing their trees.
pub fn compare(
    sql: &SqlStorage,
    base_hash: &str,
    head_hash: &str,
    with_content: bool,
    context_lines: usize,
) -> Result<Comparison> {
    let (base_tree, _) = load_commit_info(sql, base_hash)?;
    let (head_tree, _) = load_commit_info(sql, head_hash)?;

    let mut files = diff_trees(sql, Some(&base_tree), Some(&head_tree))?;

    if with_content {
        populate_hunks(sql, &mut files, context_lines)?;
    }

    let stats = compute_stats(&files);

    Ok(Comparison {
        base_hash: base_hash.to_string(),
        head_hash: head_hash.to_string(),
        files,
        stats,
    })
}

/// Fill in line-level hunks for every file diff.
fn populate_hunks(sql: &SqlStorage, files: &mut [FileDiff], context_lines: usize) -> Result<()> {
    for file in files.iter_mut() {
        let old = match &file.old_hash {
            Some(h) => load_blob_content(sql, h)?.unwrap_or_default(),
            None => Vec::new(),
        };
        let new = match &file.new_hash {
            Some(h) => load_blob_content(sql, h)?.unwrap_or_default(),
            None => Vec::new(),
        };
        file.hunks = Some(diff_blobs(&old, &new, context_lines));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
            let content = store::reconstruct_blob(sql, info.group_id, info.version_in_group)?;
            Ok(Some(content))
        }
        None => Ok(None),
    }
}

fn load_commit_info(sql: &SqlStorage, hash: &str) -> Result<(String, Vec<String>)> {
    #[derive(serde::Deserialize)]
    struct CommitRow {
        tree_hash: String,
    }

    let commits: Vec<CommitRow> = sql
        .exec(
            "SELECT tree_hash FROM commits WHERE hash = ?",
            vec![SqlStorageValue::from(hash.to_string())],
        )?
        .to_array()?;

    let tree_hash = commits
        .into_iter()
        .next()
        .ok_or_else(|| Error::RustError(format!("commit not found: {}", hash)))?
        .tree_hash;

    #[derive(serde::Deserialize)]
    struct ParentRow {
        parent_hash: String,
    }

    let parents: Vec<String> = sql
        .exec(
            "SELECT parent_hash FROM commit_parents
             WHERE commit_hash = ? ORDER BY ordinal ASC",
            vec![SqlStorageValue::from(hash.to_string())],
        )?
        .to_array::<ParentRow>()?
        .into_iter()
        .map(|p| p.parent_hash)
        .collect();

    Ok((tree_hash, parents))
}

fn compute_stats(files: &[FileDiff]) -> DiffStats {
    let mut additions = 0usize;
    let mut deletions = 0usize;

    for file in files {
        if let Some(hunks) = &file.hunks {
            for hunk in hunks {
                for line in &hunk.lines {
                    match line.tag {
                        "add" => additions += 1,
                        "delete" => deletions += 1,
                        _ => {}
                    }
                }
            }
        } else {
            // No content diff — count at file level
            match file.status {
                DiffStatus::Added => additions += 1,
                DiffStatus::Deleted => deletions += 1,
                DiffStatus::Modified => {
                    additions += 1;
                    deletions += 1;
                }
            }
        }
    }

    DiffStats {
        files_changed: files.len(),
        additions,
        deletions,
    }
}

/// Try to resolve a string as a commit hash or ref name.
fn resolve_to_commit(sql: &SqlStorage, name: &str) -> Result<String> {
    // Check if it's already a known commit hash
    #[derive(serde::Deserialize)]
    struct Count {
        n: i64,
    }

    let existing: Count = sql
        .exec(
            "SELECT COUNT(*) AS n FROM commits WHERE hash = ?",
            vec![SqlStorageValue::from(name.to_string())],
        )?
        .one()?;

    if existing.n > 0 {
        return Ok(name.to_string());
    }

    // Try as a ref name
    match crate::api::resolve_ref(sql, name)? {
        Some(hash) => Ok(hash),
        None => Err(Error::RustError(format!(
            "'{}' is not a known commit or ref",
            name
        ))),
    }
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

/// GET /diff/:sha?context=3&stat=1
pub fn handle_diff(sql: &SqlStorage, sha: &str, url: &Url) -> Result<Response> {
    if sha.is_empty() {
        return Response::error("missing commit hash", 400);
    }

    let context: usize = crate::api::get_query(url, "context")
        .and_then(|v| v.parse().ok())
        .unwrap_or(3);
    let stat_only = crate::api::get_query(url, "stat")
        .map(|v| v == "1")
        .unwrap_or(false);

    let result = diff_commit(sql, sha, !stat_only, context)?;
    Response::from_json(&result)
}

/// GET /compare/base...head?context=3&stat=1
pub fn handle_compare(sql: &SqlStorage, spec: &str, url: &Url) -> Result<Response> {
    // Accept both "base...head" (three-dot) and "base..head" (two-dot)
    let (base, head) = if let Some(pos) = spec.find("...") {
        (&spec[..pos], &spec[pos + 3..])
    } else if let Some(pos) = spec.find("..") {
        (&spec[..pos], &spec[pos + 2..])
    } else {
        return Response::error("use /compare/base...head or /compare/base..head", 400);
    };

    if base.is_empty() || head.is_empty() {
        return Response::error("both base and head are required", 400);
    }

    let base_hash = resolve_to_commit(sql, base)?;
    let head_hash = resolve_to_commit(sql, head)?;

    let context: usize = crate::api::get_query(url, "context")
        .and_then(|v| v.parse().ok())
        .unwrap_or(3);
    let stat_only = crate::api::get_query(url, "stat")
        .map(|v| v == "1")
        .unwrap_or(false);

    let result = compare(sql, &base_hash, &head_hash, !stat_only, context)?;
    Response::from_json(&result)
}
