use std::{fs, io::Write, path::PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::session::gateway_origin;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Challenge {
    pub id: String,
    pub email: String,
    pub browser_secret: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Flow {
    Open,
    Create,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Welcome {
    pub origin: String,
    pub flow: Flow,
    pub session_secret: Option<String>,
    pub challenge: Option<Challenge>,
    #[serde(default, alias = "inviteId")]
    pub operation_id: Option<String>,
    // Read old saved sign-ins without keeping the retired signup code.
    #[serde(default, rename = "inviteCode", skip_serializing)]
    pub retired_invite_code: Option<String>,
    pub handle: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub revision: String,
    pub value: Option<Welcome>,
}

pub struct WelcomeStore {
    path: PathBuf,
    pub current: Snapshot,
}

impl WelcomeStore {
    // SessionStore has already created and protected this app-owned directory.
    pub fn open(directory: PathBuf) -> Result<Self, String> {
        let path = directory.join("welcome.json");
        let current = match fs::read(&path) {
            Ok(bytes) if bytes.len() <= 4096 => serde_json::from_slice::<Snapshot>(&bytes)
                .map_err(|_| "Cannot read saved sign-in.")?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Snapshot {
                revision: Uuid::new_v4().to_string(),
                value: None,
            },
            _ => return Err("Cannot read saved sign-in.".into()),
        };
        if let Some(value) = &current.value {
            value.validate()?;
        }
        Ok(Self { path, current })
    }

    pub fn save(&mut self, revision: &str, value: Option<Welcome>) -> Result<Snapshot, String> {
        if revision != self.current.revision {
            return Err("Sign-in changed. Reopen this screen.".into());
        }
        if let Some(value) = &value {
            value.validate()?;
        }
        let next = Snapshot {
            revision: Uuid::new_v4().to_string(),
            value,
        };
        let bytes = serde_json::to_vec(&next).map_err(|_| "Cannot encode sign-in.")?;
        if bytes.len() > 4096 {
            return Err("Invalid sign-in data.".into());
        }
        let mut file = tempfile::NamedTempFile::new_in(
            self.path.parent().ok_or("Missing sign-in directory.")?,
        )
        .map_err(|_| "Cannot create private sign-in file.")?;
        file.write_all(&bytes)
            .map_err(|_| "Cannot write sign-in.")?;
        file.as_file()
            .sync_all()
            .map_err(|_| "Cannot sync sign-in.")?;
        file.persist(&self.path)
            .map_err(|_| "Cannot save sign-in.")?;
        self.current = next.clone();
        Ok(next)
    }
}

impl Welcome {
    fn validate(&self) -> Result<(), String> {
        let secret = |value: &str| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        };
        if gateway_origin(&self.origin)? != self.origin
            || self.session_secret.as_deref().is_some_and(|v| !secret(v))
            || self
                .retired_invite_code
                .as_ref()
                .is_some_and(|v| v.len() > 128)
            || self.operation_id.as_ref().is_some_and(|v| v.len() > 128)
            || self.handle.as_ref().is_some_and(|v| v.len() > 63)
            || self.challenge.as_ref().is_some_and(|c| {
                Uuid::parse_str(&c.id).is_err() || c.email.len() > 254 || !secret(&c.browser_secret)
            })
        {
            return Err("Invalid sign-in data.".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_previous_signup_state_without_retaining_the_code() {
        let previous = serde_json::json!({
            "origin": "https://gsv.space", "flow": "create", "sessionSecret": null,
            "challenge": null, "inviteCode": "invite_retired", "inviteId": "invite_existing", "handle": "alice"
        });
        let welcome: Welcome = serde_json::from_value(previous).unwrap();
        welcome.validate().unwrap();
        assert_eq!(welcome.operation_id.as_deref(), Some("invite_existing"));
        let saved = serde_json::to_value(welcome).unwrap();
        assert!(saved.get("inviteCode").is_none());
        assert!(saved.get("inviteId").is_none());
        assert_eq!(saved["operationId"], "invite_existing");
    }

    #[test]
    fn saves_before_requests_and_fences_late_writes_after_sign_out() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = WelcomeStore::open(directory.path().to_owned()).unwrap();
        let pending = Welcome {
            origin: "https://gsv.space".into(),
            flow: Flow::Create,
            session_secret: Some("a".repeat(64)),
            challenge: Some(Challenge {
                id: Uuid::new_v4().to_string(),
                email: "test@example.com".into(),
                browser_secret: "b".repeat(64),
            }),
            retired_invite_code: None,
            operation_id: Some(Uuid::new_v4().to_string()),
            handle: None,
        };
        let saved = store
            .save(&store.current.revision.clone(), Some(pending.clone()))
            .unwrap();
        let mut reopened = WelcomeStore::open(directory.path().to_owned()).unwrap();
        assert_eq!(
            reopened.current.value.as_ref().unwrap().session_secret,
            pending.session_secret
        );
        reopened.save(&saved.revision, None).unwrap();
        assert!(reopened.save(&saved.revision, Some(pending)).is_err());
        assert!(WelcomeStore::open(directory.path().to_owned())
            .unwrap()
            .current
            .value
            .is_none());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(directory.path().join("welcome.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
}
