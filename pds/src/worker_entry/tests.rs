#[test]
fn recognizes_host_identity_well_known_paths() {
    assert!(is_host_identity_path("/.well-known/did.json"));
    assert!(is_host_identity_path("/.well-known/atproto-did"));
    assert!(!is_host_identity_path("/.well-known"));
    assert!(!is_host_identity_path("/.well-known/other"));
}

#[test]
fn detects_repo_already_initialized_error() {
    let error = HttpError::new(
        409,
        "failed to initialize repo: {\"error\":\"repo already initialized\"}",
    );
    assert!(is_repo_already_initialized_error(&error));
    assert!(!is_repo_already_initialized_error(&HttpError::new(
        409,
        "different conflict",
    )));
}

#[test]
fn converts_matching_repo_status_to_init_response() {
    let response = init_response_from_repo_status(
        matching_repo_status(),
        "did:web:gsv-pds.example.com",
        "gsv-pds.example.com",
    )
    .unwrap();

    assert_eq!(response.public_key_multibase, "zPublicKey");
    assert_eq!(response.latest_commit, "bafyreiatestcommit");
    assert_eq!(response.latest_rev, "3lzpfxn2f6h2c");
}

#[test]
fn rejects_recovery_status_for_different_identity() {
    let error = init_response_from_repo_status(
        matching_repo_status(),
        "did:web:other.example.com",
        "gsv-pds.example.com",
    )
    .unwrap_err();
    assert_eq!(error.status, 409);
    assert!(error.message.contains("different DID"));

    let error = init_response_from_repo_status(
        matching_repo_status(),
        "did:web:gsv-pds.example.com",
        "other.example.com",
    )
    .unwrap_err();
    assert_eq!(error.status, 409);
    assert!(error.message.contains("different handle"));
}

#[test]
fn rejects_incomplete_recovery_status() {
    let error = init_response_from_repo_status(
        InternalRepoStatusResponse {
            initialized: false,
            did: None,
            handle: None,
            public_key_multibase: None,
            latest_commit: None,
            latest_rev: None,
            blocks: 0,
            records: 0,
            expected_blobs: 0,
            imported_blobs: 0,
        },
        "did:web:gsv-pds.example.com",
        "gsv-pds.example.com",
    )
    .unwrap_err();
    assert_eq!(error.status, 409);
    assert!(error.message.contains("uninitialized"));

    let mut status = matching_repo_status();
    status.latest_commit = None;
    let error = init_response_from_repo_status(
        status,
        "did:web:gsv-pds.example.com",
        "gsv-pds.example.com",
    )
    .unwrap_err();
    assert_eq!(error.status, 409);
    assert!(error.message.contains("latest commit"));
}

#[test]
fn builds_identity_info_response_body() {
    let account = test_account("did:web:gsv-pds.example.com", "gsv-pds.example.com");

    let body = identity_info_response_body("https://gsv-pds.example.com", &account);

    assert_eq!(body["did"], "did:web:gsv-pds.example.com");
    assert_eq!(body["handle"], "gsv-pds.example.com");
    assert_eq!(body["didDoc"]["id"], "did:web:gsv-pds.example.com");
    assert_eq!(
        body["didDoc"]["service"][0]["serviceEndpoint"],
        "https://gsv-pds.example.com"
    );
}

#[test]
fn builds_admin_account_and_subject_views() {
    let account = DirectoryAccountRow {
        did: Did::new("did:web:gsv-pds.example.com").unwrap(),
        handle: "gsv-pds.example.com".to_string(),
        email: Some("hank@example.com".to_string()),
        email_confirmed: true,
        invites_disabled: true,
        invite_note: Some("maintenance".to_string()),
        password_hash: "hash".to_string(),
        repo_name: "gsv-pds.example.com".to_string(),
        public_key_multibase: "zPublicKey".to_string(),
        active: false,
        status: Some("takedown".to_string()),
        created_at: "2026-01-01T00:00:00Z".to_string(),
    };
    let invite = DirectoryInviteCodeRow {
        code: "gsv-test".to_string(),
        available: 2,
        disabled: false,
        for_account: account.did.clone(),
        created_by: account.did.clone(),
        created_at: "2026-01-01T00:00:00Z".to_string(),
    };
    let invite_use = DirectoryInviteCodeUseRow {
        code: invite.code.clone(),
        used_by: Did::new("did:gsv:invited").unwrap(),
        used_at: "2026-01-01T00:01:00Z".to_string(),
    };
    let invite = invite_code_json(&invite, &[invite_use]);

    let view = account_view_json(&account, Some(vec![invite]));
    assert_eq!(view["did"], account.did.to_string());
    assert_eq!(view["invitesDisabled"], true);
    assert_eq!(view["inviteNote"], "maintenance");
    assert_eq!(view["invites"][0]["code"], "gsv-test");
    assert_eq!(view["invites"][0]["uses"][0]["usedBy"], "did:gsv:invited");

    let status = subject_status_json(&account);
    assert_eq!(status["subject"]["did"], account.did.to_string());
    assert_eq!(status["takedown"]["applied"], true);
    assert_eq!(status["deactivated"]["applied"], false);
}

#[test]
fn builds_verifiable_service_auth_jwt() {
    let key = RepoSigningKey::from_p256_hex(
        "0000000000000000000000000000000000000000000000000000000000000001",
    )
    .unwrap();
    let token = service_auth_jwt(
        &key,
        "did:web:gsv-pds.example.com",
        "did:web:service.example.com",
        Some("com.atproto.repo.getRecord"),
        1_776_722_400,
    )
    .unwrap();
    let parts = token.split('.').collect::<Vec<_>>();
    assert_eq!(parts.len(), 3);

    let payload = BASE64_URL_SAFE_NO_PAD.decode(parts[1]).unwrap();
    let payload: Value = serde_json::from_slice(&payload).unwrap();
    assert_eq!(payload["iss"], "did:web:gsv-pds.example.com");
    assert_eq!(payload["aud"], "did:web:service.example.com");
    assert_eq!(payload["lxm"], "com.atproto.repo.getRecord");

    let signature = BASE64_URL_SAFE_NO_PAD.decode(parts[2]).unwrap();
    crate::identity::verify_p256_signature(
        &key.verifying_key().unwrap(),
        format!("{}.{}", parts[0], parts[1]).as_bytes(),
        &signature,
    )
    .unwrap();
}

#[test]
fn verifies_service_auth_jwt_against_did_document() {
    let key = RepoSigningKey::from_p256_hex(
        "0000000000000000000000000000000000000000000000000000000000000001",
    )
    .unwrap();
    let public_key = key.public_key_multibase().unwrap();
    let doc = did_document(
        "did:web:gsv-pds.example.com",
        "gsv-pds.example.com",
        &public_key,
        "https://old-pds.example.com",
    );
    let token = service_auth_jwt(
        &key,
        "did:web:gsv-pds.example.com",
        "did:web:new-pds.example.com",
        Some(SERVER_CREATE_ACCOUNT),
        1_776_722_400,
    )
    .unwrap();

    verify_service_auth_jwt(
        &token,
        "did:web:gsv-pds.example.com",
        "did:web:new-pds.example.com",
        SERVER_CREATE_ACCOUNT,
        1_776_722_300,
        &doc,
    )
    .unwrap();
    assert!(verify_service_auth_jwt(
        &token,
        "did:web:gsv-pds.example.com",
        "did:web:other-pds.example.com",
        SERVER_CREATE_ACCOUNT,
        1_776_722_300,
        &doc,
    )
    .is_err());
    assert!(verify_service_auth_jwt(
        &token,
        "did:web:gsv-pds.example.com",
        "did:web:new-pds.example.com",
        "com.atproto.repo.getRecord",
        1_776_722_300,
        &doc,
    )
    .is_err());
    assert!(verify_service_auth_jwt(
        &token,
        "did:web:gsv-pds.example.com",
        "did:web:new-pds.example.com",
        SERVER_CREATE_ACCOUNT,
        1_776_722_401,
        &doc,
    )
    .is_err());
}

#[test]
fn verifies_es256k_service_auth_jwt_against_did_document() {
    use k256::ecdsa::signature::hazmat::PrehashSigner;

    let key = k256::ecdsa::SigningKey::from_slice(&[2_u8; REPO_SIGNING_KEY_BYTES]).unwrap();
    let public_key = key.verifying_key().to_encoded_point(true);
    let mut multikey = Vec::with_capacity(2 + public_key.as_bytes().len());
    multikey.extend_from_slice(&[0xe7, 0x01]);
    multikey.extend_from_slice(public_key.as_bytes());
    let public_key_multibase = format!("z{}", bs58::encode(multikey).into_string());
    let doc = did_document(
        "did:web:es256k.example.com",
        "es256k.example.com",
        &public_key_multibase,
        "https://old-pds.example.com",
    );
    let header =
        BASE64_URL_SAFE_NO_PAD.encode(to_vec(&json!({"typ": "JWT", "alg": "ES256K"})).unwrap());
    let payload = BASE64_URL_SAFE_NO_PAD.encode(
        to_vec(&json!({
            "iss": "did:web:es256k.example.com",
            "aud": "did:web:new-pds.example.com",
            "exp": 1_776_722_400_i64,
            "lxm": SERVER_CREATE_ACCOUNT,
        }))
        .unwrap(),
    );
    let signing_input = format!("{header}.{payload}");
    let digest = Sha256::digest(signing_input.as_bytes());
    let signature: k256::ecdsa::Signature = key.sign_prehash(&digest).unwrap();
    let token = format!(
        "{signing_input}.{}",
        BASE64_URL_SAFE_NO_PAD.encode(signature.to_bytes())
    );

    verify_service_auth_jwt(
        &token,
        "did:web:es256k.example.com",
        "did:web:new-pds.example.com",
        SERVER_CREATE_ACCOUNT,
        1_776_722_300,
        &doc,
    )
    .unwrap();
}

#[test]
fn extracts_plc_operation_atproto_signing_key() {
    let key = "did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169";
    assert_eq!(
        plc_operation_atproto_signing_key(&json!({
            "verificationMethods": {
                "atproto": key,
            },
        }))
        .unwrap(),
        key
    );
    assert!(plc_operation_atproto_signing_key(&json!({})).is_err());
}

#[test]
fn normalizes_at_identifiers() {
    assert_eq!(
        normalize_at_identifier("GSV-PDS.EXAMPLE.COM"),
        "gsv-pds.example.com"
    );
    assert_eq!(
        normalize_at_identifier("did:web:MiXeD.example.com"),
        "did:web:MiXeD.example.com"
    );
}

#[test]
fn parses_only_internal_repo_control_paths() {
    assert_eq!(
        internal_repo_control_parts(&["_pds_internal", "repos", "alice", "init"]),
        Some(("alice", InternalRepoControlAction::Init))
    );
    assert_eq!(
        internal_repo_control_parts(&["repos", "alice", "init"]),
        None
    );
    assert_eq!(
        internal_repo_control_parts(&["_pds_internal", "repos", "alice"]),
        None
    );
    assert_eq!(
        internal_repo_control_parts(&["_pds_internal", "repos", "alice", "init", "extra"]),
        None
    );
    assert_eq!(
        internal_repo_control_parts(&["_pds_internal", "repos", "alice", "lexicons"]),
        None
    );
}

#[test]
fn parses_only_internal_directory_control_paths() {
    assert_eq!(
        internal_directory_control_action(&["_pds_internal", "directory", "status"]),
        Some(InternalDirectoryControlAction::Status)
    );
    assert_eq!(
        internal_directory_control_action(&["_pds_internal", "directory", "accounts", "status"]),
        Some(InternalDirectoryControlAction::AccountStatus)
    );
    assert_eq!(
        internal_directory_control_action(&["_pds_internal", "directory", "repos", "upsert"]),
        Some(InternalDirectoryControlAction::RepoUpsert)
    );
    assert_eq!(
        internal_directory_control_action(&["directory", "status"]),
        None
    );
    assert_eq!(
        internal_directory_control_action(&["_pds_internal", "directory", "repos"]),
        None
    );
}

#[test]
fn validates_app_password_names() {
    assert!(ensure_app_password_name("desktop client").is_ok());
    assert!(ensure_app_password_name("").is_err());
    assert!(ensure_app_password_name("   ").is_err());
    assert!(ensure_app_password_name(&"x".repeat(65)).is_err());
}

#[test]
fn detects_firehose_commit_frame_limits() {
    assert!(!firehose_commit_frame_exceeds_limits(
        FIREHOSE_COMMIT_BLOCKS_MAX_BYTES,
        FIREHOSE_COMMIT_OPS_MAX,
    ));
    assert!(firehose_commit_frame_exceeds_limits(
        FIREHOSE_COMMIT_BLOCKS_MAX_BYTES + 1,
        1,
    ));
    assert!(firehose_commit_frame_exceeds_limits(
        1,
        FIREHOSE_COMMIT_OPS_MAX + 1,
    ));
}

#[test]
fn builds_sync_event_payload_with_only_commit_block() {
    use crate::storage::{MemoryRepoStore, RepoBlockStore};

    let mut store = MemoryRepoStore::new();
    let commit_bytes = encode_dag_cbor(&json!({"commit": "root"})).unwrap();
    let commit_cid = store.put_block(commit_bytes.clone()).unwrap();
    let extra_bytes = encode_dag_cbor(&json!({"record": "not included"})).unwrap();
    let extra_cid = store.put_block(extra_bytes.clone()).unwrap();

    let payload = directory_sync_event_payload_from_store(commit_cid, &store).unwrap();
    assert_eq!(payload.event_type, DirectoryCommitEventType::Sync);
    assert_eq!(payload.since, None);
    assert_eq!(payload.prev_data, None);
    assert!(payload.ops.is_empty());
    assert!(payload.blobs.is_empty());

    let decoded = decode_car(&payload.blocks).unwrap();
    assert_eq!(decoded.roots, vec![commit_cid]);
    assert_eq!(decoded.blocks.len(), 1);
    assert_eq!(decoded.blocks[0].cid, commit_cid);

    let payload = directory_sync_event_payload_from_blocks(
        commit_cid,
        &[
            CarBlock {
                cid: extra_cid,
                bytes: extra_bytes,
            },
            CarBlock {
                cid: commit_cid,
                bytes: commit_bytes,
            },
        ],
    )
    .unwrap();
    let decoded = decode_car(&payload.blocks).unwrap();
    assert_eq!(decoded.roots, vec![commit_cid]);
    assert_eq!(decoded.blocks.len(), 1);
    assert_eq!(decoded.blocks[0].cid, commit_cid);
}

#[test]
fn rejects_sync_event_payloads_over_sync_block_limit() {
    use crate::storage::{MemoryRepoStore, RepoBlockStore};

    let mut store = MemoryRepoStore::new();
    let cid = store
        .put_block(encode_dag_cbor(&"x".repeat(FIREHOSE_SYNC_BLOCKS_MAX_BYTES)).unwrap())
        .unwrap();

    let error = directory_sync_event_payload_from_store(cid, &store).unwrap_err();
    assert_eq!(error.status, 500);
    assert!(error.message.contains("sync event blocks exceed"));
}

#[test]
fn accepts_and_validates_known_record_envelopes() {
    let collection = Nsid::new("app.gsv.record").unwrap();
    let lexicons = vec![test_record_lexicon("app.gsv.record")];
    assert_eq!(
        ensure_record_envelope(
            &collection,
            &json!({
                "$type": "app.gsv.record",
                "text": "hello",
            }),
            None,
            &lexicons,
        )
        .unwrap(),
        RecordValidationStatus::Valid
    );
    assert_eq!(
        ensure_record_envelope(
            &collection,
            &json!({
                "$type": "app.gsv.record",
                "text": "hello",
            }),
            Some(true),
            &lexicons,
        )
        .unwrap(),
        RecordValidationStatus::Valid
    );
}

#[test]
fn explicit_no_validation_returns_unknown_status() {
    let collection = Nsid::new("app.gsv.record").unwrap();
    assert_eq!(
        ensure_record_envelope(
            &collection,
            &json!({
                "$type": "app.gsv.record",
                "text": "hello",
            }),
            Some(false),
            &[],
        )
        .unwrap(),
        RecordValidationStatus::Unknown
    );
}

#[test]
fn optimistic_unknown_lexicon_returns_unknown_status() {
    let collection = Nsid::new("app.gsv.unknown").unwrap();
    assert_eq!(
        ensure_record_envelope(
            &collection,
            &json!({
                "$type": "app.gsv.unknown",
                "text": "hello",
            }),
            None,
            &[],
        )
        .unwrap(),
        RecordValidationStatus::Unknown
    );
}

#[test]
fn rejects_invalid_record_envelopes_and_unknown_validate_true() {
    let collection = Nsid::new("app.gsv.record").unwrap();

    let error =
        ensure_record_envelope(&collection, &json!({"text": "hello"}), None, &[]).unwrap_err();
    assert_eq!(error.status, 400);
    assert!(error.message.contains("$type"));

    let error = ensure_record_envelope(
        &collection,
        &json!({
            "$type": "app.gsv.other",
            "text": "hello",
        }),
        None,
        &[],
    )
    .unwrap_err();
    assert_eq!(error.status, 400);
    assert!(error.message.contains("does not match"));

    let unknown_collection = Nsid::new("app.gsv.unknown").unwrap();
    let error = ensure_record_envelope(
        &unknown_collection,
        &json!({
            "$type": "app.gsv.unknown",
            "text": "hello",
        }),
        Some(true),
        &[],
    )
    .unwrap_err();
    assert_eq!(error.status, 400);
    assert!(error.message.contains("lexicon"));
}

fn matching_repo_status() -> InternalRepoStatusResponse {
    InternalRepoStatusResponse {
        initialized: true,
        did: Some("did:web:gsv-pds.example.com".to_string()),
        handle: Some("gsv-pds.example.com".to_string()),
        public_key_multibase: Some("zPublicKey".to_string()),
        latest_commit: Some("bafyreiatestcommit".to_string()),
        latest_rev: Some("3lzpfxn2f6h2c".to_string()),
        blocks: 42,
        records: 7,
        expected_blobs: 2,
        imported_blobs: 1,
    }
}

fn test_account(did: &str, handle: &str) -> DirectoryAccountRow {
    test_account_with_public_key(did, handle, "zPublicKey")
}

fn test_account_with_public_key(
    did: &str,
    handle: &str,
    public_key_multibase: &str,
) -> DirectoryAccountRow {
    DirectoryAccountRow {
        did: Did::new(did).unwrap(),
        handle: handle.to_string(),
        email: None,
        email_confirmed: false,
        invites_disabled: false,
        invite_note: None,
        password_hash: "hash".to_string(),
        repo_name: repo_object_name_from_identifier(did),
        public_key_multibase: public_key_multibase.to_string(),
        active: true,
        status: None,
        created_at: "2026-01-01T00:00:00Z".to_string(),
    }
}

fn test_record_lexicon(id: &str) -> Value {
    json!({
        "lexicon": 1,
        "id": id,
        "defs": {
            "main": {
                "type": "record",
                "key": "any",
                "record": {
                    "type": "object",
                    "required": ["$type", "text"],
                    "properties": {
                        "$type": { "type": "string", "const": id },
                        "text": { "type": "string" }
                    }
                }
            }
        }
    })
}
