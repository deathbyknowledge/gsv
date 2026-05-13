use super::*;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct DirectoryCommitEventRequest {
    #[serde(default, rename = "eventType")]
    pub(super) event_type: DirectoryCommitEventType,
    #[serde(default)]
    pub(super) since: Option<String>,
    #[serde(default, rename = "prevData")]
    pub(super) prev_data: Option<String>,
    #[serde(rename = "blocksBase64")]
    pub(super) blocks_base64: String,
    #[serde(default)]
    pub(super) ops: Vec<DirectoryCommitOp>,
    #[serde(default)]
    pub(super) blobs: Option<Vec<String>>,
}

#[derive(Clone, Debug, Serialize)]
pub(super) struct DirectoryCommitEventPayload {
    #[serde(rename = "eventType")]
    pub(super) event_type: DirectoryCommitEventType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) since: Option<RepoRev>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "prevData")]
    pub(super) prev_data: Option<crate::cid::Cid>,
    pub(super) blocks: Vec<u8>,
    pub(super) ops: Vec<DirectoryCommitOp>,
    pub(super) blobs: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum DirectoryCommitEventType {
    Commit,
    Sync,
}

impl Default for DirectoryCommitEventType {
    fn default() -> Self {
        Self::Commit
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct DirectoryCommitOp {
    pub(super) action: String,
    pub(super) path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) cid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) prev: Option<String>,
}

pub(super) fn directory_commit_ops(ops: &[RepoOperation]) -> Vec<DirectoryCommitOp> {
    ops.iter()
        .map(|op| DirectoryCommitOp {
            action: op.action.as_str().to_string(),
            path: op.path.to_string(),
            cid: op.cid.map(|cid| cid.to_string()),
            prev: op.prev.map(|cid| cid.to_string()),
        })
        .collect()
}

pub(super) fn firehose_commit_frame_exceeds_limits(blocks_len: usize, ops_len: usize) -> bool {
    blocks_len > FIREHOSE_COMMIT_BLOCKS_MAX_BYTES || ops_len > FIREHOSE_COMMIT_OPS_MAX
}

pub(super) fn directory_sync_event_payload_from_store<S>(
    commit_cid: crate::cid::Cid,
    storage: &S,
) -> Result<DirectoryCommitEventPayload, HttpError>
where
    S: RepoBlockStore,
{
    let blocks =
        encode_car_from_store(&[commit_cid], [commit_cid], storage).map_err(HttpError::car)?;
    directory_sync_event_payload_from_car(blocks)
}

pub(super) fn directory_sync_event_payload_from_blocks(
    commit_cid: crate::cid::Cid,
    blocks: &[CarBlock],
) -> Result<DirectoryCommitEventPayload, HttpError> {
    let commit_block = blocks
        .iter()
        .find(|block| block.cid == commit_cid)
        .ok_or_else(|| {
            HttpError::new(
                400,
                format!("imported repo missing root block `{commit_cid}`"),
            )
        })?
        .clone();
    let blocks = encode_car(&[commit_cid], [commit_block]).map_err(HttpError::car)?;
    directory_sync_event_payload_from_car(blocks)
}

pub(super) fn directory_sync_event_payload_from_car(
    blocks: Vec<u8>,
) -> Result<DirectoryCommitEventPayload, HttpError> {
    if blocks.len() > FIREHOSE_SYNC_BLOCKS_MAX_BYTES {
        return Err(HttpError::new(
            500,
            format!(
                "sync event blocks exceed {FIREHOSE_SYNC_BLOCKS_MAX_BYTES} bytes: {}",
                blocks.len()
            ),
        ));
    }
    Ok(DirectoryCommitEventPayload {
        event_type: DirectoryCommitEventType::Sync,
        since: None,
        prev_data: None,
        blocks,
        ops: Vec::new(),
        blobs: Vec::new(),
    })
}

pub(super) fn validate_repo_paths(paths: Vec<String>) -> Result<Vec<RepoPath>, HttpError> {
    paths
        .into_iter()
        .map(|path| RepoPath::parse(&path).map_err(HttpError::bad_request))
        .collect::<Result<BTreeSet<_>, _>>()
        .map(|paths| paths.into_iter().collect())
}

#[derive(Debug, Default)]
pub(super) struct RepoRecordPathOps {
    pub(super) upserts: Vec<RepoPath>,
    pub(super) deletes: Vec<RepoPath>,
}

pub(super) fn repo_record_path_ops_from_commit_ops(
    ops: &[DirectoryCommitOp],
) -> Result<RepoRecordPathOps, HttpError> {
    let mut paths = BTreeMap::new();
    for op in ops {
        let path = RepoPath::parse(&op.path).map_err(HttpError::bad_request)?;
        paths.insert(path, op.action != "delete");
    }
    let (upserts, deletes): (Vec<_>, Vec<_>) = paths.into_iter().partition(|(_, active)| *active);
    Ok(RepoRecordPathOps {
        upserts: upserts.into_iter().map(|(path, _)| path).collect(),
        deletes: deletes.into_iter().map(|(path, _)| path).collect(),
    })
}

pub(super) async fn mutation_diff_cids(
    repo: &mut SignedRepository<SqlRepoStore>,
    mutation: &RepoMutation,
) -> Result<Vec<crate::cid::Cid>, HttpError> {
    let mut seen = BTreeSet::new();
    let mut cids = Vec::new();
    for op in &mutation.ops {
        for cid in repo
            .extract_record_cids(&op.path)
            .await
            .map_err(HttpError::repo)?
        {
            if seen.insert(cid) {
                cids.push(cid);
            }
        }
    }
    if seen.insert(mutation.commit_cid) {
        cids.insert(0, mutation.commit_cid);
    }
    Ok(cids)
}

pub(super) fn previous_data_root(
    store: &SqlRepoStore,
    previous_commit: Option<crate::cid::Cid>,
) -> Result<Option<crate::cid::Cid>, HttpError> {
    previous_commit
        .map(|cid| {
            CommitBlock::read_from(store, &cid)
                .map_err(HttpError::worker)?
                .map(|block| block.commit.data)
                .ok_or_else(|| HttpError::new(500, format!("previous commit `{cid}` not found")))
        })
        .transpose()
}

pub(super) fn subscribe_event_frame(event: &DirectoryEventRow) -> Result<Vec<u8>, HttpError> {
    match event.event_type.as_str() {
        "account" => return subscribe_account_event_frame(event),
        "identity" => return subscribe_identity_event_frame(event),
        "sync" => return subscribe_sync_event_frame(event),
        _ => {}
    }

    let commit = event
        .commit_cid
        .ok_or_else(|| HttpError::new(500, "directory commit event is missing commit cid"))?;
    let rev = event
        .rev
        .as_ref()
        .ok_or_else(|| HttpError::new(500, "directory commit event is missing rev"))?;
    let ops = from_str::<Vec<DirectoryCommitOp>>(&event.ops_json).map_err(HttpError::worker)?;
    let blobs = from_str::<Vec<String>>(&event.blobs_json).map_err(HttpError::worker)?;
    let frame_ops = ops
        .into_iter()
        .map(|op| {
            Ok(SubscribeReposOp {
                action: op.action,
                path: op.path,
                cid: op
                    .cid
                    .map(|cid| parse_cid(&cid).map_err(HttpError::bad_request))
                    .transpose()?,
                prev: op
                    .prev
                    .map(|cid| parse_cid(&cid).map_err(HttpError::bad_request))
                    .transpose()?,
            })
        })
        .collect::<Result<Vec<_>, HttpError>>()?;
    let frame_blobs = blobs
        .into_iter()
        .map(|cid| parse_cid(&cid).map_err(HttpError::bad_request))
        .collect::<Result<Vec<_>, HttpError>>()?;

    let header = SubscribeReposHeader {
        op: 1,
        kind: "#commit",
    };
    let body = SubscribeReposCommit {
        seq: event.seq,
        rebase: false,
        too_big: false,
        repo: event.did.to_string(),
        commit,
        rev: rev.to_string(),
        since: event.since.as_ref().map(|rev| rev.to_string()),
        prev_data: event.prev_data,
        blocks: event.blocks.clone().unwrap_or_default(),
        ops: frame_ops,
        blobs: frame_blobs,
        time: event.created_at.clone(),
    };

    let mut frame = encode_dag_cbor(&header).map_err(HttpError::worker)?;
    frame.extend(encode_dag_cbor(&body).map_err(HttpError::worker)?);
    Ok(frame)
}

pub(super) fn subscribe_error_frame(
    error: &str,
    message: Option<&str>,
) -> Result<Vec<u8>, HttpError> {
    let header = SubscribeReposErrorHeader { op: -1 };
    let body = SubscribeReposError { error, message };
    let mut frame = encode_dag_cbor(&header).map_err(HttpError::worker)?;
    frame.extend(encode_dag_cbor(&body).map_err(HttpError::worker)?);
    Ok(frame)
}

pub(super) fn subscribe_info_frame(
    name: &str,
    message: Option<&str>,
) -> Result<Vec<u8>, HttpError> {
    let header = SubscribeReposHeader {
        op: 1,
        kind: "#info",
    };
    let body = SubscribeReposInfo { name, message };
    let mut frame = encode_dag_cbor(&header).map_err(HttpError::worker)?;
    frame.extend(encode_dag_cbor(&body).map_err(HttpError::worker)?);
    Ok(frame)
}

pub(super) fn subscribe_sync_event_frame(event: &DirectoryEventRow) -> Result<Vec<u8>, HttpError> {
    let rev = event
        .rev
        .as_ref()
        .ok_or_else(|| HttpError::new(500, "directory sync event is missing rev"))?;
    let header = SubscribeReposHeader {
        op: 1,
        kind: "#sync",
    };
    let body = SubscribeReposSync {
        seq: event.seq,
        did: event.did.to_string(),
        blocks: event.blocks.clone().unwrap_or_default(),
        rev: rev.to_string(),
        time: event.created_at.clone(),
    };

    let mut frame = encode_dag_cbor(&header).map_err(HttpError::worker)?;
    frame.extend(encode_dag_cbor(&body).map_err(HttpError::worker)?);
    Ok(frame)
}

pub(super) fn subscribe_identity_event_frame(
    event: &DirectoryEventRow,
) -> Result<Vec<u8>, HttpError> {
    let payload =
        from_str::<DirectoryIdentityEventPayload>(&event.blobs_json).map_err(HttpError::worker)?;
    let header = SubscribeReposHeader {
        op: 1,
        kind: "#identity",
    };
    let body = SubscribeReposIdentity {
        seq: event.seq,
        did: event.did.to_string(),
        handle: payload.handle,
        time: event.created_at.clone(),
    };

    let mut frame = encode_dag_cbor(&header).map_err(HttpError::worker)?;
    frame.extend(encode_dag_cbor(&body).map_err(HttpError::worker)?);
    Ok(frame)
}

pub(super) fn subscribe_account_event_frame(
    event: &DirectoryEventRow,
) -> Result<Vec<u8>, HttpError> {
    let payload =
        from_str::<DirectoryAccountEventPayload>(&event.blobs_json).map_err(HttpError::worker)?;
    let header = SubscribeReposHeader {
        op: 1,
        kind: "#account",
    };
    let body = SubscribeReposAccount {
        seq: event.seq,
        did: event.did.to_string(),
        active: payload.active,
        status: payload.status,
        time: event.created_at.clone(),
    };

    let mut frame = encode_dag_cbor(&header).map_err(HttpError::worker)?;
    frame.extend(encode_dag_cbor(&body).map_err(HttpError::worker)?);
    Ok(frame)
}

#[derive(Serialize)]
pub(super) struct SubscribeReposHeader<'a> {
    op: i64,
    #[serde(rename = "t")]
    kind: &'a str,
}

#[derive(Serialize)]
pub(super) struct SubscribeReposErrorHeader {
    op: i64,
}

#[derive(Serialize)]
pub(super) struct SubscribeReposError<'a> {
    error: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<&'a str>,
}

#[derive(Serialize)]
pub(super) struct SubscribeReposInfo<'a> {
    name: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<&'a str>,
}

#[derive(Serialize)]
pub(super) struct SubscribeReposCommit {
    seq: i64,
    rebase: bool,
    #[serde(rename = "tooBig")]
    too_big: bool,
    repo: String,
    commit: crate::cid::Cid,
    rev: String,
    since: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "prevData")]
    prev_data: Option<crate::cid::Cid>,
    #[serde(with = "serde_bytes")]
    blocks: Vec<u8>,
    ops: Vec<SubscribeReposOp>,
    blobs: Vec<crate::cid::Cid>,
    time: String,
}

#[derive(Serialize)]
pub(super) struct SubscribeReposSync {
    seq: i64,
    did: String,
    #[serde(with = "serde_bytes")]
    blocks: Vec<u8>,
    rev: String,
    time: String,
}

#[derive(Deserialize)]
pub(super) struct DirectoryIdentityEventPayload {
    handle: Option<String>,
}

#[derive(Serialize)]
pub(super) struct SubscribeReposIdentity {
    seq: i64,
    did: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    handle: Option<String>,
    time: String,
}

#[derive(Deserialize)]
pub(super) struct DirectoryAccountEventPayload {
    active: bool,
    status: Option<String>,
}

#[derive(Serialize)]
pub(super) struct SubscribeReposAccount {
    seq: i64,
    did: String,
    active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<String>,
    time: String,
}

#[derive(Serialize)]
pub(super) struct SubscribeReposOp {
    action: String,
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    cid: Option<crate::cid::Cid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    prev: Option<crate::cid::Cid>,
}
