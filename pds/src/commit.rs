//! Signed repository commit blocks.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::cbor::{decode_dag_cbor, encode_block, CborError};
use crate::cid::{dag_cbor_cid, Cid};
use crate::storage::{RepoBlockStore, StorageError};

pub const COMMIT_VERSION: i64 = 3;

#[derive(Debug, Error)]
pub enum CommitError {
    #[error(transparent)]
    Cbor(#[from] CborError),

    #[error(transparent)]
    Storage(#[from] StorageError),

    #[error("failed to sign commit: {0}")]
    Signing(String),

    #[error("invalid DID `{value}`: {reason}")]
    InvalidDid { value: String, reason: String },

    #[error("invalid repo revision `{value}`: {reason}")]
    InvalidRev { value: String, reason: String },

    #[error("unsupported commit version `{version}`")]
    UnsupportedVersion { version: i64 },
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Did(String);

impl Did {
    pub fn new(value: impl Into<String>) -> Result<Self, CommitError> {
        let value = value.into();
        validate_did(&value)?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for Did {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<Did> for String {
    fn from(value: Did) -> Self {
        value.0
    }
}

impl TryFrom<String> for Did {
    type Error = CommitError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl FromStr for Did {
    type Err = CommitError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::new(value)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct RepoRev(String);

impl RepoRev {
    pub fn new(value: impl Into<String>) -> Result<Self, CommitError> {
        let value = value.into();
        validate_repo_rev(&value)?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for RepoRev {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<RepoRev> for String {
    fn from(value: RepoRev) -> Self {
        value.0
    }
}

impl TryFrom<String> for RepoRev {
    type Error = CommitError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl FromStr for RepoRev {
    type Err = CommitError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::new(value)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnsignedCommit {
    pub did: Did,
    pub version: i64,
    pub data: Cid,
    pub rev: RepoRev,
    pub prev: Option<Cid>,
}

impl UnsignedCommit {
    pub fn new(did: Did, data: Cid, rev: RepoRev, prev: Option<Cid>) -> Self {
        Self {
            did,
            version: COMMIT_VERSION,
            data,
            rev,
            prev,
        }
    }

    pub fn signable_bytes(&self) -> Result<Vec<u8>, CommitError> {
        self.validate_version()?;
        Ok(crate::cbor::encode_dag_cbor(self)?)
    }

    pub fn sign_with(&self, signer: &impl CommitSigner) -> Result<SignedCommit, CommitError> {
        let signable_bytes = self.signable_bytes()?;
        let sig = signer
            .sign_commit(&signable_bytes)
            .map_err(CommitError::Signing)?;
        self.with_signature(sig)
    }

    pub fn with_signature(&self, sig: Vec<u8>) -> Result<SignedCommit, CommitError> {
        self.validate_version()?;
        Ok(SignedCommit {
            did: self.did.clone(),
            version: self.version,
            data: self.data,
            rev: self.rev.clone(),
            prev: self.prev,
            sig,
        })
    }

    fn validate_version(&self) -> Result<(), CommitError> {
        if self.version == COMMIT_VERSION {
            Ok(())
        } else {
            Err(CommitError::UnsupportedVersion {
                version: self.version,
            })
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignedCommit {
    pub did: Did,
    pub version: i64,
    pub data: Cid,
    pub rev: RepoRev,
    pub prev: Option<Cid>,
    #[serde(with = "serde_bytes")]
    pub sig: Vec<u8>,
}

impl SignedCommit {
    pub fn unsigned(&self) -> UnsignedCommit {
        UnsignedCommit {
            did: self.did.clone(),
            version: self.version,
            data: self.data,
            rev: self.rev.clone(),
            prev: self.prev,
        }
    }

    pub fn signable_bytes(&self) -> Result<Vec<u8>, CommitError> {
        self.unsigned().signable_bytes()
    }

    pub fn encode_block(&self) -> Result<CommitBlock, CommitError> {
        self.unsigned().validate_version()?;
        let block = encode_block(self)?;
        Ok(CommitBlock {
            cid: block.cid,
            bytes: block.bytes,
            commit: self.clone(),
        })
    }

    pub fn write_to(&self, storage: &mut impl RepoBlockStore) -> Result<CommitBlock, CommitError> {
        let block = self.encode_block()?;
        storage.put_block_with_cid(block.cid, block.bytes.clone())?;
        Ok(block)
    }

    pub fn next_unsigned(&self, cid: Cid, data: Cid, rev: RepoRev) -> UnsignedCommit {
        UnsignedCommit::new(self.did.clone(), data, rev, Some(cid))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitBlock {
    pub cid: Cid,
    pub bytes: Vec<u8>,
    pub commit: SignedCommit,
}

impl CommitBlock {
    pub fn decode(bytes: &[u8]) -> Result<Self, CommitError> {
        let commit: SignedCommit = decode_dag_cbor(bytes)?;
        commit.unsigned().validate_version()?;
        Ok(Self {
            cid: dag_cbor_cid(bytes),
            bytes: bytes.to_vec(),
            commit,
        })
    }

    pub fn read_from(
        storage: &impl RepoBlockStore,
        cid: &Cid,
    ) -> Result<Option<Self>, CommitError> {
        let Some(bytes) = storage.get_block(cid)? else {
            return Ok(None);
        };

        let block = Self::decode(&bytes)?;
        if &block.cid == cid {
            Ok(Some(block))
        } else {
            Err(StorageError::ConflictingBlock { cid: *cid }.into())
        }
    }
}

pub trait CommitSigner {
    fn sign_commit(&self, signable_bytes: &[u8]) -> Result<Vec<u8>, String>;
}

fn validate_did(value: &str) -> Result<(), CommitError> {
    if value.len() > 2048 {
        return invalid_did(value, "must be at most 2048 characters");
    }

    let Some(rest) = value.strip_prefix("did:") else {
        return invalid_did(value, "must start with `did:`");
    };
    let Some((method, identifier)) = rest.split_once(':') else {
        return invalid_did(value, "must contain a DID method and identifier");
    };

    if method.is_empty() {
        return invalid_did(value, "method must not be empty");
    }
    if !method.bytes().all(|byte| byte.is_ascii_lowercase()) {
        return invalid_did(value, "method must contain only lowercase ASCII letters");
    }
    if identifier.is_empty() {
        return invalid_did(value, "identifier must not be empty");
    }
    if !identifier.bytes().all(|byte| {
        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'%' | b'-')
    }) {
        return invalid_did(
            value,
            "identifier contains a character outside the AT Protocol DID syntax",
        );
    }
    if !identifier
        .bytes()
        .last()
        .is_some_and(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return invalid_did(
            value,
            "identifier must end with an ASCII letter, digit, dot, underscore, or hyphen",
        );
    }

    Ok(())
}

fn validate_repo_rev(value: &str) -> Result<(), CommitError> {
    if value.len() != 13 {
        return invalid_rev(value, "must be exactly 13 characters");
    }

    let mut bytes = value.bytes();
    let first = bytes.next().expect("length checked");
    if !matches!(first, b'2'..=b'7' | b'a'..=b'j') {
        return invalid_rev(value, "first character must be 2-7 or a-j");
    }
    if !bytes.all(|byte| matches!(byte, b'2'..=b'7' | b'a'..=b'z')) {
        return invalid_rev(value, "characters must be 2-7 or a-z");
    }

    Ok(())
}

fn invalid_did<T>(value: &str, reason: impl Into<String>) -> Result<T, CommitError> {
    Err(CommitError::InvalidDid {
        value: value.to_string(),
        reason: reason.into(),
    })
}

fn invalid_rev<T>(value: &str, reason: impl Into<String>) -> Result<T, CommitError> {
    Err(CommitError::InvalidRev {
        value: value.to_string(),
        reason: reason.into(),
    })
}

#[cfg(test)]
mod tests {
    use serde::{Deserialize, Serialize};
    use sha2::{Digest, Sha256};

    use super::*;
    use crate::cbor::decode_dag_cbor;
    use crate::cid::{dag_cbor_cid, verify_repo_block_cid};
    use crate::storage::MemoryRepoStore;

    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
    struct TestRecord {
        #[serde(rename = "$type")]
        record_type: String,
        text: String,
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

    fn did() -> Did {
        Did::new("did:gsv:alice").unwrap()
    }

    fn rev(value: &str) -> RepoRev {
        RepoRev::new(value).unwrap()
    }

    fn data_cid(text: &str) -> Cid {
        dag_cbor_cid(
            &crate::cbor::encode_dag_cbor(&TestRecord {
                record_type: "app.gsv.record".to_string(),
                text: text.to_string(),
            })
            .unwrap(),
        )
    }

    fn unsigned(prev: Option<Cid>) -> UnsignedCommit {
        UnsignedCommit::new(did(), data_cid("root"), rev("3jqfcqzm3fo2j"), prev)
    }

    #[test]
    fn validates_dids() {
        assert_eq!(
            Did::new("did:web:pds.example.com").unwrap().as_str(),
            "did:web:pds.example.com"
        );
        assert_eq!(
            Did::new("did:plc:abc123").unwrap().as_str(),
            "did:plc:abc123"
        );
        assert!(matches!(
            Did::new("web:pds.example.com"),
            Err(CommitError::InvalidDid { .. })
        ));
        assert!(matches!(
            Did::new("did:Web:pds.example.com"),
            Err(CommitError::InvalidDid { .. })
        ));
        assert!(matches!(
            Did::new("did:web:"),
            Err(CommitError::InvalidDid { .. })
        ));
        assert!(matches!(
            Did::new("did:web:pds.example.com/"),
            Err(CommitError::InvalidDid { .. })
        ));
    }

    #[test]
    fn validates_repo_revisions_as_tids() {
        assert_eq!(
            RepoRev::new("3jqfcqzm3fo2j").unwrap().as_str(),
            "3jqfcqzm3fo2j"
        );
        assert!(matches!(
            RepoRev::new("1jqfcqzm3fo2j"),
            Err(CommitError::InvalidRev { .. })
        ));
        assert!(matches!(
            RepoRev::new("3jqfcqzm3fo2"),
            Err(CommitError::InvalidRev { .. })
        ));
        assert!(matches!(
            RepoRev::new("3jqfcqzm3fo2J"),
            Err(CommitError::InvalidRev { .. })
        ));
    }

    #[test]
    fn unsigned_commit_defaults_to_repo_version_three() {
        let commit = unsigned(None);

        assert_eq!(commit.version, COMMIT_VERSION);
        assert_eq!(commit.did, did());
        assert_eq!(commit.prev, None);
    }

    #[test]
    fn signable_bytes_are_deterministic() {
        let commit = unsigned(None);

        assert_eq!(
            commit.signable_bytes().unwrap(),
            commit.signable_bytes().unwrap()
        );
        assert_eq!(
            decode_dag_cbor::<UnsignedCommit>(&commit.signable_bytes().unwrap()).unwrap(),
            commit
        );
    }

    #[test]
    fn signing_uses_unsigned_commit_bytes() {
        let commit = unsigned(None);
        let signable = commit.signable_bytes().unwrap();
        let signer = HashSigner(b"test-key");
        let signed = commit.sign_with(&signer).unwrap();

        assert_eq!(signed.signable_bytes().unwrap(), signable);
        assert_eq!(signed.unsigned(), commit);
        assert_eq!(signed.sig, signer.sign_commit(&signable).unwrap());
    }

    #[test]
    fn signature_is_not_part_of_signable_bytes() {
        let commit = unsigned(None);
        let signed_a = commit.with_signature(vec![1, 2, 3]).unwrap();
        let signed_b = commit.with_signature(vec![9, 8, 7, 6]).unwrap();

        assert_eq!(
            signed_a.signable_bytes().unwrap(),
            signed_b.signable_bytes().unwrap()
        );
        assert_ne!(
            signed_a.encode_block().unwrap().cid,
            signed_b.encode_block().unwrap().cid
        );
    }

    #[test]
    fn prev_link_changes_signable_bytes_and_commit_cid() {
        let prev = unsigned(None)
            .with_signature(vec![1])
            .unwrap()
            .encode_block()
            .unwrap();
        let without_prev = unsigned(None).with_signature(vec![2]).unwrap();
        let with_prev = unsigned(Some(prev.cid)).with_signature(vec![2]).unwrap();

        assert_ne!(
            without_prev.signable_bytes().unwrap(),
            with_prev.signable_bytes().unwrap()
        );
        assert_ne!(
            without_prev.encode_block().unwrap().cid,
            with_prev.encode_block().unwrap().cid
        );
        assert_eq!(with_prev.prev, Some(prev.cid));
    }

    #[test]
    fn next_unsigned_links_to_previous_commit() {
        let first = unsigned(None)
            .with_signature(vec![1])
            .unwrap()
            .encode_block()
            .unwrap();
        let second =
            first
                .commit
                .next_unsigned(first.cid, data_cid("next-root"), rev("3jqfcqzm3fo3j"));

        assert_eq!(second.did, did());
        assert_eq!(second.prev, Some(first.cid));
        assert_eq!(second.data, data_cid("next-root"));
    }

    #[test]
    fn signed_commit_round_trips_through_dag_cbor() {
        let signed = unsigned(None).with_signature(vec![0, 1, 2, 255]).unwrap();
        let block = signed.encode_block().unwrap();
        let decoded: SignedCommit = decode_dag_cbor(&block.bytes).unwrap();

        assert_eq!(decoded, signed);
        assert_eq!(CommitBlock::decode(&block.bytes).unwrap(), block);
    }

    #[test]
    fn signature_encodes_as_cbor_byte_string() {
        let signed = unsigned(None).with_signature(vec![0, 1, 2, 255]).unwrap();
        let block = signed.encode_block().unwrap();

        assert!(block
            .bytes
            .windows(5)
            .any(|window| window == [0x44, 0, 1, 2, 255]));
    }

    #[test]
    fn write_to_stores_content_addressed_commit_block() {
        let signed = unsigned(None).with_signature(vec![1, 2, 3]).unwrap();
        let mut store = MemoryRepoStore::new();
        let block = signed.write_to(&mut store).unwrap();
        let stored_bytes = store.get_block(&block.cid).unwrap().unwrap();

        assert_eq!(stored_bytes, block.bytes);
        verify_repo_block_cid(&block.cid, &stored_bytes).unwrap();
        assert_eq!(
            CommitBlock::read_from(&store, &block.cid).unwrap().unwrap(),
            block
        );
    }

    #[test]
    fn duplicate_commit_write_is_idempotent() {
        let signed = unsigned(None).with_signature(vec![1, 2, 3]).unwrap();
        let mut store = MemoryRepoStore::new();
        let first = signed.write_to(&mut store).unwrap();
        let second = signed.write_to(&mut store).unwrap();

        assert_eq!(first.cid, second.cid);
        assert_eq!(store.block_count(), 1);
    }

    #[test]
    fn read_from_returns_none_for_missing_commit() {
        let store = MemoryRepoStore::new();
        let missing = unsigned(None)
            .with_signature(vec![1])
            .unwrap()
            .encode_block()
            .unwrap()
            .cid;

        assert_eq!(CommitBlock::read_from(&store, &missing).unwrap(), None);
    }

    #[test]
    fn rejects_unsupported_version_before_signing() {
        let mut commit = unsigned(None);
        commit.version = 2;

        assert!(matches!(
            commit.sign_with(&HashSigner(b"test-key")),
            Err(CommitError::UnsupportedVersion { version: 2 })
        ));
    }

    #[test]
    fn rejects_unsupported_signed_commit_version_before_encoding() {
        let mut commit = unsigned(None).with_signature(vec![1]).unwrap();
        commit.version = 2;

        assert!(matches!(
            commit.encode_block(),
            Err(CommitError::UnsupportedVersion { version: 2 })
        ));
    }

    #[test]
    fn propagates_signer_failures() {
        assert!(matches!(
            unsigned(None).sign_with(&FailingSigner),
            Err(CommitError::Signing(message)) if message == "missing key"
        ));
    }
}
