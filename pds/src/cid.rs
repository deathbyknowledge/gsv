//! CID construction, parsing, and validation helpers.

use std::str::FromStr;

use atrium_repo::blockstore::{DAG_CBOR, SHA2_256};
pub use atrium_repo::Cid;
use atrium_repo::Multihash;
use cid::Version;
use sha2::{Digest, Sha256};
use thiserror::Error;

pub const DAG_CBOR_CODEC: u64 = DAG_CBOR;
pub const RAW_CODEC: u64 = 0x55;
pub const SHA2_256_CODE: u64 = SHA2_256;

#[derive(Debug, Error)]
pub enum CidError {
    #[error("invalid CID `{value}`: {reason}")]
    Invalid { value: String, reason: String },

    #[error("invalid repo block CID `{cid}`: {reason}")]
    InvalidRepoBlock { cid: String, reason: String },
}

pub fn parse_cid(value: &str) -> Result<Cid, CidError> {
    Cid::from_str(value).map_err(|error| CidError::Invalid {
        value: value.to_string(),
        reason: error.to_string(),
    })
}

pub fn dag_cbor_cid(bytes: &[u8]) -> Cid {
    cid_for_bytes(DAG_CBOR_CODEC, bytes)
}

pub fn raw_cid(bytes: &[u8]) -> Cid {
    cid_for_bytes(RAW_CODEC, bytes)
}

pub fn raw_cid_from_sha256_digest(digest: &[u8]) -> Cid {
    cid_from_sha256_digest(RAW_CODEC, digest)
}

pub fn cid_for_bytes(codec: u64, bytes: &[u8]) -> Cid {
    let digest = Sha256::digest(bytes);
    cid_from_sha256_digest(codec, digest.as_slice())
}

fn cid_from_sha256_digest(codec: u64, digest: &[u8]) -> Cid {
    let hash = Multihash::wrap(SHA2_256_CODE, digest)
        .expect("SHA-256 digest always fits in default multihash size");
    Cid::new_v1(codec, hash)
}

pub fn validate_repo_block_cid(cid: &Cid) -> Result<(), CidError> {
    if cid.version() != Version::V1 {
        return invalid_repo_block(cid, "must be CIDv1");
    }
    if cid.codec() != DAG_CBOR_CODEC {
        return invalid_repo_block(cid, "must use dag-cbor codec");
    }
    if cid.hash().code() != SHA2_256_CODE {
        return invalid_repo_block(cid, "must use sha2-256 multihash");
    }
    if cid.hash().digest().len() != 32 {
        return invalid_repo_block(cid, "sha2-256 digest must be 32 bytes");
    }
    Ok(())
}

pub fn verify_repo_block_cid(cid: &Cid, bytes: &[u8]) -> Result<(), CidError> {
    validate_repo_block_cid(cid)?;
    let actual = dag_cbor_cid(bytes);
    if &actual != cid {
        return invalid_repo_block(
            cid,
            format!("content hashes to `{actual}`, not the supplied CID"),
        );
    }
    Ok(())
}

fn invalid_repo_block<T>(cid: &Cid, reason: impl Into<String>) -> Result<T, CidError> {
    Err(CidError::InvalidRepoBlock {
        cid: cid.to_string(),
        reason: reason.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_dag_cbor_cid_from_bytes() {
        let cid = dag_cbor_cid(&[0xa2, 0x61, 0x61, 0x01, 0x61, 0x62, 0x02]);

        assert!(cid.to_string().starts_with("bafy"));
        assert_eq!(cid.version(), Version::V1);
        assert_eq!(cid.codec(), DAG_CBOR_CODEC);
        assert_eq!(cid.hash().code(), SHA2_256_CODE);
        assert_eq!(cid.hash().digest().len(), 32);
        validate_repo_block_cid(&cid).unwrap();
    }

    #[test]
    fn parses_and_verifies_repo_block_cid() {
        let bytes = [0xf6];
        let cid = dag_cbor_cid(&bytes);
        let parsed = parse_cid(&cid.to_string()).unwrap();

        assert_eq!(parsed, cid);
        verify_repo_block_cid(&parsed, &bytes).unwrap();
    }

    #[test]
    fn rejects_content_mismatch() {
        let cid = dag_cbor_cid(&[0xf6]);

        assert!(verify_repo_block_cid(&cid, &[0xf5]).is_err());
    }

    #[test]
    fn rejects_non_repo_block_codec() {
        let cid = raw_cid(b"raw bytes");

        assert!(validate_repo_block_cid(&cid).is_err());
    }

    #[test]
    fn computes_raw_cid_from_bytes() {
        let cid = raw_cid(b"raw bytes");

        assert!(cid.to_string().starts_with("baf"));
        assert_eq!(cid.version(), Version::V1);
        assert_eq!(cid.codec(), RAW_CODEC);
        assert_eq!(cid.hash().code(), SHA2_256_CODE);
        assert_eq!(cid.hash().digest().len(), 32);
    }

    #[test]
    fn computes_raw_cid_from_streamed_sha256_digest() {
        let digest = Sha256::digest(b"raw bytes");

        assert_eq!(raw_cid_from_sha256_digest(&digest), raw_cid(b"raw bytes"));
    }
}
