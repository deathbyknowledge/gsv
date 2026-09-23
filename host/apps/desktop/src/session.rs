use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use url::Url;
use uuid::Uuid;

const KEYS: &[&str] = &[
    "gsv.ui.gateway.username",
    "gsv.ui.session.token.v1",
    "gsv.ui.session.pending-revokes.v1",
    "gsv.ui.installation-onboarding.v1",
];
const PENDING_REVOKES: &str = "gsv.ui.session.pending-revokes.v1";
const MAX_SESSION_BYTES: usize = 128 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Session {
    pub generation: String,
    pub origin: Option<String>,
    pub values: BTreeMap<String, String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredSession {
    generation: String,
    origin: Option<String>,
    values: BTreeMap<String, String>,
    #[serde(default)]
    pending_revokes: BTreeMap<String, Vec<String>>,
}

pub struct SessionStore {
    path: PathBuf,
    pub current: Session,
    pending_revokes: BTreeMap<String, Vec<String>>,
}

pub fn gateway_origin(value: &str) -> Result<String, String> {
    let url = Url::parse(value.trim()).map_err(|_| "Enter the full HTTPS space address.")?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("Use an HTTPS origin without credentials, path, query or fragment.".into());
    }
    Ok(url.origin().ascii_serialization())
}

impl SessionStore {
    pub fn import_previous_session(
        directory: &std::path::Path,
        previous: &std::path::Path,
    ) -> Result<(), String> {
        use fs2::FileExt;
        if directory.join("session.json").exists() || !previous.join("session.json").exists() {
            return Ok(());
        }
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(previous.join("prototype.lock"))
            .map_err(|_| "Cannot open the previous Desktop session.")?;
        lock.try_lock_exclusive()
            .map_err(|_| "Close the older GSV window before upgrading.")?;
        let previous = Self::open(previous.to_owned())?;
        let mut destination = Self::open(directory.to_owned())?;
        destination.commit(previous.current, previous.pending_revokes)
    }

    pub fn open(directory: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&directory).map_err(|_| "Cannot create desktop data directory.")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
                .map_err(|_| "Cannot protect desktop data directory.")?;
        }
        let path = directory.join("session.json");
        let stored = match fs::read(&path) {
            Ok(bytes) if bytes.len() <= MAX_SESSION_BYTES => {
                let session: StoredSession = serde_json::from_slice(&bytes)
                    .map_err(|_| "Desktop session file is invalid.")?;
                for origin in session.origin.iter().chain(session.pending_revokes.keys()) {
                    if gateway_origin(origin)? != *origin {
                        return Err("Desktop gateway is not a canonical origin.".into());
                    }
                }
                session
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => StoredSession {
                generation: Uuid::new_v4().to_string(),
                origin: None,
                values: BTreeMap::new(),
                pending_revokes: BTreeMap::new(),
            },
            _ => return Err("Cannot read desktop session file.".into()),
        };
        Ok(Self {
            path,
            current: Session {
                generation: stored.generation,
                origin: stored.origin,
                values: stored.values,
            },
            pending_revokes: stored.pending_revokes,
        })
    }

    pub fn configure(&mut self, origin: Option<String>) -> Result<Session, String> {
        self.configure_onboarding(origin, None)
    }

    pub fn configure_onboarding(
        &mut self,
        origin: Option<String>,
        onboarding_token: Option<String>,
    ) -> Result<Session, String> {
        let origin = origin.as_deref().map(gateway_origin).transpose()?;
        if let Some(token) = &onboarding_token {
            if origin.is_none()
                || !token.starts_with("onboard_")
                || token.len() != 51
                || !token[8..]
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            {
                return Err("Invalid setup authorization.".into());
            }
        }
        let mut pending_revokes = self.pending_revokes.clone();
        if let Some(previous_origin) = &self.current.origin {
            let pending: Vec<String> = self
                .current
                .values
                .get(PENDING_REVOKES)
                .map(|value| serde_json::from_str(value))
                .transpose()
                .map_err(|_| "Invalid pending session revocations.")?
                .unwrap_or_default();
            if pending.is_empty() {
                pending_revokes.remove(previous_origin);
            } else {
                pending_revokes.insert(previous_origin.clone(), pending);
            }
        }
        let mut values = BTreeMap::new();
        if let Some(token) = onboarding_token {
            values.insert("gsv.ui.installation-onboarding.v1".into(), token);
        }
        if let Some(pending) = origin
            .as_ref()
            .and_then(|origin| pending_revokes.remove(origin))
        {
            values.insert(
                PENDING_REVOKES.into(),
                serde_json::to_string(&pending)
                    .map_err(|_| "Cannot encode pending session revocations.")?,
            );
        }
        self.commit(
            Session {
                generation: Uuid::new_v4().to_string(),
                origin,
                values,
            },
            pending_revokes,
        )?;
        Ok(self.current.clone())
    }

    pub fn store(
        &mut self,
        generation: &str,
        values: BTreeMap<String, String>,
    ) -> Result<(), String> {
        if generation != self.current.generation || self.current.origin.is_none() {
            return Err("The configured space has changed.".into());
        }
        if values.len() > KEYS.len()
            || values
                .iter()
                .any(|(key, value)| !KEYS.contains(&key.as_str()) || value.len() > 32 * 1024)
        {
            return Err("Invalid session storage update.".into());
        }
        self.commit(
            Session {
                values,
                ..self.current.clone()
            },
            self.pending_revokes.clone(),
        )
    }

    fn commit(
        &mut self,
        next: Session,
        pending_revokes: BTreeMap<String, Vec<String>>,
    ) -> Result<(), String> {
        let stored = StoredSession {
            generation: next.generation.clone(),
            origin: next.origin.clone(),
            values: next.values.clone(),
            pending_revokes: pending_revokes.clone(),
        };
        let bytes = serde_json::to_vec(&stored).map_err(|_| "Cannot encode session.")?;
        if bytes.len() > MAX_SESSION_BYTES {
            return Err("Desktop session storage is full.".into());
        }
        let parent = self.path.parent().ok_or("Missing session directory.")?;
        let mut file = tempfile::NamedTempFile::new_in(parent)
            .map_err(|_| "Cannot create private session file.")?;
        // NamedTempFile is created with mode 0600 on Unix; replacement is atomic.
        file.write_all(&bytes)
            .map_err(|_| "Cannot write session.")?;
        file.flush().map_err(|_| "Cannot flush session.")?;
        file.as_file()
            .sync_all()
            .map_err(|_| "Cannot sync session.")?;
        file.persist(&self.path)
            .map_err(|_| "Cannot save session.")?;
        self.current = next;
        self.pending_revokes = pending_revokes;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upgrade_imports_once_without_overwriting_a_new_session() {
        let temp = tempfile::tempdir().unwrap();
        let previous = temp.path().join("previous");
        let current = temp.path().join("current");
        let mut old = SessionStore::open(previous.clone()).unwrap();
        old.configure(Some("https://first.example".into())).unwrap();
        fs::File::create(previous.join("prototype.lock")).unwrap();
        SessionStore::import_previous_session(&current, &previous).unwrap();
        let mut imported = SessionStore::open(current.clone()).unwrap();
        assert_eq!(imported.current.generation, old.current.generation);
        imported
            .configure(Some("https://second.example".into()))
            .unwrap();
        SessionStore::import_previous_session(&current, &previous).unwrap();
        assert_eq!(
            SessionStore::open(current)
                .unwrap()
                .current
                .origin
                .as_deref(),
            Some("https://second.example")
        );
        assert_eq!(
            SessionStore::open(previous)
                .unwrap()
                .current
                .origin
                .as_deref(),
            Some("https://first.example")
        );
    }

    #[test]
    fn existing_session_files_keep_their_credential_when_opened() {
        let directory = tempfile::tempdir().unwrap();
        let session = Session {
            generation: "existing-generation".into(),
            origin: Some("https://first.example".into()),
            values: BTreeMap::from([(KEYS[1].into(), "fixture credential".into())]),
        };
        fs::write(
            directory.path().join("session.json"),
            serde_json::to_vec(&session).unwrap(),
        )
        .unwrap();
        let store = SessionStore::open(directory.path().to_owned()).unwrap();
        assert_eq!(store.current.generation, session.generation);
        assert_eq!(store.current.values, session.values);
        assert!(store.pending_revokes.is_empty());
    }

    #[test]
    fn disconnect_keeps_only_revocation_ids_and_returns_them_to_their_original_space() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = SessionStore::open(directory.path().to_owned()).unwrap();
        let first = store
            .configure(Some("https://first.example".into()))
            .unwrap();
        store
            .store(
                &first.generation,
                BTreeMap::from([
                    (KEYS[0].into(), "alice".into()),
                    (KEYS[1].into(), "fixture credential".into()),
                    (PENDING_REVOKES.into(), r#"["first-token"]"#.into()),
                ]),
            )
            .unwrap();
        store.configure(None).unwrap();
        let mut store = SessionStore::open(directory.path().to_owned()).unwrap();
        assert!(store.current.origin.is_none());
        assert!(store.current.values.is_empty());
        let saved = fs::read_to_string(directory.path().join("session.json")).unwrap();
        assert!(!saved.contains("fixture credential"));
        assert!(!saved.contains("alice"));

        let second = store
            .configure(Some("https://second.example".into()))
            .unwrap();
        assert!(second.values.is_empty());
        assert!(!serde_json::to_string(&second)
            .unwrap()
            .contains("first-token"));
        assert!(store.store(&first.generation, BTreeMap::new()).is_err());
        store
            .store(
                &second.generation,
                BTreeMap::from([(PENDING_REVOKES.into(), r#"["second-token"]"#.into())]),
            )
            .unwrap();
        store.configure(None).unwrap();

        let mut store = SessionStore::open(directory.path().to_owned()).unwrap();
        let first_again = store
            .configure(Some("https://first.example".into()))
            .unwrap();
        assert_eq!(
            first_again.values,
            BTreeMap::from([(PENDING_REVOKES.into(), r#"["first-token"]"#.into()),])
        );
        assert!(!serde_json::to_string(&first_again)
            .unwrap()
            .contains("second-token"));
        store
            .store(&first_again.generation, BTreeMap::new())
            .unwrap();
        store.configure(None).unwrap();

        let mut store = SessionStore::open(directory.path().to_owned()).unwrap();
        let first_done = store
            .configure(Some("https://first.example".into()))
            .unwrap();
        assert!(first_done.values.is_empty());
        let second_again = store
            .configure(Some("https://second.example".into()))
            .unwrap();
        assert_eq!(
            second_again.values.get(PENDING_REVOKES).unwrap(),
            r#"["second-token"]"#
        );
    }

    #[test]
    fn oversized_revocation_storage_leaves_the_previous_session_intact() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = SessionStore::open(directory.path().to_owned()).unwrap();
        let previous = store
            .configure(Some("https://first.example".into()))
            .unwrap();
        let next = Session {
            origin: None,
            ..previous.clone()
        };
        assert!(store
            .commit(
                next,
                BTreeMap::from([(
                    "https://first.example".into(),
                    vec!["x".repeat(MAX_SESSION_BYTES)]
                ),])
            )
            .is_err());
        assert_eq!(store.current.origin, previous.origin);
        assert_eq!(
            SessionStore::open(directory.path().to_owned())
                .unwrap()
                .current
                .origin,
            previous.origin
        );
    }

    #[test]
    fn destination_change_rejects_late_credential_writes() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = SessionStore::open(directory.path().to_owned()).unwrap();
        let first = store
            .configure(Some("https://first.example".into()))
            .unwrap();
        let second = store
            .configure(Some("https://second.example".into()))
            .unwrap();
        assert!(store
            .store(
                &first.generation,
                BTreeMap::from([(KEYS[1].into(), "old credential".into()),])
            )
            .is_err());
        assert!(store.current.values.is_empty());
        assert_eq!(store.current.generation, second.generation);
        assert_eq!(
            SessionStore::open(directory.path().to_owned())
                .unwrap()
                .current
                .origin,
            Some("https://second.example".into())
        );
    }

    #[test]
    fn gateway_is_an_origin_not_a_navigation_target() {
        for value in [
            "http://remote.example",
            "https://root:secret@space.example",
            "https://space.example/ws",
            "https://space.example/#secret",
            "file:///tmp/ui",
        ] {
            assert!(gateway_origin(value).is_err());
        }
        assert_eq!(
            gateway_origin("https://SPACE.example/").unwrap(),
            "https://space.example"
        );
        assert!(gateway_origin("http://localhost:8787").is_ok());
    }
}
