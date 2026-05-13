//! Storage traits for durable repo blocks, records, commits, and blobs.

use std::collections::BTreeMap;

use thiserror::Error;

use crate::cid::{dag_cbor_cid, verify_repo_block_cid, Cid, CidError};
use crate::data_model::{DataModelError, Nsid, RepoPath};

#[derive(Debug, Error)]
pub enum StorageError {
    #[error(transparent)]
    Cid(#[from] CidError),

    #[error(transparent)]
    DataModel(#[from] DataModelError),

    #[error("block `{cid}` already exists with different bytes")]
    ConflictingBlock { cid: Cid },

    #[error("storage backend error: {0}")]
    Backend(String),
}

pub trait RepoBlockStore {
    fn put_block(&mut self, bytes: Vec<u8>) -> Result<Cid, StorageError> {
        let cid = dag_cbor_cid(&bytes);
        self.put_block_with_cid(cid, bytes)?;
        Ok(cid)
    }

    fn put_block_with_cid(&mut self, cid: Cid, bytes: Vec<u8>) -> Result<(), StorageError>;

    fn get_block(&self, cid: &Cid) -> Result<Option<Vec<u8>>, StorageError>;

    fn has_block(&self, cid: &Cid) -> Result<bool, StorageError> {
        Ok(self.get_block(cid)?.is_some())
    }
}

impl<T> RepoBlockStore for &mut T
where
    T: RepoBlockStore + ?Sized,
{
    fn put_block_with_cid(&mut self, cid: Cid, bytes: Vec<u8>) -> Result<(), StorageError> {
        (**self).put_block_with_cid(cid, bytes)
    }

    fn get_block(&self, cid: &Cid) -> Result<Option<Vec<u8>>, StorageError> {
        (**self).get_block(cid)
    }
}

pub trait RepoRecordIndex {
    fn put_record_pointer(&mut self, path: RepoPath, cid: Cid)
        -> Result<Option<Cid>, StorageError>;

    fn get_record_pointer(&self, path: &RepoPath) -> Result<Option<Cid>, StorageError>;

    fn delete_record_pointer(&mut self, path: &RepoPath) -> Result<Option<Cid>, StorageError>;

    fn list_record_pointers(&self, collection: &Nsid)
        -> Result<Vec<(RepoPath, Cid)>, StorageError>;
}

impl<T> RepoRecordIndex for &mut T
where
    T: RepoRecordIndex + ?Sized,
{
    fn put_record_pointer(
        &mut self,
        path: RepoPath,
        cid: Cid,
    ) -> Result<Option<Cid>, StorageError> {
        (**self).put_record_pointer(path, cid)
    }

    fn get_record_pointer(&self, path: &RepoPath) -> Result<Option<Cid>, StorageError> {
        (**self).get_record_pointer(path)
    }

    fn delete_record_pointer(&mut self, path: &RepoPath) -> Result<Option<Cid>, StorageError> {
        (**self).delete_record_pointer(path)
    }

    fn list_record_pointers(
        &self,
        collection: &Nsid,
    ) -> Result<Vec<(RepoPath, Cid)>, StorageError> {
        (**self).list_record_pointers(collection)
    }
}

#[derive(Clone, Debug, Default)]
pub struct MemoryRepoStore {
    blocks: BTreeMap<Cid, Vec<u8>>,
    records: BTreeMap<RepoPath, Cid>,
}

impl MemoryRepoStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn block_count(&self) -> usize {
        self.blocks.len()
    }

    pub fn record_count(&self) -> usize {
        self.records.len()
    }
}

impl RepoBlockStore for MemoryRepoStore {
    fn put_block_with_cid(&mut self, cid: Cid, bytes: Vec<u8>) -> Result<(), StorageError> {
        verify_repo_block_cid(&cid, &bytes)?;
        if let Some(existing) = self.blocks.get(&cid) {
            if existing != &bytes {
                return Err(StorageError::ConflictingBlock { cid });
            }
            return Ok(());
        }

        self.blocks.insert(cid, bytes);
        Ok(())
    }

    fn get_block(&self, cid: &Cid) -> Result<Option<Vec<u8>>, StorageError> {
        Ok(self.blocks.get(cid).cloned())
    }
}

impl RepoRecordIndex for MemoryRepoStore {
    fn put_record_pointer(
        &mut self,
        path: RepoPath,
        cid: Cid,
    ) -> Result<Option<Cid>, StorageError> {
        Ok(self.records.insert(path, cid))
    }

    fn get_record_pointer(&self, path: &RepoPath) -> Result<Option<Cid>, StorageError> {
        Ok(self.records.get(path).copied())
    }

    fn delete_record_pointer(&mut self, path: &RepoPath) -> Result<Option<Cid>, StorageError> {
        Ok(self.records.remove(path))
    }

    fn list_record_pointers(
        &self,
        collection: &Nsid,
    ) -> Result<Vec<(RepoPath, Cid)>, StorageError> {
        Ok(self
            .records
            .iter()
            .filter(|(path, _)| &path.collection == collection)
            .map(|(path, cid)| (path.clone(), *cid))
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cbor::encode_dag_cbor;
    use crate::cid::cid_for_bytes;

    #[test]
    fn stores_and_loads_blocks_by_cid() {
        let mut store = MemoryRepoStore::new();
        let bytes = encode_dag_cbor("hello").unwrap();
        let cid = store.put_block(bytes.clone()).unwrap();

        assert!(store.has_block(&cid).unwrap());
        assert_eq!(store.get_block(&cid).unwrap(), Some(bytes));
        assert_eq!(store.block_count(), 1);
    }

    #[test]
    fn rejects_mismatched_block_cid() {
        let mut store = MemoryRepoStore::new();
        let bytes = encode_dag_cbor("hello").unwrap();
        let wrong_cid = cid_for_bytes(crate::cid::DAG_CBOR_CODEC, b"different");

        assert!(store.put_block_with_cid(wrong_cid, bytes).is_err());
    }

    #[test]
    fn record_index_stores_lists_and_deletes_pointers() {
        let mut store = MemoryRepoStore::new();
        let path_a = RepoPath::parse("app.gsv.record/a").unwrap();
        let path_b = RepoPath::parse("app.gsv.record/b").unwrap();
        let other = RepoPath::parse("app.gsv.other/a").unwrap();
        let cid_a = store.put_block(encode_dag_cbor("a").unwrap()).unwrap();
        let cid_b = store.put_block(encode_dag_cbor("b").unwrap()).unwrap();
        let cid_other = store.put_block(encode_dag_cbor("other").unwrap()).unwrap();

        assert_eq!(
            store.put_record_pointer(path_a.clone(), cid_a).unwrap(),
            None
        );
        store.put_record_pointer(path_b.clone(), cid_b).unwrap();
        store.put_record_pointer(other, cid_other).unwrap();

        assert_eq!(store.get_record_pointer(&path_a).unwrap(), Some(cid_a));
        let collection = Nsid::new("app.gsv.record").unwrap();
        let listed = store.list_record_pointers(&collection).unwrap();
        assert_eq!(listed, vec![(path_a.clone(), cid_a), (path_b, cid_b)]);

        assert_eq!(store.delete_record_pointer(&path_a).unwrap(), Some(cid_a));
        assert_eq!(store.get_record_pointer(&path_a).unwrap(), None);
    }
}
