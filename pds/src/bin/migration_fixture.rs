use std::error::Error;
use std::io::{self, Cursor, Read};

use base64::{
    engine::general_purpose::{
        STANDARD as BASE64_STANDARD, URL_SAFE_NO_PAD as BASE64_URL_SAFE_NO_PAD,
    },
    Engine,
};
use futures_executor::block_on;
use pds::car::{decode_car, encode_car_from_store};
use pds::cid::raw_cid;
use pds::commit::{Did, RepoRev};
use pds::data_model::{Nsid, RecordKey, RepoPath};
use pds::identity::RepoSigningKey;
use pds::plc::{
    create_plc_operation, did_key_from_public_key_multibase, sign_plc_update_operation,
    SignPlcOperationRequest,
};
use pds::repo::SignedRepository;
use pds::repo_import::validate_imported_repo;
use pds::storage::MemoryRepoStore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const INITIAL_REV: &str = "3jqfcqzm3fo2j";
const RECORD_REV: &str = "3jqfcqzm3fo3j";
const CREATE_ACCOUNT_LXM: &str = "com.atproto.server.createAccount";

type AnyError = Box<dyn Error + Send + Sync + 'static>;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum FixtureRequest {
    Generate(GenerateRequest),
    Finalize(FinalizeRequest),
    DecodeSubscribeReposFrames(DecodeSubscribeReposFramesRequest),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenerateRequest {
    handle: String,
    old_pds_origin: String,
    collection: String,
    rkey: String,
    record_text: String,
    blob_text: String,
    created_at: String,
    seed: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FinalizeRequest {
    generated: GeneratedFixture,
    pds_origin: String,
    service_did: String,
    reserved_signing_key: String,
    server_rotation_key_p256_hex: String,
    exp: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DecodeSubscribeReposFramesRequest {
    frames_base64: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct GeneratedFixture {
    did: String,
    handle: String,
    old_pds_origin: String,
    external_signing_key_p256_hex: String,
    external_rotation_key_p256_hex: String,
    external_signing_did_key: String,
    external_rotation_did_key: String,
    genesis_op: Value,
    collection: String,
    rkey: String,
    record_uri: String,
    record_cid: String,
    latest_commit: String,
    source_repo_car_base64: String,
    blob_cid: String,
    blob_mime_type: String,
    blob_bytes_base64: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FinalizedFixture {
    plc_op: Value,
    service_auth: String,
    server_rotation_did_key: String,
}

#[derive(Debug, Deserialize)]
struct SubscribeReposHeader {
    op: i64,
    #[serde(default)]
    #[serde(rename = "t")]
    kind: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SubscribeReposCommitFrame {
    seq: i64,
    rebase: bool,
    #[serde(rename = "tooBig")]
    too_big: bool,
    repo: String,
    commit: pds::cid::Cid,
    rev: String,
    since: Option<String>,
    #[serde(default, rename = "prevData")]
    prev_data: Option<pds::cid::Cid>,
    #[serde(with = "serde_bytes")]
    blocks: Vec<u8>,
    ops: Vec<SubscribeReposOpFrame>,
    blobs: Vec<pds::cid::Cid>,
    time: String,
}

#[derive(Debug, Deserialize)]
struct SubscribeReposSyncFrame {
    seq: i64,
    did: String,
    #[serde(with = "serde_bytes")]
    blocks: Vec<u8>,
    rev: String,
    time: String,
}

#[derive(Debug, Deserialize)]
struct SubscribeReposIdentityFrame {
    seq: i64,
    did: String,
    handle: Option<String>,
    time: String,
}

#[derive(Debug, Deserialize)]
struct SubscribeReposAccountFrame {
    seq: i64,
    did: String,
    active: bool,
    status: Option<String>,
    time: String,
}

#[derive(Debug, Deserialize)]
struct SubscribeReposInfoFrame {
    name: String,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SubscribeReposErrorFrame {
    error: String,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SubscribeReposOpFrame {
    action: String,
    path: String,
    cid: Option<pds::cid::Cid>,
    prev: Option<pds::cid::Cid>,
}

fn main() -> Result<(), AnyError> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let request: FixtureRequest = serde_json::from_str(&input)?;
    let output = match request {
        FixtureRequest::Generate(request) => serde_json::to_value(generate_fixture(request)?)?,
        FixtureRequest::Finalize(request) => serde_json::to_value(finalize_fixture(request)?)?,
        FixtureRequest::DecodeSubscribeReposFrames(request) => {
            serde_json::to_value(decode_subscribe_repos_frames(request)?)?
        }
    };
    println!("{}", serde_json::to_string_pretty(&output)?);
    Ok(())
}

fn generate_fixture(request: GenerateRequest) -> Result<GeneratedFixture, AnyError> {
    let external_signing_key = derived_p256_key(&request.seed, "external-atproto-signing")?;
    let external_rotation_key = derived_p256_key(&request.seed, "external-plc-rotation")?;
    let external_signing_did_key =
        did_key_from_public_key_multibase(&external_signing_key.public_key_multibase()?)?;
    let external_rotation_did_key =
        did_key_from_public_key_multibase(&external_rotation_key.public_key_multibase()?)?;

    let created = create_plc_operation(
        &request.handle,
        &request.old_pds_origin,
        &external_signing_did_key,
        std::slice::from_ref(&external_rotation_did_key),
        &external_rotation_key,
    )?;

    let blob_bytes = request.blob_text.into_bytes();
    let blob_cid = raw_cid(&blob_bytes);
    let record = json!({
        "$type": request.collection,
        "text": request.record_text,
        "createdAt": request.created_at,
        "attachment": {
            "$type": "blob",
            "ref": { "$link": blob_cid.to_string() },
            "mimeType": "text/plain",
            "size": blob_bytes.len(),
        },
    });
    let (record_cid, latest_commit, source_repo_car) = block_on(source_repo_car(
        &created.did,
        &request.collection,
        &request.rkey,
        &record,
        &external_signing_key,
    ))?;
    let record_uri = format!(
        "at://{}/{}/{}",
        created.did, request.collection, request.rkey
    );

    Ok(GeneratedFixture {
        did: created.did.clone(),
        handle: request.handle.clone(),
        old_pds_origin: request.old_pds_origin,
        external_signing_key_p256_hex: external_signing_key.to_p256_hex(),
        external_rotation_key_p256_hex: external_rotation_key.to_p256_hex(),
        external_signing_did_key,
        external_rotation_did_key,
        genesis_op: created.operation,
        collection: request.collection,
        rkey: request.rkey,
        record_uri,
        record_cid: record_cid.to_string(),
        latest_commit: latest_commit.to_string(),
        source_repo_car_base64: BASE64_STANDARD.encode(source_repo_car),
        blob_cid: blob_cid.to_string(),
        blob_mime_type: "text/plain".to_string(),
        blob_bytes_base64: BASE64_STANDARD.encode(blob_bytes),
    })
}

fn finalize_fixture(request: FinalizeRequest) -> Result<FinalizedFixture, AnyError> {
    let external_rotation_key =
        RepoSigningKey::from_p256_hex(&request.generated.external_rotation_key_p256_hex)?;
    let external_signing_key =
        RepoSigningKey::from_p256_hex(&request.generated.external_signing_key_p256_hex)?;
    let server_rotation_key =
        RepoSigningKey::from_p256_hex(request.server_rotation_key_p256_hex.trim())?;
    let server_rotation_did_key =
        did_key_from_public_key_multibase(&server_rotation_key.public_key_multibase()?)?;
    let plc_op = sign_plc_update_operation(
        &request.generated.genesis_op,
        &external_rotation_key,
        &request.generated.external_rotation_did_key,
        SignPlcOperationRequest {
            token: None,
            rotation_keys: Some(vec![
                request.generated.external_rotation_did_key.clone(),
                server_rotation_did_key.clone(),
            ]),
            also_known_as: Some(vec![format!("at://{}", request.generated.handle)]),
            verification_methods: Some(json!({
                "atproto": request.reserved_signing_key,
            })),
            services: Some(json!({
                "atproto_pds": {
                    "type": "AtprotoPersonalDataServer",
                    "endpoint": request.pds_origin,
                },
            })),
        },
    )?;
    let service_auth = service_auth_jwt(
        &external_signing_key,
        &request.generated.did,
        &request.service_did,
        CREATE_ACCOUNT_LXM,
        request.exp,
    )?;
    Ok(FinalizedFixture {
        plc_op,
        service_auth,
        server_rotation_did_key,
    })
}

fn decode_subscribe_repos_frames(
    request: DecodeSubscribeReposFramesRequest,
) -> Result<Vec<Value>, AnyError> {
    request
        .frames_base64
        .iter()
        .map(|frame| decode_subscribe_repos_frame(frame))
        .collect()
}

fn decode_subscribe_repos_frame(frame_base64: &str) -> Result<Value, AnyError> {
    let frame = BASE64_STANDARD.decode(frame_base64)?;
    let mut cursor = Cursor::new(frame);
    let header: SubscribeReposHeader = serde_ipld_dagcbor::de::from_reader_once(&mut cursor)?;
    if header.op == -1 {
        let body: SubscribeReposErrorFrame = serde_ipld_dagcbor::de::from_reader_once(&mut cursor)?;
        if cursor.position() != cursor.get_ref().len() as u64 {
            return Err("subscribeRepos error frame had trailing bytes".into());
        }
        return Ok(json!({
            "op": header.op,
            "kind": "#error",
            "error": body.error,
            "message": body.message,
        }));
    }
    if header.op != 1 {
        return Err(format!("unsupported subscribeRepos op {}", header.op).into());
    }
    let kind = header
        .kind
        .ok_or_else(|| "subscribeRepos event frame missing `t` kind".to_string())?;
    let body = match kind.as_str() {
        "#commit" => {
            let body: SubscribeReposCommitFrame =
                serde_ipld_dagcbor::de::from_reader_once(&mut cursor)?;
            json!({
                "op": header.op,
                "kind": kind,
                "seq": body.seq,
                "rebase": body.rebase,
                "tooBig": body.too_big,
                "repo": body.repo,
                "commit": body.commit.to_string(),
                "rev": body.rev,
                "since": body.since,
                "prevData": body.prev_data.map(|cid| cid.to_string()),
                "blocksBase64": BASE64_STANDARD.encode(body.blocks),
                "ops": body.ops.into_iter().map(subscribe_repo_op_json).collect::<Vec<_>>(),
                "blobs": body.blobs.into_iter().map(|cid| cid.to_string()).collect::<Vec<_>>(),
                "time": body.time,
            })
        }
        "#sync" => {
            let body: SubscribeReposSyncFrame =
                serde_ipld_dagcbor::de::from_reader_once(&mut cursor)?;
            json!({
                "op": header.op,
                "kind": kind,
                "seq": body.seq,
                "did": body.did,
                "blocksBase64": BASE64_STANDARD.encode(body.blocks),
                "rev": body.rev,
                "time": body.time,
            })
        }
        "#identity" => {
            let body: SubscribeReposIdentityFrame =
                serde_ipld_dagcbor::de::from_reader_once(&mut cursor)?;
            json!({
                "op": header.op,
                "kind": kind,
                "seq": body.seq,
                "did": body.did,
                "handle": body.handle,
                "time": body.time,
            })
        }
        "#account" => {
            let body: SubscribeReposAccountFrame =
                serde_ipld_dagcbor::de::from_reader_once(&mut cursor)?;
            json!({
                "op": header.op,
                "kind": kind,
                "seq": body.seq,
                "did": body.did,
                "active": body.active,
                "status": body.status,
                "time": body.time,
            })
        }
        "#info" => {
            let body: SubscribeReposInfoFrame =
                serde_ipld_dagcbor::de::from_reader_once(&mut cursor)?;
            json!({
                "op": header.op,
                "kind": kind,
                "name": body.name,
                "message": body.message,
            })
        }
        other => return Err(format!("unsupported subscribeRepos frame kind `{other}`").into()),
    };
    if cursor.position() != cursor.get_ref().len() as u64 {
        return Err("subscribeRepos frame had trailing bytes".into());
    }
    Ok(body)
}

fn subscribe_repo_op_json(op: SubscribeReposOpFrame) -> Value {
    json!({
        "action": op.action,
        "path": op.path,
        "cid": op.cid.map(|cid| cid.to_string()),
        "prev": op.prev.map(|cid| cid.to_string()),
    })
}

async fn source_repo_car(
    did: &str,
    collection: &str,
    rkey: &str,
    record: &Value,
    signing_key: &RepoSigningKey,
) -> Result<(pds::cid::Cid, pds::cid::Cid, Vec<u8>), AnyError> {
    let did = Did::new(did.to_string())?;
    let path = RepoPath::new(Nsid::new(collection)?, RecordKey::new(rkey)?);
    let mut repo = SignedRepository::create(
        MemoryRepoStore::new(),
        did.clone(),
        RepoRev::new(INITIAL_REV)?,
        signing_key,
    )
    .await?;
    let mutation = repo
        .create_record(path, record, RepoRev::new(RECORD_REV)?, signing_key)
        .await?;
    let cids = repo.export_cids().await?;
    let car = encode_car_from_store(&[repo.latest_commit_cid()], cids, repo.storage())?;
    validate_imported_repo(decode_car(&car)?, &did).await?;
    let record_cid = mutation
        .record_cid
        .ok_or_else(|| "source repo create_record did not return a record CID".to_string())?;
    Ok((record_cid, repo.latest_commit_cid(), car))
}

fn service_auth_jwt(
    signing_key: &RepoSigningKey,
    iss: &str,
    aud: &str,
    lxm: &str,
    exp: i64,
) -> Result<String, AnyError> {
    let header = json!({
        "typ": "JWT",
        "alg": "ES256",
        "kid": format!("{iss}#atproto"),
    });
    let payload = json!({
        "iss": iss,
        "aud": aud,
        "exp": exp,
        "lxm": lxm,
    });
    let header = BASE64_URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header)?);
    let payload = BASE64_URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload)?);
    let signing_input = format!("{header}.{payload}");
    let signature = signing_key.sign_sha256(signing_input.as_bytes())?;
    Ok(format!(
        "{signing_input}.{}",
        BASE64_URL_SAFE_NO_PAD.encode(signature)
    ))
}

fn derived_p256_key(seed: &str, label: &str) -> Result<RepoSigningKey, AnyError> {
    for counter in 0_u8..=u8::MAX {
        let digest = Sha256::digest(format!("{seed}:{label}:{counter}").as_bytes());
        let hex = hex_encode(&digest);
        if let Ok(key) = RepoSigningKey::from_p256_hex(&hex) {
            return Ok(key);
        }
    }
    Err(format!("failed to derive a valid P-256 key for {label}").into())
}

fn hex_encode(bytes: &[u8]) -> String {
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
    use pds::service_auth::verify_service_auth_jwt;

    #[test]
    fn generates_importable_repo_and_finalize_artifacts() {
        let generated = generate_fixture(GenerateRequest {
            handle: "migration-test.gsv.dev".to_string(),
            old_pds_origin: "https://old-pds.invalid".to_string(),
            collection: "app.gsv.migrationSmoke".to_string(),
            rkey: "migration-test".to_string(),
            record_text: "source record".to_string(),
            blob_text: "source blob".to_string(),
            created_at: "2026-05-11T00:00:00.000Z".to_string(),
            seed: "unit-test-seed".to_string(),
        })
        .unwrap();
        let car = BASE64_STANDARD
            .decode(&generated.source_repo_car_base64)
            .unwrap();
        block_on(validate_imported_repo(
            decode_car(&car).unwrap(),
            &Did::new(generated.did.clone()).unwrap(),
        ))
        .unwrap();
        assert_eq!(
            generated.blob_cid,
            raw_cid(
                &BASE64_STANDARD
                    .decode(&generated.blob_bytes_base64)
                    .unwrap()
            )
            .to_string()
        );

        let reserved_key = derived_p256_key("unit-test-seed", "reserved-atproto")
            .unwrap()
            .public_key_multibase()
            .unwrap();
        let reserved_did_key = did_key_from_public_key_multibase(&reserved_key).unwrap();
        let finalized = finalize_fixture(FinalizeRequest {
            generated: generated.clone(),
            pds_origin: "https://new-pds.example.com".to_string(),
            service_did: "did:web:new-pds.example.com".to_string(),
            reserved_signing_key: reserved_did_key.clone(),
            server_rotation_key_p256_hex: derived_p256_key("unit-test-seed", "server-rotation")
                .unwrap()
                .to_p256_hex(),
            exp: 1_777_777_777,
        })
        .unwrap();
        assert_eq!(
            finalized.plc_op["services"]["atproto_pds"]["endpoint"],
            "https://new-pds.example.com"
        );
        assert_eq!(
            finalized.plc_op["verificationMethods"]["atproto"],
            reserved_did_key
        );
        let did_doc = json!({
            "id": generated.did,
            "verificationMethod": [{
                "id": format!("{}#atproto", generated.did),
                "type": "Multikey",
                "controller": generated.did,
                "publicKeyMultibase": generated.external_signing_did_key.trim_start_matches("did:key:"),
            }],
        });
        verify_service_auth_jwt(
            &finalized.service_auth,
            &generated.did,
            "did:web:new-pds.example.com",
            CREATE_ACCOUNT_LXM,
            1_777_777_000,
            &did_doc,
        )
        .unwrap();
    }

    #[test]
    fn decodes_subscribe_repos_account_frames() {
        let mut frame = pds::cbor::encode_dag_cbor(&json!({
            "op": 1,
            "t": "#account",
        }))
        .unwrap();
        frame.extend(
            pds::cbor::encode_dag_cbor(&json!({
                "seq": 42,
                "did": "did:plc:abc123",
                "active": false,
                "status": "deactivated",
                "time": "2026-05-11T00:00:00.000Z",
            }))
            .unwrap(),
        );
        let decoded = decode_subscribe_repos_frames(DecodeSubscribeReposFramesRequest {
            frames_base64: vec![BASE64_STANDARD.encode(frame)],
        })
        .unwrap();

        assert_eq!(decoded[0]["kind"], "#account");
        assert_eq!(decoded[0]["seq"], 42);
        assert_eq!(decoded[0]["did"], "did:plc:abc123");
        assert_eq!(decoded[0]["active"], false);
        assert_eq!(decoded[0]["status"], "deactivated");
    }

    #[test]
    fn decodes_subscribe_repos_error_frames() {
        let mut frame = pds::cbor::encode_dag_cbor(&json!({
            "op": -1,
        }))
        .unwrap();
        frame.extend(
            pds::cbor::encode_dag_cbor(&json!({
                "error": "FutureCursor",
                "message": "cursor is ahead of the current stream sequence",
            }))
            .unwrap(),
        );
        let decoded = decode_subscribe_repos_frames(DecodeSubscribeReposFramesRequest {
            frames_base64: vec![BASE64_STANDARD.encode(frame)],
        })
        .unwrap();

        assert_eq!(decoded[0]["op"], -1);
        assert_eq!(decoded[0]["kind"], "#error");
        assert_eq!(decoded[0]["error"], "FutureCursor");
    }
}
