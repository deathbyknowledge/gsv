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
];

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Session {
    pub generation: String,
    pub origin: Option<String>,
    pub values: BTreeMap<String, String>,
}

pub struct SessionStore {
    path: PathBuf,
    pub current: Session,
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
    pub fn open(directory: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&directory).map_err(|_| "Cannot create prototype data directory.")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
                .map_err(|_| "Cannot protect prototype data directory.")?;
        }
        let path = directory.join("session.json");
        let current = match fs::read(&path) {
            Ok(bytes) if bytes.len() <= 128 * 1024 => {
                let session: Session = serde_json::from_slice(&bytes)
                    .map_err(|_| "Prototype session file is invalid.")?;
                if let Some(origin) = &session.origin {
                    if gateway_origin(origin)? != *origin {
                        return Err("Prototype gateway is not a canonical origin.".into());
                    }
                }
                session
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Session {
                generation: Uuid::new_v4().to_string(),
                origin: None,
                values: BTreeMap::new(),
            },
            _ => return Err("Cannot read prototype session file.".into()),
        };
        Ok(Self { path, current })
    }

    pub fn configure(&mut self, origin: Option<String>) -> Result<Session, String> {
        let origin = origin.as_deref().map(gateway_origin).transpose()?;
        self.commit(Session {
            generation: Uuid::new_v4().to_string(),
            origin,
            values: BTreeMap::new(),
        })?;
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
        self.commit(Session {
            values,
            ..self.current.clone()
        })
    }

    fn commit(&mut self, next: Session) -> Result<(), String> {
        let parent = self.path.parent().ok_or("Missing session directory.")?;
        let mut file = tempfile::NamedTempFile::new_in(parent)
            .map_err(|_| "Cannot create private session file.")?;
        // NamedTempFile is created with mode 0600 on Unix; replacement is atomic.
        serde_json::to_writer(file.as_file_mut(), &next).map_err(|_| "Cannot encode session.")?;
        file.flush().map_err(|_| "Cannot flush session.")?;
        file.as_file()
            .sync_all()
            .map_err(|_| "Cannot sync session.")?;
        file.persist(&self.path)
            .map_err(|_| "Cannot save session.")?;
        self.current = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
