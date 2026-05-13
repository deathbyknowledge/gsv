//! OAuth DPoP proof verification helpers.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use thiserror::Error;
use url::Url;

const DPOP_MAX_CLOCK_SKEW_SECONDS: i64 = 300;
const P256_COORDINATE_BYTES: usize = 32;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedDpopProof {
    pub jkt: String,
    pub jti: String,
    pub nonce: Option<String>,
    pub ath: Option<String>,
}

#[derive(Debug, Error)]
pub enum DpopError {
    #[error("missing DPoP proof")]
    MissingProof,

    #[error("malformed DPoP proof")]
    MalformedProof,

    #[error("unsupported DPoP proof algorithm")]
    UnsupportedAlgorithm,

    #[error("invalid DPoP public key")]
    InvalidPublicKey,

    #[error("invalid DPoP signature")]
    InvalidSignature,

    #[error("DPoP proof does not match request method")]
    MethodMismatch,

    #[error("DPoP proof does not match request URI")]
    UriMismatch,

    #[error("DPoP proof timestamp is outside the accepted window")]
    InvalidTimestamp,

    #[error("DPoP proof nonce is missing or stale")]
    NonceMismatch,

    #[error("DPoP proof key binding does not match")]
    KeyBindingMismatch,

    #[error("DPoP proof access token hash does not match")]
    AccessTokenHashMismatch,
}

#[derive(Debug, Deserialize)]
struct DpopHeader {
    typ: String,
    alg: String,
    jwk: DpopJwk,
}

#[derive(Clone, Debug, Deserialize)]
struct DpopJwk {
    kty: String,
    crv: String,
    x: String,
    y: String,
    #[serde(default)]
    d: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DpopClaims {
    jti: String,
    htm: String,
    htu: String,
    iat: i64,
    #[serde(default)]
    nonce: Option<String>,
    #[serde(default)]
    ath: Option<String>,
}

pub fn verify_dpop_proof(
    proof_jwt: &str,
    method: &str,
    htu: &str,
    now: i64,
    expected_nonce: Option<&str>,
    expected_jkt: Option<&str>,
    access_token: Option<&str>,
) -> Result<VerifiedDpopProof, DpopError> {
    let (encoded_header, encoded_claims, encoded_signature) =
        split_jwt(proof_jwt).ok_or(DpopError::MalformedProof)?;
    let header: DpopHeader = decode_json(encoded_header).map_err(|_| DpopError::MalformedProof)?;
    let claims: DpopClaims = decode_json(encoded_claims).map_err(|_| DpopError::MalformedProof)?;

    if header.typ != "dpop+jwt" || header.alg != "ES256" {
        return Err(DpopError::UnsupportedAlgorithm);
    }
    let verifying_key = verifying_key_from_jwk(&header.jwk)?;
    let signature = decode_base64url(encoded_signature)?;
    let signature = Signature::from_slice(&signature).map_err(|_| DpopError::InvalidSignature)?;
    let signing_input = format!("{encoded_header}.{encoded_claims}");
    verifying_key
        .verify(signing_input.as_bytes(), &signature)
        .map_err(|_| DpopError::InvalidSignature)?;

    if claims.jti.is_empty() {
        return Err(DpopError::MalformedProof);
    }
    if claims.htm != method.to_ascii_uppercase() {
        return Err(DpopError::MethodMismatch);
    }
    if claims.htu != htu {
        return Err(DpopError::UriMismatch);
    }
    if claims.iat > now.saturating_add(DPOP_MAX_CLOCK_SKEW_SECONDS)
        || claims.iat < now.saturating_sub(DPOP_MAX_CLOCK_SKEW_SECONDS)
    {
        return Err(DpopError::InvalidTimestamp);
    }
    if let Some(expected_nonce) = expected_nonce {
        if claims.nonce.as_deref() != Some(expected_nonce) {
            return Err(DpopError::NonceMismatch);
        }
    }

    let jkt = jwk_thumbprint(&header.jwk)?;
    if expected_jkt.is_some_and(|expected| expected != jkt) {
        return Err(DpopError::KeyBindingMismatch);
    }
    if let Some(access_token) = access_token {
        let expected_ath = access_token_hash(access_token);
        if claims.ath.as_deref() != Some(expected_ath.as_str()) {
            return Err(DpopError::AccessTokenHashMismatch);
        }
    }

    Ok(VerifiedDpopProof {
        jkt,
        jti: claims.jti,
        nonce: claims.nonce,
        ath: claims.ath,
    })
}

pub fn dpop_htu(url: &Url) -> String {
    let mut value = format!(
        "{}://{}",
        url.scheme(),
        url.host_str().unwrap_or("localhost")
    );
    if let Some(port) = url.port() {
        value.push(':');
        value.push_str(&port.to_string());
    }
    value.push_str(url.path());
    value
}

pub fn access_token_hash(access_token: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(access_token.as_bytes()))
}

fn split_jwt(jwt: &str) -> Option<(&str, &str, &str)> {
    let mut parts = jwt.split('.');
    let header = parts.next()?;
    let claims = parts.next()?;
    let signature = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    Some((header, claims, signature))
}

fn decode_json<T: for<'de> Deserialize<'de>>(value: &str) -> Result<T, DpopError> {
    let bytes = decode_base64url(value)?;
    serde_json::from_slice(&bytes).map_err(|_| DpopError::MalformedProof)
}

fn decode_base64url(value: &str) -> Result<Vec<u8>, DpopError> {
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| DpopError::MalformedProof)
}

fn verifying_key_from_jwk(jwk: &DpopJwk) -> Result<VerifyingKey, DpopError> {
    if jwk.kty != "EC" || jwk.crv != "P-256" || jwk.d.is_some() {
        return Err(DpopError::InvalidPublicKey);
    }
    let x = decode_base64url(&jwk.x)?;
    let y = decode_base64url(&jwk.y)?;
    if x.len() != P256_COORDINATE_BYTES || y.len() != P256_COORDINATE_BYTES {
        return Err(DpopError::InvalidPublicKey);
    }
    let mut sec1 = Vec::with_capacity(1 + P256_COORDINATE_BYTES * 2);
    sec1.push(0x04);
    sec1.extend_from_slice(&x);
    sec1.extend_from_slice(&y);
    VerifyingKey::from_sec1_bytes(&sec1).map_err(|_| DpopError::InvalidPublicKey)
}

fn jwk_thumbprint(jwk: &DpopJwk) -> Result<String, DpopError> {
    if jwk.kty != "EC" || jwk.crv != "P-256" || jwk.d.is_some() {
        return Err(DpopError::InvalidPublicKey);
    }
    let canonical = format!(
        r#"{{"crv":"{}","kty":"{}","x":"{}","y":"{}"}}"#,
        jwk.crv, jwk.kty, jwk.x, jwk.y
    );
    Ok(URL_SAFE_NO_PAD.encode(Sha256::digest(canonical.as_bytes())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::{signature::Signer, Signature, SigningKey};
    use serde_json::json;

    #[test]
    fn verifies_es256_dpop_proof() {
        let key = SigningKey::from_slice(&[7_u8; 32]).unwrap();
        let public = key.verifying_key().to_encoded_point(false);
        let x = URL_SAFE_NO_PAD.encode(public.x().unwrap());
        let y = URL_SAFE_NO_PAD.encode(public.y().unwrap());
        let proof = signed_proof(
            &key,
            &json!({
                "typ": "dpop+jwt",
                "alg": "ES256",
                "jwk": {
                    "kty": "EC",
                    "crv": "P-256",
                    "x": x,
                    "y": y,
                },
            }),
            &json!({
                "jti": "proof-1",
                "htm": "POST",
                "htu": "https://pds.example.com/oauth/token",
                "iat": 1000,
                "nonce": "nonce-1",
            }),
        );

        let proof = verify_dpop_proof(
            &proof,
            "POST",
            "https://pds.example.com/oauth/token",
            1000,
            Some("nonce-1"),
            None,
            None,
        )
        .unwrap();

        assert_eq!(proof.jti, "proof-1");
        assert_eq!(proof.nonce.as_deref(), Some("nonce-1"));
        assert!(!proof.jkt.is_empty());
    }

    #[test]
    fn rejects_wrong_access_token_hash() {
        let key = SigningKey::from_slice(&[9_u8; 32]).unwrap();
        let public = key.verifying_key().to_encoded_point(false);
        let proof = signed_proof(
            &key,
            &json!({
                "typ": "dpop+jwt",
                "alg": "ES256",
                "jwk": {
                    "kty": "EC",
                    "crv": "P-256",
                    "x": URL_SAFE_NO_PAD.encode(public.x().unwrap()),
                    "y": URL_SAFE_NO_PAD.encode(public.y().unwrap()),
                },
            }),
            &json!({
                "jti": "proof-1",
                "htm": "GET",
                "htu": "https://pds.example.com/xrpc/com.atproto.server.getSession",
                "iat": 1000,
                "ath": access_token_hash("other-token"),
            }),
        );

        assert!(matches!(
            verify_dpop_proof(
                &proof,
                "GET",
                "https://pds.example.com/xrpc/com.atproto.server.getSession",
                1000,
                None,
                None,
                Some("access-token")
            ),
            Err(DpopError::AccessTokenHashMismatch)
        ));
    }

    fn signed_proof(
        key: &SigningKey,
        header: &serde_json::Value,
        claims: &serde_json::Value,
    ) -> String {
        let encoded_header = URL_SAFE_NO_PAD.encode(serde_json::to_vec(header).unwrap());
        let encoded_claims = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap());
        let signing_input = format!("{encoded_header}.{encoded_claims}");
        let signature: Signature = key.sign(signing_input.as_bytes());
        format!(
            "{signing_input}.{}",
            URL_SAFE_NO_PAD.encode(signature.to_bytes())
        )
    }
}
