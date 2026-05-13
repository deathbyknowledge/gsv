//! Repository mutation, commit, and record logic.

use serde::de::DeserializeOwned;
use serde::Serialize;
use thiserror::Error;

use crate::cbor::{decode_dag_cbor, encode_block, CborError};
use crate::cid::Cid;
use crate::commit::{
    CommitBlock, CommitError, CommitSigner, Did, RepoRev, SignedCommit, UnsignedCommit,
};
use crate::data_model::{Nsid, RepoPath};
use crate::mst::{MerkleSearchTree, MstEntry, MstError};
use crate::storage::{RepoBlockStore, RepoRecordIndex, StorageError};

#[derive(Debug, Error)]
pub enum RepoError {
    #[error(transparent)]
    Cbor(#[from] CborError),

    #[error(transparent)]
    Storage(#[from] StorageError),

    #[error(transparent)]
    Commit(#[from] CommitError),

    #[error(transparent)]
    Mst(#[from] MstError),

    #[error("record already exists at `{path}`")]
    RecordAlreadyExists { path: RepoPath },

    #[error("record does not exist at `{path}`")]
    RecordNotFound { path: RepoPath },

    #[error("record `{path}` points to missing block `{cid}`")]
    MissingRecordBlock { path: RepoPath, cid: Cid },

    #[error("commit `{cid}` does not exist")]
    MissingCommit { cid: Cid },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredRecord<T> {
    pub path: RepoPath,
    pub cid: Cid,
    pub record: T,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecordListItem {
    pub path: RepoPath,
    pub cid: Cid,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepoMutation {
    pub commit_cid: Cid,
    pub commit: SignedCommit,
    pub mst_root: Cid,
    pub record_cid: Option<Cid>,
    pub ops: Vec<RepoOperation>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepoOperation {
    pub action: RepoOperationAction,
    pub path: RepoPath,
    pub cid: Option<Cid>,
    pub prev: Option<Cid>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RepoOperationAction {
    Create,
    Update,
    Delete,
}

impl RepoOperationAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Update => "update",
            Self::Delete => "delete",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RepoWrite<T> {
    Create { path: RepoPath, record: T },
    Update { path: RepoPath, record: T },
    Delete { path: RepoPath },
}

#[derive(Clone, Debug)]
pub struct Repository<S> {
    storage: S,
}

impl<S> Repository<S> {
    pub fn new(storage: S) -> Self {
        Self { storage }
    }

    pub fn storage(&self) -> &S {
        &self.storage
    }

    pub fn storage_mut(&mut self) -> &mut S {
        &mut self.storage
    }

    pub fn into_storage(self) -> S {
        self.storage
    }
}

#[derive(Clone, Debug)]
pub struct SignedRepository<S> {
    storage: S,
    latest: CommitBlock,
}

impl<S> SignedRepository<S> {
    pub fn latest_commit_cid(&self) -> Cid {
        self.latest.cid
    }

    pub fn latest_commit(&self) -> &SignedCommit {
        &self.latest.commit
    }

    pub fn mst_root(&self) -> Cid {
        self.latest.commit.data
    }

    pub fn storage(&self) -> &S {
        &self.storage
    }

    pub fn storage_mut(&mut self) -> &mut S {
        &mut self.storage
    }

    pub fn into_storage(self) -> S {
        self.storage
    }
}

impl<S> SignedRepository<S>
where
    S: RepoBlockStore,
{
    pub fn open(storage: S, latest_commit_cid: Cid) -> Result<Self, RepoError> {
        let Some(latest) = CommitBlock::read_from(&storage, &latest_commit_cid)? else {
            return Err(RepoError::MissingCommit {
                cid: latest_commit_cid,
            });
        };

        Ok(Self { storage, latest })
    }
}

impl<S> SignedRepository<S>
where
    S: RepoBlockStore + RepoRecordIndex + Send,
{
    pub async fn create(
        storage: S,
        did: Did,
        rev: RepoRev,
        signer: &impl CommitSigner,
    ) -> Result<Self, RepoError> {
        let mut storage = storage;
        let data = {
            let tree = MerkleSearchTree::create(&mut storage).await?;
            tree.root()
        };
        let signed = UnsignedCommit::new(did, data, rev, None).sign_with(signer)?;
        let latest = signed.write_to(&mut storage)?;

        Ok(Self { storage, latest })
    }

    pub async fn create_record<T: Serialize>(
        &mut self,
        path: RepoPath,
        record: &T,
        rev: RepoRev,
        signer: &impl CommitSigner,
    ) -> Result<RepoMutation, RepoError> {
        self.apply_writes(vec![RepoWrite::Create { path, record }], rev, signer)
            .await
    }

    pub async fn update_record<T: Serialize>(
        &mut self,
        path: RepoPath,
        record: &T,
        rev: RepoRev,
        signer: &impl CommitSigner,
    ) -> Result<RepoMutation, RepoError> {
        self.apply_writes(vec![RepoWrite::Update { path, record }], rev, signer)
            .await
    }

    pub async fn delete_record(
        &mut self,
        path: &RepoPath,
        rev: RepoRev,
        signer: &impl CommitSigner,
    ) -> Result<RepoMutation, RepoError> {
        self.apply_writes(
            vec![RepoWrite::<()>::Delete { path: path.clone() }],
            rev,
            signer,
        )
        .await
    }

    pub async fn apply_writes<T: Serialize>(
        &mut self,
        writes: Vec<RepoWrite<T>>,
        rev: RepoRev,
        signer: &impl CommitSigner,
    ) -> Result<RepoMutation, RepoError> {
        let mut record_blocks = Vec::new();
        let mut index_updates = Vec::new();
        let mut ops = Vec::new();

        let mst_root = {
            let mut tree = MerkleSearchTree::open(&mut self.storage, self.latest.commit.data);
            for write in writes {
                match write {
                    RepoWrite::Create { path, record } => {
                        if tree.get(&path).await?.is_some() {
                            return Err(RepoError::RecordAlreadyExists { path });
                        }
                        let block = encode_block(&record)?;
                        tree.add(path.clone(), block.cid).await?;
                        record_blocks.push((block.cid, block.bytes));
                        index_updates.push((path.clone(), Some(block.cid)));
                        ops.push(RepoOperation {
                            action: RepoOperationAction::Create,
                            path,
                            cid: Some(block.cid),
                            prev: None,
                        });
                    }
                    RepoWrite::Update { path, record } => {
                        let Some(previous) = tree.get(&path).await? else {
                            return Err(RepoError::RecordNotFound { path });
                        };
                        let block = encode_block(&record)?;
                        tree.update(path.clone(), block.cid).await?;
                        record_blocks.push((block.cid, block.bytes));
                        index_updates.push((path.clone(), Some(block.cid)));
                        ops.push(RepoOperation {
                            action: RepoOperationAction::Update,
                            path,
                            cid: Some(block.cid),
                            prev: Some(previous),
                        });
                    }
                    RepoWrite::Delete { path } => {
                        let Some(previous) = tree.get(&path).await? else {
                            return Err(RepoError::RecordNotFound { path });
                        };
                        tree.delete(&path).await?;
                        index_updates.push((path.clone(), None));
                        ops.push(RepoOperation {
                            action: RepoOperationAction::Delete,
                            path,
                            cid: None,
                            prev: Some(previous),
                        });
                    }
                }
            }

            let root = tree.root();
            {
                let storage = tree.into_storage()?;
                for (cid, bytes) in &record_blocks {
                    storage.put_block_with_cid(*cid, bytes.clone())?;
                }
            }
            root
        };

        let record_cid = index_updates.iter().rev().find_map(|(_, cid)| *cid);
        let mutation = self.commit_root(mst_root, record_cid, ops, rev, signer)?;
        for (path, cid) in index_updates {
            if let Some(cid) = cid {
                self.storage_mut().put_record_pointer(path, cid)?;
            } else {
                self.storage_mut().delete_record_pointer(&path)?;
            }
        }

        Ok(mutation)
    }

    pub async fn get_record<T: DeserializeOwned>(
        &mut self,
        path: &RepoPath,
    ) -> Result<Option<StoredRecord<T>>, RepoError> {
        let Some(cid) = self.mst_get(path).await? else {
            return Ok(None);
        };
        let Some(bytes) = self.storage().get_block(&cid)? else {
            return Err(RepoError::MissingRecordBlock {
                path: path.clone(),
                cid,
            });
        };
        let record = decode_dag_cbor(&bytes)?;

        Ok(Some(StoredRecord {
            path: path.clone(),
            cid,
            record,
        }))
    }

    pub async fn entries(&mut self) -> Result<Vec<MstEntry>, RepoError> {
        let mut tree = MerkleSearchTree::open(&mut self.storage, self.latest.commit.data);
        Ok(tree.entries().await?)
    }

    pub async fn entries_for_collection(
        &mut self,
        collection: &Nsid,
    ) -> Result<Vec<MstEntry>, RepoError> {
        let mut tree = MerkleSearchTree::open(&mut self.storage, self.latest.commit.data);
        Ok(tree.entries_for_collection(collection).await?)
    }

    pub async fn export_cids(&mut self) -> Result<Vec<Cid>, RepoError> {
        let mut tree = MerkleSearchTree::open(&mut self.storage, self.latest.commit.data);
        let result = tree.export_cids().await?;

        let mut cids = vec![self.latest.cid];
        cids.extend(result);
        Ok(cids)
    }

    pub async fn extract_record_cids(&mut self, path: &RepoPath) -> Result<Vec<Cid>, RepoError> {
        let mut tree = MerkleSearchTree::open(&mut self.storage, self.latest.commit.data);
        let result = tree.extract_path_cids(path).await?;

        let mut cids = vec![self.latest.cid];
        cids.extend(result);
        Ok(cids)
    }

    fn commit_root(
        &mut self,
        mst_root: Cid,
        record_cid: Option<Cid>,
        ops: Vec<RepoOperation>,
        rev: RepoRev,
        signer: &impl CommitSigner,
    ) -> Result<RepoMutation, RepoError> {
        let unsigned = self
            .latest
            .commit
            .next_unsigned(self.latest.cid, mst_root, rev);
        let signed = unsigned.sign_with(signer)?;
        let latest = signed.write_to(self.storage_mut())?;
        self.latest = latest.clone();

        Ok(RepoMutation {
            commit_cid: latest.cid,
            commit: latest.commit,
            mst_root,
            record_cid,
            ops,
        })
    }

    async fn mst_get(&mut self, path: &RepoPath) -> Result<Option<Cid>, RepoError> {
        let mut tree = MerkleSearchTree::open(&mut self.storage, self.latest.commit.data);
        Ok(tree.get(path).await?)
    }
}

impl<S> Repository<S>
where
    S: RepoBlockStore + RepoRecordIndex,
{
    pub fn create_record<T: Serialize>(
        &mut self,
        path: RepoPath,
        record: &T,
    ) -> Result<Cid, RepoError> {
        if self.storage.get_record_pointer(&path)?.is_some() {
            return Err(RepoError::RecordAlreadyExists { path });
        }
        self.put_record(path, record)
    }

    pub fn put_record<T: Serialize>(
        &mut self,
        path: RepoPath,
        record: &T,
    ) -> Result<Cid, RepoError> {
        let block = encode_block(record)?;
        self.storage
            .put_block_with_cid(block.cid, block.bytes.clone())?;
        self.storage.put_record_pointer(path, block.cid)?;
        Ok(block.cid)
    }

    pub fn update_record<T: Serialize>(
        &mut self,
        path: RepoPath,
        record: &T,
    ) -> Result<Cid, RepoError> {
        if self.storage.get_record_pointer(&path)?.is_none() {
            return Err(RepoError::RecordNotFound { path });
        }
        self.put_record(path, record)
    }

    pub fn get_record<T: DeserializeOwned>(
        &self,
        path: &RepoPath,
    ) -> Result<Option<StoredRecord<T>>, RepoError> {
        let Some(cid) = self.storage.get_record_pointer(path)? else {
            return Ok(None);
        };
        let Some(bytes) = self.storage.get_block(&cid)? else {
            return Err(RepoError::MissingRecordBlock {
                path: path.clone(),
                cid,
            });
        };
        let record = decode_dag_cbor(&bytes)?;
        Ok(Some(StoredRecord {
            path: path.clone(),
            cid,
            record,
        }))
    }

    pub fn delete_record(&mut self, path: &RepoPath) -> Result<Option<Cid>, RepoError> {
        Ok(self.storage.delete_record_pointer(path)?)
    }

    pub fn list_records(&self, collection: &Nsid) -> Result<Vec<RecordListItem>, RepoError> {
        Ok(self
            .storage
            .list_record_pointers(collection)?
            .into_iter()
            .map(|(path, cid)| RecordListItem { path, cid })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use futures_executor::block_on;
    use serde::{Deserialize, Serialize};
    use sha2::{Digest, Sha256};

    use super::*;
    use crate::cid::verify_repo_block_cid;
    use crate::commit::{CommitBlock, CommitSigner};
    use crate::storage::MemoryRepoStore;

    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
    struct TestRecord {
        #[serde(rename = "$type")]
        record_type: String,
        text: String,
    }

    fn record(text: &str) -> TestRecord {
        TestRecord {
            record_type: "app.gsv.record".to_string(),
            text: text.to_string(),
        }
    }

    fn path(rkey: &str) -> RepoPath {
        RepoPath::parse(&format!("app.gsv.record/{rkey}")).unwrap()
    }

    fn other_path(rkey: &str) -> RepoPath {
        RepoPath::parse(&format!("app.gsv.other/{rkey}")).unwrap()
    }

    fn did() -> Did {
        Did::new("did:gsv:alice").unwrap()
    }

    fn rev(value: &str) -> RepoRev {
        RepoRev::new(value).unwrap()
    }

    struct HashSigner(&'static [u8]);

    impl CommitSigner for HashSigner {
        fn sign_commit(&self, signable_bytes: &[u8]) -> Result<Vec<u8>, String> {
            let mut hasher = Sha256::new();
            hasher.update(self.0);
            hasher.update(signable_bytes);
            Ok(hasher.finalize().to_vec())
        }
    }

    struct FailingSigner;

    impl CommitSigner for FailingSigner {
        fn sign_commit(&self, _signable_bytes: &[u8]) -> Result<Vec<u8>, String> {
            Err("missing key".to_string())
        }
    }

    async fn signed_repo() -> SignedRepository<MemoryRepoStore> {
        SignedRepository::create(
            MemoryRepoStore::new(),
            did(),
            rev("3jqfcqzm3fo2j"),
            &HashSigner(b"repo-key"),
        )
        .await
        .unwrap()
    }

    #[test]
    fn put_record_stores_block_and_pointer() {
        let mut repo = Repository::new(MemoryRepoStore::new());
        let path = path("a");
        let cid = repo.put_record(path.clone(), &record("hello")).unwrap();

        assert_eq!(repo.storage().block_count(), 1);
        assert_eq!(repo.storage().record_count(), 1);
        assert_eq!(
            repo.get_record::<TestRecord>(&path).unwrap().unwrap().cid,
            cid
        );
    }

    #[test]
    fn create_record_rejects_existing_path() {
        let mut repo = Repository::new(MemoryRepoStore::new());
        let path = path("a");

        repo.create_record(path.clone(), &record("hello")).unwrap();

        assert!(matches!(
            repo.create_record(path, &record("again")),
            Err(RepoError::RecordAlreadyExists { .. })
        ));
    }

    #[test]
    fn update_record_rejects_missing_path() {
        let mut repo = Repository::new(MemoryRepoStore::new());

        assert!(matches!(
            repo.update_record(path("missing"), &record("hello")),
            Err(RepoError::RecordNotFound { .. })
        ));
    }

    #[test]
    fn updating_record_changes_pointer_and_keeps_old_block() {
        let mut repo = Repository::new(MemoryRepoStore::new());
        let path = path("a");
        let old_cid = repo.put_record(path.clone(), &record("old")).unwrap();
        let new_cid = repo.update_record(path.clone(), &record("new")).unwrap();
        let stored = repo.get_record::<TestRecord>(&path).unwrap().unwrap();

        assert_ne!(old_cid, new_cid);
        assert_eq!(stored.cid, new_cid);
        assert_eq!(stored.record, record("new"));
        assert_eq!(repo.storage().block_count(), 2);
    }

    #[test]
    fn same_record_bytes_produce_same_cid() {
        let mut repo = Repository::new(MemoryRepoStore::new());
        let cid_a = repo.put_record(path("a"), &record("same")).unwrap();
        let cid_b = repo.put_record(path("b"), &record("same")).unwrap();

        assert_eq!(cid_a, cid_b);
        assert_eq!(repo.storage().block_count(), 1);
        assert_eq!(repo.storage().record_count(), 2);
    }

    #[test]
    fn delete_record_removes_pointer_but_not_block() {
        let mut repo = Repository::new(MemoryRepoStore::new());
        let path = path("a");
        let cid = repo.put_record(path.clone(), &record("hello")).unwrap();

        assert_eq!(repo.delete_record(&path).unwrap(), Some(cid));
        assert!(repo.get_record::<TestRecord>(&path).unwrap().is_none());
        assert_eq!(repo.storage().block_count(), 1);
    }

    #[test]
    fn lists_records_by_collection_in_path_order() {
        let mut repo = Repository::new(MemoryRepoStore::new());
        let cid_b = repo.put_record(path("b"), &record("b")).unwrap();
        let cid_a = repo.put_record(path("a"), &record("a")).unwrap();
        repo.put_record(
            RepoPath::parse("app.gsv.other/a").unwrap(),
            &record("other"),
        )
        .unwrap();

        let listed = repo
            .list_records(&Nsid::new("app.gsv.record").unwrap())
            .unwrap();

        assert_eq!(
            listed,
            vec![
                RecordListItem {
                    path: path("a"),
                    cid: cid_a,
                },
                RecordListItem {
                    path: path("b"),
                    cid: cid_b,
                },
            ]
        );
    }

    #[test]
    fn signed_repo_create_writes_empty_mst_and_initial_commit() {
        block_on(async {
            let repo = signed_repo().await;

            assert_eq!(repo.latest_commit().did, did());
            assert_eq!(repo.latest_commit().prev, None);
            assert_eq!(repo.latest_commit().rev, rev("3jqfcqzm3fo2j"));
            assert_eq!(repo.latest_commit().data, repo.mst_root());
            assert!(repo.storage().has_block(&repo.mst_root()).unwrap());
            assert!(repo.storage().has_block(&repo.latest_commit_cid()).unwrap());
            assert_eq!(repo.storage().record_count(), 0);
            assert_eq!(repo.storage().block_count(), 2);
        });
    }

    #[test]
    fn signed_create_record_updates_record_mst_and_commit() {
        block_on(async {
            let mut repo = signed_repo().await;
            let signer = HashSigner(b"repo-key");
            let initial_commit = repo.latest_commit_cid();
            let initial_root = repo.mst_root();
            let path = path("a");

            let mutation = repo
                .create_record(
                    path.clone(),
                    &record("hello"),
                    rev("3jqfcqzm3fo3j"),
                    &signer,
                )
                .await
                .unwrap();

            assert_eq!(mutation.commit_cid, repo.latest_commit_cid());
            assert_eq!(mutation.commit.prev, Some(initial_commit));
            assert_eq!(mutation.commit.rev, rev("3jqfcqzm3fo3j"));
            assert_eq!(mutation.mst_root, repo.mst_root());
            assert_ne!(mutation.mst_root, initial_root);
            assert_eq!(
                mutation.ops,
                vec![RepoOperation {
                    action: RepoOperationAction::Create,
                    path: path.clone(),
                    cid: mutation.record_cid,
                    prev: None,
                }]
            );
            assert_eq!(
                repo.storage().get_record_pointer(&path).unwrap(),
                mutation.record_cid
            );

            let stored = repo.get_record::<TestRecord>(&path).await.unwrap().unwrap();
            assert_eq!(stored.path, path);
            assert_eq!(Some(stored.cid), mutation.record_cid);
            assert_eq!(stored.record, record("hello"));
        });
    }

    #[test]
    fn signed_update_record_links_prev_and_keeps_old_record_block() {
        block_on(async {
            let mut repo = signed_repo().await;
            let signer = HashSigner(b"repo-key");
            let path = path("a");
            let first = repo
                .create_record(path.clone(), &record("old"), rev("3jqfcqzm3fo3j"), &signer)
                .await
                .unwrap();
            let old_record_cid = first.record_cid.unwrap();
            let block_count_after_create = repo.storage().block_count();

            let second = repo
                .update_record(path.clone(), &record("new"), rev("3jqfcqzm3fo4j"), &signer)
                .await
                .unwrap();

            assert_eq!(second.commit.prev, Some(first.commit_cid));
            assert_ne!(second.record_cid, Some(old_record_cid));
            assert_eq!(
                second.ops,
                vec![RepoOperation {
                    action: RepoOperationAction::Update,
                    path: path.clone(),
                    cid: second.record_cid,
                    prev: Some(old_record_cid),
                }]
            );
            assert!(repo.storage().has_block(&old_record_cid).unwrap());
            assert!(repo.storage().block_count() > block_count_after_create);

            let stored = repo.get_record::<TestRecord>(&path).await.unwrap().unwrap();
            assert_eq!(Some(stored.cid), second.record_cid);
            assert_eq!(stored.record, record("new"));
        });
    }

    #[test]
    fn signed_delete_record_removes_mst_entry_but_keeps_old_block() {
        block_on(async {
            let mut repo = signed_repo().await;
            let signer = HashSigner(b"repo-key");
            let path = path("a");
            let first = repo
                .create_record(
                    path.clone(),
                    &record("hello"),
                    rev("3jqfcqzm3fo3j"),
                    &signer,
                )
                .await
                .unwrap();
            let old_record_cid = first.record_cid.unwrap();

            let delete = repo
                .delete_record(&path, rev("3jqfcqzm3fo4j"), &signer)
                .await
                .unwrap();

            assert_eq!(delete.commit.prev, Some(first.commit_cid));
            assert_eq!(delete.record_cid, None);
            assert_eq!(
                delete.ops,
                vec![RepoOperation {
                    action: RepoOperationAction::Delete,
                    path: path.clone(),
                    cid: None,
                    prev: Some(old_record_cid),
                }]
            );
            assert_eq!(repo.storage().get_record_pointer(&path).unwrap(), None);
            assert!(repo.storage().has_block(&old_record_cid).unwrap());
            assert!(repo
                .get_record::<TestRecord>(&path)
                .await
                .unwrap()
                .is_none());
        });
    }

    #[test]
    fn signed_apply_writes_batches_multiple_ops_into_one_commit() {
        block_on(async {
            let mut repo = signed_repo().await;
            let signer = HashSigner(b"repo-key");
            let existing = repo
                .create_record(
                    path("existing"),
                    &record("old"),
                    rev("3jqfcqzm3fo3j"),
                    &signer,
                )
                .await
                .unwrap();
            let previous_commit = existing.commit_cid;
            let old_record = existing.record_cid.unwrap();

            let mutation = repo
                .apply_writes(
                    vec![
                        RepoWrite::Update {
                            path: path("existing"),
                            record: record("new"),
                        },
                        RepoWrite::Create {
                            path: path("created"),
                            record: record("created"),
                        },
                        RepoWrite::Delete {
                            path: path("created"),
                        },
                    ],
                    rev("3jqfcqzm3fo4j"),
                    &signer,
                )
                .await
                .unwrap();

            assert_eq!(mutation.commit.prev, Some(previous_commit));
            assert_eq!(mutation.ops.len(), 3);
            assert_eq!(mutation.ops[0].action, RepoOperationAction::Update);
            assert_eq!(mutation.ops[0].path, path("existing"));
            assert_eq!(mutation.ops[0].prev, Some(old_record));
            assert_eq!(mutation.ops[1].action, RepoOperationAction::Create);
            assert_eq!(mutation.ops[1].path, path("created"));
            assert_eq!(mutation.ops[2].action, RepoOperationAction::Delete);
            assert_eq!(mutation.ops[2].path, path("created"));
            assert_eq!(mutation.ops[2].prev, mutation.ops[1].cid);
            assert_eq!(
                repo.get_record::<TestRecord>(&path("existing"))
                    .await
                    .unwrap()
                    .unwrap()
                    .record,
                record("new")
            );
            assert!(repo
                .get_record::<TestRecord>(&path("created"))
                .await
                .unwrap()
                .is_none());
        });
    }

    #[test]
    fn signed_repo_reopens_from_latest_commit() {
        block_on(async {
            let mut repo = signed_repo().await;
            let signer = HashSigner(b"repo-key");
            let path = path("a");
            let mutation = repo
                .create_record(
                    path.clone(),
                    &record("hello"),
                    rev("3jqfcqzm3fo3j"),
                    &signer,
                )
                .await
                .unwrap();
            let storage = repo.into_storage();
            let mut reopened = SignedRepository::open(storage, mutation.commit_cid).unwrap();

            assert_eq!(reopened.latest_commit_cid(), mutation.commit_cid);
            assert_eq!(reopened.mst_root(), mutation.mst_root);
            assert_eq!(
                reopened
                    .get_record::<TestRecord>(&path)
                    .await
                    .unwrap()
                    .unwrap()
                    .record,
                record("hello")
            );
        });
    }

    #[test]
    fn signed_repo_rejects_invalid_mutations_without_new_commit() {
        block_on(async {
            let mut repo = signed_repo().await;
            let signer = HashSigner(b"repo-key");
            let existing_path = path("a");
            repo.create_record(
                existing_path.clone(),
                &record("hello"),
                rev("3jqfcqzm3fo3j"),
                &signer,
            )
            .await
            .unwrap();
            let latest = repo.latest_commit_cid();

            assert!(matches!(
                repo.create_record(
                    existing_path.clone(),
                    &record("again"),
                    rev("3jqfcqzm3fo4j"),
                    &signer
                )
                .await,
                Err(RepoError::RecordAlreadyExists { .. })
            ));
            assert!(matches!(
                repo.update_record(
                    path("missing"),
                    &record("nope"),
                    rev("3jqfcqzm3fo4j"),
                    &signer
                )
                .await,
                Err(RepoError::RecordNotFound { .. })
            ));
            assert!(matches!(
                repo.delete_record(&path("missing"), rev("3jqfcqzm3fo4j"), &signer)
                    .await,
                Err(RepoError::RecordNotFound { .. })
            ));

            assert_eq!(repo.latest_commit_cid(), latest);
        });
    }

    #[test]
    fn signed_repo_signer_failure_does_not_advance_committed_view() {
        block_on(async {
            let mut repo = signed_repo().await;
            let latest = repo.latest_commit_cid();
            let root = repo.mst_root();
            let path = path("a");

            assert!(matches!(
                repo.create_record(path.clone(), &record("hello"), rev("3jqfcqzm3fo3j"), &FailingSigner)
                    .await,
                Err(RepoError::Commit(CommitError::Signing(message))) if message == "missing key"
            ));

            assert_eq!(repo.latest_commit_cid(), latest);
            assert_eq!(repo.mst_root(), root);
            assert_eq!(repo.storage().get_record_pointer(&path).unwrap(), None);
            assert!(repo
                .get_record::<TestRecord>(&path)
                .await
                .unwrap()
                .is_none());
        });
    }

    #[test]
    fn signed_repo_entries_follow_mst_after_multiple_mutations() {
        block_on(async {
            let mut repo = signed_repo().await;
            let signer = HashSigner(b"repo-key");
            repo.create_record(path("a"), &record("a"), rev("3jqfcqzm3fo3j"), &signer)
                .await
                .unwrap();
            let b = repo
                .create_record(path("b"), &record("b"), rev("3jqfcqzm3fo4j"), &signer)
                .await
                .unwrap();
            let other = repo
                .create_record(
                    other_path("a"),
                    &record("other"),
                    rev("3jqfcqzm3fo5j"),
                    &signer,
                )
                .await
                .unwrap();
            let b_updated = repo
                .update_record(path("b"), &record("b2"), rev("3jqfcqzm3fo6j"), &signer)
                .await
                .unwrap();
            repo.delete_record(&path("a"), rev("3jqfcqzm3fo7j"), &signer)
                .await
                .unwrap();

            assert_ne!(b.record_cid, b_updated.record_cid);
            assert_eq!(
                repo.entries().await.unwrap(),
                vec![
                    MstEntry {
                        path: other_path("a"),
                        cid: other.record_cid.unwrap(),
                    },
                    MstEntry {
                        path: path("b"),
                        cid: b_updated.record_cid.unwrap(),
                    },
                ]
            );
            assert_eq!(
                repo.entries_for_collection(&Nsid::new("app.gsv.record").unwrap())
                    .await
                    .unwrap(),
                vec![MstEntry {
                    path: path("b"),
                    cid: b_updated.record_cid.unwrap(),
                }]
            );
        });
    }

    #[test]
    fn signed_repo_exported_blocks_are_content_addressed() {
        block_on(async {
            let mut repo = signed_repo().await;
            let signer = HashSigner(b"repo-key");
            let mutation = repo
                .create_record(path("a"), &record("hello"), rev("3jqfcqzm3fo3j"), &signer)
                .await
                .unwrap();

            let exported = repo.export_cids().await.unwrap();

            assert!(exported.contains(&repo.latest_commit_cid()));
            assert!(exported.contains(&repo.mst_root()));
            assert!(exported.contains(&mutation.record_cid.unwrap()));
            for cid in exported {
                let bytes = repo.storage().get_block(&cid).unwrap().unwrap();
                verify_repo_block_cid(&cid, &bytes).unwrap();
            }
        });
    }

    #[test]
    fn signed_repo_extracts_record_proof_blocks() {
        block_on(async {
            let mut repo = signed_repo().await;
            let signer = HashSigner(b"repo-key");
            let mutation = repo
                .create_record(path("a"), &record("hello"), rev("3jqfcqzm3fo3j"), &signer)
                .await
                .unwrap();

            let extracted = repo.extract_record_cids(&path("a")).await.unwrap();

            assert!(extracted.contains(&repo.latest_commit_cid()));
            assert!(extracted.contains(&repo.mst_root()));
            assert!(extracted.contains(&mutation.record_cid.unwrap()));
            for cid in extracted {
                let bytes = repo.storage().get_block(&cid).unwrap().unwrap();
                verify_repo_block_cid(&cid, &bytes).unwrap();
            }
        });
    }

    #[test]
    fn signed_repo_extracts_non_existence_proof_without_record_block() {
        block_on(async {
            let mut repo = signed_repo().await;

            let extracted = repo.extract_record_cids(&path("missing")).await.unwrap();

            assert!(extracted.contains(&repo.latest_commit_cid()));
            assert!(extracted.contains(&repo.mst_root()));
            assert_eq!(extracted.len(), 2);
        });
    }

    #[test]
    fn signed_repo_commit_blocks_form_prev_chain() {
        block_on(async {
            let mut repo = signed_repo().await;
            let signer = HashSigner(b"repo-key");
            let initial = repo.latest_commit_cid();
            let first = repo
                .create_record(path("a"), &record("a"), rev("3jqfcqzm3fo3j"), &signer)
                .await
                .unwrap();
            let second = repo
                .update_record(path("a"), &record("b"), rev("3jqfcqzm3fo4j"), &signer)
                .await
                .unwrap();

            let first_block = CommitBlock::read_from(repo.storage(), &first.commit_cid)
                .unwrap()
                .unwrap();
            let second_block = CommitBlock::read_from(repo.storage(), &second.commit_cid)
                .unwrap()
                .unwrap();

            assert_eq!(first_block.commit.prev, Some(initial));
            assert_eq!(second_block.commit.prev, Some(first.commit_cid));
            assert_eq!(second_block.commit.data, second.mst_root);
        });
    }
}
