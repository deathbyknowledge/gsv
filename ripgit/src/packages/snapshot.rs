use std::collections::{BTreeMap, BTreeSet, VecDeque};

use serde::Deserialize;
use worker::{Error, Result, SqlStorage, SqlStorageValue};

use super::{
    analyze::analyze_package, normalize_subdir, PackageSnapshot, PackageSourceLocator,
    ResolvedPackageSource,
};

pub(crate) fn snapshot_package(
    sql: &SqlStorage,
    locator: &PackageSourceLocator,
) -> Result<PackageSnapshot> {
    let analysis = analyze_package(sql, locator)?;
    let workspace_package_roots =
        collect_workspace_package_roots(sql, &analysis.source.resolved_commit)?;
    let mut pending_roots = VecDeque::from([normalize_snapshot_root(&analysis.package_root)?]);
    let mut visited_roots = BTreeSet::new();
    let mut files = BTreeMap::new();

    while let Some(root) = pending_roots.pop_front() {
        if !visited_roots.insert(root.clone()) {
            continue;
        }

        collect_utf8_files_for_root(sql, &analysis.source, &root, &mut files)?;
        collect_ancestor_config_files(sql, &analysis.source, &root, &mut files)?;

        if let Some(package_json) = files.get(&join_snapshot_path(&root, "package.json")) {
            for dependency_root in
                collect_local_dependency_roots(&root, package_json, &workspace_package_roots)?
            {
                if !visited_roots.contains(&dependency_root) {
                    pending_roots.push_back(dependency_root);
                }
            }
        }
    }

    Ok(PackageSnapshot {
        source: analysis.source,
        package_root: analysis.package_root,
        files,
    })
}

fn normalize_snapshot_root(root: &str) -> Result<String> {
    let normalized = normalize_subdir(root)?;
    if normalized == "." {
        Ok(String::new())
    } else {
        Ok(normalized)
    }
}

fn join_snapshot_path(root: &str, child: &str) -> String {
    if root.is_empty() {
        child.to_string()
    } else {
        format!("{}/{}", root, child)
    }
}

fn collect_utf8_files_for_root(
    sql: &SqlStorage,
    source: &ResolvedPackageSource,
    root: &str,
    files: &mut BTreeMap<String, String>,
) -> Result<()> {
    let Some(tree_hash) = resolve_tree_hash_at_commit(sql, &source.resolved_commit, root)? else {
        return Ok(());
    };
    collect_utf8_files_under_tree(sql, &tree_hash, root, files)
}

fn collect_ancestor_config_files(
    sql: &SqlStorage,
    source: &ResolvedPackageSource,
    root: &str,
    files: &mut BTreeMap<String, String>,
) -> Result<()> {
    let mut current = Some(root.to_string());
    while let Some(dir) = current {
        for config_name in ["tsconfig.json", "jsconfig.json"] {
            let path = join_snapshot_path(&dir, config_name);
            if files.contains_key(&path) {
                continue;
            }
            if let Some(text) = read_utf8_file_at_commit(sql, &source.resolved_commit, &path)? {
                files.insert(path, text);
            }
        }

        current = parent_snapshot_dir(&dir);
    }
    Ok(())
}

fn resolve_tree_hash_at_commit(
    sql: &SqlStorage,
    commit_hash: &str,
    path: &str,
) -> Result<Option<String>> {
    #[derive(Deserialize)]
    struct CommitRow {
        tree_hash: String,
    }

    #[derive(Deserialize)]
    struct TreeRow {
        mode: i64,
        entry_hash: String,
    }

    let commits: Vec<CommitRow> = sql
        .exec(
            "SELECT tree_hash FROM commits WHERE hash = ?",
            vec![SqlStorageValue::from(commit_hash.to_string())],
        )?
        .to_array()?;
    let Some(commit) = commits.into_iter().next() else {
        return Ok(None);
    };

    if path.is_empty() {
        return Ok(Some(commit.tree_hash));
    }

    let segments: Vec<&str> = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    let mut current_tree = commit.tree_hash;

    for segment in segments {
        let rows: Vec<TreeRow> = sql
            .exec(
                "SELECT mode, entry_hash FROM trees WHERE tree_hash = ? AND name = ?",
                vec![
                    SqlStorageValue::from(current_tree.clone()),
                    SqlStorageValue::from(segment.to_string()),
                ],
            )?
            .to_array()?;

        let Some(entry) = rows.into_iter().next() else {
            return Ok(None);
        };

        if entry.mode != 0o040000 {
            return Ok(None);
        }
        current_tree = entry.entry_hash;
    }

    Ok(Some(current_tree))
}

fn read_utf8_file_at_commit(
    sql: &SqlStorage,
    commit_hash: &str,
    path: &str,
) -> Result<Option<String>> {
    let Some(blob_hash) = resolve_blob_hash_at_commit(sql, commit_hash, path)? else {
        return Ok(None);
    };
    let Some(bytes) = crate::store::reconstruct_blob_by_hash(sql, &blob_hash)? else {
        return Ok(None);
    };
    match String::from_utf8(bytes) {
        Ok(text) => Ok(Some(text)),
        Err(_) => Ok(None),
    }
}

fn resolve_blob_hash_at_commit(
    sql: &SqlStorage,
    commit_hash: &str,
    path: &str,
) -> Result<Option<String>> {
    #[derive(Deserialize)]
    struct CommitRow {
        tree_hash: String,
    }

    #[derive(Deserialize)]
    struct TreeRow {
        mode: i64,
        entry_hash: String,
    }

    let commits: Vec<CommitRow> = sql
        .exec(
            "SELECT tree_hash FROM commits WHERE hash = ?",
            vec![SqlStorageValue::from(commit_hash.to_string())],
        )?
        .to_array()?;
    let Some(commit) = commits.into_iter().next() else {
        return Ok(None);
    };

    let segments: Vec<&str> = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    if segments.is_empty() {
        return Ok(None);
    }

    let mut current_tree = commit.tree_hash;
    let final_index = segments.len() - 1;

    for (index, segment) in segments.into_iter().enumerate() {
        let rows: Vec<TreeRow> = sql
            .exec(
                "SELECT mode, entry_hash FROM trees WHERE tree_hash = ? AND name = ?",
                vec![
                    SqlStorageValue::from(current_tree.clone()),
                    SqlStorageValue::from(segment.to_string()),
                ],
            )?
            .to_array()?;

        let Some(entry) = rows.into_iter().next() else {
            return Ok(None);
        };

        if index == final_index {
            return if entry.mode == 0o100644 || entry.mode == 0o100755 {
                Ok(Some(entry.entry_hash))
            } else {
                Ok(None)
            };
        }

        if entry.mode != 0o040000 {
            return Ok(None);
        }
        current_tree = entry.entry_hash;
    }

    Ok(None)
}

fn collect_utf8_files_under_tree(
    sql: &SqlStorage,
    tree_hash: &str,
    prefix: &str,
    files: &mut BTreeMap<String, String>,
) -> Result<()> {
    #[derive(Deserialize)]
    struct TreeRow {
        name: String,
        mode: i64,
        entry_hash: String,
    }

    let rows: Vec<TreeRow> = sql
        .exec(
            "SELECT name, mode, entry_hash FROM trees WHERE tree_hash = ? ORDER BY name",
            vec![SqlStorageValue::from(tree_hash.to_string())],
        )?
        .to_array()?;

    for entry in rows {
        let path = if prefix.is_empty() {
            entry.name.clone()
        } else {
            format!("{}/{}", prefix, entry.name)
        };

        if entry.mode == 0o040000 {
            collect_utf8_files_under_tree(sql, &entry.entry_hash, &path, files)?;
            continue;
        }

        let Some(bytes) = crate::store::reconstruct_blob_by_hash(sql, &entry.entry_hash)? else {
            return Err(Error::RustError(format!(
                "missing blob for package snapshot file: {}",
                path
            )));
        };
        if let Ok(text) = String::from_utf8(bytes) {
            files.insert(path, text);
        }
    }

    Ok(())
}

#[derive(Deserialize)]
struct SnapshotPackageJson {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    dependencies: BTreeMap<String, String>,
    #[serde(default, rename = "devDependencies", alias = "dev_dependencies")]
    dev_dependencies: BTreeMap<String, String>,
    #[serde(default, rename = "optionalDependencies", alias = "optional_dependencies")]
    optional_dependencies: BTreeMap<String, String>,
}

fn parse_snapshot_package_json(package_json_text: &str) -> Result<SnapshotPackageJson> {
    serde_json::from_str(package_json_text)
        .map_err(|err| Error::RustError(format!("invalid package.json: {}", err)))
}

fn collect_workspace_package_roots(
    sql: &SqlStorage,
    commit_hash: &str,
) -> Result<BTreeMap<String, String>> {
    let Some(tree_hash) = resolve_tree_hash_at_commit(sql, commit_hash, "")? else {
        return Ok(BTreeMap::new());
    };

    let mut roots = BTreeMap::new();
    collect_workspace_package_roots_under_tree(sql, &tree_hash, "", &mut roots)?;
    Ok(roots)
}

fn collect_workspace_package_roots_under_tree(
    sql: &SqlStorage,
    tree_hash: &str,
    prefix: &str,
    roots: &mut BTreeMap<String, String>,
) -> Result<()> {
    #[derive(Deserialize)]
    struct TreeRow {
        name: String,
        mode: i64,
        entry_hash: String,
    }

    let rows: Vec<TreeRow> = sql
        .exec(
            "SELECT name, mode, entry_hash FROM trees WHERE tree_hash = ? ORDER BY name",
            vec![SqlStorageValue::from(tree_hash.to_string())],
        )?
        .to_array()?;

    for entry in &rows {
        if entry.mode != 0o100644 && entry.mode != 0o100755 {
            continue;
        }
        if entry.name != "package.json" {
            continue;
        }

        let Some(bytes) = crate::store::reconstruct_blob_by_hash(sql, &entry.entry_hash)? else {
            return Err(Error::RustError(format!(
                "missing blob for package snapshot file: {}",
                join_snapshot_path(prefix, &entry.name)
            )));
        };
        let Ok(text) = String::from_utf8(bytes) else {
            continue;
        };
        let package_json = parse_snapshot_package_json(&text)?;
        let Some(package_name) = package_json.name else {
            continue;
        };
        roots.entry(package_name).or_insert_with(|| prefix.to_string());
    }

    for entry in rows {
        if entry.mode != 0o040000 {
            continue;
        }

        let child_prefix = join_snapshot_path(prefix, &entry.name);
        collect_workspace_package_roots_under_tree(sql, &entry.entry_hash, &child_prefix, roots)?;
    }

    Ok(())
}

fn collect_local_dependency_roots(
    root: &str,
    package_json_text: &str,
    workspace_package_roots: &BTreeMap<String, String>,
) -> Result<Vec<String>> {
    let package_json = parse_snapshot_package_json(package_json_text)?;
    let mut roots = BTreeSet::new();

    for (package_name, spec) in package_json
        .dependencies
        .iter()
        .chain(package_json.dev_dependencies.iter())
        .chain(package_json.optional_dependencies.iter())
    {
        if let Some(relative) = spec
            .strip_prefix("file:")
            .or_else(|| spec.strip_prefix("link:"))
        {
            let resolved = resolve_relative_package_path(root, relative)?;
            if !resolved.is_empty() {
                roots.insert(resolved);
            }
            continue;
        }

        if spec.starts_with("workspace:") {
            let Some(workspace_root) = workspace_package_roots.get(package_name) else {
                return Err(Error::RustError(format!(
                    "workspace dependency {} is not present in the resolved repository snapshot",
                    package_name
                )));
            };
            if !workspace_root.is_empty() {
                roots.insert(workspace_root.clone());
            }
        }
    }

    Ok(roots.into_iter().collect())
}

fn resolve_relative_package_path(base: &str, relative: &str) -> Result<String> {
    let mut segments: Vec<&str> = if base.is_empty() {
        Vec::new()
    } else {
        base.split('/')
            .filter(|segment| !segment.is_empty())
            .collect()
    };

    let normalized_relative = relative.replace('\\', "/");
    for segment in normalized_relative.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            if segments.pop().is_none() {
                return Err(Error::RustError(format!(
                    "invalid file dependency path: {}",
                    relative
                )));
            }
            continue;
        }
        segments.push(segment);
    }

    Ok(segments.join("/"))
}

fn parent_snapshot_dir(path: &str) -> Option<String> {
    if path.is_empty() {
        return None;
    }
    path.rsplit_once('/')
        .map(|(parent, _)| parent.to_string())
        .or_else(|| Some(String::new()))
}
