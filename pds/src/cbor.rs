//! Canonical CBOR encoding and decoding for repo blocks.

use serde::de::DeserializeOwned;
use serde::Serialize;
use thiserror::Error;

use crate::cid::{dag_cbor_cid, Cid};

#[derive(Debug, Error)]
pub enum CborError {
    #[error("failed to encode DAG-CBOR: {0}")]
    Encode(String),

    #[error("failed to decode DAG-CBOR: {0}")]
    Decode(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EncodedBlock {
    pub cid: Cid,
    pub bytes: Vec<u8>,
}

pub fn encode_dag_cbor<T: Serialize + ?Sized>(value: &T) -> Result<Vec<u8>, CborError> {
    serde_ipld_dagcbor::to_vec(value).map_err(|error| CborError::Encode(error.to_string()))
}

pub fn decode_dag_cbor<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, CborError> {
    serde_ipld_dagcbor::from_slice(bytes).map_err(|error| CborError::Decode(error.to_string()))
}

pub fn encode_block<T: Serialize>(value: &T) -> Result<EncodedBlock, CborError> {
    let bytes = encode_dag_cbor(value)?;
    let cid = dag_cbor_cid(&bytes);
    Ok(EncodedBlock { cid, bytes })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde::{Deserialize, Serialize};

    use super::*;
    use crate::cid::verify_repo_block_cid;

    #[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
    struct SimpleRecord {
        #[serde(rename = "$type")]
        record_type: String,
        text: String,
    }

    #[test]
    fn encodes_simple_values_as_expected_dag_cbor() {
        assert_eq!(encode_dag_cbor(&()).unwrap(), vec![0xf6]);
        assert_eq!(encode_dag_cbor(&true).unwrap(), vec![0xf5]);
        assert_eq!(encode_dag_cbor("hi").unwrap(), vec![0x62, b'h', b'i']);
    }

    #[test]
    fn encodes_maps_in_canonical_order() {
        let value = BTreeMap::from([("b", 2_u64), ("a", 1_u64)]);

        assert_eq!(
            encode_dag_cbor(&value).unwrap(),
            vec![0xa2, 0x61, b'a', 0x01, 0x61, b'b', 0x02]
        );
    }

    #[test]
    fn round_trips_struct_records() {
        let record = SimpleRecord {
            record_type: "app.gsv.feed.post".to_string(),
            text: "hello".to_string(),
        };
        let bytes = encode_dag_cbor(&record).unwrap();
        let decoded: SimpleRecord = decode_dag_cbor(&bytes).unwrap();

        assert_eq!(decoded, record);
    }

    #[test]
    fn round_trips_json_object_records() {
        let record = serde_json::json!({
            "$type": "app.gsv.feed.post",
            "text": "hello"
        });
        let bytes = encode_dag_cbor(&record).unwrap();
        let decoded: serde_json::Value = decode_dag_cbor(&bytes).unwrap();

        assert_eq!(decoded, record);
    }

    #[test]
    fn encoded_block_includes_matching_cid() {
        let record = SimpleRecord {
            record_type: "app.gsv.feed.post".to_string(),
            text: "hello".to_string(),
        };
        let block = encode_block(&record).unwrap();

        verify_repo_block_cid(&block.cid, &block.bytes).unwrap();
        assert_eq!(
            decode_dag_cbor::<SimpleRecord>(&block.bytes).unwrap(),
            record
        );
    }
}
