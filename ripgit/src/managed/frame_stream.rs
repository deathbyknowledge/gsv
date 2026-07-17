use std::collections::BTreeMap;
use std::pin::Pin;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use futures_util::{Stream, StreamExt};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use worker::{Error, Result};

use super::{ManagedError, ManagedResult};

pub const DATA_FRAME_STREAM_MEDIA_TYPE: &str = "application/vnd.gsv.data-frame-stream.v1";
pub const RESTORE_CONTROL_KIND: &str = "gsv.restore.control";
pub const RESTORE_CONTROL_MEDIA_TYPE: &str = "application/json";
pub const RIPGIT_MANIFEST_KIND: &str = "do.sqlite.schema";
pub const RIPGIT_MANIFEST_MEDIA_TYPE: &str = "application/vnd.gsv.ripgit-snapshot-manifest+json";
pub const RIPGIT_PAGE_KIND: &str = "do.sqlite.rows";
pub const RIPGIT_PAGE_MEDIA_TYPE: &str = "application/vnd.gsv.ripgit-snapshot-page+json";

pub const MAX_FRAME_BODY_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_FRAME_COUNT: u64 = 10_000_000;
pub const MAX_TOTAL_BODY_BYTES: u64 = 16 * 1024 * 1024 * 1024;
pub const MAX_RESTORE_CONTROL_BODY_BYTES: usize = 16 * 1024;
pub const MAX_DATA_FRAME_COUNT: u64 = MAX_FRAME_COUNT - 1;
pub const MAX_DATA_TOTAL_BODY_BYTES: u64 =
    MAX_TOTAL_BODY_BYTES - MAX_RESTORE_CONTROL_BODY_BYTES as u64;

const MAGIC: [u8; 8] = [0x47, 0x53, 0x56, 0x44, 0x46, 0x00, 0x01, 0x0a];
const SEMANTIC_DIGEST_DOMAIN: [u8; 7] = [0x47, 0x53, 0x56, 0x53, 0x00, 0x01, 0x0a];
const PREFIX_BYTES: usize = 18;
const MAX_KIND_BYTES: usize = 64;
const MAX_OBJECT_ID_BYTES: usize = 1024;
const MAX_MEDIA_TYPE_BYTES: usize = 127;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DataFrameRecord {
    pub kind: String,
    pub object_id: String,
    pub body_media_type: String,
    pub part: u32,
    pub body: Vec<u8>,
}

impl DataFrameRecord {
    pub fn validate(&self) -> ManagedResult<()> {
        validate_identifier(&self.kind, MAX_KIND_BYTES, "frame kind")?;
        validate_identifier(&self.object_id, MAX_OBJECT_ID_BYTES, "frame object ID")?;
        validate_media_type(&self.body_media_type)?;
        if self.body.len() > MAX_FRAME_BODY_BYTES {
            return Err(ManagedError::new(
                413,
                "managed_frame_body_too_large",
                "Managed data frame body exceeds 4 MiB",
            ));
        }
        Ok(())
    }
}

pub fn stream_magic() -> Vec<u8> {
    MAGIC.to_vec()
}

pub fn stream_terminator() -> Vec<u8> {
    vec![0; PREFIX_BYTES]
}

pub fn encode_record(record: DataFrameRecord) -> ManagedResult<Vec<Vec<u8>>> {
    record.validate()?;
    let kind = record.kind.into_bytes();
    let object_id = record.object_id.into_bytes();
    let media_type = record.body_media_type.into_bytes();
    let mut prefix = vec![0_u8; PREFIX_BYTES];
    prefix[0..2].copy_from_slice(&(kind.len() as u16).to_be_bytes());
    prefix[2..4].copy_from_slice(&(object_id.len() as u16).to_be_bytes());
    prefix[4..6].copy_from_slice(&(media_type.len() as u16).to_be_bytes());
    prefix[6..10].copy_from_slice(&record.part.to_be_bytes());
    prefix[10..18].copy_from_slice(&(record.body.len() as u64).to_be_bytes());
    Ok(vec![prefix, kind, object_id, media_type, record.body])
}

pub struct DataFrameReader<S> {
    source: Pin<Box<S>>,
    buffered: Vec<u8>,
    buffered_offset: usize,
    ended: bool,
    started: bool,
    terminated: bool,
    frame_count: u64,
    total_body_bytes: u64,
    max_first_body_bytes: usize,
}

impl<S> DataFrameReader<S>
where
    S: Stream<Item = Result<Vec<u8>>> + 'static,
{
    #[cfg(test)]
    pub fn new(source: S) -> Self {
        Self::with_first_body_limit(source, MAX_FRAME_BODY_BYTES)
    }

    pub fn with_first_body_limit(source: S, max_first_body_bytes: usize) -> Self {
        Self {
            source: Box::pin(source),
            buffered: Vec::new(),
            buffered_offset: 0,
            ended: false,
            started: false,
            terminated: false,
            frame_count: 0,
            total_body_bytes: 0,
            max_first_body_bytes: max_first_body_bytes.min(MAX_FRAME_BODY_BYTES),
        }
    }

    pub async fn next_record(&mut self) -> ManagedResult<Option<DataFrameRecord>> {
        if self.terminated {
            return Ok(None);
        }
        if !self.started {
            let magic = self.read_exact(MAGIC.len(), "stream magic").await?;
            if magic != MAGIC {
                return Err(invalid_stream(
                    "invalid_managed_frame_magic",
                    "Managed data frame stream has an invalid magic value",
                ));
            }
            self.started = true;
        }

        let prefix = self.read_exact(PREFIX_BYTES, "record prefix").await?;
        if prefix.iter().all(|byte| *byte == 0) {
            self.require_end().await?;
            self.terminated = true;
            return Ok(None);
        }

        let kind_bytes = u16::from_be_bytes([prefix[0], prefix[1]]) as usize;
        let object_id_bytes = u16::from_be_bytes([prefix[2], prefix[3]]) as usize;
        let media_type_bytes = u16::from_be_bytes([prefix[4], prefix[5]]) as usize;
        let part = u32::from_be_bytes([prefix[6], prefix[7], prefix[8], prefix[9]]);
        let body_bytes = u64::from_be_bytes([
            prefix[10], prefix[11], prefix[12], prefix[13], prefix[14], prefix[15], prefix[16],
            prefix[17],
        ]);
        let max_body_bytes = if self.frame_count == 0 {
            self.max_first_body_bytes
        } else {
            MAX_FRAME_BODY_BYTES
        };
        if kind_bytes == 0
            || kind_bytes > MAX_KIND_BYTES
            || object_id_bytes == 0
            || object_id_bytes > MAX_OBJECT_ID_BYTES
            || media_type_bytes == 0
            || media_type_bytes > MAX_MEDIA_TYPE_BYTES
            || body_bytes > max_body_bytes as u64
        {
            return Err(invalid_stream(
                "invalid_managed_frame_prefix",
                "Managed data frame prefix exceeds the v1 limits",
            ));
        }
        self.frame_count = self.frame_count.checked_add(1).ok_or_else(|| {
            invalid_stream(
                "managed_frame_limit_exceeded",
                "Managed data frame count exceeds the v1 limit",
            )
        })?;
        self.total_body_bytes = self
            .total_body_bytes
            .checked_add(body_bytes)
            .ok_or_else(|| {
                invalid_stream(
                    "managed_frame_limit_exceeded",
                    "Managed data frame body bytes exceed the v1 limit",
                )
            })?;
        if self.frame_count > MAX_FRAME_COUNT || self.total_body_bytes > MAX_TOTAL_BODY_BYTES {
            return Err(invalid_stream(
                "managed_frame_limit_exceeded",
                "Managed data frame stream exceeds the v1 limits",
            ));
        }

        let kind = self.read_string(kind_bytes, "frame kind").await?;
        let object_id = self.read_string(object_id_bytes, "frame object ID").await?;
        let body_media_type = self
            .read_string(media_type_bytes, "frame media type")
            .await?;
        let body = self.read_exact(body_bytes as usize, "frame body").await?;
        let record = DataFrameRecord {
            kind,
            object_id,
            body_media_type,
            part,
            body,
        };
        record.validate()?;
        Ok(Some(record))
    }

    async fn read_string(&mut self, length: usize, label: &str) -> ManagedResult<String> {
        String::from_utf8(self.read_exact(length, label).await?).map_err(|_| {
            invalid_stream(
                "invalid_managed_frame_text",
                "Managed data frame metadata is not valid UTF-8",
            )
        })
    }

    async fn read_exact(&mut self, length: usize, label: &str) -> ManagedResult<Vec<u8>> {
        let mut result = vec![0_u8; length];
        let mut written = 0;
        while written < length {
            if self.buffered_offset == self.buffered.len() {
                self.fill().await?;
                if self.ended {
                    return Err(invalid_stream(
                        "truncated_managed_frame_stream",
                        format!("Managed data frame stream ended inside {}", label),
                    ));
                }
            }
            let available = self.buffered.len() - self.buffered_offset;
            let count = available.min(length - written);
            result[written..written + count].copy_from_slice(
                &self.buffered[self.buffered_offset..self.buffered_offset + count],
            );
            self.buffered_offset += count;
            written += count;
        }
        Ok(result)
    }

    async fn require_end(&mut self) -> ManagedResult<()> {
        if self.buffered_offset < self.buffered.len() {
            return Err(invalid_stream(
                "managed_frame_trailing_data",
                "Managed data frame stream contains bytes after its terminator",
            ));
        }
        self.fill().await?;
        if !self.ended {
            return Err(invalid_stream(
                "managed_frame_trailing_data",
                "Managed data frame stream contains bytes after its terminator",
            ));
        }
        Ok(())
    }

    async fn fill(&mut self) -> ManagedResult<()> {
        if self.ended || self.buffered_offset < self.buffered.len() {
            return Ok(());
        }
        loop {
            match self.source.next().await {
                Some(Ok(chunk)) if chunk.is_empty() => continue,
                Some(Ok(chunk)) => {
                    self.buffered = chunk;
                    self.buffered_offset = 0;
                    return Ok(());
                }
                Some(Err(_)) => {
                    return Err(ManagedError::internal(
                        "managed_frame_stream_read_failed",
                        "Managed data frame request body could not be read",
                    ));
                }
                None => {
                    self.ended = true;
                    self.buffered.clear();
                    self.buffered_offset = 0;
                    return Ok(());
                }
            }
        }
    }
}

pub fn canonical_json_bytes<T: Serialize>(value: &T) -> ManagedResult<Vec<u8>> {
    let value = serde_json::to_value(value).map_err(ManagedError::from)?;
    serde_json::to_vec(&value).map_err(ManagedError::from)
}

pub fn parse_canonical_json(body: &[u8]) -> ManagedResult<Value> {
    let value: Value = serde_json::from_slice(body).map_err(|_| {
        invalid_stream(
            "noncanonical_managed_json",
            "Managed data frame JSON body is invalid",
        )
    })?;
    if canonical_json_bytes(&value)? != body {
        return Err(invalid_stream(
            "noncanonical_managed_json",
            "Managed data frame JSON body is not canonical",
        ));
    }
    Ok(value)
}

pub struct ObjectSemanticDigestV1 {
    state: [u8; 32],
    next_part_by_kind: BTreeMap<String, u32>,
}

impl ObjectSemanticDigestV1 {
    pub fn new(object_id: &str) -> ManagedResult<Self> {
        validate_identifier(object_id, MAX_OBJECT_ID_BYTES, "semantic object ID")?;
        let object_id = object_id.as_bytes();
        let state = sha256(&[
            &SEMANTIC_DIGEST_DOMAIN,
            &(object_id.len() as u32).to_be_bytes(),
            object_id,
        ]);
        Ok(Self {
            state,
            next_part_by_kind: BTreeMap::new(),
        })
    }

    pub fn append(&mut self, record: &DataFrameRecord) -> ManagedResult<()> {
        record.validate()?;
        if !matches!(
            record.kind.as_str(),
            RIPGIT_MANIFEST_KIND | RIPGIT_PAGE_KIND
        ) {
            return Err(invalid_stream(
                "invalid_semantic_frame_kind",
                "Ripgit restore contains an unsupported semantic frame kind",
            ));
        }
        let expected_part = self
            .next_part_by_kind
            .get(&record.kind)
            .copied()
            .unwrap_or(0);
        if record.part != expected_part {
            return Err(invalid_stream(
                "invalid_semantic_frame_part",
                "Ripgit semantic frame parts must be contiguous from zero",
            ));
        }
        let next_part = expected_part.checked_add(1).ok_or_else(|| {
            invalid_stream(
                "managed_frame_limit_exceeded",
                "Ripgit semantic frame part is exhausted",
            )
        })?;
        self.next_part_by_kind
            .insert(record.kind.clone(), next_part);

        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Metadata<'a> {
            body_encoding: &'static str,
            body_media_type: &'a str,
            kind: &'a str,
            part: u32,
        }
        let metadata = canonical_json_bytes(&Metadata {
            body_encoding: "identity",
            body_media_type: &record.body_media_type,
            kind: &record.kind,
            part: record.part,
        })?;
        let record_digest = sha256(&[
            &(metadata.len() as u32).to_be_bytes(),
            &metadata,
            &(record.body.len() as u64).to_be_bytes(),
            &record.body,
        ]);
        self.state = sha256(&[&SEMANTIC_DIGEST_DOMAIN, &self.state, &record_digest]);
        Ok(())
    }

    pub fn digest_base64_url(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.state)
    }
}

pub fn validate_sha256_base64_url(value: &str) -> ManagedResult<()> {
    if value.len() != 43 {
        return Err(invalid_stream(
            "invalid_semantic_digest",
            "Ripgit semantic digest must be an unpadded base64url SHA-256 digest",
        ));
    }
    let decoded = URL_SAFE_NO_PAD.decode(value).map_err(|_| {
        invalid_stream(
            "invalid_semantic_digest",
            "Ripgit semantic digest must be an unpadded base64url SHA-256 digest",
        )
    })?;
    if decoded.len() != 32 || URL_SAFE_NO_PAD.encode(decoded) != value {
        return Err(invalid_stream(
            "invalid_semantic_digest",
            "Ripgit semantic digest must be an unpadded base64url SHA-256 digest",
        ));
    }
    Ok(())
}

pub(super) fn validate_identifier(
    value: &str,
    maximum_bytes: usize,
    label: &str,
) -> ManagedResult<()> {
    if value.is_empty() || value.len() > maximum_bytes || value.chars().any(char::is_control) {
        return Err(invalid_stream(
            "invalid_managed_frame_identifier",
            format!("Managed {} is invalid", label),
        ));
    }
    Ok(())
}

fn validate_media_type(value: &str) -> ManagedResult<()> {
    let valid_token = |token: &str| {
        !token.is_empty()
            && token.bytes().all(|byte| {
                byte.is_ascii_alphanumeric()
                    || matches!(
                        byte,
                        b'!' | b'#' | b'$' | b'&' | b'^' | b'_' | b'.' | b'+' | b'-'
                    )
            })
    };
    let (essence, parameters) = value
        .split_once(';')
        .map_or((value, None), |(essence, parameters)| {
            (essence, Some(parameters))
        });
    let mut tokens = essence.split('/');
    let valid_essence = matches!(
        (tokens.next(), tokens.next(), tokens.next()),
        (Some(r#type), Some(subtype), None) if valid_token(r#type) && valid_token(subtype)
    );
    let valid_parameters = parameters.is_none_or(|parameters| {
        !parameters.is_empty() && parameters.bytes().all(|byte| (b' '..=b'~').contains(&byte))
    });
    if value.len() > MAX_MEDIA_TYPE_BYTES || !valid_essence || !valid_parameters {
        return Err(invalid_stream(
            "invalid_managed_frame_media_type",
            "Managed data frame media type is invalid",
        ));
    }
    Ok(())
}

fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut digest = Sha256::new();
    for part in parts {
        digest.update(part);
    }
    digest.finalize().into()
}

fn invalid_stream(code: impl Into<String>, message: impl Into<String>) -> ManagedError {
    ManagedError::bad_request(code, message)
}

pub fn stream_error(error: ManagedError) -> Error {
    Error::RustError(format!("{}: {}", error.code, error.message))
}

#[cfg(test)]
mod tests {
    use futures_util::stream;

    use super::*;

    fn record() -> DataFrameRecord {
        DataFrameRecord {
            kind: RIPGIT_PAGE_KIND.to_string(),
            object_id: "repository:alice/memory".to_string(),
            body_media_type: RIPGIT_PAGE_MEDIA_TYPE.to_string(),
            part: 0,
            body: vec![0, 1, 2, 0xfe, 0xff],
        }
    }

    fn encoded(records: Vec<DataFrameRecord>) -> Vec<u8> {
        let mut bytes = stream_magic();
        for record in records {
            for chunk in encode_record(record).unwrap() {
                bytes.extend(chunk);
            }
        }
        bytes.extend(stream_terminator());
        bytes
    }

    #[test]
    fn frame_encoding_preserves_raw_binary_bodies() {
        let bytes = encoded(vec![record()]);
        assert!(bytes
            .windows(5)
            .any(|window| window == [0, 1, 2, 0xfe, 0xff]));
        assert!(!String::from_utf8_lossy(&bytes).contains("AAEC_v8"));
    }

    #[test]
    fn frame_media_types_match_the_shared_wire_grammar() {
        for valid in [
            "application/json",
            "application/vnd.gsv.test+json; charset=utf-8",
        ] {
            validate_media_type(valid).unwrap();
        }
        for invalid in [
            "application",
            "application//json",
            "application/json/extra",
            "application /json",
            "application/json;",
            "application/json;\ncharset=utf-8",
        ] {
            assert!(validate_media_type(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn canonical_json_sorts_object_keys() {
        let value = serde_json::json!({ "z": 1, "a": { "y": true, "b": null } });
        assert_eq!(
            canonical_json_bytes(&value).unwrap(),
            br#"{"a":{"b":null,"y":true},"z":1}"#
        );
        parse_canonical_json(br#"{"a":{"b":null,"y":true},"z":1}"#).unwrap();
        assert!(parse_canonical_json(br#"{"z":1,"a":2}"#).is_err());
    }

    #[test]
    fn semantic_digest_is_stable_and_binds_metadata() {
        let mut digest = ObjectSemanticDigestV1::new("repository:alice/memory").unwrap();
        digest.append(&record()).unwrap();
        assert_eq!(digest.digest_base64_url().len(), 43);
        assert_eq!(
            digest.digest_base64_url(),
            "QKL2JaX9dDeKVRs8C8pwsXhKXxm-gZj0lLckWHnQ8pg"
        );
        assert!(digest.append(&record()).is_err());
    }

    #[test]
    fn reader_handles_single_byte_fragmentation_and_requires_terminal_eof() {
        futures_executor::block_on(async {
            let bytes = encoded(vec![record()]);
            let chunks = bytes
                .iter()
                .copied()
                .map(|byte| Ok(vec![byte]))
                .collect::<Vec<Result<Vec<u8>>>>();
            let mut reader = DataFrameReader::new(stream::iter(chunks));
            assert_eq!(reader.next_record().await.unwrap(), Some(record()));
            assert_eq!(reader.next_record().await.unwrap(), None);
            assert_eq!(reader.next_record().await.unwrap(), None);
        });
    }

    #[test]
    fn reader_rejects_truncation_and_trailing_data() {
        futures_executor::block_on(async {
            let mut truncated = encoded(vec![record()]);
            truncated.pop();
            let mut reader = DataFrameReader::new(stream::iter(vec![Ok(truncated)]));
            reader.next_record().await.unwrap();
            assert_eq!(
                reader.next_record().await.unwrap_err().code,
                "truncated_managed_frame_stream"
            );

            let mut trailing = encoded(vec![]);
            trailing.push(1);
            let mut reader = DataFrameReader::new(stream::iter(vec![Ok(trailing)]));
            assert_eq!(
                reader.next_record().await.unwrap_err().code,
                "managed_frame_trailing_data"
            );
        });
    }

    #[test]
    fn reader_rejects_an_oversized_first_body_before_reading_it() {
        futures_executor::block_on(async {
            let mut oversized = record();
            oversized.body = vec![0; MAX_RESTORE_CONTROL_BODY_BYTES + 1];
            let bytes = encoded(vec![oversized]);
            let prefix_only = bytes[..MAGIC.len() + PREFIX_BYTES].to_vec();
            let mut reader = DataFrameReader::with_first_body_limit(
                stream::iter(vec![Ok(prefix_only)]),
                MAX_RESTORE_CONTROL_BODY_BYTES,
            );
            assert_eq!(
                reader.next_record().await.unwrap_err().code,
                "invalid_managed_frame_prefix"
            );
        });
    }
}
