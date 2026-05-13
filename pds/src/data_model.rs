//! Canonical repository data model types.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Clone, Debug, PartialEq, Eq, Error)]
pub enum DataModelError {
    #[error("invalid NSID `{value}`: {reason}")]
    InvalidNsid { value: String, reason: String },

    #[error("invalid record key `{value}`: {reason}")]
    InvalidRecordKey { value: String, reason: String },

    #[error("invalid repo path `{value}`: {reason}")]
    InvalidRepoPath { value: String, reason: String },
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Nsid(String);

impl Nsid {
    pub fn new(value: impl Into<String>) -> Result<Self, DataModelError> {
        let value = value.into();
        validate_nsid(&value)?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for Nsid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<Nsid> for String {
    fn from(value: Nsid) -> Self {
        value.0
    }
}

impl TryFrom<String> for Nsid {
    type Error = DataModelError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl FromStr for Nsid {
    type Err = DataModelError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::new(value)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct RecordKey(String);

impl RecordKey {
    pub fn new(value: impl Into<String>) -> Result<Self, DataModelError> {
        let value = value.into();
        validate_record_key(&value)?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for RecordKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<RecordKey> for String {
    fn from(value: RecordKey) -> Self {
        value.0
    }
}

impl TryFrom<String> for RecordKey {
    type Error = DataModelError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl FromStr for RecordKey {
    type Err = DataModelError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::new(value)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct RepoPath {
    pub collection: Nsid,
    pub rkey: RecordKey,
}

impl RepoPath {
    pub fn new(collection: Nsid, rkey: RecordKey) -> Self {
        Self { collection, rkey }
    }

    pub fn parse(value: &str) -> Result<Self, DataModelError> {
        let (collection, rkey) =
            value
                .split_once('/')
                .ok_or_else(|| DataModelError::InvalidRepoPath {
                    value: value.to_string(),
                    reason: "expected collection/rkey".to_string(),
                })?;

        if rkey.contains('/') {
            return Err(DataModelError::InvalidRepoPath {
                value: value.to_string(),
                reason: "expected exactly one slash".to_string(),
            });
        }

        Ok(Self {
            collection: Nsid::new(collection).map_err(|error| DataModelError::InvalidRepoPath {
                value: value.to_string(),
                reason: error.to_string(),
            })?,
            rkey: RecordKey::new(rkey).map_err(|error| DataModelError::InvalidRepoPath {
                value: value.to_string(),
                reason: error.to_string(),
            })?,
        })
    }

    pub fn as_mst_key(&self) -> String {
        format!("{}/{}", self.collection, self.rkey)
    }
}

impl fmt::Display for RepoPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.as_mst_key())
    }
}

impl FromStr for RepoPath {
    type Err = DataModelError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::parse(value)
    }
}

fn validate_nsid(value: &str) -> Result<(), DataModelError> {
    if value.is_empty() {
        return invalid_nsid(value, "must not be empty");
    }
    if value.len() > 317 {
        return invalid_nsid(value, "must be at most 317 characters");
    }
    if !value.is_ascii() {
        return invalid_nsid(value, "must contain only ASCII characters");
    }

    let segments = value.split('.').collect::<Vec<_>>();
    if segments.len() < 3 {
        return invalid_nsid(value, "must contain at least 3 segments");
    }
    if segments.iter().any(|segment| segment.is_empty()) {
        return invalid_nsid(value, "segments must not be empty");
    }

    let name = segments.last().expect("segments are non-empty");
    validate_nsid_name(value, name)?;

    let authority = &segments[..segments.len() - 1];
    let authority_len = authority.iter().map(|segment| segment.len()).sum::<usize>()
        + authority.len().saturating_sub(1);
    if authority_len > 253 {
        return invalid_nsid(value, "domain authority must be at most 253 characters");
    }

    let first = authority.first().expect("NSID has at least 3 segments");
    if first.as_bytes()[0].is_ascii_digit() {
        return invalid_nsid(
            value,
            "top-level domain segment must not start with a digit",
        );
    }

    for segment in authority {
        validate_nsid_authority_segment(value, segment)?;
    }

    Ok(())
}

fn validate_nsid_authority_segment(nsid: &str, segment: &str) -> Result<(), DataModelError> {
    if segment.len() > 63 {
        return invalid_nsid(
            nsid,
            "domain authority segments must be at most 63 characters",
        );
    }
    if segment.starts_with('-') || segment.ends_with('-') {
        return invalid_nsid(
            nsid,
            "domain authority segments must not start or end with hyphen",
        );
    }
    if !segment
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return invalid_nsid(
            nsid,
            "domain authority segments may contain only ASCII letters, digits, and hyphen",
        );
    }
    Ok(())
}

fn validate_nsid_name(nsid: &str, name: &str) -> Result<(), DataModelError> {
    if name.len() > 63 {
        return invalid_nsid(nsid, "name segment must be at most 63 characters");
    }
    if name.as_bytes()[0].is_ascii_digit() {
        return invalid_nsid(nsid, "name segment must not start with a digit");
    }
    if !name.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return invalid_nsid(
            nsid,
            "name segment may contain only ASCII letters and digits",
        );
    }
    Ok(())
}

fn validate_record_key(value: &str) -> Result<(), DataModelError> {
    if value.is_empty() {
        return invalid_record_key(value, "must not be empty");
    }
    if value.len() > 512 {
        return invalid_record_key(value, "must be at most 512 characters");
    }
    if value == "." || value == ".." {
        return invalid_record_key(value, "must not be `.` or `..`");
    }
    if !value.bytes().all(is_record_key_byte) {
        return invalid_record_key(
            value,
            "may contain only ASCII letters, digits, period, dash, underscore, colon, or tilde",
        );
    }
    Ok(())
}

fn is_record_key_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b':' | b'~')
}

fn invalid_nsid<T>(value: &str, reason: impl Into<String>) -> Result<T, DataModelError> {
    Err(DataModelError::InvalidNsid {
        value: value.to_string(),
        reason: reason.into(),
    })
}

fn invalid_record_key<T>(value: &str, reason: impl Into<String>) -> Result<T, DataModelError> {
    Err(DataModelError::InvalidRecordKey {
        value: value.to_string(),
        reason: reason.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_valid_nsids() {
        for value in [
            "com.example.fooBar",
            "net.users.bob.ping",
            "a-0.b-1.c",
            "a.b.c",
            "com.example.fooBarV2",
            "cn.8.lex.stuff",
        ] {
            assert_eq!(Nsid::new(value).unwrap().as_str(), value);
        }
    }

    #[test]
    fn rejects_invalid_nsids() {
        for value in [
            "",
            "com.example",
            "com..example.record",
            "com.example.3",
            "com.example.foo-bar",
            "3com.example.foo",
            "-com.example.foo",
            "com-.example.foo",
            "com.example.foo/bar",
            "com.example.foo_bar",
            "com.example.foo*",
            "com.example.föö",
        ] {
            assert!(Nsid::new(value).is_err(), "{value} should be invalid");
        }
    }

    #[test]
    fn accepts_valid_record_keys() {
        for value in [
            "3jui7kd54zh2y",
            "self",
            "example.com",
            "~1.2-3_",
            "dHJ1ZQ",
            "pre:fix",
            "_",
        ] {
            assert_eq!(RecordKey::new(value).unwrap().as_str(), value);
        }
    }

    #[test]
    fn rejects_invalid_record_keys() {
        for value in [
            "",
            ".",
            "..",
            "alpha/beta",
            "#extra",
            "@handle",
            "any space",
            "any+space",
            "number[3]",
            "number(3)",
            "\"quote\"",
            "dHJ1ZQ==",
            "snow☃",
        ] {
            assert!(RecordKey::new(value).is_err(), "{value} should be invalid");
        }
    }

    #[test]
    fn parses_repo_path() {
        let path = RepoPath::parse("app.gsv.device.profile/self").unwrap();

        assert_eq!(path.collection.as_str(), "app.gsv.device.profile");
        assert_eq!(path.rkey.as_str(), "self");
        assert_eq!(path.as_mst_key(), "app.gsv.device.profile/self");
        assert_eq!(path.to_string(), "app.gsv.device.profile/self");
    }

    #[test]
    fn rejects_invalid_repo_paths() {
        for value in [
            "",
            "app.gsv.device.profile",
            "app.gsv.device.profile/",
            "/self",
            "app.gsv.device.profile/self/extra",
            "app.gsv.device.profile/any space",
            "app.gsv.3/self",
        ] {
            assert!(RepoPath::parse(value).is_err(), "{value} should be invalid");
        }
    }
}
