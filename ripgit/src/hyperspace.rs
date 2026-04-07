use crate::{api, git, packages, store, KEYFRAME_INTERVAL};
use std::collections::{BTreeMap, HashMap, HashSet};
use worker::*;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyRequest {
    pub default_branch: Option<String>,
    pub author: String,
    pub email: String,
    pub message: String,
    pub expected_head: Option<String>,
    pub ops: Vec<ApplyOp>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    pub default_branch: Option<String>,
    pub remote_url: Option<String>,
    pub remote_ref: Option<String>,
    pub author: String,
    pub email: String,
    pub message: String,
}

#[derive(serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ApplyOp {
    Put {
        path: String,
        #[serde(rename = "contentBytes")]
        content_bytes: Vec<u8>,
    },
    Delete {
        path: String,
        recursive: Option<bool>,
    },
    Move {
        from: String,
        to: String,
    },
}

#[derive(serde::Serialize)]
struct ApplyResponse<'a> {
    ok: bool,
    head: Option<&'a str>,
    conflict: bool,
    error: Option<String>,
}

#[derive(serde::Serialize)]
struct ImportResponse<'a> {
    ok: bool,
    head: Option<&'a str>,
    changed: bool,
    remote_url: &'a str,
    remote_ref: &'a str,
}

pub fn check_internal_access(req: &Request, env: &Env) -> Option<Result<Response>> {
    let expected = match env.var("RIPGIT_INTERNAL_KEY") {
        Ok(value) => value.to_string(),
        Err(_) => {
            return Some(Response::error(
                "RIPGIT_INTERNAL_KEY is not configured",
                500,
            ))
        }
    };

    let provided = req.headers().get("X-Ripgit-Internal-Key").ok().flatten();
    if provided.as_deref() != Some(expected.as_str()) {
        return Some(Response::error("Unauthorized", 401));
    }

    None
}

pub async fn handle_read(sql: &SqlStorage, req: &Request) -> Result<Response> {
    let url = req.url()?;
    api::handle_file(sql, &url)
}

pub async fn handle_search(sql: &SqlStorage, req: &Request) -> Result<Response> {
    let url = req.url()?;
    let query = match api::get_query(&url, "query") {
        Some(query) if !query.trim().is_empty() => query,
        _ => return Response::error("missing 'query' query parameter", 400),
    };
    let prefix = api::get_query(&url, "prefix").filter(|value| !value.trim().is_empty());
    let limit = api::get_query(&url, "limit")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(500);

    let results = store::search_code(sql, &query, prefix.as_deref(), None, limit)?;
    let total_matches: usize = results.iter().map(|result| result.matches.len()).sum();

    #[derive(serde::Serialize)]
    struct SearchMatch {
        path: String,
        line: usize,
        content: String,
    }

    #[derive(serde::Serialize)]
    struct SearchResponse {
        ok: bool,
        matches: Vec<SearchMatch>,
        truncated: bool,
    }

    let matches = results
        .into_iter()
        .flat_map(|result| {
            result.matches.into_iter().map(move |entry| SearchMatch {
                path: result.path.clone(),
                line: entry.line_number,
                content: entry.line_text,
            })
        })
        .collect::<Vec<_>>();

    Response::from_json(&SearchResponse {
        ok: true,
        matches,
        truncated: total_matches >= 500,
    })
}

pub async fn handle_packages_analyze(
    sql: &SqlStorage,
    req: &Request,
    repo: &str,
) -> Result<Response> {
    let locator = package_source_locator(req, repo)?;
    let analysis = packages::analyze_package(sql, &locator)?;
    Response::from_json(&analysis)
}

pub async fn handle_packages_build(
    sql: &SqlStorage,
    req: &Request,
    repo: &str,
) -> Result<Response> {
    let locator = package_source_locator(req, repo)?;
    let target = match api::get_query(&req.url()?, "target").as_deref() {
        None | Some("dynamic-worker") => packages::PackageBuildTarget::DynamicWorker,
        Some(other) => return Response::error(format!("unsupported build target: {}", other), 400),
    };
    let build = packages::build_package(sql, &locator, target).await?;
    Response::from_json(&build)
}

fn package_source_locator(req: &Request, repo: &str) -> Result<packages::PackageSourceLocator> {
    let url = req.url()?;
    let requested_ref = api::get_query(&url, "ref").unwrap_or_else(|| "main".to_string());
    let Some(subdir) = api::get_query(&url, "subdir") else {
        return Err(Error::RustError(
            "missing 'subdir' query parameter".to_string(),
        ));
    };

    Ok(packages::PackageSourceLocator {
        repo: repo.to_string(),
        requested_ref,
        subdir,
    })
}

pub async fn handle_apply(sql: &SqlStorage, req: &mut Request) -> Result<Response> {
    let body = req.bytes().await?;
    let apply: ApplyRequest = serde_json::from_slice(&body)
        .map_err(|err| Error::RustError(format!("invalid apply request: {}", err)))?;

    let ref_name = workspace_ref_name(apply.default_branch.as_deref().unwrap_or("main"));
    let current_head = api::resolve_ref(sql, &ref_name)?;

    if let Some(expected) = apply.expected_head.as_deref() {
        if current_head.as_deref() != Some(expected) {
            let response = ApplyResponse {
                ok: false,
                head: current_head.as_deref(),
                conflict: true,
                error: Some(format!(
                    "ref {} moved: expected {}, found {}",
                    ref_name,
                    expected,
                    current_head.as_deref().unwrap_or(store::ZERO_HASH),
                )),
            };
            return Response::from_json(&response);
        }
    }

    let mut files = load_head_files(sql, current_head.as_deref())?;
    let mut changed_paths: Vec<String> = Vec::new();

    for op in &apply.ops {
        match op {
            ApplyOp::Put {
                path,
                content_bytes,
            } => {
                let normalized = normalize_rel_path(path, false)?;
                let hash = git_sha1("blob", content_bytes);
                store::store_blob(sql, &hash, content_bytes, &normalized, KEYFRAME_INTERVAL)?;
                files.insert(normalized.clone(), (0o100644, hash));
                changed_paths.push(normalized);
            }
            ApplyOp::Delete { path, recursive } => {
                let normalized = normalize_rel_path(path, false)?;
                delete_path(&mut files, &normalized, recursive.unwrap_or(false))?;
                changed_paths.push(normalized);
            }
            ApplyOp::Move { from, to } => {
                let normalized_from = normalize_rel_path(from, false)?;
                let normalized_to = normalize_rel_path(to, false)?;
                move_path(&mut files, &normalized_from, &normalized_to)?;
                changed_paths.push(normalized_from);
                changed_paths.push(normalized_to);
            }
        }
    }

    if changed_paths.is_empty() {
        let response = ApplyResponse {
            ok: true,
            head: current_head.as_deref(),
            conflict: false,
            error: None,
        };
        return Response::from_json(&response);
    }

    let tree_hash = build_tree_from_files(sql, "", &files)?;
    let timestamp = now_secs();
    let parents = current_head.clone().into_iter().collect::<Vec<_>>();
    let parent_refs = parents.iter().map(String::as_str).collect::<Vec<_>>();
    let raw_commit = serialize_commit_content(
        &tree_hash,
        &parent_refs,
        &apply.author,
        &apply.email,
        timestamp,
        &apply.message,
    );
    let commit_hash = git_sha1("commit", &raw_commit);
    let parsed = store::ParsedCommit {
        tree_hash: tree_hash.clone(),
        parents,
        author: apply.author.clone(),
        author_email: apply.email.clone(),
        author_time: timestamp,
        committer: apply.author.clone(),
        committer_email: apply.email.clone(),
        commit_time: timestamp,
        message: apply.message.clone(),
    };

    store::store_commit(sql, &commit_hash, &parsed, &raw_commit, false)?;

    if let Err(err) = store::update_ref(
        sql,
        &ref_name,
        current_head.as_deref().unwrap_or(store::ZERO_HASH),
        &commit_hash,
    ) {
        let response = ApplyResponse {
            ok: false,
            head: current_head.as_deref(),
            conflict: true,
            error: Some(err.to_string()),
        };
        return Response::from_json(&response);
    }

    store::set_config(sql, "default_branch", &ref_name)?;
    store::rebuild_fts_index(sql, &commit_hash)?;

    let response = ApplyResponse {
        ok: true,
        head: Some(commit_hash.as_str()),
        conflict: false,
        error: None,
    };
    Response::from_json(&response)
}

pub async fn handle_import(sql: &SqlStorage, req: &mut Request) -> Result<Response> {
    let body = req.bytes().await?;
    let import: ImportRequest = serde_json::from_slice(&body)
        .map_err(|err| Error::RustError(format!("invalid import request: {}", err)))?;

    let remote_url = import
        .remote_url
        .clone()
        .or_else(|| store::get_config(sql, "upstream.remote_url").ok().flatten())
        .ok_or_else(|| Error::RustError("remoteUrl is required".to_string()))?;
    let remote_ref = import
        .remote_ref
        .clone()
        .or_else(|| store::get_config(sql, "upstream.remote_ref").ok().flatten())
        .unwrap_or_else(|| "main".to_string());
    let ref_name = workspace_ref_name(import.default_branch.as_deref().unwrap_or("main"));
    store::set_config(sql, "upstream.remote_url", &remote_url)?;
    store::set_config(sql, "upstream.remote_ref", &remote_ref)?;
    store::set_config(sql, "upstream.source", "git-upload-pack")?;

    let fetched = git::fetch_remote_ref(sql, &remote_url, &remote_ref, &ref_name).await?;

    let response = ImportResponse {
        ok: true,
        head: Some(fetched.head.as_str()),
        changed: fetched.changed,
        remote_url: remote_url.as_str(),
        remote_ref: remote_ref.as_str(),
    };
    Response::from_json(&response)
}

fn load_head_files(
    sql: &SqlStorage,
    current_head: Option<&str>,
) -> Result<HashMap<String, (u32, String)>> {
    let Some(head) = current_head else {
        return Ok(HashMap::new());
    };

    #[derive(serde::Deserialize)]
    struct CommitRow {
        tree_hash: String,
    }

    let commits: Vec<CommitRow> = sql
        .exec(
            "SELECT tree_hash FROM commits WHERE hash = ?",
            vec![SqlStorageValue::from(head.to_string())],
        )?
        .to_array()?;

    let Some(commit) = commits.first() else {
        return Ok(HashMap::new());
    };

    flatten_tree(sql, &commit.tree_hash, "")
}

fn workspace_ref_name(default_branch: &str) -> String {
    if default_branch.starts_with("refs/") {
        default_branch.to_string()
    } else {
        format!("refs/heads/{}", default_branch)
    }
}

fn now_secs() -> i64 {
    worker::Date::now().as_millis() as i64 / 1000
}

fn normalize_rel_path(path: &str, allow_empty: bool) -> Result<String> {
    let mut segments: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            return Err(Error::RustError(format!("invalid path: {}", path)));
        }
        segments.push(segment);
    }

    let normalized = segments.join("/");
    if normalized.is_empty() && !allow_empty {
        return Err(Error::RustError("path is required".into()));
    }
    Ok(normalized)
}

fn delete_path(
    files: &mut HashMap<String, (u32, String)>,
    path: &str,
    recursive: bool,
) -> Result<()> {
    if files.remove(path).is_some() {
        return Ok(());
    }

    let marker = format!("{}/.dir", path);
    let prefix = format!("{}/", path);
    let descendants = files
        .keys()
        .filter(|key| **key == marker || key.starts_with(&prefix))
        .cloned()
        .collect::<Vec<_>>();

    if descendants.is_empty() {
        return Err(Error::RustError(format!("path not found: {}", path)));
    }

    if !recursive {
        let has_real_children = descendants.iter().any(|entry| entry != &marker);
        if has_real_children {
            return Err(Error::RustError(format!(
                "ENOTEMPTY: directory not empty, rmdir '{}'",
                path,
            )));
        }
    }

    for entry in descendants {
        files.remove(&entry);
    }

    Ok(())
}

fn move_path(files: &mut HashMap<String, (u32, String)>, from: &str, to: &str) -> Result<()> {
    if from == to {
        return Ok(());
    }

    if path_exists(files, to) {
        return Err(Error::RustError(format!(
            "destination already exists: {}",
            to
        )));
    }

    if let Some(entry) = files.remove(from) {
        files.insert(to.to_string(), entry);
        return Ok(());
    }

    let prefix = format!("{}/", from);
    let descendants = files
        .iter()
        .filter(|(path, _)| path.starts_with(&prefix))
        .map(|(path, entry)| (path.clone(), entry.clone()))
        .collect::<Vec<_>>();

    if descendants.is_empty() {
        return Err(Error::RustError(format!("path not found: {}", from)));
    }

    for (old_path, _) in &descendants {
        let suffix = &old_path[prefix.len()..];
        let candidate = format!("{}/{}", to, suffix);
        if path_exists(files, &candidate) {
            return Err(Error::RustError(format!(
                "destination already exists: {}",
                candidate
            )));
        }
    }

    for (old_path, _) in &descendants {
        files.remove(old_path);
    }
    for (old_path, entry) in descendants {
        let suffix = &old_path[prefix.len()..];
        files.insert(format!("{}/{}", to, suffix), entry);
    }

    Ok(())
}

fn path_exists(files: &HashMap<String, (u32, String)>, path: &str) -> bool {
    if files.contains_key(path) {
        return true;
    }

    let prefix = format!("{}/", path);
    files
        .keys()
        .any(|key| key == &format!("{}/.dir", path) || key.starts_with(&prefix))
}

fn flatten_tree(
    sql: &SqlStorage,
    tree_hash: &str,
    prefix: &str,
) -> Result<HashMap<String, (u32, String)>> {
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

    let mut files = HashMap::new();
    for row in rows {
        let path = if prefix.is_empty() {
            row.name.clone()
        } else {
            format!("{}/{}", prefix, row.name)
        };

        if row.mode == 0o040000 {
            files.extend(flatten_tree(sql, &row.entry_hash, &path)?);
        } else {
            files.insert(path, (row.mode as u32, row.entry_hash));
        }
    }

    Ok(files)
}

fn build_tree_from_files(
    sql: &SqlStorage,
    dir: &str,
    all_files: &HashMap<String, (u32, String)>,
) -> Result<String> {
    let dir_prefix = if dir.is_empty() {
        String::new()
    } else {
        format!("{}/", dir)
    };

    let mut entries: BTreeMap<String, (u32, String)> = BTreeMap::new();
    let mut seen_subdirs: HashSet<String> = HashSet::new();

    for (path, (mode, hash)) in all_files {
        let rel = if dir.is_empty() {
            path.as_str()
        } else if let Some(rest) = path.strip_prefix(&dir_prefix) {
            rest
        } else {
            continue;
        };

        if let Some(pos) = rel.find('/') {
            let subdir_name = &rel[..pos];
            if seen_subdirs.insert(subdir_name.to_string()) {
                let full_subdir = if dir.is_empty() {
                    subdir_name.to_string()
                } else {
                    format!("{}/{}", dir, subdir_name)
                };
                let subtree_hash = build_tree_from_files(sql, &full_subdir, all_files)?;
                entries.insert(subdir_name.to_string(), (0o040000u32, subtree_hash));
            }
        } else {
            entries.insert(rel.to_string(), (*mode, hash.clone()));
        }
    }

    let content = serialize_tree_content(&entries);
    let tree_hash = git_sha1("tree", &content);
    store::store_tree(sql, &tree_hash, &content)?;
    Ok(tree_hash)
}

fn serialize_tree_content(entries: &BTreeMap<String, (u32, String)>) -> Vec<u8> {
    let mut sorted: Vec<(&String, &(u32, String))> = entries.iter().collect();
    sorted.sort_by(|(a_name, (a_mode, _)), (b_name, (b_mode, _))| {
        let a_key = if *a_mode == 0o040000 {
            format!("{}/", a_name)
        } else {
            (*a_name).clone()
        };
        let b_key = if *b_mode == 0o040000 {
            format!("{}/", b_name)
        } else {
            (*b_name).clone()
        };
        a_key.cmp(&b_key)
    });

    let mut buf = Vec::new();
    for (name, (mode, hash)) in &sorted {
        write_tree_entry(&mut buf, *mode, name, hash);
    }
    buf
}

fn write_tree_entry(buf: &mut Vec<u8>, mode: u32, name: &str, hash: &str) {
    let mode_str = format!("{:o}", mode);
    buf.extend_from_slice(mode_str.as_bytes());
    buf.push(b' ');
    buf.extend_from_slice(name.as_bytes());
    buf.push(0);
    if let Ok(bytes) = hex_to_bytes(hash) {
        buf.extend_from_slice(&bytes);
    }
}

fn git_sha1(obj_type: &str, content: &[u8]) -> String {
    let header = format!("{} {}\0", obj_type, content.len());
    let mut hasher = sha1_smol::Sha1::new();
    hasher.update(header.as_bytes());
    hasher.update(content);
    hasher.digest().to_string()
}


fn hex_to_bytes(hex: &str) -> std::result::Result<[u8; 20], ()> {
    if hex.len() != 40 {
        return Err(());
    }

    let mut out = [0u8; 20];
    for i in 0..20 {
        out[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).map_err(|_| ())?;
    }
    Ok(out)
}

fn serialize_commit_content(
    tree_hash: &str,
    parent_hashes: &[&str],
    author_name: &str,
    author_email: &str,
    timestamp: i64,
    message: &str,
) -> Vec<u8> {
    let mut content = format!("tree {}\n", tree_hash);
    for parent in parent_hashes {
        content.push_str(&format!("parent {}\n", parent));
    }
    let ident = format!("{} <{}> {} +0000", author_name, author_email, timestamp);
    content.push_str(&format!("author {}\n", ident));
    content.push_str(&format!("committer {}\n", ident));
    content.push('\n');
    content.push_str(message);
    content.into_bytes()
}
