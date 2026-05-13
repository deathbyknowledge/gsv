//! Password hashing and compact bearer-token helpers.

use base64::engine::general_purpose::{STANDARD_NO_PAD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use hmac::{Hmac, Mac};
use pbkdf2::pbkdf2_hmac;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use thiserror::Error;

const PASSWORD_ALGORITHM: &str = "pbkdf2-sha256";
const PASSWORD_ITERATIONS: u32 = 100_000;
const PASSWORD_HASH_LEN: usize = 32;
pub const ACCESS_SCOPE: &str = "com.atproto.access";
pub const REFRESH_SCOPE: &str = "com.atproto.refresh";

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenClaims {
    pub iss: String,
    pub aud: String,
    pub sub: String,
    pub iat: i64,
    pub exp: i64,
    pub jti: String,
    pub scope: String,
    pub handle: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth_scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dpop_jkt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dpop_nonce: Option<String>,
}

#[derive(Debug, Error)]
pub enum AuthError {
    #[error("invalid password hash")]
    InvalidPasswordHash,

    #[error("invalid auth token")]
    InvalidToken,

    #[error("auth token has expired")]
    ExpiredToken,

    #[error("auth token has wrong scope")]
    WrongTokenScope,

    #[error("failed to sign auth token")]
    TokenSigning,
}

pub fn hash_password(password: &str, salt: &[u8]) -> String {
    let mut hash = [0_u8; PASSWORD_HASH_LEN];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, PASSWORD_ITERATIONS, &mut hash);
    format!(
        "{PASSWORD_ALGORITHM}${PASSWORD_ITERATIONS}${}${}",
        STANDARD_NO_PAD.encode(salt),
        STANDARD_NO_PAD.encode(hash)
    )
}

pub fn verify_password(password: &str, encoded: &str) -> Result<bool, AuthError> {
    let mut parts = encoded.split('$');
    let algorithm = parts.next().ok_or(AuthError::InvalidPasswordHash)?;
    let iterations = parts
        .next()
        .ok_or(AuthError::InvalidPasswordHash)?
        .parse::<u32>()
        .map_err(|_| AuthError::InvalidPasswordHash)?;
    let salt = parts
        .next()
        .ok_or(AuthError::InvalidPasswordHash)
        .and_then(|value| {
            STANDARD_NO_PAD
                .decode(value)
                .map_err(|_| AuthError::InvalidPasswordHash)
        })?;
    let expected = parts
        .next()
        .ok_or(AuthError::InvalidPasswordHash)
        .and_then(|value| {
            STANDARD_NO_PAD
                .decode(value)
                .map_err(|_| AuthError::InvalidPasswordHash)
        })?;
    if parts.next().is_some()
        || algorithm != PASSWORD_ALGORITHM
        || iterations == 0
        || expected.len() != PASSWORD_HASH_LEN
    {
        return Err(AuthError::InvalidPasswordHash);
    }

    let mut actual = vec![0_u8; expected.len()];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), &salt, iterations, &mut actual);
    Ok(constant_time_eq(&actual, &expected))
}

pub fn sign_token(secret: &str, claims: &TokenClaims) -> Result<String, AuthError> {
    let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#);
    let payload =
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).map_err(|_| AuthError::TokenSigning)?);
    let signing_input = format!("{header}.{payload}");
    let signature = hmac_sha256(secret.as_bytes(), signing_input.as_bytes())?;
    Ok(format!(
        "{signing_input}.{}",
        URL_SAFE_NO_PAD.encode(signature)
    ))
}

pub fn verify_token(
    secret: &str,
    token: &str,
    expected_scope: &str,
    now: i64,
) -> Result<TokenClaims, AuthError> {
    let mut parts = token.split('.');
    let header = parts.next().ok_or(AuthError::InvalidToken)?;
    let payload = parts.next().ok_or(AuthError::InvalidToken)?;
    let signature = parts.next().ok_or(AuthError::InvalidToken)?;
    if parts.next().is_some() {
        return Err(AuthError::InvalidToken);
    }

    let signing_input = format!("{header}.{payload}");
    let expected_signature = hmac_sha256(secret.as_bytes(), signing_input.as_bytes())?;
    let signature = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| AuthError::InvalidToken)?;
    if !constant_time_eq(&expected_signature, &signature) {
        return Err(AuthError::InvalidToken);
    }

    let claims = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| AuthError::InvalidToken)
        .and_then(|bytes| {
            serde_json::from_slice::<TokenClaims>(&bytes).map_err(|_| AuthError::InvalidToken)
        })?;
    if claims.exp <= now {
        return Err(AuthError::ExpiredToken);
    }
    if claims.scope != expected_scope {
        return Err(AuthError::WrongTokenScope);
    }
    Ok(claims)
}

pub fn session_claims(
    did: &str,
    handle: &str,
    jti: &str,
    scope: &str,
    now: i64,
    ttl_seconds: i64,
) -> TokenClaims {
    TokenClaims {
        iss: "gsv-pds".to_string(),
        aud: "com.atproto".to_string(),
        sub: did.to_string(),
        iat: now,
        exp: now.saturating_add(ttl_seconds),
        jti: jti.to_string(),
        scope: scope.to_string(),
        handle: handle.to_string(),
        client_id: None,
        oauth_scope: None,
        dpop_jkt: None,
        dpop_nonce: None,
    }
}

pub fn oauth_session_claims(
    did: &str,
    handle: &str,
    jti: &str,
    scope: &str,
    now: i64,
    ttl_seconds: i64,
    client_id: &str,
    oauth_scope: &str,
    dpop_jkt: &str,
    dpop_nonce: &str,
) -> TokenClaims {
    let mut claims = session_claims(did, handle, jti, scope, now, ttl_seconds);
    claims.client_id = Some(client_id.to_string());
    claims.oauth_scope = Some(oauth_scope.to_string());
    claims.dpop_jkt = Some(dpop_jkt.to_string());
    claims.dpop_nonce = Some(dpop_nonce.to_string());
    claims
}

fn hmac_sha256(secret: &[u8], bytes: &[u8]) -> Result<Vec<u8>, AuthError> {
    let mut mac = HmacSha256::new_from_slice(secret).map_err(|_| AuthError::TokenSigning)?;
    mac.update(bytes);
    Ok(mac.finalize().into_bytes().to_vec())
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0_u8;
    for (a, b) in left.iter().zip(right) {
        diff |= a ^ b;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_hash_round_trips() {
        let hash = hash_password("correct horse", b"salty");

        assert!(verify_password("correct horse", &hash).unwrap());
        assert!(!verify_password("wrong", &hash).unwrap());
    }

    #[test]
    fn token_round_trips_and_enforces_scope() {
        let claims = session_claims(
            "did:web:example.com",
            "example.com",
            "jti",
            ACCESS_SCOPE,
            100,
            60,
        );
        let token = sign_token("secret", &claims).unwrap();

        assert_eq!(
            verify_token("secret", &token, ACCESS_SCOPE, 120)
                .unwrap()
                .sub,
            "did:web:example.com"
        );
        assert!(matches!(
            verify_token("secret", &token, REFRESH_SCOPE, 120),
            Err(AuthError::WrongTokenScope)
        ));
        assert!(matches!(
            verify_token("secret", &token, ACCESS_SCOPE, 200),
            Err(AuthError::ExpiredToken)
        ));
    }
}
