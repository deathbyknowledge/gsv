//! Git smart HTTP protocol handlers for receive-pack and upload-pack.

use crate::{pack, store, KEYFRAME_INTERVAL};
use std::collections::{HashMap, HashSet, VecDeque};
use worker::*;

// ---------------------------------------------------------------------------
// git-receive-pack (handles `git push`)
// ---------------------------------------------------------------------------

/// Process a git-receive-pack POST request.
///
/// Uses a streaming approach: builds a lightweight index of the pack entries,
/// then processes objects by type (commits → trees → blobs), decompressing
/// each entry on-demand from the pack bytes. Only one resolved object is held
/// in memory at a time, keeping peak memory to pack_size + O(1 object).
///
/// 1. Parse pkt-line ref update commands
/// 2. Build pack index (decompress-to-sink, no data held)
/// 3. Pre-compute types by following OFS_DELTA chains
/// 4. Process commits (decompress, store, drop)
/// 5. Process trees (decompress, store, drop)
/// 6. Resolve blob paths (all trees now in DB)
/// 7. Process blobs (decompress, store with xpatch compression, drop)
/// 8. Update refs
/// 9. Return report-status
pub fn handle_receive_pack(sql: &SqlStorage, body: &[u8]) -> Result<Response> {
    // --- 1. Parse ref update commands from pkt-lines ---
    let request = parse_receive_pack_request(body);
    let preferred_sideband_mode = preferred_sideband_mode(&request.capabilities);
    let sideband_mode = match requested_sideband_mode(&request.capabilities) {
        Ok(mode) => mode,
        Err(e) => {
            return protocol_fatal_response(
                "git-receive-pack",
                &format!("receive-pack capabilities: {}", e),
                preferred_sideband_mode,
            )
        }
    };
    let send_progress = should_send_receive_progress(&request, sideband_mode);

    // Git splits large pushes (>http.postBuffer) into two POSTs:
    //   1st: a 4-byte flush "0000" (no commands, no pack)
    //   2nd: the full payload (commands + flush + pack)
    // Return 200 for the probe so git proceeds with the real request.
    if request.commands.is_empty() {
        let mut resp = Response::from_bytes(Vec::new())?;
        resp.headers_mut()
            .set("Content-Type", "application/x-git-receive-pack-result")?;
        return Ok(resp);
    }

    // --- Check bulk mode (skip_fts=1 skips commit graph + FTS indexing) ---
    let result: Result<Response> = (|| {
        let bulk_mode = store::get_config(sql, "skip_fts")?
            .map(|v| v == "1")
            .unwrap_or(false);

        // --- 2-7. Process pack data (streaming) ---
        // Note: Cloudflare DO SQLite does not support BEGIN/COMMIT via sql.exec().
        // transactionSync() is not available in workers-rs 0.7.5.
        // Each sql.exec() auto-commits individually. If the DO times out mid-push,
        // partial state may result. Use the admin/set-ref endpoint to recover.
        // TODO: look into getting transaction support in workers-rs
        let pack_data = &body[request.pack_offset..];

        // Reject oversized packs before any object is parsed.  A clean ng response
        // is far better than an OOM panic mid-push.  The push script already splits
        // at 30 MB; this is a server-side safety net.
        if pack_data.len() > pack::MAX_PACK_BYTES {
            let reason = format!(
                "pack too large ({} MB, limit {} MB)",
                pack_data.len() / 1_000_000,
                pack::MAX_PACK_BYTES / 1_000_000,
            );
            let status_body = build_unpack_error_status(&request.commands, &reason);
            let progress = if send_progress {
                receive_pack_progress_messages(
                    &request,
                    pack_data.len(),
                    0,
                    request.commands.len(),
                    false,
                )
            } else {
                Vec::new()
            };
            return protocol_result_response(
                "git-receive-pack",
                maybe_sideband_wrap_with_progress(status_body, &progress, sideband_mode),
            );
        }

        if pack_data.len() > 4 && &pack_data[..4] == b"PACK" {
            process_pack_streaming(sql, pack_data, bulk_mode)?;
        }

        // --- 8. Update refs ---
        let mut results: Vec<(String, std::result::Result<(), String>)> = Vec::new();

        for cmd in &request.commands {
            let result = store::update_ref(sql, &cmd.ref_name, &cmd.old_hash, &cmd.new_hash)
                .map_err(|e| format!("{}", e));
            results.push((cmd.ref_name.clone(), result));
        }

        // --- Set default branch + rebuild FTS index ---
        for (ref_name, result) in &results {
            if result.is_ok() && ref_name.starts_with("refs/heads/") {
                if store::get_config(sql, "default_branch")?.is_none() {
                    let _ = store::set_config(sql, "default_branch", ref_name);
                }
            }
        }

        let mut rebuilt_default_branch_fts = false;
        if !bulk_mode {
            if let Some(default_ref) = store::get_config(sql, "default_branch")? {
                for cmd in &request.commands {
                    if cmd.ref_name == default_ref {
                        if let Some((_, Ok(()))) = results.iter().find(|(r, _)| r == &cmd.ref_name)
                        {
                            let _ = store::rebuild_fts_index(sql, &cmd.new_hash);
                            rebuilt_default_branch_fts = true;
                        }
                    }
                }
            }
        }

        // --- 9. Return report-status ---
        let status_body = build_report_status(&results);
        let ok_count = results.iter().filter(|(_, result)| result.is_ok()).count();
        let progress = if send_progress {
            receive_pack_progress_messages(
                &request,
                pack_data.len(),
                ok_count,
                results.len().saturating_sub(ok_count),
                rebuilt_default_branch_fts,
            )
        } else {
            Vec::new()
        };

        protocol_result_response(
            "git-receive-pack",
            maybe_sideband_wrap_with_progress(status_body, &progress, sideband_mode),
        )
    })();

    result.or_else(|err| {
        protocol_fatal_response(
            "git-receive-pack",
            &protocol_error_message(&err),
            sideband_mode,
        )
    })
}

/// Process pack data using the streaming two-pass approach.
///
/// Pass 1: `build_index` walks the pack byte stream, recording metadata for
/// each entry (offsets, type, delta base references). Zlib data is decompressed
/// to a sink — no object data is held in memory.
///
/// Pass 2: entries are processed by type. Each is decompressed on-demand from
/// the pack bytes (which stay in memory as the request body), delta chains are
/// resolved iteratively, and the result is stored in permanent tables then
/// dropped. Only one resolved object exists in memory at a time.
fn process_pack_streaming(sql: &SqlStorage, pack_data: &[u8], bulk_mode: bool) -> Result<()> {
    // --- Build lightweight index ---
    let (index, offset_to_idx) = pack::build_index(pack_data).map_err(|e| Error::RustError(e.0))?;

    // --- Pre-compute types by following OFS_DELTA chains ---
    // Returns Some(type) for entries resolvable via OFS_DELTA, None for REF_DELTA.
    let types: Vec<Option<pack::ObjectType>> = (0..index.len())
        .map(|i| pack::resolve_type(&index, &offset_to_idx, i))
        .collect();

    let mut hash_to_idx: HashMap<String, usize> = HashMap::new();

    // Resolve cache: avoids re-decompressing shared delta chain bases.
    // 1024 entries ≈ 20-30 MB, well within DO's 128 MB memory limit.
    let mut cache = pack::ResolveCache::new(1024, pack::CACHE_BUDGET_BYTES);

    // --- Load external bases for thin pack resolution ---
    // Thin packs use REF_DELTAs referencing objects from previous pushes.
    // Collect base hashes not in this pack and load from raw_objects
    // (commits/trees) or reconstruct from the blobs table.
    let mut external: pack::ExternalObjects = HashMap::new();
    for entry in &index {
        if let Some(ref base_hash) = entry.base_hash {
            if !external.contains_key(base_hash.as_str()) {
                // Try raw_objects first (commits and trees)
                if let Ok(Some(raw)) = store::load_raw_object_pub(sql, base_hash) {
                    let obj_type = store::detect_object_type(sql, base_hash);
                    external.insert(base_hash.clone(), (obj_type, raw.into()));
                }
                // Try blobs table (reconstructed from delta chain)
                else if let Ok(Some(blob_data)) = store::reconstruct_blob_by_hash(sql, base_hash)
                {
                    external.insert(
                        base_hash.clone(),
                        (pack::ObjectType::Blob, blob_data.into()),
                    );
                }
            }
        }
    }

    // --- Process commits ---
    let mut root_tree_hashes: Vec<String> = Vec::new();

    for i in 0..index.len() {
        if types[i] != Some(pack::ObjectType::Commit) {
            continue;
        }
        let (_, data) = pack::resolve_entry(
            pack_data,
            &index,
            &offset_to_idx,
            i,
            &hash_to_idx,
            &mut pack::ResolveCtx {
                cache: &mut cache,
                external: &external,
            },
        )
        .map_err(|e| Error::RustError(e.0))?;
        let hash = pack::hash_object(&pack::ObjectType::Commit, &*data);
        hash_to_idx.insert(hash.clone(), i);
        let parsed = store::parse_commit(&*data)
            .map_err(|e| Error::RustError(format!("commit {}: {}", hash, e)))?;
        root_tree_hashes.push(parsed.tree_hash.clone());
        store::store_commit(sql, &hash, &parsed, &*data, bulk_mode)?;
    }

    // --- Process trees ---
    for i in 0..index.len() {
        if types[i] != Some(pack::ObjectType::Tree) {
            continue;
        }
        let (_, data) = pack::resolve_entry(
            pack_data,
            &index,
            &offset_to_idx,
            i,
            &hash_to_idx,
            &mut pack::ResolveCtx {
                cache: &mut cache,
                external: &external,
            },
        )
        .map_err(|e| Error::RustError(e.0))?;
        let hash = pack::hash_object(&pack::ObjectType::Tree, &*data);
        hash_to_idx.insert(hash.clone(), i);
        store::store_tree(sql, &hash, &*data)?;
    }

    // --- Resolve blob paths (all trees now in permanent storage) ---
    let empty_pack_trees: HashMap<String, Vec<store::TreeEntry>> = HashMap::new();
    let blob_paths = store::resolve_blob_paths(sql, &empty_pack_trees, &root_tree_hashes)?;

    // Free memory: commit/tree entries in the resolve cache are no longer needed.
    // This reclaims ~20-30 MB before blob processing, which needs headroom for
    // keyframe decompression and xpatch delta computation.
    cache.clear();

    // --- Process blobs ---
    for i in 0..index.len() {
        if types[i] != Some(pack::ObjectType::Blob) {
            continue;
        }
        let (_, data) = pack::resolve_entry(
            pack_data,
            &index,
            &offset_to_idx,
            i,
            &hash_to_idx,
            &mut pack::ResolveCtx {
                cache: &mut cache,
                external: &external,
            },
        )
        .map_err(|e| Error::RustError(e.0))?;
        let hash = pack::hash_object(&pack::ObjectType::Blob, &*data);
        hash_to_idx.insert(hash.clone(), i);
        let path = blob_paths
            .get(&hash)
            .map(|s| s.as_str())
            .unwrap_or("unknown");
        store::store_blob(sql, &hash, &*data, path, KEYFRAME_INTERVAL)?;
    }

    // --- Handle REF_DELTA entries with unknown types ---
    for i in 0..index.len() {
        if types[i].is_some() {
            continue;
        }
        let resolved = pack::resolve_entry(
            pack_data,
            &index,
            &offset_to_idx,
            i,
            &hash_to_idx,
            &mut pack::ResolveCtx {
                cache: &mut cache,
                external: &external,
            },
        );
        match resolved {
            Ok((obj_type, data)) => {
                let hash = pack::hash_object(&obj_type, &*data);
                hash_to_idx.insert(hash.clone(), i);
                match obj_type {
                    pack::ObjectType::Commit => {
                        let parsed = store::parse_commit(&*data)
                            .map_err(|e| Error::RustError(format!("commit {}: {}", hash, e)))?;
                        store::store_commit(sql, &hash, &parsed, &*data, bulk_mode)?;
                    }
                    pack::ObjectType::Tree => {
                        store::store_tree(sql, &hash, &*data)?;
                    }
                    pack::ObjectType::Blob => {
                        let path = blob_paths
                            .get(&hash)
                            .map(|s| s.as_str())
                            .unwrap_or("unknown");
                        store::store_blob(sql, &hash, &*data, path, KEYFRAME_INTERVAL)?;
                    }
                    pack::ObjectType::Tag => {}
                }
            }
            Err(_) => {}
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// git-upload-pack (handles `git clone` / `git fetch`)
// ---------------------------------------------------------------------------

/// Process a git-upload-pack POST request.
///
/// 1. Parse want/have lines from the client
/// 2. Walk the commit graph to collect all needed objects
/// 3. Reconstruct blob content from xpatch delta chains
/// 4. Generate and return a pack file
pub fn handle_upload_pack(sql: &SqlStorage, body: &[u8]) -> Result<Response> {
    // --- 1. Parse want/have negotiation ---
    let request = parse_upload_request(body);
    let preferred_sideband_mode = preferred_sideband_mode(&request.capabilities);
    let sideband_mode = match requested_sideband_mode(&request.capabilities) {
        Ok(mode) => mode,
        Err(e) => {
            return protocol_fatal_response(
                "git-upload-pack",
                &format!("upload-pack capabilities: {}", e),
                preferred_sideband_mode,
            )
        }
    };
    let send_progress = should_send_upload_progress(&request, sideband_mode);

    let result: Result<Response> = (|| {
        if request.wants.is_empty() {
            return Err(Error::RustError("no want lines received".into()));
        }

        let have_set: HashSet<String> = request.haves.iter().cloned().collect();
        let common_haves = find_common_haves(sql, &request.wants, &request.haves)?;

        let can_send_pack_without_done = !request.done
            && request.capabilities.contains("multi_ack_detailed")
            && request.capabilities.contains("no-done")
            && !common_haves.is_empty();

        if !request.done && !request.haves.is_empty() && !can_send_pack_without_done {
            return protocol_result_response(
                "git-upload-pack",
                build_negotiation_response(&request, &common_haves),
            );
        }

        // --- 2-3. Collect all needed objects (commits, trees, blobs) ---
        let objects = store::collect_objects(sql, &request.wants, &have_set)?;

        // Build response: pkt-line negotiation prefix, then pack data.
        let mut resp_body = build_pack_response_prefix(&request, &common_haves);
        match sideband_mode {
            Some(mode) => {
                if send_progress {
                    for message in upload_pack_progress_messages(objects.len()) {
                        append_sideband_data(&mut resp_body, 2, message.as_bytes(), mode);
                    }
                }
                pack::generate_into(&objects, |chunk| {
                    append_sideband_data(&mut resp_body, 1, chunk, mode)
                });
                resp_body.extend_from_slice(b"0000");
            }
            None => pack::generate_into(&objects, |chunk| resp_body.extend_from_slice(chunk)),
        }

        protocol_result_response("git-upload-pack", resp_body)
    })();

    result.or_else(|err| {
        protocol_fatal_response(
            "git-upload-pack",
            &protocol_error_message(&err),
            sideband_mode,
        )
    })
}

#[derive(Debug, Default)]
struct UploadRequest {
    wants: Vec<String>,
    haves: Vec<String>,
    capabilities: HashSet<String>,
    done: bool,
}

/// Parse want/have lines from a git-upload-pack request body.
///
/// Format (pkt-line encoded):
///   want <hash>[ capabilities]\n
///   ...
///   [have <hash>\n]
///   ...
///   done\n
fn parse_upload_request(data: &[u8]) -> UploadRequest {
    let mut request = UploadRequest::default();
    let mut pos = 0;
    let mut saw_first_want = false;

    loop {
        match read_pkt_line(data, pos) {
            Some((None, new_pos)) => {
                // Flush packet — may separate wants from haves
                pos = new_pos;
            }
            Some((Some(line), new_pos)) => {
                pos = new_pos;
                let text = match std::str::from_utf8(line) {
                    Ok(t) => t.trim_end_matches('\n'),
                    Err(_) => continue,
                };

                if text == "done" {
                    request.done = true;
                    break;
                } else if let Some(rest) = text.strip_prefix("want ") {
                    // First want line may have capabilities after a space
                    let mut fields = rest.split_whitespace();
                    let hash = fields.next().unwrap_or("");
                    if hash.len() == 40 {
                        request.wants.push(hash.to_string());
                    }
                    if !saw_first_want {
                        saw_first_want = true;
                        for capability in fields {
                            request.capabilities.insert(capability.to_string());
                        }
                    }
                } else if let Some(rest) = text.strip_prefix("have ") {
                    let hash = rest.split_whitespace().next().unwrap_or("");
                    if hash.len() == 40 {
                        request.haves.push(hash.to_string());
                    }
                }
            }
            None => break,
        }
    }

    request
}

fn find_common_haves(sql: &SqlStorage, wants: &[String], haves: &[String]) -> Result<Vec<String>> {
    if wants.is_empty() || haves.is_empty() {
        return Ok(Vec::new());
    }

    let want_haves: HashSet<String> = haves.iter().cloned().collect();
    let mut found: HashSet<String> = HashSet::new();
    let mut visited: HashSet<String> = HashSet::new();
    let mut queue: VecDeque<String> = wants.iter().cloned().collect();

    #[derive(serde::Deserialize)]
    struct ParentRow {
        parent_hash: String,
    }

    while let Some(commit_hash) = queue.pop_front() {
        if !visited.insert(commit_hash.clone()) {
            continue;
        }

        if want_haves.contains(&commit_hash) {
            found.insert(commit_hash.clone());
        }

        let parents: Vec<ParentRow> = sql
            .exec(
                "SELECT parent_hash FROM commit_parents
                 WHERE commit_hash = ? ORDER BY ordinal ASC",
                vec![SqlStorageValue::from(commit_hash)],
            )?
            .to_array()?;

        for parent in parents {
            if !visited.contains(&parent.parent_hash) {
                queue.push_back(parent.parent_hash);
            }
        }
    }

    Ok(haves
        .iter()
        .filter(|have| found.contains(*have))
        .cloned()
        .collect())
}

fn build_negotiation_response(request: &UploadRequest, common_haves: &[String]) -> Vec<u8> {
    let mut body = Vec::new();

    match common_haves.last().map(|s| s.as_str()) {
        Some(_) if request.capabilities.contains("multi_ack_detailed") => {
            for common in common_haves {
                pkt_line_bytes(&mut body, format!("ACK {} common\n", common).as_bytes());
            }
            pkt_line_bytes(&mut body, b"NAK\n");
        }
        Some(common) if request.capabilities.contains("multi_ack") => {
            pkt_line_bytes(&mut body, format!("ACK {} continue\n", common).as_bytes());
            pkt_line_bytes(&mut body, b"NAK\n");
        }
        Some(common) => {
            pkt_line_bytes(&mut body, format!("ACK {}\n", common).as_bytes());
        }
        None => pkt_line_bytes(&mut body, b"NAK\n"),
    }

    body
}

fn build_pack_response_prefix(request: &UploadRequest, common_haves: &[String]) -> Vec<u8> {
    let mut body = Vec::new();

    if !request.done
        && request.capabilities.contains("multi_ack_detailed")
        && request.capabilities.contains("no-done")
    {
        if let Some(common) = common_haves.last().map(|s| s.as_str()) {
            for common_have in common_haves {
                pkt_line_bytes(
                    &mut body,
                    format!("ACK {} common\n", common_have).as_bytes(),
                );
            }
            pkt_line_bytes(&mut body, format!("ACK {} ready\n", common).as_bytes());
            pkt_line_bytes(&mut body, b"NAK\n");
            pkt_line_bytes(&mut body, format!("ACK {}\n", common).as_bytes());
            return body;
        }
    }

    if request.done {
        if request.capabilities.contains("multi_ack_detailed")
            || request.capabilities.contains("multi_ack")
        {
            if let Some(common) = common_haves.last().map(|s| s.as_str()) {
                pkt_line_bytes(&mut body, format!("ACK {}\n", common).as_bytes());
                return body;
            }
        }

        if common_haves.is_empty() {
            pkt_line_bytes(&mut body, b"NAK\n");
        }
        return body;
    }

    pkt_line_bytes(&mut body, b"NAK\n");
    body
}

// ---------------------------------------------------------------------------
// Pkt-line parsing for ref commands
// ---------------------------------------------------------------------------

struct RefCommand {
    old_hash: String,
    new_hash: String,
    ref_name: String,
}

#[derive(Default)]
struct ReceivePackRequest {
    commands: Vec<RefCommand>,
    pack_offset: usize,
    capabilities: HashSet<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SidebandMode {
    Small,
    Large,
}

impl SidebandMode {
    fn max_data_len(self) -> usize {
        match self {
            // 4-byte pkt-line length + 1 sideband code + 995 bytes data = 1000 total.
            Self::Small => 995,
            // 4-byte pkt-line length + 1 sideband code + 65515 bytes data = 65520 total.
            Self::Large => 65_515,
        }
    }
}

/// Parse pkt-line encoded ref update commands from the start of the body.
/// Returns the commands and the byte offset where the pack data begins.
fn parse_receive_pack_request(data: &[u8]) -> ReceivePackRequest {
    let mut request = ReceivePackRequest::default();
    let mut pos = 0;
    let mut first_command = true;

    loop {
        match read_pkt_line(data, pos) {
            Some((None, new_pos)) => {
                // Flush packet: end of commands
                pos = new_pos;
                break;
            }
            Some((Some(line), new_pos)) => {
                pos = new_pos;
                if let Some((cmd, capabilities)) = parse_single_command(line) {
                    if first_command {
                        request.capabilities = capabilities;
                        first_command = false;
                    }
                    request.commands.push(cmd);
                }
            }
            None => break, // end of data
        }
    }

    request.pack_offset = pos;
    request
}

/// Read one pkt-line from data at the given position.
/// Returns Some((None, new_pos)) for flush, Some((Some(payload), new_pos))
/// for data, or None if at end of input.
fn read_pkt_line(data: &[u8], pos: usize) -> Option<(Option<&[u8]>, usize)> {
    if pos + 4 > data.len() {
        return None;
    }

    let hex = std::str::from_utf8(&data[pos..pos + 4]).ok()?;
    let len = usize::from_str_radix(hex, 16).ok()?;

    if len == 0 {
        // Flush packet
        return Some((None, pos + 4));
    }
    if len < 4 || pos + len > data.len() {
        return None; // malformed
    }

    let payload = &data[pos + 4..pos + len];
    Some((Some(payload), pos + len))
}

/// Parse a single command line: "<old-hex> <new-hex> <refname>[\0capabilities]\n"
fn parse_single_command(line: &[u8]) -> Option<(RefCommand, HashSet<String>)> {
    // Strip trailing newline
    let line = if line.last() == Some(&b'\n') {
        &line[..line.len() - 1]
    } else {
        line
    };

    let (line, capabilities) = match line.iter().position(|&b| b == 0) {
        Some(pos) => (&line[..pos], parse_capabilities(&line[pos + 1..])),
        None => (line, HashSet::new()),
    };

    let text = std::str::from_utf8(line).ok()?;
    let parts: Vec<&str> = text.splitn(3, ' ').collect();
    if parts.len() != 3 {
        return None;
    }

    Some((
        RefCommand {
            old_hash: parts[0].to_string(),
            new_hash: parts[1].to_string(),
            ref_name: parts[2].to_string(),
        },
        capabilities,
    ))
}

fn parse_capabilities(raw: &[u8]) -> HashSet<String> {
    std::str::from_utf8(raw)
        .ok()
        .map(|text| text.split_whitespace().map(str::to_string).collect())
        .unwrap_or_default()
}

fn preferred_sideband_mode(capabilities: &HashSet<String>) -> Option<SidebandMode> {
    if capabilities.contains("side-band-64k") {
        Some(SidebandMode::Large)
    } else if capabilities.contains("side-band") {
        Some(SidebandMode::Small)
    } else {
        None
    }
}

fn requested_sideband_mode(
    capabilities: &HashSet<String>,
) -> std::result::Result<Option<SidebandMode>, String> {
    let wants_small = capabilities.contains("side-band");
    let wants_large = capabilities.contains("side-band-64k");

    if wants_small && wants_large {
        return Err("client requested both side-band and side-band-64k".into());
    }

    Ok(preferred_sideband_mode(capabilities))
}

fn should_send_upload_progress(
    request: &UploadRequest,
    sideband_mode: Option<SidebandMode>,
) -> bool {
    sideband_mode.is_some() && !request.capabilities.contains("no-progress")
}

fn should_send_receive_progress(
    request: &ReceivePackRequest,
    sideband_mode: Option<SidebandMode>,
) -> bool {
    sideband_mode.is_some() && !request.capabilities.contains("quiet")
}

fn upload_pack_progress_messages(object_count: usize) -> Vec<String> {
    vec![
        format!("Enumerating objects: {}, done.\n", object_count),
        format!(
            "Counting objects: 100% ({}/{}), done.\n",
            object_count, object_count
        ),
        format!(
            "Compressing objects: 100% ({}/{}), done.\n",
            object_count, object_count
        ),
        format!(
            "Total {} (delta 0), reused 0 (delta 0), pack-reused 0\n",
            object_count
        ),
    ]
}

fn receive_pack_progress_messages(
    request: &ReceivePackRequest,
    pack_bytes: usize,
    ok_count: usize,
    failed_count: usize,
    rebuilt_default_branch_fts: bool,
) -> Vec<String> {
    let mut messages = vec![
        format!("Processing {} ref update(s).\n", request.commands.len()),
        format!("Received pack: {} bytes.\n", pack_bytes),
        format!(
            "Updated refs: {} succeeded, {} failed.\n",
            ok_count, failed_count
        ),
    ];

    if rebuilt_default_branch_fts {
        messages.push("Rebuilt search index for the default branch.\n".to_string());
    }

    messages
}

// ---------------------------------------------------------------------------
// Report status
// ---------------------------------------------------------------------------

/// Build a report-status response in pkt-line format.
fn build_report_status(results: &[(String, std::result::Result<(), String>)]) -> Vec<u8> {
    build_report_status_with_unpack_result("ok", results)
}

fn build_unpack_error_status(commands: &[RefCommand], reason: &str) -> Vec<u8> {
    let results: Vec<(String, std::result::Result<(), String>)> = commands
        .iter()
        .map(|cmd| (cmd.ref_name.clone(), Err(reason.to_string())))
        .collect();
    build_report_status_with_unpack_result(reason, &results)
}

fn build_report_status_with_unpack_result(
    unpack_result: &str,
    results: &[(String, std::result::Result<(), String>)],
) -> Vec<u8> {
    let mut buf = Vec::new();

    pkt_line_bytes(&mut buf, format!("unpack {}\n", unpack_result).as_bytes());

    for (ref_name, result) in results {
        match result {
            Ok(()) => {
                let line = format!("ok {}\n", ref_name);
                pkt_line_bytes(&mut buf, line.as_bytes());
            }
            Err(reason) => {
                let line = format!("ng {} {}\n", ref_name, reason);
                pkt_line_bytes(&mut buf, line.as_bytes());
            }
        }
    }

    buf.extend_from_slice(b"0000"); // flush
    buf
}

fn maybe_sideband_wrap_with_progress(
    body: Vec<u8>,
    progress_messages: &[String],
    sideband_mode: Option<SidebandMode>,
) -> Vec<u8> {
    match sideband_mode {
        Some(mode) => {
            let mut wrapped = Vec::new();
            for message in progress_messages {
                append_sideband_data(&mut wrapped, 2, message.as_bytes(), mode);
            }
            append_sideband_data(&mut wrapped, 1, &body, mode);
            wrapped.extend_from_slice(b"0000");
            wrapped
        }
        None => body,
    }
}

fn protocol_result_response(service: &str, body: Vec<u8>) -> Result<Response> {
    let mut resp = Response::from_bytes(body)?;
    resp.headers_mut()
        .set("Content-Type", &format!("application/x-{}-result", service))?;
    Ok(resp)
}

fn protocol_fatal_response(
    service: &str,
    message: &str,
    sideband_mode: Option<SidebandMode>,
) -> Result<Response> {
    protocol_result_response(service, protocol_fatal_body(message, sideband_mode))
}

fn protocol_fatal_body(message: &str, sideband_mode: Option<SidebandMode>) -> Vec<u8> {
    match sideband_mode {
        Some(mode) => {
            let mut body = Vec::new();
            append_sideband_data(
                &mut body,
                3,
                format!("fatal: {}\n", message).as_bytes(),
                mode,
            );
            body.extend_from_slice(b"0000");
            body
        }
        None => {
            let mut body = Vec::new();
            pkt_line_bytes(&mut body, format!("ERR {}\n", message).as_bytes());
            body.extend_from_slice(b"0000");
            body
        }
    }
}

fn protocol_error_message(err: &Error) -> String {
    match err {
        Error::RustError(message) => message.clone(),
        _ => err.to_string(),
    }
}

fn append_sideband_data(buf: &mut Vec<u8>, channel: u8, data: &[u8], mode: SidebandMode) {
    for chunk in data.chunks(mode.max_data_len()) {
        let mut payload = Vec::with_capacity(1 + chunk.len());
        payload.push(channel);
        payload.extend_from_slice(chunk);
        pkt_line_bytes(buf, &payload);
    }
}

fn pkt_line_bytes(buf: &mut Vec<u8>, data: &[u8]) {
    let len = 4 + data.len();
    buf.extend_from_slice(format!("{:04x}", len).as_bytes());
    buf.extend_from_slice(data);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_receive_pack_request_reads_capabilities_and_pack_offset() {
        let mut body = Vec::new();
        pkt_line_bytes(
            &mut body,
            b"0000000000000000000000000000000000000000 0123456789012345678901234567890123456789 refs/heads/main\0report-status side-band-64k ofs-delta\n",
        );
        body.extend_from_slice(b"0000PACK");

        let request = parse_receive_pack_request(&body);

        assert_eq!(request.commands.len(), 1);
        assert_eq!(request.commands[0].ref_name, "refs/heads/main");
        assert_eq!(request.pack_offset, body.len() - 4);
        assert!(request.capabilities.contains("report-status"));
        assert!(request.capabilities.contains("side-band-64k"));
        assert!(request.capabilities.contains("ofs-delta"));
    }

    #[test]
    fn requested_sideband_mode_rejects_conflicting_requests() {
        let capabilities = HashSet::from(["side-band".to_string(), "side-band-64k".to_string()]);

        let err = requested_sideband_mode(&capabilities).expect_err("conflicting sideband");

        assert_eq!(err, "client requested both side-band and side-band-64k");
    }

    #[test]
    fn maybe_sideband_wrap_encodes_report_status_on_channel_one() {
        let body = build_report_status(&[("refs/heads/main".to_string(), Ok(()))]);

        let wrapped =
            maybe_sideband_wrap_with_progress(body.clone(), &[], Some(SidebandMode::Large));

        let mut expected = Vec::new();
        let mut payload = Vec::new();
        payload.push(1);
        payload.extend_from_slice(&body);
        pkt_line_bytes(&mut expected, &payload);
        expected.extend_from_slice(b"0000");
        assert_eq!(wrapped, expected);
    }

    #[test]
    fn maybe_sideband_wrap_with_progress_places_channel_two_before_status() {
        let body = build_report_status(&[("refs/heads/main".to_string(), Ok(()))]);
        let progress = vec!["Processing 1 ref update(s).\n".to_string()];

        let wrapped =
            maybe_sideband_wrap_with_progress(body.clone(), &progress, Some(SidebandMode::Large));

        let mut expected = Vec::new();
        let mut progress_payload = Vec::new();
        progress_payload.push(2);
        progress_payload.extend_from_slice(progress[0].as_bytes());
        pkt_line_bytes(&mut expected, &progress_payload);
        let mut status_payload = Vec::new();
        status_payload.push(1);
        status_payload.extend_from_slice(&body);
        pkt_line_bytes(&mut expected, &status_payload);
        expected.extend_from_slice(b"0000");
        assert_eq!(wrapped, expected);
    }

    #[test]
    fn upload_pack_progress_can_be_suppressed_by_no_progress() {
        let request = UploadRequest {
            capabilities: HashSet::from(["no-progress".to_string()]),
            ..UploadRequest::default()
        };

        assert!(!should_send_upload_progress(
            &request,
            Some(SidebandMode::Large)
        ));
        assert!(should_send_upload_progress(
            &UploadRequest::default(),
            Some(SidebandMode::Large)
        ));
        assert!(!should_send_upload_progress(
            &UploadRequest::default(),
            None
        ));
    }

    #[test]
    fn receive_pack_progress_can_be_suppressed_by_quiet() {
        let request = ReceivePackRequest {
            capabilities: HashSet::from(["quiet".to_string()]),
            ..ReceivePackRequest::default()
        };

        assert!(!should_send_receive_progress(
            &request,
            Some(SidebandMode::Large)
        ));
        assert!(should_send_receive_progress(
            &ReceivePackRequest::default(),
            Some(SidebandMode::Large)
        ));
        assert!(!should_send_receive_progress(
            &ReceivePackRequest::default(),
            None
        ));
    }

    #[test]
    fn upload_pack_progress_messages_include_expected_stages() {
        let messages = upload_pack_progress_messages(7);

        assert_eq!(
            messages,
            vec![
                "Enumerating objects: 7, done.\n",
                "Counting objects: 100% (7/7), done.\n",
                "Compressing objects: 100% (7/7), done.\n",
                "Total 7 (delta 0), reused 0 (delta 0), pack-reused 0\n",
            ]
        );
    }

    #[test]
    fn receive_pack_progress_messages_include_summary_and_rebuild_notice() {
        let request = ReceivePackRequest {
            commands: vec![RefCommand {
                old_hash: store::ZERO_HASH.to_string(),
                new_hash: "0123456789012345678901234567890123456789".to_string(),
                ref_name: "refs/heads/main".to_string(),
            }],
            ..ReceivePackRequest::default()
        };

        let messages = receive_pack_progress_messages(&request, 1234, 1, 0, true);

        assert_eq!(
            messages,
            vec![
                "Processing 1 ref update(s).\n",
                "Received pack: 1234 bytes.\n",
                "Updated refs: 1 succeeded, 0 failed.\n",
                "Rebuilt search index for the default branch.\n",
            ]
        );
    }

    #[test]
    fn append_sideband_data_splits_payloads_at_mode_boundary() {
        let data = vec![b'x'; 1_100];
        let mut wrapped = Vec::new();

        append_sideband_data(&mut wrapped, 1, &data, SidebandMode::Small);

        let mut expected = Vec::new();
        let mut first = vec![1];
        first.extend(vec![b'x'; 995]);
        pkt_line_bytes(&mut expected, &first);
        let mut second = vec![1];
        second.extend(vec![b'x'; 105]);
        pkt_line_bytes(&mut expected, &second);
        assert_eq!(wrapped, expected);
    }

    #[test]
    fn build_unpack_error_status_uses_unpack_error_without_ng_prefix() {
        let commands = vec![RefCommand {
            old_hash: store::ZERO_HASH.to_string(),
            new_hash: "0123456789012345678901234567890123456789".to_string(),
            ref_name: "refs/heads/main".to_string(),
        }];

        let status = build_unpack_error_status(&commands, "pack too large");

        let mut expected = Vec::new();
        pkt_line_bytes(&mut expected, b"unpack pack too large\n");
        pkt_line_bytes(&mut expected, b"ng refs/heads/main pack too large\n");
        expected.extend_from_slice(b"0000");
        assert_eq!(status, expected);
    }

    #[test]
    fn protocol_fatal_body_uses_channel_three_when_sideband_is_active() {
        let body = protocol_fatal_body("boom", Some(SidebandMode::Large));

        let mut expected = Vec::new();
        let mut payload = vec![3];
        payload.extend_from_slice(b"fatal: boom\n");
        pkt_line_bytes(&mut expected, &payload);
        expected.extend_from_slice(b"0000");
        assert_eq!(body, expected);
    }

    #[test]
    fn protocol_fatal_body_uses_err_pkt_line_without_sideband() {
        let body = protocol_fatal_body("boom", None);

        let mut expected = Vec::new();
        pkt_line_bytes(&mut expected, b"ERR boom\n");
        expected.extend_from_slice(b"0000");
        assert_eq!(body, expected);
    }

    #[test]
    fn parse_upload_request_reads_caps_haves_and_done() {
        let mut body = Vec::new();
        pkt_line_bytes(
            &mut body,
            b"want 0123456789012345678901234567890123456789 multi_ack_detailed no-done ofs-delta\n",
        );
        body.extend_from_slice(b"0000");
        pkt_line_bytes(
            &mut body,
            b"have abcdefabcdefabcdefabcdefabcdefabcdefabcd\n",
        );
        pkt_line_bytes(&mut body, b"done\n");

        let request = parse_upload_request(&body);

        assert_eq!(
            request.wants,
            vec!["0123456789012345678901234567890123456789"]
        );
        assert_eq!(
            request.haves,
            vec!["abcdefabcdefabcdefabcdefabcdefabcdefabcd"]
        );
        assert!(request.done);
        assert!(request.capabilities.contains("multi_ack_detailed"));
        assert!(request.capabilities.contains("no-done"));
        assert!(request.capabilities.contains("ofs-delta"));
    }

    #[test]
    fn pack_response_prefix_uses_ack_ready_for_no_done_fetches() {
        let mut capabilities = HashSet::new();
        capabilities.insert("multi_ack_detailed".to_string());
        capabilities.insert("no-done".to_string());
        let request = UploadRequest {
            capabilities,
            ..UploadRequest::default()
        };

        let common_haves = vec!["0123456789012345678901234567890123456789".to_string()];
        let prefix = build_pack_response_prefix(&request, &common_haves);

        let mut expected = Vec::new();
        pkt_line_bytes(
            &mut expected,
            b"ACK 0123456789012345678901234567890123456789 common\n",
        );
        pkt_line_bytes(
            &mut expected,
            b"ACK 0123456789012345678901234567890123456789 ready\n",
        );
        pkt_line_bytes(&mut expected, b"NAK\n");
        pkt_line_bytes(
            &mut expected,
            b"ACK 0123456789012345678901234567890123456789\n",
        );
        assert_eq!(prefix, expected);
    }

    #[test]
    fn negotiation_response_acks_common_commit_before_done() {
        let mut capabilities = HashSet::new();
        capabilities.insert("multi_ack_detailed".to_string());
        let request = UploadRequest {
            capabilities,
            ..UploadRequest::default()
        };

        let response = build_negotiation_response(
            &request,
            &["0123456789012345678901234567890123456789".to_string()],
        );

        let mut expected = Vec::new();
        pkt_line_bytes(
            &mut expected,
            b"ACK 0123456789012345678901234567890123456789 common\n",
        );
        pkt_line_bytes(&mut expected, b"NAK\n");
        assert_eq!(response, expected);
    }
}
