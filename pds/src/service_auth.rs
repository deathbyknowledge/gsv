//! AT Protocol service-auth JWT verification helpers.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde::Deserialize;
use serde_json::Value;
use thiserror::Error;

use crate::atproto_resolver::did_document_public_key_multibase;
use crate::commit::Did;
use crate::identity::verify_multibase_signature;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ServiceAuthError {
    #[error("BadJwt")]
    BadJwt,

    #[error("BadJwtType")]
    BadJwtType,

    #[error("BadJwtAlg")]
    BadJwtAlg,

    #[error("BadJwtIss")]
    BadJwtIss,

    #[error("BadJwtAudience")]
    BadJwtAudience,

    #[error("BadJwtLexiconMethod")]
    BadJwtLexiconMethod,

    #[error("JwtExpired")]
    JwtExpired,

    #[error("BadJwtSignature")]
    BadJwtSignature,

    #[error("MissingDidDocumentKey")]
    MissingDidDocumentKey,
}

#[derive(Debug, Deserialize)]
struct ServiceAuthJwtHeader {
    alg: String,
    #[serde(default)]
    typ: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ServiceAuthJwtClaims {
    iss: String,
    aud: String,
    exp: i64,
    #[serde(default)]
    lxm: Option<String>,
}

pub fn verify_service_auth_jwt(
    token: &str,
    expected_iss: &str,
    expected_aud: &str,
    expected_lxm: &str,
    now: i64,
    did_doc: &Value,
) -> Result<(), ServiceAuthError> {
    let parts = token.split('.').collect::<Vec<_>>();
    if parts.len() != 3 {
        return Err(ServiceAuthError::BadJwt);
    }
    let header: ServiceAuthJwtHeader = decode_jwt_json_part(parts[0])?;
    if matches!(
        header.typ.as_deref(),
        Some("at+jwt" | "refresh+jwt" | "dpop+jwt")
    ) {
        return Err(ServiceAuthError::BadJwtType);
    }
    if !matches!(header.alg.as_str(), "ES256" | "ES256K") {
        return Err(ServiceAuthError::BadJwtAlg);
    }
    let claims: ServiceAuthJwtClaims = decode_jwt_json_part(parts[1])?;
    if Did::new(claims.iss.clone()).is_err() || claims.iss != expected_iss {
        return Err(ServiceAuthError::BadJwtIss);
    }
    if claims.aud != expected_aud {
        return Err(ServiceAuthError::BadJwtAudience);
    }
    if claims.lxm.as_deref() != Some(expected_lxm) {
        return Err(ServiceAuthError::BadJwtLexiconMethod);
    }
    if claims.exp <= now {
        return Err(ServiceAuthError::JwtExpired);
    }
    let public_key_multibase = did_document_public_key_multibase(did_doc, "atproto")
        .ok_or(ServiceAuthError::MissingDidDocumentKey)?;
    let signature = URL_SAFE_NO_PAD
        .decode(parts[2])
        .map_err(|_| ServiceAuthError::BadJwtSignature)?;
    verify_multibase_signature(
        &public_key_multibase,
        &header.alg,
        format!("{}.{}", parts[0], parts[1]).as_bytes(),
        &signature,
    )
    .map_err(|_| ServiceAuthError::BadJwtSignature)
}

fn decode_jwt_json_part<T>(part: &str) -> Result<T, ServiceAuthError>
where
    T: for<'de> Deserialize<'de>,
{
    let bytes = URL_SAFE_NO_PAD
        .decode(part)
        .map_err(|_| ServiceAuthError::BadJwt)?;
    serde_json::from_slice(&bytes).map_err(|_| ServiceAuthError::BadJwt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use k256::ecdsa::signature::hazmat::PrehashSigner;
    use serde_json::{json, to_vec};
    use sha2::{Digest, Sha256};

    use crate::identity::{public_key_multibase, RepoSigningKey};

    const CREATE_ACCOUNT: &str = "com.atproto.server.createAccount";

    #[test]
    fn verifies_es256_service_auth_jwt_against_did_document() {
        let key = RepoSigningKey::from_p256_hex(
            "0000000000000000000000000000000000000000000000000000000000000001",
        )
        .unwrap();
        let public_key = key.public_key_multibase().unwrap();
        let doc = did_doc(
            "did:web:gsv-pds.example.com",
            "gsv-pds.example.com",
            &public_key,
        );
        let token = service_auth_jwt(
            &key,
            "did:web:gsv-pds.example.com",
            "did:web:new-pds.example.com",
            CREATE_ACCOUNT,
            1_776_722_400,
        );

        verify_service_auth_jwt(
            &token,
            "did:web:gsv-pds.example.com",
            "did:web:new-pds.example.com",
            CREATE_ACCOUNT,
            1_776_722_300,
            &doc,
        )
        .unwrap();
        assert_eq!(
            verify_service_auth_jwt(
                &token,
                "did:web:gsv-pds.example.com",
                "did:web:other-pds.example.com",
                CREATE_ACCOUNT,
                1_776_722_300,
                &doc,
            ),
            Err(ServiceAuthError::BadJwtAudience)
        );
        assert_eq!(
            verify_service_auth_jwt(
                &token,
                "did:web:gsv-pds.example.com",
                "did:web:new-pds.example.com",
                "com.atproto.repo.getRecord",
                1_776_722_300,
                &doc,
            ),
            Err(ServiceAuthError::BadJwtLexiconMethod)
        );
        assert_eq!(
            verify_service_auth_jwt(
                &token,
                "did:web:gsv-pds.example.com",
                "did:web:new-pds.example.com",
                CREATE_ACCOUNT,
                1_776_722_401,
                &doc,
            ),
            Err(ServiceAuthError::JwtExpired)
        );
    }

    #[test]
    fn verifies_es256k_service_auth_jwt_against_did_document() {
        let key = k256::ecdsa::SigningKey::from_slice(&[2_u8; 32]).unwrap();
        let public_key = key.verifying_key().to_encoded_point(true);
        let mut multikey = Vec::with_capacity(2 + public_key.as_bytes().len());
        multikey.extend_from_slice(&[0xe7, 0x01]);
        multikey.extend_from_slice(public_key.as_bytes());
        let public_key_multibase = format!("z{}", bs58::encode(multikey).into_string());
        let doc = did_doc(
            "did:web:es256k.example.com",
            "es256k.example.com",
            &public_key_multibase,
        );
        let token = es256k_service_auth_jwt(
            &key,
            "did:web:es256k.example.com",
            "did:web:new-pds.example.com",
            CREATE_ACCOUNT,
            1_776_722_400,
        );

        verify_service_auth_jwt(
            &token,
            "did:web:es256k.example.com",
            "did:web:new-pds.example.com",
            CREATE_ACCOUNT,
            1_776_722_300,
            &doc,
        )
        .unwrap();
    }

    fn did_doc(did: &str, handle: &str, public_key_multibase: &str) -> Value {
        json!({
            "id": did,
            "alsoKnownAs": [format!("at://{handle}")],
            "verificationMethod": [{
                "id": format!("{did}#atproto"),
                "type": "Multikey",
                "controller": did,
                "publicKeyMultibase": public_key_multibase,
            }],
            "service": [{
                "id": "#atproto_pds",
                "type": "AtprotoPersonalDataServer",
                "serviceEndpoint": "https://old-pds.example.com",
            }],
        })
    }

    fn service_auth_jwt(key: &RepoSigningKey, iss: &str, aud: &str, lxm: &str, exp: i64) -> String {
        let header =
            URL_SAFE_NO_PAD.encode(to_vec(&json!({"typ": "JWT", "alg": "ES256"})).unwrap());
        let payload = URL_SAFE_NO_PAD.encode(
            to_vec(&json!({
                "iss": iss,
                "aud": aud,
                "exp": exp,
                "lxm": lxm,
            }))
            .unwrap(),
        );
        let signing_input = format!("{header}.{payload}");
        let signature = key.sign_sha256(signing_input.as_bytes()).unwrap();
        format!("{signing_input}.{}", URL_SAFE_NO_PAD.encode(signature))
    }

    fn es256k_service_auth_jwt(
        key: &k256::ecdsa::SigningKey,
        iss: &str,
        aud: &str,
        lxm: &str,
        exp: i64,
    ) -> String {
        let header =
            URL_SAFE_NO_PAD.encode(to_vec(&json!({"typ": "JWT", "alg": "ES256K"})).unwrap());
        let payload = URL_SAFE_NO_PAD.encode(
            to_vec(&json!({
                "iss": iss,
                "aud": aud,
                "exp": exp,
                "lxm": lxm,
            }))
            .unwrap(),
        );
        let signing_input = format!("{header}.{payload}");
        let digest = Sha256::digest(signing_input.as_bytes());
        let signature: k256::ecdsa::Signature = key.sign_prehash(&digest).unwrap();
        format!(
            "{signing_input}.{}",
            URL_SAFE_NO_PAD.encode(signature.to_bytes())
        )
    }

    #[test]
    fn round_trips_test_p256_multibase() {
        let key = RepoSigningKey::from_p256_hex(
            "0000000000000000000000000000000000000000000000000000000000000001",
        )
        .unwrap();
        let verifying_key = key.verifying_key().unwrap();
        assert_eq!(
            public_key_multibase(&verifying_key).unwrap(),
            key.public_key_multibase().unwrap()
        );
    }
}
