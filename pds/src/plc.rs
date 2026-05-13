//! did:plc operation helpers.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as BASE64_URL_SAFE_NO_PAD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::cbor::{encode_dag_cbor, CborError};
use crate::cid::{dag_cbor_cid, Cid};
use crate::identity::{IdentityError, RepoSigningKey};

#[derive(Debug, Error)]
pub enum PlcError {
    #[error("{0}")]
    BadRequest(String),

    #[error(transparent)]
    Cbor(#[from] CborError),

    #[error(transparent)]
    Identity(#[from] IdentityError),
}

#[derive(Debug, Deserialize)]
pub struct SignPlcOperationRequest {
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default, rename = "rotationKeys")]
    pub rotation_keys: Option<Vec<String>>,
    #[serde(default, rename = "alsoKnownAs")]
    pub also_known_as: Option<Vec<String>>,
    #[serde(default, rename = "verificationMethods")]
    pub verification_methods: Option<Value>,
    #[serde(default)]
    pub services: Option<Value>,
}

pub struct CreatedPlcOperation {
    pub did: String,
    pub operation: Value,
}

pub fn recommended_did_credentials_body(
    origin: &str,
    handle: &str,
    public_key_multibase: &str,
    rotation_keys: &[String],
) -> Result<Value, PlcError> {
    let mut body = json!({
        "alsoKnownAs": [format!("at://{handle}")],
        "verificationMethods": {
            "atproto": did_key_from_public_key_multibase(public_key_multibase)?,
        },
        "services": {
            "atproto_pds": {
                "type": "AtprotoPersonalDataServer",
                "endpoint": origin,
            },
        },
    });
    if !rotation_keys.is_empty() {
        body["rotationKeys"] = json!(rotation_keys);
    }
    Ok(body)
}

pub fn create_plc_operation(
    handle: &str,
    pds_origin: &str,
    signing_key: &str,
    rotation_keys: &[String],
    rotation_signing_key: &RepoSigningKey,
) -> Result<CreatedPlcOperation, PlcError> {
    if rotation_keys.is_empty() || rotation_keys.len() > 5 {
        return bad_request("InvalidRotationKeys");
    }
    validate_did_key_syntax(signing_key)?;
    for key in rotation_keys {
        validate_rotation_did_key(key)?;
    }
    let unsigned = json!({
        "type": "plc_operation",
        "rotationKeys": rotation_keys,
        "verificationMethods": {
            "atproto": signing_key,
        },
        "alsoKnownAs": [ensure_at_uri(handle)],
        "services": {
            "atproto_pds": {
                "type": "AtprotoPersonalDataServer",
                "endpoint": ensure_http_url(pds_origin),
            },
        },
        "prev": null,
    });
    let operation = sign_operation(unsigned, rotation_signing_key)?;
    let did = did_for_create_operation(&operation)?;
    Ok(CreatedPlcOperation { did, operation })
}

pub fn did_key_from_public_key_multibase(public_key_multibase: &str) -> Result<String, PlcError> {
    validate_public_key_multibase(public_key_multibase)?;
    Ok(format!("did:key:{public_key_multibase}"))
}

pub fn sign_plc_update_operation(
    last_op: &Value,
    rotation_key: &RepoSigningKey,
    rotation_did_key: &str,
    body: SignPlcOperationRequest,
) -> Result<Value, PlcError> {
    let normalized = normalize_plc_operation(last_op)?;
    let current_rotation_keys = required_string_array(&normalized, "rotationKeys")?;
    if !current_rotation_keys
        .iter()
        .any(|key| key == rotation_did_key)
    {
        return bad_request("server PLC rotation key is not authorized for this DID");
    }

    let mut unsigned = normalized
        .as_object()
        .ok_or_else(|| PlcError::BadRequest("InvalidOperation".to_string()))?
        .clone();
    unsigned.remove("sig");
    unsigned.insert("type".to_string(), json!("plc_operation"));
    unsigned.insert(
        "rotationKeys".to_string(),
        match body.rotation_keys {
            Some(keys) => {
                for key in &keys {
                    validate_rotation_did_key(key)?;
                }
                json!(keys)
            }
            None => normalized["rotationKeys"].clone(),
        },
    );
    unsigned.insert(
        "alsoKnownAs".to_string(),
        body.also_known_as
            .map(|values| json!(values))
            .unwrap_or_else(|| normalized["alsoKnownAs"].clone()),
    );
    unsigned.insert(
        "verificationMethods".to_string(),
        body.verification_methods
            .map(ensure_json_object_value)
            .transpose()?
            .unwrap_or_else(|| normalized["verificationMethods"].clone()),
    );
    unsigned.insert(
        "services".to_string(),
        body.services
            .map(ensure_json_object_value)
            .transpose()?
            .unwrap_or_else(|| normalized["services"].clone()),
    );
    unsigned.insert(
        "prev".to_string(),
        json!(plc_operation_cid(last_op)?.to_string()),
    );

    let unsigned = Value::Object(unsigned);
    sign_operation(unsigned, rotation_key)
}

pub fn validate_submitted_plc_operation(
    operation: &Value,
    origin: &str,
    handle: &str,
    public_key_multibase: &str,
    server_rotation_key: &str,
) -> Result<(), PlcError> {
    validate_plc_operation_data(operation)?;
    let rotation_keys = required_string_array(operation, "rotationKeys")?;
    if !rotation_keys.iter().any(|key| key == server_rotation_key) {
        return bad_request("Rotation keys do not include server rotation key");
    }
    let verification_methods = operation
        .get("verificationMethods")
        .and_then(Value::as_object)
        .ok_or_else(|| PlcError::BadRequest("InvalidOperation".to_string()))?;
    let expected_signing_key = did_key_from_public_key_multibase(public_key_multibase)?;
    if verification_methods.get("atproto").and_then(Value::as_str)
        != Some(expected_signing_key.as_str())
    {
        return bad_request("Incorrect signing key");
    }
    let services = operation
        .get("services")
        .and_then(Value::as_object)
        .ok_or_else(|| PlcError::BadRequest("InvalidOperation".to_string()))?;
    let atproto_pds = services
        .get("atproto_pds")
        .and_then(Value::as_object)
        .ok_or_else(|| PlcError::BadRequest("Missing atproto_pds service".to_string()))?;
    if atproto_pds.get("type").and_then(Value::as_str) != Some("AtprotoPersonalDataServer") {
        return bad_request("Incorrect type on atproto_pds service");
    }
    if atproto_pds.get("endpoint").and_then(Value::as_str) != Some(origin) {
        return bad_request("Incorrect endpoint on atproto_pds service");
    }
    let also_known_as = required_string_array(operation, "alsoKnownAs")?;
    let expected_handle = format!("at://{handle}");
    if also_known_as.first().map(String::as_str) != Some(expected_handle.as_str()) {
        return bad_request("Incorrect handle in alsoKnownAs");
    }
    Ok(())
}

pub fn validate_did_key_syntax(value: &str) -> Result<(), PlcError> {
    decode_did_key_multibase(value).map(|_| ())
}

pub fn plc_operation_cid(operation: &Value) -> Result<Cid, PlcError> {
    let bytes = encode_dag_cbor(operation)?;
    Ok(dag_cbor_cid(&bytes))
}

pub fn did_for_create_operation(operation: &Value) -> Result<String, PlcError> {
    let bytes = encode_dag_cbor(operation)?;
    let digest = Sha256::digest(&bytes);
    Ok(format!("did:plc:{}", &base32_lower_no_pad(&digest)[..24]))
}

fn normalize_plc_operation(op: &Value) -> Result<Value, PlcError> {
    let object = op
        .as_object()
        .ok_or_else(|| PlcError::BadRequest("InvalidOperation".to_string()))?;
    match object.get("type").and_then(Value::as_str) {
        Some("plc_operation") => {
            validate_plc_operation_data(op)?;
            let mut normalized = object.clone();
            normalized.remove("sig");
            Ok(Value::Object(normalized))
        }
        Some("create") => {
            let signing_key = required_string_field(op, "signingKey")?;
            let recovery_key = required_string_field(op, "recoveryKey")?;
            let handle = required_string_field(op, "handle")?;
            let service = required_string_field(op, "service")?;
            Ok(json!({
                "type": "plc_operation",
                "verificationMethods": {
                    "atproto": signing_key,
                },
                "rotationKeys": [recovery_key, signing_key],
                "alsoKnownAs": [ensure_at_uri(handle)],
                "services": {
                    "atproto_pds": {
                        "type": "AtprotoPersonalDataServer",
                        "endpoint": ensure_http_url(service),
                    },
                },
                "prev": op.get("prev").cloned().unwrap_or(Value::Null),
            }))
        }
        Some("plc_tombstone") => bad_request("DidTombstoned"),
        _ => bad_request("InvalidOperation"),
    }
}

fn validate_plc_operation_data(operation: &Value) -> Result<(), PlcError> {
    if operation.get("type").and_then(Value::as_str) != Some("plc_operation") {
        return bad_request("InvalidOperation");
    }
    let rotation_keys = required_string_array(operation, "rotationKeys")?;
    if rotation_keys.is_empty() || rotation_keys.len() > 5 {
        return bad_request("InvalidRotationKeys");
    }
    for key in &rotation_keys {
        validate_rotation_did_key(key)?;
    }
    let verification_methods = operation
        .get("verificationMethods")
        .and_then(Value::as_object)
        .ok_or_else(|| PlcError::BadRequest("InvalidVerificationMethods".to_string()))?;
    if verification_methods.is_empty() {
        return bad_request("InvalidVerificationMethods");
    }
    for key in verification_methods.values() {
        let Some(key) = key.as_str() else {
            return bad_request("InvalidVerificationMethods");
        };
        validate_did_key_syntax(key)?;
    }
    required_string_array(operation, "alsoKnownAs")?;
    if !operation.get("services").is_some_and(Value::is_object) {
        return bad_request("InvalidServices");
    }
    if !operation
        .get("prev")
        .is_some_and(|value| value.is_null() || value.is_string())
    {
        return bad_request("InvalidPrev");
    }
    Ok(())
}

fn ensure_json_object_value(value: Value) -> Result<Value, PlcError> {
    if value.is_object() {
        Ok(value)
    } else {
        bad_request("expected JSON object")
    }
}

fn sign_operation(unsigned: Value, signing_key: &RepoSigningKey) -> Result<Value, PlcError> {
    validate_plc_operation_data(&unsigned)?;
    let signing_bytes = encode_dag_cbor(&unsigned)?;
    let sig = BASE64_URL_SAFE_NO_PAD.encode(signing_key.sign_sha256(&signing_bytes)?);
    let mut signed = unsigned
        .as_object()
        .ok_or_else(|| PlcError::BadRequest("InvalidOperation".to_string()))?
        .clone();
    signed.insert("sig".to_string(), json!(sig));
    Ok(Value::Object(signed))
}

fn required_string_field<'a>(value: &'a Value, field: &str) -> Result<&'a str, PlcError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| PlcError::BadRequest(format!("InvalidOperation: missing `{field}`")))
}

fn required_string_array(value: &Value, field: &str) -> Result<Vec<String>, PlcError> {
    value
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| PlcError::BadRequest(format!("InvalidOperation: missing `{field}`")))?
        .iter()
        .map(|value| {
            value
                .as_str()
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .ok_or_else(|| PlcError::BadRequest(format!("InvalidOperation: bad `{field}`")))
        })
        .collect()
}

fn validate_public_key_multibase(public_key_multibase: &str) -> Result<(), PlcError> {
    if !public_key_multibase.starts_with('z') {
        return bad_request("InvalidSigningKey");
    }
    let decoded = bs58::decode(public_key_multibase.trim_start_matches('z'))
        .into_vec()
        .map_err(|_| PlcError::BadRequest("InvalidSigningKey".to_string()))?;
    if decoded.len() == 35 && decoded.starts_with(&[0x80, 0x24]) {
        Ok(())
    } else {
        bad_request("InvalidSigningKey")
    }
}

fn validate_rotation_did_key(value: &str) -> Result<(), PlcError> {
    let multikey = decode_did_key_multibase(value)?;
    if (multikey.len() == 35 && multikey.starts_with(&[0x80, 0x24]))
        || (multikey.len() == 35 && multikey.starts_with(&[0xe7, 0x01]))
    {
        Ok(())
    } else {
        bad_request("InvalidDidKey")
    }
}

fn decode_did_key_multibase(value: &str) -> Result<Vec<u8>, PlcError> {
    let Some(multibase) = value.strip_prefix("did:key:") else {
        return bad_request("InvalidDidKey");
    };
    let Some(base58btc) = multibase.strip_prefix('z') else {
        return bad_request("InvalidDidKey");
    };
    let decoded = bs58::decode(base58btc)
        .into_vec()
        .map_err(|_| PlcError::BadRequest("InvalidDidKey".to_string()))?;
    if decoded.is_empty() {
        bad_request("InvalidDidKey")
    } else {
        Ok(decoded)
    }
}

fn base32_lower_no_pad(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
    let mut out = String::with_capacity((bytes.len() * 8).div_ceil(5));
    let mut buffer = 0_u16;
    let mut bits = 0_u8;
    for byte in bytes {
        buffer = (buffer << 8) | u16::from(*byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            let index = ((buffer >> bits) & 0b11111) as usize;
            out.push(ALPHABET[index] as char);
        }
    }
    if bits > 0 {
        let index = ((buffer << (5 - bits)) & 0b11111) as usize;
        out.push(ALPHABET[index] as char);
    }
    out
}

fn ensure_at_uri(value: &str) -> String {
    if value.starts_with("at://") {
        value.to_string()
    } else {
        format!(
            "at://{}",
            value
                .trim_start_matches("https://")
                .trim_start_matches("http://")
        )
    }
}

fn ensure_http_url(value: &str) -> String {
    if value.starts_with("http://") || value.starts_with("https://") {
        value.to_string()
    } else {
        format!("https://{value}")
    }
}

fn bad_request<T>(message: impl Into<String>) -> Result<T, PlcError> {
    Err(PlcError::BadRequest(message.into()))
}

#[cfg(test)]
mod tests {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD as BASE64_URL_SAFE_NO_PAD, Engine};
    use serde_json::{json, Value};

    use super::*;
    use crate::cbor::encode_dag_cbor;
    use crate::identity::verify_p256_signature;

    #[test]
    fn creates_plc_genesis_operations() {
        let rotation_key = test_signing_key();
        let rotation_did_key =
            did_key_from_public_key_multibase(&rotation_key.public_key_multibase().unwrap())
                .unwrap();
        let repo_key = RepoSigningKey::from_p256_hex(
            "0000000000000000000000000000000000000000000000000000000000000002",
        )
        .unwrap();
        let repo_did_key =
            did_key_from_public_key_multibase(&repo_key.public_key_multibase().unwrap()).unwrap();

        let created = create_plc_operation(
            "alice.example.com",
            "https://pds.example.com",
            &repo_did_key,
            std::slice::from_ref(&rotation_did_key),
            &rotation_key,
        )
        .unwrap();

        assert!(created.did.starts_with("did:plc:"));
        assert_eq!(created.did.len(), 32);
        assert_eq!(created.operation["type"], "plc_operation");
        assert_eq!(created.operation["prev"], Value::Null);
        assert_eq!(created.operation["rotationKeys"][0], rotation_did_key);
        assert_eq!(
            created.operation["verificationMethods"]["atproto"],
            repo_did_key
        );
        assert_eq!(
            created.operation["alsoKnownAs"][0],
            "at://alice.example.com"
        );
        assert_eq!(
            created.operation["services"]["atproto_pds"]["endpoint"],
            "https://pds.example.com"
        );
        assert_eq!(
            did_for_create_operation(&created.operation).unwrap(),
            created.did
        );

        let sig = created.operation["sig"].as_str().unwrap();
        let mut unsigned = created.operation.as_object().unwrap().clone();
        unsigned.remove("sig");
        let unsigned = Value::Object(unsigned);
        let bytes = encode_dag_cbor(&unsigned).unwrap();
        let signature = BASE64_URL_SAFE_NO_PAD.decode(sig).unwrap();
        verify_p256_signature(&rotation_key.verifying_key().unwrap(), &bytes, &signature).unwrap();
    }

    #[test]
    fn builds_recommended_did_credentials() {
        let key = test_signing_key();
        let public_key = key.public_key_multibase().unwrap();
        let rotation_key = did_key_from_public_key_multibase(&public_key).unwrap();

        let body = recommended_did_credentials_body(
            "https://pds.example.com",
            "alice.example.com",
            &public_key,
            &[rotation_key],
        )
        .unwrap();

        assert_eq!(body["alsoKnownAs"][0], "at://alice.example.com");
        assert_eq!(
            body["verificationMethods"]["atproto"],
            did_key_from_public_key_multibase(&public_key).unwrap()
        );
        assert_eq!(
            body["services"]["atproto_pds"]["endpoint"],
            "https://pds.example.com"
        );
        assert_eq!(body["rotationKeys"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn signs_plc_update_operations() {
        let key = test_signing_key();
        let did_key =
            did_key_from_public_key_multibase(&key.public_key_multibase().unwrap()).unwrap();
        let last_op = json!({
            "type": "plc_operation",
            "rotationKeys": [did_key.clone()],
            "verificationMethods": {
                "atproto": did_key.clone(),
            },
            "alsoKnownAs": ["at://old.example.com"],
            "services": {
                "atproto_pds": {
                    "type": "AtprotoPersonalDataServer",
                    "endpoint": "https://old.example.com",
                },
            },
            "prev": null,
            "sig": "previous-signature",
        });

        let operation = sign_plc_update_operation(
            &last_op,
            &key,
            &did_key,
            SignPlcOperationRequest {
                token: None,
                rotation_keys: Some(vec![did_key.clone()]),
                also_known_as: Some(vec!["at://new.example.com".to_string()]),
                verification_methods: None,
                services: Some(json!({
                    "atproto_pds": {
                        "type": "AtprotoPersonalDataServer",
                        "endpoint": "https://new.example.com",
                    },
                })),
            },
        )
        .unwrap();

        assert_eq!(operation["type"], "plc_operation");
        assert_eq!(
            operation["prev"],
            plc_operation_cid(&last_op).unwrap().to_string()
        );
        assert_eq!(operation["alsoKnownAs"][0], "at://new.example.com");
        assert_eq!(
            operation["services"]["atproto_pds"]["endpoint"],
            "https://new.example.com"
        );
        let sig = operation["sig"].as_str().unwrap();
        assert!(!sig.contains('='));

        let mut unsigned = operation.as_object().unwrap().clone();
        unsigned.remove("sig");
        let unsigned = Value::Object(unsigned);
        let bytes = encode_dag_cbor(&unsigned).unwrap();
        let signature = BASE64_URL_SAFE_NO_PAD.decode(sig).unwrap();
        verify_p256_signature(&key.verifying_key().unwrap(), &bytes, &signature).unwrap();
    }

    #[test]
    fn rejects_unauthorized_rotation_key_when_signing() {
        let key = test_signing_key();
        let did_key =
            did_key_from_public_key_multibase(&key.public_key_multibase().unwrap()).unwrap();
        let other_key = "did:key:zDnaefPz6o6nYx3YJnuhRrZQn4g8KJrpx7cC9qg2g6w8Y5wWn";
        let last_op = json!({
            "type": "plc_operation",
            "rotationKeys": [other_key],
            "verificationMethods": {
                "atproto": did_key,
            },
            "alsoKnownAs": ["at://old.example.com"],
            "services": {
                "atproto_pds": {
                    "type": "AtprotoPersonalDataServer",
                    "endpoint": "https://old.example.com",
                },
            },
            "prev": null,
        });

        assert!(sign_plc_update_operation(
            &last_op,
            &key,
            &did_key_from_public_key_multibase(&key.public_key_multibase().unwrap()).unwrap(),
            SignPlcOperationRequest {
                token: None,
                rotation_keys: None,
                also_known_as: None,
                verification_methods: None,
                services: None,
            },
        )
        .is_err());
    }

    #[test]
    fn validates_submitted_plc_operations_against_local_account() {
        let key = test_signing_key();
        let public_key = key.public_key_multibase().unwrap();
        let did_key = did_key_from_public_key_multibase(&public_key).unwrap();
        let operation = json!({
            "type": "plc_operation",
            "rotationKeys": [did_key.clone()],
            "verificationMethods": {
                "atproto": did_key.clone(),
            },
            "alsoKnownAs": ["at://alice.example.com"],
            "services": {
                "atproto_pds": {
                    "type": "AtprotoPersonalDataServer",
                    "endpoint": "https://pds.example.com",
                },
            },
            "prev": "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "sig": "signature",
        });

        validate_submitted_plc_operation(
            &operation,
            "https://pds.example.com",
            "alice.example.com",
            &public_key,
            &did_key,
        )
        .unwrap();

        let mut wrong_endpoint = operation.clone();
        wrong_endpoint["services"]["atproto_pds"]["endpoint"] = json!("https://other.example.com");
        assert!(validate_submitted_plc_operation(
            &wrong_endpoint,
            "https://pds.example.com",
            "alice.example.com",
            &public_key,
            &did_key,
        )
        .is_err());
    }

    fn test_signing_key() -> RepoSigningKey {
        RepoSigningKey::from_p256_hex(
            "0000000000000000000000000000000000000000000000000000000000000001",
        )
        .unwrap()
    }
}
