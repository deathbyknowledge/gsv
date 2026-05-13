//! Repository CAR import validation and index reconstruction.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;
use thiserror::Error;

use crate::car::{encode_car, CarBlock, CarError, DecodedCar};
use crate::cbor::{decode_dag_cbor, CborError};
use crate::cid::{parse_cid, Cid};
use crate::commit::{CommitBlock, CommitError, Did, RepoRev};
use crate::data_model::RepoPath;
use crate::repo::{RepoError, SignedRepository};
use crate::storage::{MemoryRepoStore, RepoBlockStore, StorageError};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportedRepo {
    pub root: Cid,
    pub rev: RepoRev,
    pub records: Vec<ImportedRecord>,
    pub current_car: Vec<u8>,
    pub blocks: Vec<CarBlock>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportedRecord {
    pub path: RepoPath,
    pub cid: Cid,
    pub blob_cids: Vec<Cid>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportRepoOp {
    pub action: ImportRepoAction,
    pub path: RepoPath,
    pub cid: Option<Cid>,
    pub prev: Option<Cid>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImportRepoAction {
    Create,
    Update,
    Delete,
}

impl ImportRepoAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Update => "update",
            Self::Delete => "delete",
        }
    }
}

#[derive(Debug, Error)]
pub enum RepoImportError {
    #[error(transparent)]
    Car(#[from] CarError),

    #[error(transparent)]
    Cbor(#[from] CborError),

    #[error(transparent)]
    Commit(#[from] CommitError),

    #[error(transparent)]
    Repo(#[from] RepoError),

    #[error(transparent)]
    Storage(#[from] StorageError),

    #[error("expected exactly one CAR root, got {count}")]
    ExpectedOneRoot { count: usize },

    #[error("CAR root block `{root}` was not found")]
    MissingRootBlock { root: Cid },

    #[error("commit data root `{root}` was not found")]
    MissingDataRoot { root: Cid },

    #[error("import root DID `{actual}` does not match repo DID `{expected}`")]
    DidMismatch { expected: Did, actual: Did },

    #[error("record `{path}` points to missing block `{cid}`")]
    MissingRecordBlock { path: RepoPath, cid: Cid },

    #[error("record blob reference nesting exceeded max depth {max_depth}")]
    BlobRefDepthExceeded { max_depth: usize },
}

const MAX_BLOB_REF_DEPTH: usize = 32;

pub async fn validate_imported_repo(
    decoded: DecodedCar,
    expected_did: &Did,
) -> Result<ImportedRepo, RepoImportError> {
    if decoded.roots.len() != 1 {
        return Err(RepoImportError::ExpectedOneRoot {
            count: decoded.roots.len(),
        });
    }
    let root = decoded.roots[0];
    if !decoded.blocks.iter().any(|block| block.cid == root) {
        return Err(RepoImportError::MissingRootBlock { root });
    }

    let mut store = MemoryRepoStore::new();
    for block in &decoded.blocks {
        store.put_block_with_cid(block.cid, block.bytes.clone())?;
    }

    let commit =
        CommitBlock::read_from(&store, &root)?.ok_or(RepoImportError::MissingRootBlock { root })?;
    if &commit.commit.did != expected_did {
        return Err(RepoImportError::DidMismatch {
            expected: expected_did.clone(),
            actual: commit.commit.did.clone(),
        });
    }
    if !store.has_block(&commit.commit.data)? {
        return Err(RepoImportError::MissingDataRoot {
            root: commit.commit.data,
        });
    }

    let mut repo = SignedRepository::open(store, root)?;
    let entries = repo.entries().await?;
    let mut records = Vec::with_capacity(entries.len());
    for entry in entries {
        let Some(bytes) = repo.storage().get_block(&entry.cid)? else {
            return Err(RepoImportError::MissingRecordBlock {
                path: entry.path,
                cid: entry.cid,
            });
        };
        let record = decode_dag_cbor::<Value>(&bytes)?;
        records.push(ImportedRecord {
            path: entry.path,
            cid: entry.cid,
            blob_cids: extract_record_blob_refs(&record)?,
        });
    }

    let cids = repo.export_cids().await?;
    let blocks = reachable_repo_blocks(&cids, repo.storage())?;
    let current_car = encode_car(&[root], blocks.clone())?;

    Ok(ImportedRepo {
        root,
        rev: commit.commit.rev,
        records,
        current_car,
        blocks,
    })
}

fn reachable_repo_blocks(
    cids: &[Cid],
    storage: &impl RepoBlockStore,
) -> Result<Vec<CarBlock>, RepoImportError> {
    let mut blocks = Vec::with_capacity(cids.len());
    let mut seen = BTreeSet::new();
    for cid in cids {
        if !seen.insert(*cid) {
            continue;
        }
        let bytes = storage
            .get_block(cid)?
            .ok_or(CarError::MissingBlock { cid: *cid })?;
        blocks.push(CarBlock { cid: *cid, bytes });
    }
    Ok(blocks)
}

pub fn diff_imported_records(
    existing: impl IntoIterator<Item = (RepoPath, Cid)>,
    imported: &[ImportedRecord],
) -> Vec<ImportRepoOp> {
    let existing = existing.into_iter().collect::<BTreeMap<_, _>>();
    let imported = imported
        .iter()
        .map(|record| (record.path.clone(), record.cid))
        .collect::<BTreeMap<_, _>>();

    let mut ops = Vec::new();
    for (path, cid) in &imported {
        match existing.get(path).copied() {
            None => ops.push(ImportRepoOp {
                action: ImportRepoAction::Create,
                path: path.clone(),
                cid: Some(*cid),
                prev: None,
            }),
            Some(prev) if prev != *cid => ops.push(ImportRepoOp {
                action: ImportRepoAction::Update,
                path: path.clone(),
                cid: Some(*cid),
                prev: Some(prev),
            }),
            Some(_) => {}
        }
    }

    for (path, prev) in existing {
        if !imported.contains_key(&path) {
            ops.push(ImportRepoOp {
                action: ImportRepoAction::Delete,
                path,
                cid: None,
                prev: Some(prev),
            });
        }
    }

    ops
}

pub fn extract_record_blob_refs(record: &Value) -> Result<Vec<Cid>, RepoImportError> {
    let mut cids = BTreeSet::new();
    collect_record_blob_refs(record, &mut cids, 0)?;
    Ok(cids.into_iter().collect())
}

fn collect_record_blob_refs(
    record: &Value,
    cids: &mut BTreeSet<Cid>,
    depth: usize,
) -> Result<(), RepoImportError> {
    if depth > MAX_BLOB_REF_DEPTH {
        return Err(RepoImportError::BlobRefDepthExceeded {
            max_depth: MAX_BLOB_REF_DEPTH,
        });
    }
    match record {
        Value::Object(map) => {
            if map.get("$type").and_then(Value::as_str) == Some("blob") {
                if let Some(cid) = map
                    .get("ref")
                    .and_then(Value::as_object)
                    .and_then(|ref_obj| ref_obj.get("$link"))
                    .and_then(Value::as_str)
                {
                    cids.insert(parse_cid(cid).map_err(CarError::Cid)?);
                }
            }
            for value in map.values() {
                collect_record_blob_refs(value, cids, depth + 1)?;
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_record_blob_refs(value, cids, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use futures_executor::block_on;
    use serde::Serialize;
    use serde_json::json;
    use sha2::{Digest, Sha256};

    use super::*;
    use crate::car::{decode_car, encode_car_from_store};
    use crate::cbor::encode_block;
    use crate::cid::raw_cid;
    use crate::commit::{CommitSigner, RepoRev};
    use crate::data_model::{Nsid, RecordKey};
    use crate::repo::RepoWrite;

    #[derive(Serialize)]
    struct TestRecord {
        #[serde(rename = "$type")]
        record_type: String,
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        attachment: Option<Value>,
    }

    fn did() -> Did {
        Did::new("did:web:example.com").unwrap()
    }

    fn other_did() -> Did {
        Did::new("did:web:elsewhere.example").unwrap()
    }

    fn rev(value: &str) -> RepoRev {
        RepoRev::new(value).unwrap()
    }

    fn path(rkey: &str) -> RepoPath {
        RepoPath::new(
            Nsid::new("app.gsv.record").unwrap(),
            RecordKey::new(rkey).unwrap(),
        )
    }

    fn record(text: &str) -> TestRecord {
        TestRecord {
            record_type: "app.gsv.record".to_string(),
            text: text.to_string(),
            attachment: None,
        }
    }

    fn record_with_blob(text: &str, cid: Cid) -> TestRecord {
        TestRecord {
            record_type: "app.gsv.record".to_string(),
            text: text.to_string(),
            attachment: Some(json!({
                "$type": "blob",
                "ref": { "$link": cid.to_string() },
                "mimeType": "text/plain",
                "size": 5,
            })),
        }
    }

    struct HashSigner;

    impl CommitSigner for HashSigner {
        fn sign_commit(&self, signable_bytes: &[u8]) -> Result<Vec<u8>, String> {
            Ok(Sha256::digest(signable_bytes).to_vec())
        }
    }

    async fn repo_car(repo_did: Did) -> Vec<u8> {
        let mut repo = SignedRepository::create(
            MemoryRepoStore::new(),
            repo_did,
            rev("2222222222222"),
            &HashSigner,
        )
        .await
        .unwrap();
        let blob_cid = raw_cid(b"hello");
        repo.apply_writes(
            vec![
                RepoWrite::Create {
                    path: path("one"),
                    record: record_with_blob("one", blob_cid),
                },
                RepoWrite::Create {
                    path: path("two"),
                    record: record("two"),
                },
            ],
            rev("2222222222223"),
            &HashSigner,
        )
        .await
        .unwrap();

        let cids = repo.export_cids().await.unwrap();
        encode_car_from_store(&[repo.latest_commit_cid()], cids, repo.storage()).unwrap()
    }

    #[test]
    fn validates_imported_repo_and_rebuilds_record_metadata() {
        block_on(async {
            let car = repo_car(did()).await;
            let imported = validate_imported_repo(decode_car(&car).unwrap(), &did())
                .await
                .unwrap();

            assert_eq!(imported.records.len(), 2);
            assert_eq!(imported.rev, rev("2222222222223"));
            assert!(!imported.current_car.is_empty());
            assert!(imported.records.iter().any(|record| {
                record.path == path("one") && record.blob_cids == vec![raw_cid(b"hello")]
            }));
        });
    }

    #[test]
    fn rejects_import_with_wrong_did() {
        block_on(async {
            let car = repo_car(other_did()).await;
            assert!(matches!(
                validate_imported_repo(decode_car(&car).unwrap(), &did()).await,
                Err(RepoImportError::DidMismatch { .. })
            ));
        });
    }

    #[test]
    fn rejects_import_without_single_root() {
        block_on(async {
            let car = repo_car(did()).await;
            let decoded = decode_car(&car).unwrap();
            let without_root = DecodedCar {
                roots: Vec::new(),
                blocks: decoded.blocks.clone(),
            };
            assert!(matches!(
                validate_imported_repo(without_root, &did()).await,
                Err(RepoImportError::ExpectedOneRoot { count: 0 })
            ));

            let missing_root = DecodedCar {
                roots: decoded.roots,
                blocks: Vec::new(),
            };
            assert!(matches!(
                validate_imported_repo(missing_root, &did()).await,
                Err(RepoImportError::MissingRootBlock { .. })
            ));
        });
    }

    #[test]
    fn rejects_import_with_missing_data_root() {
        block_on(async {
            let car = repo_car(did()).await;
            let decoded = decode_car(&car).unwrap();
            let root = decoded.roots[0];

            let mut store = MemoryRepoStore::new();
            for block in &decoded.blocks {
                store
                    .put_block_with_cid(block.cid, block.bytes.clone())
                    .unwrap();
            }
            let commit = CommitBlock::read_from(&store, &root).unwrap().unwrap();
            let data_root = commit.commit.data;
            let without_data_root = DecodedCar {
                roots: decoded.roots,
                blocks: decoded
                    .blocks
                    .into_iter()
                    .filter(|block| block.cid != data_root)
                    .collect(),
            };

            assert!(matches!(
                validate_imported_repo(without_data_root, &did()).await,
                Err(RepoImportError::MissingDataRoot { root }) if root == data_root
            ));
        });
    }

    #[test]
    fn prunes_unreachable_blocks_from_imported_repo() {
        block_on(async {
            let car = repo_car(did()).await;
            let mut decoded = decode_car(&car).unwrap();
            let extra = encode_block(&json!({ "unused": true })).unwrap();
            decoded.blocks.push(CarBlock {
                cid: extra.cid,
                bytes: extra.bytes,
            });

            let imported = validate_imported_repo(decoded, &did()).await.unwrap();
            assert!(!imported.blocks.iter().any(|block| block.cid == extra.cid));

            let exported = decode_car(&imported.current_car).unwrap();
            assert!(!exported.blocks.iter().any(|block| block.cid == extra.cid));
            assert_eq!(exported.blocks, imported.blocks);
        });
    }

    #[test]
    fn rejects_deep_blob_ref_nesting() {
        let mut value = json!({
            "$type": "blob",
            "ref": { "$link": raw_cid(b"hello").to_string() },
            "mimeType": "text/plain",
            "size": 5,
        });
        for _ in 0..=MAX_BLOB_REF_DEPTH {
            value = json!({ "child": value });
        }

        assert!(matches!(
            extract_record_blob_refs(&value),
            Err(RepoImportError::BlobRefDepthExceeded { max_depth })
                if max_depth == MAX_BLOB_REF_DEPTH
        ));
    }

    #[test]
    fn diffs_imported_records_against_existing_records() {
        let unchanged = path("unchanged");
        let updated = path("updated");
        let deleted = path("deleted");
        let created = path("created");
        let unchanged_cid = raw_cid(b"same");
        let old_cid = raw_cid(b"old");
        let new_cid = raw_cid(b"new");
        let deleted_cid = raw_cid(b"deleted");

        let ops = diff_imported_records(
            [
                (unchanged.clone(), unchanged_cid),
                (updated.clone(), old_cid),
                (deleted.clone(), deleted_cid),
            ],
            &[
                ImportedRecord {
                    path: unchanged,
                    cid: unchanged_cid,
                    blob_cids: Vec::new(),
                },
                ImportedRecord {
                    path: updated.clone(),
                    cid: new_cid,
                    blob_cids: Vec::new(),
                },
                ImportedRecord {
                    path: created.clone(),
                    cid: raw_cid(b"created"),
                    blob_cids: Vec::new(),
                },
            ],
        );

        assert_eq!(ops.len(), 3);
        assert!(ops.iter().any(|op| {
            op.action == ImportRepoAction::Create && op.path == created && op.prev.is_none()
        }));
        assert!(ops.iter().any(|op| {
            op.action == ImportRepoAction::Update && op.path == updated && op.prev == Some(old_cid)
        }));
        assert!(ops.iter().any(|op| {
            op.action == ImportRepoAction::Delete
                && op.path == deleted
                && op.prev == Some(deleted_cid)
                && op.cid.is_none()
        }));
    }

    #[test]
    fn decode_car_still_rejects_truncated_imports() {
        let mut car = block_on(repo_car(did()));
        car.pop();

        assert!(decode_car(&car).is_err());
    }
}
