//! CAR import, export, and commit diff slice support.

use std::collections::BTreeSet;
use std::io::Cursor;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::cbor::{decode_dag_cbor, encode_dag_cbor, CborError};
use crate::cid::{verify_repo_block_cid, Cid, CidError};
use crate::storage::{RepoBlockStore, StorageError};

#[derive(Debug, Error)]
pub enum CarError {
    #[error(transparent)]
    Cbor(#[from] CborError),

    #[error(transparent)]
    Storage(#[from] StorageError),

    #[error(transparent)]
    Cid(#[from] CidError),

    #[error("missing repo block `{cid}`")]
    MissingBlock { cid: Cid },

    #[error("invalid CAR varint")]
    InvalidVarint,

    #[error("invalid CAR section: {0}")]
    InvalidSection(String),

    #[error("invalid CAR CID: {0}")]
    InvalidCid(String),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CarHeader {
    pub version: u64,
    pub roots: Vec<Cid>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CarBlock {
    pub cid: Cid,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecodedCar {
    pub roots: Vec<Cid>,
    pub blocks: Vec<CarBlock>,
}

pub fn encode_car_from_store<S>(
    roots: &[Cid],
    cids: impl IntoIterator<Item = Cid>,
    storage: &S,
) -> Result<Vec<u8>, CarError>
where
    S: RepoBlockStore,
{
    let mut blocks = Vec::new();
    let mut seen = BTreeSet::new();
    for cid in cids {
        if !seen.insert(cid) {
            continue;
        }
        let bytes = storage
            .get_block(&cid)?
            .ok_or(CarError::MissingBlock { cid })?;
        blocks.push(CarBlock { cid, bytes });
    }
    encode_car(roots, blocks)
}

pub fn encode_car(
    roots: &[Cid],
    blocks: impl IntoIterator<Item = CarBlock>,
) -> Result<Vec<u8>, CarError> {
    let header = CarHeader {
        version: 1,
        roots: roots.to_vec(),
    };
    let header_bytes = encode_dag_cbor(&header)?;
    let mut car = Vec::new();
    push_varint(header_bytes.len(), &mut car);
    car.extend_from_slice(&header_bytes);

    for block in blocks {
        verify_repo_block_cid(&block.cid, &block.bytes)?;
        let cid_bytes = block.cid.to_bytes();
        push_varint(cid_bytes.len() + block.bytes.len(), &mut car);
        car.extend_from_slice(&cid_bytes);
        car.extend_from_slice(&block.bytes);
    }

    Ok(car)
}

pub fn decode_car(bytes: &[u8]) -> Result<DecodedCar, CarError> {
    let mut offset = 0;
    let header_len = read_varint(bytes, &mut offset)?;
    let header_end = offset
        .checked_add(header_len)
        .ok_or_else(|| CarError::InvalidSection("header length overflows".to_string()))?;
    if header_end > bytes.len() {
        return Err(CarError::InvalidSection(
            "header extends past end of input".to_string(),
        ));
    }

    let header: CarHeader = decode_dag_cbor(&bytes[offset..header_end])?;
    if header.version != 1 {
        return Err(CarError::InvalidSection(format!(
            "unsupported CAR version {}",
            header.version
        )));
    }
    offset = header_end;

    let mut blocks = Vec::new();
    while offset < bytes.len() {
        let section_len = read_varint(bytes, &mut offset)?;
        let section_end = offset
            .checked_add(section_len)
            .ok_or_else(|| CarError::InvalidSection("block length overflows".to_string()))?;
        if section_end > bytes.len() {
            return Err(CarError::InvalidSection(
                "block extends past end of input".to_string(),
            ));
        }

        let mut cursor = Cursor::new(&bytes[offset..section_end]);
        let cid = Cid::read_bytes(&mut cursor)
            .map_err(|error| CarError::InvalidCid(error.to_string()))?;
        let cid_len = cursor.position() as usize;
        if cid_len >= section_len {
            return Err(CarError::InvalidSection(
                "block section does not contain block bytes".to_string(),
            ));
        }

        let block_start = offset + cid_len;
        let block_bytes = bytes[block_start..section_end].to_vec();
        verify_repo_block_cid(&cid, &block_bytes)?;
        blocks.push(CarBlock {
            cid,
            bytes: block_bytes,
        });
        offset = section_end;
    }

    Ok(DecodedCar {
        roots: header.roots,
        blocks,
    })
}

fn push_varint(mut value: usize, out: &mut Vec<u8>) {
    while value >= 0x80 {
        out.push((value as u8 & 0x7f) | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

fn read_varint(bytes: &[u8], offset: &mut usize) -> Result<usize, CarError> {
    let mut shift = 0;
    let mut value = 0usize;
    while *offset < bytes.len() {
        let byte = bytes[*offset];
        *offset += 1;

        let part = (byte & 0x7f) as usize;
        value |= part.checked_shl(shift).ok_or(CarError::InvalidVarint)?;
        if byte & 0x80 == 0 {
            return Ok(value);
        }

        shift += 7;
        if shift >= usize::BITS {
            return Err(CarError::InvalidVarint);
        }
    }
    Err(CarError::InvalidVarint)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cbor::encode_dag_cbor;
    use crate::storage::MemoryRepoStore;

    #[test]
    fn encodes_and_decodes_car_v1_with_roots_and_blocks() {
        let mut store = MemoryRepoStore::new();
        let first = store.put_block(encode_dag_cbor("first").unwrap()).unwrap();
        let second = store.put_block(encode_dag_cbor("second").unwrap()).unwrap();

        let car = encode_car_from_store(&[first], [first, second], &store).unwrap();
        let decoded = decode_car(&car).unwrap();

        assert_eq!(decoded.roots, vec![first]);
        assert_eq!(decoded.blocks.len(), 2);
        assert_eq!(decoded.blocks[0].cid, first);
        assert_eq!(decoded.blocks[1].cid, second);
        assert_eq!(
            decode_dag_cbor::<String>(&decoded.blocks[0].bytes).unwrap(),
            "first"
        );
        assert_eq!(
            decode_dag_cbor::<String>(&decoded.blocks[1].bytes).unwrap(),
            "second"
        );
    }

    #[test]
    fn encodes_duplicate_cids_once_when_exporting_from_store() {
        let mut store = MemoryRepoStore::new();
        let cid = store.put_block(encode_dag_cbor("value").unwrap()).unwrap();

        let car = encode_car_from_store(&[cid], [cid, cid, cid], &store).unwrap();
        let decoded = decode_car(&car).unwrap();

        assert_eq!(decoded.blocks.len(), 1);
        assert_eq!(decoded.blocks[0].cid, cid);
    }

    #[test]
    fn rejects_missing_blocks() {
        let store = MemoryRepoStore::new();
        let cid = crate::cid::dag_cbor_cid(&encode_dag_cbor("missing").unwrap());

        assert!(matches!(
            encode_car_from_store(&[cid], [cid], &store),
            Err(CarError::MissingBlock { cid: missing }) if missing == cid
        ));
    }

    #[test]
    fn rejects_truncated_car() {
        let mut store = MemoryRepoStore::new();
        let cid = store.put_block(encode_dag_cbor("value").unwrap()).unwrap();
        let mut car = encode_car_from_store(&[cid], [cid], &store).unwrap();
        car.pop();

        assert!(decode_car(&car).is_err());
    }
}
