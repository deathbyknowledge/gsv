//! Repository signing identity helpers.

use k256::ecdsa::{Signature as K256Signature, VerifyingKey as K256VerifyingKey};
use p256::ecdsa::{
    signature::hazmat::{PrehashSigner, PrehashVerifier},
    Signature, SigningKey, VerifyingKey,
};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::commit::CommitSigner;

const P256_SECRET_KEY_LEN: usize = 32;
const P256_SIGNATURE_LEN: usize = 64;
const P256_PUB_MULTICODEC_VARINT: [u8; 2] = [0x80, 0x24];
const SECP256K1_PUB_MULTICODEC_VARINT: [u8; 2] = [0xe7, 0x01];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepoSigningKey {
    secret_key_bytes: [u8; P256_SECRET_KEY_LEN],
}

#[derive(Debug, Error)]
pub enum IdentityError {
    #[error("invalid P-256 signing key hex: expected 64 lowercase or uppercase hex characters")]
    InvalidSigningKeyHex,

    #[error("invalid P-256 signing key")]
    InvalidSigningKey,

    #[error("invalid P-256 public key")]
    InvalidPublicKey,

    #[error("unsupported public key algorithm")]
    UnsupportedKeyAlgorithm,

    #[error("invalid P-256 signature")]
    InvalidSignature,

    #[error("P-256 signature verification failed")]
    VerificationFailed,

    #[error("failed to sign with P-256 key")]
    SigningFailed,
}

impl RepoSigningKey {
    pub fn from_p256_hex(value: &str) -> Result<Self, IdentityError> {
        let bytes = decode_fixed_hex::<P256_SECRET_KEY_LEN>(value)?;
        SigningKey::from_slice(&bytes).map_err(|_| IdentityError::InvalidSigningKey)?;
        Ok(Self {
            secret_key_bytes: bytes,
        })
    }

    pub fn to_p256_hex(&self) -> String {
        encode_hex(&self.secret_key_bytes)
    }

    pub fn public_key_multibase(&self) -> Result<String, IdentityError> {
        let key = self.signing_key()?;
        public_key_multibase(key.verifying_key())
    }

    pub fn verifying_key(&self) -> Result<VerifyingKey, IdentityError> {
        Ok(*self.signing_key()?.verifying_key())
    }

    pub fn sign_sha256(&self, bytes: &[u8]) -> Result<Vec<u8>, IdentityError> {
        let key = self.signing_key()?;
        let digest = Sha256::digest(bytes);
        let signature: Signature = key
            .sign_prehash(&digest)
            .map_err(|_| IdentityError::SigningFailed)?;
        let signature = signature.normalize_s().unwrap_or(signature);
        Ok(signature.to_bytes().to_vec())
    }

    fn signing_key(&self) -> Result<SigningKey, IdentityError> {
        SigningKey::from_slice(&self.secret_key_bytes).map_err(|_| IdentityError::InvalidSigningKey)
    }
}

impl CommitSigner for RepoSigningKey {
    fn sign_commit(&self, signable_bytes: &[u8]) -> Result<Vec<u8>, String> {
        self.sign_sha256(signable_bytes)
            .map_err(|error| error.to_string())
    }
}

pub fn public_key_multibase(verifying_key: &VerifyingKey) -> Result<String, IdentityError> {
    let point = verifying_key.to_encoded_point(true);
    let bytes = point.as_bytes();
    if bytes.len() != 33 {
        return Err(IdentityError::InvalidPublicKey);
    }

    let mut multikey = Vec::with_capacity(P256_PUB_MULTICODEC_VARINT.len() + bytes.len());
    multikey.extend_from_slice(&P256_PUB_MULTICODEC_VARINT);
    multikey.extend_from_slice(bytes);
    Ok(format!("z{}", bs58::encode(multikey).into_string()))
}

pub fn verifying_key_from_public_key_multibase(
    public_key_multibase: &str,
) -> Result<VerifyingKey, IdentityError> {
    let decoded = decode_public_key_multibase(public_key_multibase, &P256_PUB_MULTICODEC_VARINT)?;
    VerifyingKey::from_sec1_bytes(&decoded).map_err(|_| IdentityError::InvalidPublicKey)
}

fn decode_public_key_multibase(
    public_key_multibase: &str,
    prefix: &[u8],
) -> Result<Vec<u8>, IdentityError> {
    let Some(encoded) = public_key_multibase.strip_prefix('z') else {
        return Err(IdentityError::InvalidPublicKey);
    };
    let decoded = bs58::decode(encoded)
        .into_vec()
        .map_err(|_| IdentityError::InvalidPublicKey)?;
    if decoded.len() != prefix.len() + 33 || !decoded.starts_with(prefix) {
        return Err(IdentityError::InvalidPublicKey);
    }
    Ok(decoded[prefix.len()..].to_vec())
}

pub fn verify_p256_signature(
    verifying_key: &VerifyingKey,
    signable_bytes: &[u8],
    signature_bytes: &[u8],
) -> Result<(), IdentityError> {
    if signature_bytes.len() != P256_SIGNATURE_LEN {
        return Err(IdentityError::InvalidSignature);
    }
    let signature =
        Signature::from_slice(signature_bytes).map_err(|_| IdentityError::InvalidSignature)?;
    let digest = Sha256::digest(signable_bytes);
    verifying_key
        .verify_prehash(&digest, &signature)
        .map_err(|_| IdentityError::VerificationFailed)
}

pub fn verify_multibase_signature(
    public_key_multibase: &str,
    jwt_alg: &str,
    signable_bytes: &[u8],
    signature_bytes: &[u8],
) -> Result<(), IdentityError> {
    match jwt_alg {
        "ES256" => {
            let verifying_key = verifying_key_from_public_key_multibase(public_key_multibase)?;
            verify_p256_signature(&verifying_key, signable_bytes, signature_bytes)
        }
        "ES256K" => {
            let public_key = decode_public_key_multibase(
                public_key_multibase,
                &SECP256K1_PUB_MULTICODEC_VARINT,
            )?;
            verify_secp256k1_signature(&public_key, signable_bytes, signature_bytes)
        }
        _ => Err(IdentityError::UnsupportedKeyAlgorithm),
    }
}

fn verify_secp256k1_signature(
    public_key: &[u8],
    signable_bytes: &[u8],
    signature_bytes: &[u8],
) -> Result<(), IdentityError> {
    if signature_bytes.len() != P256_SIGNATURE_LEN {
        return Err(IdentityError::InvalidSignature);
    }
    let verifying_key = K256VerifyingKey::from_sec1_bytes(public_key)
        .map_err(|_| IdentityError::InvalidPublicKey)?;
    let signature =
        K256Signature::from_slice(signature_bytes).map_err(|_| IdentityError::InvalidSignature)?;
    let digest = Sha256::digest(signable_bytes);
    verifying_key
        .verify_prehash(&digest, &signature)
        .map_err(|_| IdentityError::VerificationFailed)
}

fn decode_fixed_hex<const N: usize>(value: &str) -> Result<[u8; N], IdentityError> {
    if value.len() != N * 2 {
        return Err(IdentityError::InvalidSigningKeyHex);
    }

    let mut bytes = [0; N];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        let high = hex_nibble(pair[0])?;
        let low = hex_nibble(pair[1])?;
        bytes[index] = (high << 4) | low;
    }
    Ok(bytes)
}

fn hex_nibble(byte: u8) -> Result<u8, IdentityError> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err(IdentityError::InvalidSigningKeyHex),
    }
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        result.push(HEX[(byte >> 4) as usize] as char);
        result.push(HEX[(byte & 0x0f) as usize] as char);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cbor::decode_dag_cbor;
    use crate::cid::dag_cbor_cid;
    use crate::commit::{Did, RepoRev, SignedCommit, UnsignedCommit};

    const TEST_KEY_HEX: &str = "0000000000000000000000000000000000000000000000000000000000000001";

    #[test]
    fn parses_and_serializes_p256_secret_key_hex() {
        let key = RepoSigningKey::from_p256_hex(TEST_KEY_HEX).unwrap();

        assert_eq!(key.to_p256_hex(), TEST_KEY_HEX);
    }

    #[test]
    fn rejects_invalid_secret_keys() {
        assert!(RepoSigningKey::from_p256_hex("01").is_err());
        assert!(RepoSigningKey::from_p256_hex(
            "0000000000000000000000000000000000000000000000000000000000000000"
        )
        .is_err());
        assert!(RepoSigningKey::from_p256_hex(
            "gg00000000000000000000000000000000000000000000000000000000000000"
        )
        .is_err());
    }

    #[test]
    fn encodes_p256_public_key_as_multikey_multibase() {
        let key = RepoSigningKey::from_p256_hex(TEST_KEY_HEX).unwrap();
        let public_key = key.public_key_multibase().unwrap();

        assert!(public_key.starts_with('z'));
        let decoded = bs58::decode(public_key.trim_start_matches('z'))
            .into_vec()
            .unwrap();
        assert_eq!(&decoded[..2], &P256_PUB_MULTICODEC_VARINT);
        assert_eq!(decoded.len(), 35);
        assert!(matches!(decoded[2], 0x02 | 0x03));
    }

    #[test]
    fn decodes_p256_public_key_multibase() {
        let key = RepoSigningKey::from_p256_hex(TEST_KEY_HEX).unwrap();
        let public_key = key.public_key_multibase().unwrap();

        let decoded = verifying_key_from_public_key_multibase(&public_key).unwrap();
        assert_eq!(
            public_key_multibase(&decoded).unwrap(),
            key.public_key_multibase().unwrap()
        );
        assert!(verifying_key_from_public_key_multibase("not-multibase").is_err());
        assert!(verifying_key_from_public_key_multibase("zbad").is_err());
    }

    #[test]
    fn signs_and_verifies_commit_signable_bytes() {
        let key = RepoSigningKey::from_p256_hex(TEST_KEY_HEX).unwrap();
        let unsigned = UnsignedCommit::new(
            Did::new("did:web:example.com").unwrap(),
            dag_cbor_cid(b"mst-root"),
            RepoRev::new("2222222222222").unwrap(),
            None,
        );

        let signed = unsigned.sign_with(&key).unwrap();
        assert_eq!(signed.sig.len(), P256_SIGNATURE_LEN);
        verify_p256_signature(
            &key.verifying_key().unwrap(),
            &signed.signable_bytes().unwrap(),
            &signed.sig,
        )
        .unwrap();

        let block = signed.encode_block().unwrap();
        let decoded: SignedCommit = decode_dag_cbor(&block.bytes).unwrap();
        assert_eq!(decoded.sig, signed.sig);
    }

    #[test]
    fn verifies_p256_and_secp256k1_multibase_signatures() {
        let p256_key = RepoSigningKey::from_p256_hex(TEST_KEY_HEX).unwrap();
        let bytes = b"service-jwt-input";
        let p256_signature = p256_key.sign_sha256(bytes).unwrap();
        verify_multibase_signature(
            &p256_key.public_key_multibase().unwrap(),
            "ES256",
            bytes,
            &p256_signature,
        )
        .unwrap();

        let secp_key = k256::ecdsa::SigningKey::from_slice(&[1_u8; P256_SECRET_KEY_LEN]).unwrap();
        let digest = Sha256::digest(bytes);
        let secp_signature: K256Signature = secp_key.sign_prehash(&digest).unwrap();
        let public_key = secp_key.verifying_key().to_encoded_point(true);
        let mut multikey =
            Vec::with_capacity(SECP256K1_PUB_MULTICODEC_VARINT.len() + public_key.as_bytes().len());
        multikey.extend_from_slice(&SECP256K1_PUB_MULTICODEC_VARINT);
        multikey.extend_from_slice(public_key.as_bytes());
        let public_key_multibase = format!("z{}", bs58::encode(multikey).into_string());
        verify_multibase_signature(
            &public_key_multibase,
            "ES256K",
            bytes,
            &secp_signature.to_bytes(),
        )
        .unwrap();

        assert!(verify_multibase_signature(
            &public_key_multibase,
            "ES256",
            bytes,
            &secp_signature.to_bytes(),
        )
        .is_err());
        assert!(verify_multibase_signature(
            &public_key_multibase,
            "unsupported",
            bytes,
            &secp_signature.to_bytes(),
        )
        .is_err());
    }
}
