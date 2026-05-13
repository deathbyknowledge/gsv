use super::*;

#[derive(Debug, Deserialize)]
pub(super) struct InitRepoRequest {
    pub(super) did: String,
    pub(super) handle: String,
    pub(super) rev: String,
    #[serde(rename = "signingKeyP256Hex", alias = "signing_key_p256_hex")]
    pub(super) signing_key_p256_hex: String,
    #[serde(default)]
    pub(super) reset: Option<bool>,
    #[serde(default, rename = "notifyDirectory")]
    pub(super) notify_directory: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub(super) struct UpdateRepoIdentityRequest {
    pub(super) handle: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct UpdateRepoSigningKeyRequest {
    #[serde(rename = "signingKeyP256Hex", alias = "signing_key_p256_hex")]
    pub(super) signing_key_p256_hex: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct XrpcCreateAccountRequest {
    pub(super) handle: String,
    #[serde(default)]
    pub(super) email: Option<String>,
    #[serde(default)]
    pub(super) password: Option<String>,
    #[serde(default)]
    pub(super) did: Option<String>,
    #[serde(default, rename = "inviteCode", alias = "invite_code")]
    pub(super) invite_code: Option<String>,
    #[serde(default, rename = "recoveryKey", alias = "recovery_key")]
    pub(super) recovery_key: Option<String>,
    #[serde(default, rename = "plcOp")]
    pub(super) plc_op: Option<Value>,
}

#[derive(Debug, Deserialize)]
pub(super) struct XrpcCreateSessionRequest {
    pub(super) identifier: String,
    pub(super) password: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct XrpcChangePasswordRequest {
    #[serde(rename = "oldPassword", alias = "old_password")]
    pub(super) old_password: String,
    #[serde(rename = "newPassword", alias = "new_password")]
    pub(super) new_password: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct XrpcRequestPasswordResetRequest {
    pub(super) email: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct XrpcResetPasswordRequest {
    pub(super) token: String,
    pub(super) password: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct XrpcConfirmEmailRequest {
    pub(super) email: String,
    pub(super) token: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct XrpcUpdateEmailRequest {
    pub(super) email: String,
    #[serde(default)]
    pub(super) token: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct XrpcDeleteAccountRequest {
    pub(super) did: String,
    pub(super) password: String,
    pub(super) token: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct XrpcUpdateHandleRequest {
    pub(super) handle: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct XrpcRefreshIdentityRequest {
    pub(super) identifier: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct XrpcSubmitPlcOperationRequest {
    pub(super) operation: Value,
}

#[derive(Debug, Default, Deserialize)]
pub(super) struct XrpcReserveSigningKeyRequest {
    #[serde(default)]
    pub(super) did: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct XrpcCreateInviteCodeRequest {
    #[serde(rename = "useCount", alias = "use_count")]
    pub(super) use_count: i64,
    #[serde(default, rename = "forAccount", alias = "for_account")]
    pub(super) for_account: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct XrpcCreateInviteCodesRequest {
    #[serde(rename = "useCount", alias = "use_count")]
    pub(super) use_count: i64,
    #[serde(default, rename = "codeCount", alias = "code_count")]
    pub(super) code_count: Option<i64>,
    #[serde(default, rename = "forAccounts", alias = "for_accounts")]
    pub(super) for_accounts: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub(super) struct XrpcCreateAppPasswordRequest {
    pub(super) name: String,
    #[serde(default)]
    pub(super) privileged: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub(super) struct XrpcRevokeAppPasswordRequest {
    pub(super) name: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct XrpcAdminDidRequest {
    pub(super) did: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct XrpcAdminAccountInvitesRequest {
    pub(super) account: String,
    #[serde(default)]
    pub(super) note: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct XrpcAdminDisableInviteCodesRequest {
    #[serde(default)]
    pub(super) codes: Option<Vec<String>>,
    #[serde(default)]
    pub(super) accounts: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub(super) struct XrpcAdminSendEmailRequest {
    #[serde(rename = "recipientDid", alias = "recipient_did")]
    pub(super) recipient_did: String,
    pub(super) content: String,
    #[serde(default)]
    pub(super) subject: Option<String>,
    #[serde(rename = "senderDid", alias = "sender_did")]
    pub(super) sender_did: String,
    #[serde(default)]
    pub(super) comment: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct XrpcAdminUpdateAccountEmailRequest {
    pub(super) account: String,
    pub(super) email: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct XrpcAdminUpdateAccountHandleRequest {
    pub(super) did: String,
    pub(super) handle: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct XrpcAdminUpdateAccountPasswordRequest {
    pub(super) did: String,
    pub(super) password: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct XrpcAdminUpdateAccountSigningKeyRequest {
    pub(super) did: String,
    #[serde(rename = "signingKey", alias = "signing_key")]
    pub(super) signing_key: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct XrpcAdminStatusAttrRequest {
    pub(super) applied: bool,
    #[serde(default, rename = "ref")]
    pub(super) ref_value: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct XrpcAdminUpdateSubjectStatusRequest {
    pub(super) subject: Value,
    #[serde(default)]
    pub(super) takedown: Option<XrpcAdminStatusAttrRequest>,
    #[serde(default)]
    pub(super) deactivated: Option<XrpcAdminStatusAttrRequest>,
}

#[derive(Debug, Deserialize)]
pub(super) struct ServiceAuthRequest {
    pub(super) aud: String,
    pub(super) exp: i64,
    #[serde(default)]
    pub(super) lxm: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct ServiceAuthResponse {
    pub(super) token: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct InternalInitRepoResponse {
    #[serde(rename = "publicKeyMultibase")]
    pub(super) public_key_multibase: String,
    #[serde(rename = "latestCommit")]
    pub(super) latest_commit: String,
    #[serde(rename = "latestRev")]
    pub(super) latest_rev: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct InternalRepoStatusResponse {
    pub(super) initialized: bool,
    pub(super) did: Option<String>,
    pub(super) handle: Option<String>,
    #[serde(rename = "publicKeyMultibase")]
    pub(super) public_key_multibase: Option<String>,
    #[serde(rename = "latestCommit")]
    pub(super) latest_commit: Option<String>,
    #[serde(rename = "latestRev")]
    pub(super) latest_rev: Option<String>,
    #[serde(default)]
    pub(super) blocks: i64,
    #[serde(default)]
    pub(super) records: i64,
    #[serde(default, rename = "expectedBlobs")]
    pub(super) expected_blobs: i64,
    #[serde(default, rename = "importedBlobs")]
    pub(super) imported_blobs: i64,
}

#[derive(Debug, Deserialize)]
pub(super) struct InternalAccountStatusResponse {
    pub(super) active: bool,
    pub(super) status: Option<String>,
}

pub(super) struct CreatedSession {
    pub(super) row: DirectorySessionRow,
    pub(super) tokens: SessionTokens,
}

pub(super) struct CreatedOAuthSession {
    pub(super) row: DirectorySessionRow,
    pub(super) tokens: SessionTokens,
    pub(super) dpop_nonce: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct OAuthClientAuthBinding {
    pub(super) method: OAuthClientAuthMethod,
    pub(super) kid: Option<String>,
    pub(super) alg: Option<String>,
    pub(super) jkt: Option<String>,
}

impl OAuthClientAuthBinding {
    pub(super) fn none() -> Self {
        Self {
            method: OAuthClientAuthMethod::None,
            kid: None,
            alg: None,
            jkt: None,
        }
    }

    pub(super) fn from_verified(assertion: crate::oauth::VerifiedClientAssertion) -> Self {
        Self {
            method: OAuthClientAuthMethod::PrivateKeyJwt,
            kid: Some(assertion.kid),
            alg: Some(assertion.alg),
            jkt: Some(assertion.jkt),
        }
    }

    pub(super) fn from_parts(
        method: &str,
        kid: Option<String>,
        alg: Option<String>,
        jkt: Option<String>,
    ) -> Result<Self, HttpError> {
        let method = match method {
            "none" => OAuthClientAuthMethod::None,
            "private_key_jwt" => OAuthClientAuthMethod::PrivateKeyJwt,
            other => {
                return Err(HttpError::new(
                    500,
                    format!("unknown OAuth client auth `{other}`"),
                ))
            }
        };
        Ok(Self {
            method,
            kid,
            alg,
            jkt,
        })
    }

    pub(super) fn method_str(&self) -> &'static str {
        self.method.as_str()
    }

    pub(super) fn ensure_matches(&self, expected: &Self) -> Result<(), HttpError> {
        if self == expected {
            Ok(())
        } else {
            Err(HttpError::new(
                401,
                "OAuth client authentication key does not match this authorization session",
            ))
        }
    }
}

pub(super) struct SessionTokens {
    pub(super) access_jwt: String,
    pub(super) refresh_jwt: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct XrpcCreateRecordRequest {
    pub(super) repo: String,
    pub(super) collection: String,
    #[serde(default)]
    pub(super) rkey: Option<String>,
    pub(super) record: Value,
    #[serde(default, rename = "validate")]
    pub(super) validate: Option<bool>,
    #[serde(default, rename = "swapCommit")]
    pub(super) swap_commit: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct XrpcPutRecordRequest {
    pub(super) repo: String,
    pub(super) collection: String,
    pub(super) rkey: String,
    pub(super) record: Value,
    #[serde(default, rename = "validate")]
    pub(super) validate: Option<bool>,
    #[serde(default, rename = "swapRecord")]
    pub(super) swap_record: SwapRecordField,
    #[serde(default, rename = "swapCommit")]
    pub(super) swap_commit: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct XrpcDeleteRecordRequest {
    pub(super) repo: String,
    pub(super) collection: String,
    pub(super) rkey: String,
    #[serde(default, rename = "swapRecord")]
    pub(super) swap_record: Option<String>,
    #[serde(default, rename = "swapCommit")]
    pub(super) swap_commit: Option<String>,
}

#[derive(Debug, Default)]
pub(super) enum SwapRecordField {
    #[default]
    Missing,
    Absent,
    Cid(String),
}

impl<'de> Deserialize<'de> for SwapRecordField {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Option::<String>::deserialize(deserializer)?
            .map(Self::Cid)
            .map_or(Ok(Self::Absent), Ok)
    }
}

#[derive(Debug, Deserialize)]
pub(super) struct XrpcApplyWritesRequest {
    pub(super) repo: String,
    #[serde(default, rename = "validate")]
    pub(super) validate: Option<bool>,
    pub(super) writes: Vec<XrpcApplyWriteRequest>,
    #[serde(default, rename = "swapCommit")]
    pub(super) swap_commit: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct XrpcApplyWriteRequest {
    #[serde(rename = "$type")]
    pub(super) write_type: String,
    pub(super) collection: String,
    #[serde(default)]
    pub(super) rkey: Option<String>,
    #[serde(default)]
    pub(super) value: Option<Value>,
}

#[derive(Debug, Deserialize)]
pub(super) struct DirectoryUpsertRepoRequest {
    pub(super) did: String,
    pub(super) handle: String,
    #[serde(rename = "repoName", alias = "repo_name")]
    pub(super) repo_name: String,
    pub(super) head: String,
    pub(super) rev: String,
    #[serde(default)]
    pub(super) active: Option<bool>,
    #[serde(default)]
    pub(super) records: Option<Vec<String>>,
    #[serde(default)]
    pub(super) event: Option<DirectoryCommitEventRequest>,
}
