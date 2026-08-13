use fs2::FileExt;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::fmt::{self, Display, Formatter};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::marker::PhantomData;
use std::path::{Path, PathBuf};

pub const DEFAULT_SESSION_KEY: &str = "agent:main:cli:dm:main";

pub fn gsv_home() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".gsv")
}

pub fn device_log_dir() -> PathBuf {
    gsv_home().join("logs")
}

pub fn device_log_path() -> PathBuf {
    device_log_dir().join("device.log")
}

pub fn device_log_pattern() -> PathBuf {
    device_log_dir().join("device.log*")
}

/// Normalize legacy/alias session keys to canonical format.
pub fn normalize_session_key(raw: &str) -> String {
    let trimmed = raw.trim();

    if trimmed.is_empty() || trimmed == "main" {
        return DEFAULT_SESSION_KEY.to_string();
    }

    trimmed.to_string()
}

/// CLI configuration loaded from ~/.config/gsv/config.toml
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct CliConfig {
    /// Gateway connection settings
    #[serde(default)]
    pub gateway: GatewayConfig,

    /// Cloudflare API settings (for deploy commands)
    #[serde(default)]
    pub cloudflare: CloudflareConfig,

    /// Release defaults (install/upgrade channel preference)
    #[serde(default)]
    pub release: ReleaseConfig,

    /// R2 storage settings (for mount command)
    #[serde(default)]
    pub r2: R2Config,

    /// Device defaults (for `gsv device` and daemon service)
    #[serde(default, alias = "node")]
    pub device: DeviceConfig,

    /// Default session settings
    #[serde(default)]
    pub session: SessionConfig,

    /// Fields owned by newer or optional host applications.
    #[serde(default, flatten)]
    pub extra: toml::Table,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct GatewayConfig {
    /// WebSocket URL for the gateway
    pub url: Option<String>,

    /// Username for gateway authentication
    pub username: Option<String>,

    /// Non-interactive gateway credential (legacy "token" field)
    pub token: Option<String>,

    /// Cached short-lived user session token for CLI commands
    pub session_token: Option<String>,

    /// ID of cached user session token (for revoke/audit UX)
    pub session_token_id: Option<String>,

    /// Expiration timestamp (unix ms) for cached user session token
    pub session_expires_at: Option<i64>,

    #[serde(default, flatten)]
    pub extra: toml::Table,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct CloudflareConfig {
    /// Cloudflare account ID
    pub account_id: Option<String>,

    /// Cloudflare API token
    pub api_token: Option<String>,

    #[serde(default, flatten)]
    pub extra: toml::Table,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct ReleaseConfig {
    /// Preferred release channel for setup/upgrade defaults (`stable` or `dev`)
    pub channel: Option<String>,

    #[serde(default, flatten)]
    pub extra: toml::Table,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct R2Config {
    /// Cloudflare Account ID
    pub account_id: Option<String>,

    /// R2 Access Key ID
    pub access_key_id: Option<String>,

    /// R2 Secret Access Key
    pub secret_access_key: Option<String>,

    /// R2 bucket name
    pub bucket: Option<String>,

    #[serde(default, flatten)]
    pub extra: toml::Table,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct DeviceConfig {
    /// Device ID
    pub id: Option<String>,

    /// Device gateway token
    pub token: Option<String>,

    /// Workspace directory for file tools
    pub workspace: Option<PathBuf>,

    #[serde(default, flatten)]
    pub extra: toml::Table,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionConfig {
    /// Default session key
    pub default_key: Option<String>,

    #[serde(default, flatten)]
    pub extra: toml::Table,
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self {
            default_key: Some(DEFAULT_SESSION_KEY.to_string()),
            extra: toml::Table::new(),
        }
    }
}

#[derive(Debug)]
pub enum ConfigError {
    DirectoryUnavailable,
    MissingParent(PathBuf),
    Io(std::io::Error),
    Decode(toml::de::Error),
    Encode(toml::ser::Error),
    Persist(tempfile::PersistError),
}

impl Display for ConfigError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::DirectoryUnavailable => {
                write!(f, "GSV configuration directory is unavailable")
            }
            Self::MissingParent(path) => {
                write!(f, "Configuration path has no parent: {}", path.display())
            }
            Self::Io(error) => write!(f, "Configuration I/O failed: {error}"),
            Self::Decode(error) => write!(f, "Configuration could not be parsed: {error}"),
            Self::Encode(error) => write!(f, "Configuration could not be encoded: {error}"),
            Self::Persist(error) => write!(f, "Configuration could not be replaced: {error}"),
        }
    }
}

impl std::error::Error for ConfigError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::DirectoryUnavailable | Self::MissingParent(_) => None,
            Self::Io(error) => Some(error),
            Self::Decode(error) => Some(error),
            Self::Encode(error) => Some(error),
            Self::Persist(error) => Some(error),
        }
    }
}

impl From<std::io::Error> for ConfigError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<toml::de::Error> for ConfigError {
    fn from(error: toml::de::Error) -> Self {
        Self::Decode(error)
    }
}

impl From<toml::ser::Error> for ConfigError {
    fn from(error: toml::ser::Error) -> Self {
        Self::Encode(error)
    }
}

/// Locked, atomic storage for a complete TOML document. Applications should
/// prefer `update` for read-modify-write operations so concurrent host
/// processes cannot overwrite one another's changes.
#[derive(Debug, Clone)]
pub struct ConfigFile<T> {
    path: PathBuf,
    marker: PhantomData<fn() -> T>,
}

impl<T> ConfigFile<T>
where
    T: Default + DeserializeOwned + Serialize,
{
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            marker: PhantomData,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> Result<T, ConfigError> {
        let lock = self.open_lock()?;
        FileExt::lock_shared(&lock)?;
        let result = self.load_unlocked();
        FileExt::unlock(&lock)?;
        result
    }

    pub fn save(&self, value: &T) -> Result<(), ConfigError> {
        let lock = self.open_lock()?;
        FileExt::lock_exclusive(&lock)?;
        let result = self.save_unlocked(value);
        FileExt::unlock(&lock)?;
        result
    }

    pub fn update<R>(
        &self,
        update: impl FnOnce(&mut T) -> Result<R, ConfigError>,
    ) -> Result<R, ConfigError> {
        let lock = self.open_lock()?;
        FileExt::lock_exclusive(&lock)?;
        let result = (|| {
            let mut document = self.load_unlocked()?;
            let result = update(&mut document)?;
            self.save_unlocked(&document)?;
            Ok(result)
        })();
        FileExt::unlock(&lock)?;
        result
    }

    fn open_lock(&self) -> Result<File, ConfigError> {
        let parent = self
            .path
            .parent()
            .ok_or_else(|| ConfigError::MissingParent(self.path.clone()))?;
        std::fs::create_dir_all(parent)?;
        let lock_path = self.path.with_extension(
            self.path
                .extension()
                .and_then(|extension| extension.to_str())
                .map_or_else(
                    || "lock".to_string(),
                    |extension| format!("{extension}.lock"),
                ),
        );
        let lock = secure_open(&lock_path)?;
        Ok(lock)
    }

    fn load_unlocked(&self) -> Result<T, ConfigError> {
        match std::fs::read_to_string(&self.path) {
            Ok(content) => Ok(toml::from_str(&content)?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
            Err(error) => Err(error.into()),
        }
    }

    fn save_unlocked(&self, value: &T) -> Result<(), ConfigError> {
        let parent = self
            .path
            .parent()
            .ok_or_else(|| ConfigError::MissingParent(self.path.clone()))?;
        std::fs::create_dir_all(parent)?;
        let encoded = toml::to_string_pretty(value)?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
        set_private_permissions(temporary.as_file())?;
        temporary.write_all(encoded.as_bytes())?;
        temporary.as_file_mut().sync_all()?;
        temporary
            .persist(&self.path)
            .map_err(ConfigError::Persist)?;
        #[cfg(unix)]
        File::open(parent)?.sync_all()?;
        Ok(())
    }
}

fn secure_open(path: &Path) -> Result<File, std::io::Error> {
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    set_private_permissions(&file)?;
    Ok(file)
}

fn set_private_permissions(_file: &File) -> Result<(), std::io::Error> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = _file.metadata()?.permissions();
        permissions.set_mode(0o600);
        _file.set_permissions(permissions)?;
    }
    Ok(())
}

impl CliConfig {
    /// Get the config file path
    pub fn config_path() -> Option<PathBuf> {
        dirs::config_dir().map(|d| d.join("gsv").join("config.toml"))
    }

    /// Load config from file, returning default if file doesn't exist
    pub fn load() -> Self {
        let Some(path) = Self::config_path() else {
            return Self::default();
        };

        if !path.exists() {
            return Self::default();
        }

        let cfg = ConfigFile::new(path.clone())
            .load()
            .unwrap_or_else(|error| {
                eprintln!("Warning: Failed to load config: {error}");
                Self::default()
            });

        #[cfg(unix)]
        let mut cfg = cfg;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = std::fs::metadata(&path) {
                let mode = meta.permissions().mode();
                if (mode & 0o077) != 0 {
                    if cfg.gateway.session_token.is_some() {
                        eprintln!(
                            "Warning: ignoring cached gateway session token due to insecure permissions on {} (mode {:o}, expected 600).",
                            path.display(),
                            mode & 0o777,
                        );
                    }
                    cfg.gateway.session_token = None;
                    cfg.gateway.session_token_id = None;
                    cfg.gateway.session_expires_at = None;
                }
            }
        }

        cfg
    }

    /// Update the complete shared host configuration under one exclusive
    /// read-modify-write lock. Callers that change individual fields must use
    /// this boundary instead of saving a previously loaded snapshot.
    pub fn update<R>(update: impl FnOnce(&mut Self) -> R) -> Result<R, ConfigError> {
        let path = Self::config_path().ok_or(ConfigError::DirectoryUnavailable)?;
        ConfigFile::new(path).update(|config| Ok(update(config)))
    }

    /// Save config to file
    pub fn save(&self) -> Result<(), Box<dyn std::error::Error>> {
        let Some(path) = Self::config_path() else {
            return Err("Could not determine config directory".into());
        };

        ConfigFile::new(path)
            .save(self)
            .map_err(|error| Box::new(error) as Box<dyn std::error::Error>)
    }

    /// Get effective gateway URL (config -> default)
    pub fn gateway_url(&self) -> String {
        self.gateway
            .url
            .clone()
            .unwrap_or_else(|| "ws://localhost:8787/ws".to_string())
    }

    /// Get effective token (config only, no default)
    pub fn gateway_token(&self) -> Option<String> {
        self.gateway.token.clone()
    }

    /// Get cached user session token if present and not expired.
    pub fn gateway_session_token(&self) -> Option<String> {
        let token = self.gateway.session_token.clone()?;
        if let Some(expires_at) = self.gateway.session_expires_at {
            if chrono::Utc::now().timestamp_millis() >= expires_at {
                return None;
            }
        }
        Some(token)
    }

    pub fn gateway_session_expires_at(&self) -> Option<i64> {
        self.gateway.session_expires_at
    }

    /// Get effective gateway username (config only, no default)
    pub fn gateway_username(&self) -> Option<String> {
        self.gateway.username.clone()
    }

    /// Get normalized release channel from config (`stable` or `dev`)
    pub fn release_channel(&self) -> Option<String> {
        self.release
            .channel
            .as_deref()
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .filter(|value| matches!(value.as_str(), "stable" | "dev"))
    }

    /// Get default session key
    pub fn default_session(&self) -> String {
        let raw = self
            .session
            .default_key
            .as_deref()
            .unwrap_or(DEFAULT_SESSION_KEY);
        normalize_session_key(raw)
    }

    /// Get default device ID (if configured)
    pub fn default_device_id(&self) -> Option<String> {
        self.device.id.clone()
    }

    /// Get default device workspace (if configured)
    pub fn default_device_workspace(&self) -> Option<PathBuf> {
        self.device.workspace.clone()
    }

    /// Get default device token (if configured)
    pub fn default_device_token(&self) -> Option<String> {
        self.device.token.clone()
    }

    /// Get the GSV home directory (~/.gsv)
    pub fn gsv_home(&self) -> PathBuf {
        gsv_home()
    }

    /// Get the R2 mount path
    pub fn r2_mount_path(&self) -> PathBuf {
        self.gsv_home().join("r2")
    }
}

/// Generate a sample config file content
pub fn sample_config() -> &'static str {
    r#"# GSV CLI Configuration
# Location: ~/.config/gsv/config.toml

[gateway]
# WebSocket URL for the gateway (required for remote)
url = "wss://gateway.stevej.workers.dev/ws"

# Gateway username
# username = "root"

# Non-interactive gateway credential (legacy "token" field, keep secret!)
token = "your-token-here"

# Cached short-lived user session token (written by `gsv auth login`)
# session_token = "gsv_user_..."
# session_token_id = "uuid"
# session_expires_at = 1735689600000

[cloudflare]
# Used by 'gsv deploy' commands
# account_id = "your-cloudflare-account-id"
# api_token = "your-cloudflare-api-token"

[release]
# Preferred release channel for installer/setup/upgrade defaults (`stable` or `dev`)
# channel = "stable"

[r2]
# Cloudflare R2 credentials (for 'gsv mount' command)
# account_id = "your-account-id"
# access_key_id = "your-access-key"
# secret_access_key = "your-secret-key"
# bucket = "gsv-storage"

[session]
# Default session key
default_key = "agent:main:cli:dm:main"

[device]
# Optional defaults used by 'gsv device'
# id = "device-macbook"
# token = "your-device-token"
# workspace = "/Users/you/projects"

"#
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_preserves_unknown_application_and_section_fields() {
        let temp = tempfile::tempdir().expect("temporary config directory");
        let path = temp.path().join("config.toml");
        std::fs::write(
            &path,
            r#"
future_top = "owned elsewhere"

[gateway]
url = "wss://example.test/ws"
future_gateway = 42

[desktop]
selected_pid = "proc-7"
"#,
        )
        .expect("seed config");
        let store = ConfigFile::<CliConfig>::new(&path);
        store
            .update(|config| {
                config.gateway.username = Some("root".to_string());
                Ok(())
            })
            .expect("update config");

        let value: toml::Value =
            toml::from_str(&std::fs::read_to_string(path).expect("saved config contents"))
                .expect("saved TOML");
        assert_eq!(value["future_top"].as_str(), Some("owned elsewhere"));
        assert_eq!(value["gateway"]["future_gateway"].as_integer(), Some(42));
        assert_eq!(value["desktop"]["selected_pid"].as_str(), Some("proc-7"));
        assert_eq!(value["gateway"]["username"].as_str(), Some("root"));
    }

    #[test]
    fn update_reads_the_latest_complete_document_under_lock() {
        let temp = tempfile::tempdir().expect("temporary config directory");
        let path = temp.path().join("config.toml");
        let first = ConfigFile::<CliConfig>::new(&path);
        let second = ConfigFile::<CliConfig>::new(&path);
        first
            .update(|config| {
                config.gateway.username = Some("root".to_string());
                Ok(())
            })
            .expect("first update");
        second
            .update(|config| {
                config.release.channel = Some("dev".to_string());
                Ok(())
            })
            .expect("second update");
        let result = first.load().expect("load config");
        assert_eq!(result.gateway.username.as_deref(), Some("root"));
        assert_eq!(result.release.channel.as_deref(), Some("dev"));
    }

    #[cfg(unix)]
    #[test]
    fn saved_config_and_lock_are_private() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().expect("temporary config directory");
        let path = temp.path().join("config.toml");
        ConfigFile::<CliConfig>::new(&path)
            .save(&CliConfig::default())
            .expect("save config");
        let config_mode = std::fs::metadata(&path)
            .expect("config metadata")
            .permissions()
            .mode()
            & 0o777;
        let lock_mode = std::fs::metadata(path.with_extension("toml.lock"))
            .expect("lock metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(config_mode, 0o600);
        assert_eq!(lock_mode, 0o600);
    }
}
