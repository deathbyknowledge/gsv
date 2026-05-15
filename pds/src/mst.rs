//! Merkle Search Tree integration.

use std::future::{ready, Future};
use std::sync::{Arc, Mutex};

use atrium_repo::blockstore::{
    AsyncBlockStoreRead, AsyncBlockStoreWrite, Error as BlockStoreError,
};
use atrium_repo::mst::Tree;
use futures_core::Stream;
use futures_util::TryStreamExt;
use thiserror::Error;

use crate::cid::{cid_for_bytes, Cid, SHA2_256_CODE};
use crate::data_model::{DataModelError, Nsid, RepoPath};
use crate::storage::{RepoBlockStore, StorageError};

#[derive(Debug, Error)]
pub enum MstError {
    #[error(transparent)]
    Atrium(#[from] atrium_repo::mst::Error),

    #[error(transparent)]
    DataModel(#[from] DataModelError),

    #[error("MST storage is still shared")]
    SharedStorage,

    #[error("MST storage lock was poisoned")]
    StoragePoisoned,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MstEntry {
    pub path: RepoPath,
    pub cid: Cid,
}

pub struct MerkleSearchTree<S> {
    storage: SharedBlockStore<S>,
    root: Cid,
}

impl<S> std::fmt::Debug for MerkleSearchTree<S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MerkleSearchTree")
            .field("root", &self.root)
            .finish_non_exhaustive()
    }
}

impl<S> MerkleSearchTree<S>
where
    S: RepoBlockStore + Send,
{
    pub async fn create(storage: S) -> Result<Self, MstError> {
        let storage = SharedBlockStore::new(storage);
        let tree = Tree::create(storage.clone()).await?;
        let root = tree.root();

        Ok(Self { storage, root })
    }

    pub async fn from_entries(
        storage: S,
        entries: impl IntoIterator<Item = (RepoPath, Cid)>,
    ) -> Result<Self, MstError> {
        let mut tree = Self::create(storage).await?;
        for (path, cid) in entries {
            tree.add(path, cid).await?;
        }
        Ok(tree)
    }

    pub fn open(storage: S, root: Cid) -> Self {
        Self {
            storage: SharedBlockStore::new(storage),
            root,
        }
    }

    pub fn root(&self) -> Cid {
        self.root
    }

    pub fn into_storage(self) -> Result<S, MstError> {
        self.storage.into_inner()
    }

    pub async fn add(&mut self, path: RepoPath, cid: Cid) -> Result<(), MstError> {
        let mut tree = self.open_atrium_tree();
        tree.add(&path.as_mst_key(), cid).await?;
        self.root = tree.root();
        Ok(())
    }

    pub async fn update(&mut self, path: RepoPath, cid: Cid) -> Result<(), MstError> {
        let mut tree = self.open_atrium_tree();
        tree.update(&path.as_mst_key(), cid).await?;
        self.root = tree.root();
        Ok(())
    }

    pub async fn delete(&mut self, path: &RepoPath) -> Result<(), MstError> {
        let mut tree = self.open_atrium_tree();
        tree.delete(&path.as_mst_key()).await?;
        self.root = tree.root();
        Ok(())
    }

    pub async fn get(&mut self, path: &RepoPath) -> Result<Option<Cid>, MstError> {
        let mut tree = self.open_atrium_tree();
        Ok(tree.get(&path.as_mst_key()).await?)
    }

    pub async fn depth(&mut self) -> Result<Option<usize>, MstError> {
        let mut tree = self.open_atrium_tree();
        Ok(tree.depth(None).await?)
    }

    pub async fn entries(&mut self) -> Result<Vec<MstEntry>, MstError> {
        let mut tree = self.open_atrium_tree();
        collect_entries(tree.entries()).await
    }

    pub async fn entries_for_collection(
        &mut self,
        collection: &Nsid,
    ) -> Result<Vec<MstEntry>, MstError> {
        let mut tree = self.open_atrium_tree();
        let prefix = format!("{}/", collection.as_str());
        let entries = collect_entries(tree.entries_prefixed(&prefix)).await?;
        Ok(entries
            .into_iter()
            .filter(|entry| entry.path.collection == *collection)
            .collect())
    }

    pub async fn export_cids(&mut self) -> Result<Vec<Cid>, MstError> {
        let mut tree = self.open_atrium_tree();
        Ok(tree.export().try_collect().await?)
    }

    pub async fn extract_path_cids(&mut self, path: &RepoPath) -> Result<Vec<Cid>, MstError> {
        let mut tree = self.open_atrium_tree();
        let key = path.as_mst_key();
        let cids = tree.extract_path(&key).await?.collect();
        Ok(cids)
    }

    fn open_atrium_tree(&self) -> Tree<SharedBlockStore<S>> {
        Tree::open(self.storage.clone(), self.root)
    }
}

async fn collect_entries(
    stream: impl Stream<Item = Result<(String, Cid), atrium_repo::mst::Error>>,
) -> Result<Vec<MstEntry>, MstError> {
    let entries = stream.try_collect::<Vec<_>>().await?;
    entries
        .into_iter()
        .map(|(key, cid)| {
            Ok(MstEntry {
                path: RepoPath::parse(&key)?,
                cid,
            })
        })
        .collect()
}

struct SharedBlockStore<S> {
    inner: Arc<Mutex<S>>,
}

impl<S> Clone for SharedBlockStore<S> {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

impl<S> SharedBlockStore<S> {
    fn new(storage: S) -> Self {
        Self {
            inner: Arc::new(Mutex::new(storage)),
        }
    }

    fn into_inner(self) -> Result<S, MstError> {
        let mutex = Arc::try_unwrap(self.inner).map_err(|_| MstError::SharedStorage)?;
        mutex.into_inner().map_err(|_| MstError::StoragePoisoned)
    }
}

impl<S> AsyncBlockStoreRead for SharedBlockStore<S>
where
    S: RepoBlockStore + Send,
{
    fn read_block_into(
        &mut self,
        cid: Cid,
        contents: &mut Vec<u8>,
    ) -> impl Future<Output = Result<(), BlockStoreError>> + Send {
        let result = (|| {
            let storage = self.inner.lock().map_err(|_| storage_poisoned())?;
            let bytes = storage
                .get_block(&cid)
                .map_err(storage_error)?
                .ok_or(BlockStoreError::CidNotFound)?;

            contents.clear();
            contents.extend_from_slice(&bytes);
            Ok(())
        })();

        ready(result)
    }
}

impl<S> AsyncBlockStoreWrite for SharedBlockStore<S>
where
    S: RepoBlockStore + Send,
{
    fn write_block(
        &mut self,
        codec: u64,
        hash: u64,
        contents: &[u8],
    ) -> impl Future<Output = Result<Cid, BlockStoreError>> + Send {
        let result = (|| {
            if hash != SHA2_256_CODE {
                return Err(BlockStoreError::UnsupportedHash(hash));
            }

            let cid = cid_for_bytes(codec, contents);
            self.inner
                .lock()
                .map_err(|_| storage_poisoned())?
                .put_block_with_cid(cid, contents.to_vec())
                .map_err(storage_error)?;

            Ok(cid)
        })();

        ready(result)
    }
}

fn storage_error(error: StorageError) -> BlockStoreError {
    BlockStoreError::Other(Box::new(error))
}

fn storage_poisoned() -> BlockStoreError {
    BlockStoreError::Other(Box::new(MstError::StoragePoisoned))
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use futures_executor::block_on;
    use serde::Serialize;

    use super::*;
    use crate::cbor::encode_dag_cbor;
    use crate::cid::{dag_cbor_cid, parse_cid, verify_repo_block_cid};
    use crate::storage::MemoryRepoStore;

    #[derive(Serialize)]
    struct TestRecord<'a> {
        #[serde(rename = "$type")]
        record_type: &'a str,
        text: &'a str,
    }

    fn path(value: &str) -> RepoPath {
        RepoPath::parse(value).unwrap()
    }

    fn value_cid(text: &str) -> Cid {
        dag_cbor_cid(&record_bytes(text))
    }

    fn record_bytes(text: &str) -> Vec<u8> {
        encode_dag_cbor(&TestRecord {
            record_type: "app.gsv.record",
            text,
        })
        .unwrap()
    }

    fn entry_specs() -> Vec<(RepoPath, &'static str)> {
        vec![
            (path("app.gsv.record/a"), "alpha"),
            (path("app.gsv.record/b"), "bravo"),
            (path("app.gsv.record/c"), "charlie"),
            (path("app.gsv.other/a"), "other"),
        ]
    }

    fn entries() -> Vec<(RepoPath, Cid)> {
        entry_specs()
            .into_iter()
            .map(|(path, text)| (path, value_cid(text)))
            .collect()
    }

    #[test]
    fn creates_known_empty_root() {
        block_on(async {
            let tree = MerkleSearchTree::create(MemoryRepoStore::new())
                .await
                .unwrap();

            assert_eq!(
                tree.root(),
                Cid::from_str("bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm")
                    .unwrap()
            );
        });
    }

    #[test]
    fn build_root_is_independent_of_insert_order() {
        block_on(async {
            let forward = MerkleSearchTree::from_entries(MemoryRepoStore::new(), entries())
                .await
                .unwrap();
            let mut reversed_entries = entries();
            reversed_entries.reverse();
            let mut reversed =
                MerkleSearchTree::from_entries(MemoryRepoStore::new(), reversed_entries)
                    .await
                    .unwrap();

            assert_eq!(forward.root(), reversed.root());
            assert_eq!(
                reversed.entries().await.unwrap(),
                vec![
                    MstEntry {
                        path: path("app.gsv.other/a"),
                        cid: value_cid("other"),
                    },
                    MstEntry {
                        path: path("app.gsv.record/a"),
                        cid: value_cid("alpha"),
                    },
                    MstEntry {
                        path: path("app.gsv.record/b"),
                        cid: value_cid("bravo"),
                    },
                    MstEntry {
                        path: path("app.gsv.record/c"),
                        cid: value_cid("charlie"),
                    },
                ]
            );
        });
    }

    #[test]
    fn update_changes_root_and_value() {
        block_on(async {
            let target = path("app.gsv.record/a");
            let mut tree = MerkleSearchTree::from_entries(
                MemoryRepoStore::new(),
                vec![(target.clone(), value_cid("old"))],
            )
            .await
            .unwrap();
            let old_root = tree.root();

            tree.update(target.clone(), value_cid("new")).await.unwrap();

            assert_ne!(tree.root(), old_root);
            assert_eq!(tree.get(&target).await.unwrap(), Some(value_cid("new")));
        });
    }

    #[test]
    fn delete_removes_path() {
        block_on(async {
            let target = path("app.gsv.record/a");
            let mut tree = MerkleSearchTree::from_entries(MemoryRepoStore::new(), entries())
                .await
                .unwrap();
            let populated_root = tree.root();

            tree.delete(&target).await.unwrap();

            assert_ne!(tree.root(), populated_root);
            assert_eq!(tree.get(&target).await.unwrap(), None);
            assert!(!tree
                .entries()
                .await
                .unwrap()
                .iter()
                .any(|entry| entry.path == target));
        });
    }

    #[test]
    fn lists_entries_for_collection() {
        block_on(async {
            let collection = Nsid::new("app.gsv.record").unwrap();
            let mut tree = MerkleSearchTree::from_entries(MemoryRepoStore::new(), entries())
                .await
                .unwrap();

            assert_eq!(
                tree.entries_for_collection(&collection).await.unwrap(),
                vec![
                    MstEntry {
                        path: path("app.gsv.record/a"),
                        cid: value_cid("alpha"),
                    },
                    MstEntry {
                        path: path("app.gsv.record/b"),
                        cid: value_cid("bravo"),
                    },
                    MstEntry {
                        path: path("app.gsv.record/c"),
                        cid: value_cid("charlie"),
                    },
                ]
            );
        });
    }

    #[test]
    fn entries_for_collection_does_not_leak_later_collections() {
        block_on(async {
            let collection = Nsid::new("space.gsv.package.like").unwrap();
            let mut tree = MerkleSearchTree::from_entries(
                MemoryRepoStore::new(),
                vec![
                    (path("space.gsv.profile/self"), value_cid("profile")),
                    (path("space.gsv.user/alice"), value_cid("user")),
                ],
            )
            .await
            .unwrap();

            assert_eq!(
                tree.entries_for_collection(&collection).await.unwrap(),
                vec![]
            );
        });
    }

    #[test]
    fn exported_blocks_are_present_and_content_addressed() {
        block_on(async {
            let mut store = MemoryRepoStore::new();
            let entry_data = entry_specs()
                .into_iter()
                .map(|(path, text)| {
                    let bytes = record_bytes(text);
                    let cid = dag_cbor_cid(&bytes);
                    store.put_block_with_cid(cid, bytes).unwrap();
                    (path, cid)
                })
                .collect::<Vec<_>>();

            let mut tree = MerkleSearchTree::from_entries(store, entry_data)
                .await
                .unwrap();
            let root = tree.root();
            let exported = tree.export_cids().await.unwrap();
            let storage = tree.into_storage().unwrap();

            assert!(exported.contains(&root));
            for cid in exported {
                let bytes = storage.get_block(&cid).unwrap().unwrap();
                verify_repo_block_cid(&cid, &bytes).unwrap();
            }
        });
    }

    #[test]
    fn open_uses_existing_root() {
        block_on(async {
            let tree = MerkleSearchTree::from_entries(MemoryRepoStore::new(), entries())
                .await
                .unwrap();
            let root = tree.root();
            let storage = tree.into_storage().unwrap();
            let mut reopened = MerkleSearchTree::open(storage, root);

            assert_eq!(reopened.root(), root);
            assert_eq!(
                reopened.get(&path("app.gsv.record/b")).await.unwrap(),
                Some(value_cid("bravo"))
            );
        });
    }

    #[test]
    fn parses_empty_root_cid_with_helper() {
        assert!(parse_cid("bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm").is_ok());
    }
}
