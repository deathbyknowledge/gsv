use std::fmt::{self, Debug, Formatter};

use url::{Host, Url};

pub const DEFAULT_GATEWAY_URL: &str = "ws://localhost:8787/ws";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LoginStep {
    Url,
    Username,
    Password,
    Connecting,
    SetupRequired,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LoginDefaults {
    pub url: Option<String>,
    pub username: Option<String>,
}

#[derive(Clone)]
pub(crate) enum Credential {
    Password(String),
    Token(String),
}

#[derive(Clone)]
pub struct ConnectionSettings {
    pub(crate) attempt_id: u64,
    pub(crate) url: String,
    pub(crate) username: String,
    pub(crate) credential: Credential,
    pub(crate) remember_identity: bool,
}

impl Debug for ConnectionSettings {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ConnectionSettings")
            .field("attempt_id", &self.attempt_id)
            .field("url", &self.url)
            .field("username", &self.username)
            .field("credential", &"[REDACTED]")
            .field("remember_identity", &self.remember_identity)
            .finish()
    }
}

pub struct StartupSources {
    pub url: Option<String>,
    pub username: Option<String>,
    pub explicit_token: Option<String>,
    pub explicit_password: Option<String>,
    pub cached_token: Option<String>,
    pub configured_token: Option<String>,
}

pub enum StartupResolution {
    Connect(ConnectionSettings),
    Login(LoginDefaults),
}

pub fn resolve_startup(sources: StartupSources) -> StartupResolution {
    let url = sources
        .url
        .and_then(|value| validate_gateway_url(&value).ok());
    let username = sources
        .username
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let credential = sources
        .explicit_token
        .filter(|value| !value.is_empty())
        .map(Credential::Token)
        .or_else(|| {
            sources
                .explicit_password
                .filter(|value| !value.is_empty())
                .map(Credential::Password)
        })
        .or_else(|| {
            sources
                .cached_token
                .filter(|value| !value.is_empty())
                .map(Credential::Token)
        })
        .or_else(|| {
            sources
                .configured_token
                .filter(|value| !value.is_empty())
                .map(Credential::Token)
        });

    match (url, username, credential) {
        (Some(url), Some(username), Some(credential)) => {
            StartupResolution::Connect(ConnectionSettings {
                attempt_id: 0,
                url,
                username,
                credential,
                remember_identity: false,
            })
        }
        (url, username, _) => StartupResolution::Login(LoginDefaults { url, username }),
    }
}

#[derive(Debug)]
pub struct LoginFlow {
    step: LoginStep,
    url: String,
    username: String,
    error: Option<String>,
    active_attempt_id: Option<u64>,
    next_attempt_id: u64,
}

pub enum LoginProgress {
    Next,
    Connect(ConnectionSettings),
}

impl LoginFlow {
    pub fn new(defaults: LoginDefaults) -> Self {
        let step = if defaults.url.is_none() {
            LoginStep::Url
        } else if defaults.username.is_none() {
            LoginStep::Username
        } else {
            LoginStep::Password
        };
        Self {
            step,
            url: defaults
                .url
                .unwrap_or_else(|| DEFAULT_GATEWAY_URL.to_string()),
            username: defaults.username.unwrap_or_default(),
            error: None,
            active_attempt_id: None,
            next_attempt_id: 1,
        }
    }

    pub fn from_failure(defaults: LoginDefaults, step: LoginStep, message: String) -> Self {
        let mut flow = Self::new(defaults);
        flow.step = step;
        flow.error = Some(message);
        flow
    }

    pub fn step(&self) -> LoginStep {
        self.step
    }

    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    pub fn set_error(&mut self, message: String) {
        self.error = Some(message);
    }

    pub fn input_value(&self) -> String {
        match self.step {
            LoginStep::Url => self.url.clone(),
            LoginStep::Username => self.username.clone(),
            LoginStep::Password | LoginStep::Connecting | LoginStep::SetupRequired => String::new(),
        }
    }

    pub fn defaults(&self) -> LoginDefaults {
        LoginDefaults {
            url: Some(self.url.clone()),
            username: (!self.username.is_empty()).then(|| self.username.clone()),
        }
    }

    pub fn submit(&mut self, value: String) -> Result<LoginProgress, String> {
        self.error = None;
        match self.step {
            LoginStep::Url => {
                self.url = validate_gateway_url(&value)?;
                self.step = if self.username.is_empty() {
                    LoginStep::Username
                } else {
                    LoginStep::Password
                };
                Ok(LoginProgress::Next)
            }
            LoginStep::Username => {
                let username = value.trim();
                if username.is_empty() {
                    return Err("Type the username you use with this GSV.".to_string());
                }
                self.username = username.to_string();
                self.step = LoginStep::Password;
                Ok(LoginProgress::Next)
            }
            LoginStep::Password => {
                if value.is_empty() {
                    return Err("Type your password to continue.".to_string());
                }
                let attempt_id = self.next_attempt_id;
                self.next_attempt_id = self.next_attempt_id.wrapping_add(1).max(1);
                self.active_attempt_id = Some(attempt_id);
                self.step = LoginStep::Connecting;
                Ok(LoginProgress::Connect(ConnectionSettings {
                    attempt_id,
                    url: self.url.clone(),
                    username: self.username.clone(),
                    credential: Credential::Password(value),
                    remember_identity: true,
                }))
            }
            LoginStep::Connecting => Err("GSV is already connecting.".to_string()),
            LoginStep::SetupRequired => {
                self.step = LoginStep::Url;
                Ok(LoginProgress::Next)
            }
        }
    }

    pub fn back(&mut self) -> bool {
        self.error = None;
        self.active_attempt_id = None;
        self.step = match self.step {
            LoginStep::Url => return false,
            LoginStep::Username => LoginStep::Url,
            LoginStep::Password => LoginStep::Username,
            LoginStep::Connecting => return false,
            LoginStep::SetupRequired => LoginStep::Url,
        };
        true
    }

    pub fn cancel_connection(&mut self) -> Option<u64> {
        let attempt_id = self.active_attempt_id.take()?;
        self.error = None;
        self.step = LoginStep::Password;
        Some(attempt_id)
    }

    pub fn accept_connection(&mut self, attempt_id: u64) -> bool {
        if self.active_attempt_id != Some(attempt_id) {
            return false;
        }
        self.active_attempt_id = None;
        true
    }

    pub fn fail_connection(&mut self, attempt_id: u64, step: LoginStep, message: String) -> bool {
        if self.active_attempt_id != Some(attempt_id) {
            return false;
        }
        self.active_attempt_id = None;
        self.step = step;
        self.error = Some(message);
        true
    }

    pub fn require_setup(&mut self, attempt_id: u64, message: String) -> bool {
        if self.active_attempt_id != Some(attempt_id) && attempt_id != 0 {
            return false;
        }
        self.active_attempt_id = None;
        self.step = LoginStep::SetupRequired;
        self.error = Some(message);
        true
    }
}

fn validate_gateway_url(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("Type the WebSocket address of your GSV.".to_string());
    }
    let parsed =
        Url::parse(value).map_err(|_| "Use a complete ws:// or wss:// address.".to_string())?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(
            "Keep credentials out of the address; enter them in the next steps.".to_string(),
        );
    }
    if parsed.fragment().is_some() {
        return Err("That address cannot contain a # fragment.".to_string());
    }
    let host = parsed
        .host()
        .ok_or_else(|| "That address needs a host.".to_string())?;

    match parsed.scheme() {
        "wss" => Ok(value.to_string()),
        "ws" if is_loopback_host(host) => Ok(value.to_string()),
        "ws" => Err("Use wss:// when your GSV is not running on this computer.".to_string()),
        _ => Err("Use a ws://localhost address or a secure wss:// address.".to_string()),
    }
}

fn is_loopback_host(host: Host<&str>) -> bool {
    match host {
        Host::Domain(host) => {
            host.eq_ignore_ascii_case("localhost")
                || host.to_ascii_lowercase().ends_with(".localhost")
        }
        Host::Ipv4(host) => host.is_loopback(),
        Host::Ipv6(host) => host.is_loopback(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_sources() -> StartupSources {
        StartupSources {
            url: None,
            username: None,
            explicit_token: None,
            explicit_password: None,
            cached_token: None,
            configured_token: None,
        }
    }

    #[test]
    fn missing_values_advance_one_step_at_a_time() -> Result<(), String> {
        let mut flow = LoginFlow::new(LoginDefaults {
            url: None,
            username: None,
        });
        assert_eq!(flow.step(), LoginStep::Url);
        assert!(matches!(
            flow.submit("ws://localhost:8788/ws".to_string()),
            Ok(LoginProgress::Next)
        ));
        assert_eq!(flow.step(), LoginStep::Username);
        assert!(matches!(
            flow.submit(" hank ".to_string()),
            Ok(LoginProgress::Next)
        ));
        assert_eq!(flow.step(), LoginStep::Password);
        let settings = match flow.submit(" password with spaces ".to_string())? {
            LoginProgress::Connect(settings) => settings,
            LoginProgress::Next => {
                return Err("password should produce connection settings".to_string());
            }
        };
        assert_eq!(settings.username, "hank");
        assert!(matches!(
            settings.credential,
            Credential::Password(ref password) if password == " password with spaces "
        ));
        assert_eq!(flow.step(), LoginStep::Connecting);
        Ok(())
    }

    #[test]
    fn configured_fields_are_skipped() {
        let flow = LoginFlow::new(LoginDefaults {
            url: Some("wss://gsv.example/ws".to_string()),
            username: Some("hank".to_string()),
        });
        assert_eq!(flow.step(), LoginStep::Password);
    }

    #[test]
    fn credentials_are_exclusive_and_follow_precedence() -> Result<(), String> {
        let mut sources = empty_sources();
        sources.url = Some("wss://gsv.example/ws".to_string());
        sources.username = Some("hank".to_string());
        sources.explicit_token = Some("explicit-token".to_string());
        sources.explicit_password = Some("explicit-password".to_string());
        sources.cached_token = Some("cached-token".to_string());
        let settings = match resolve_startup(sources) {
            StartupResolution::Connect(settings) => settings,
            StartupResolution::Login(_) => {
                return Err("complete settings should connect immediately".to_string());
            }
        };
        assert!(matches!(
            settings.credential,
            Credential::Token(ref token) if token == "explicit-token"
        ));
        Ok(())
    }

    #[test]
    fn an_orphaned_credential_still_requires_login() {
        let mut sources = empty_sources();
        sources.explicit_token = Some("secret".to_string());
        assert!(matches!(
            resolve_startup(sources),
            StartupResolution::Login(LoginDefaults { username: None, .. })
        ));
    }

    #[test]
    fn missing_or_insecure_addresses_never_receive_a_credential() {
        let mut missing = empty_sources();
        missing.username = Some("hank".to_string());
        missing.explicit_token = Some("secret".to_string());
        assert!(matches!(
            resolve_startup(missing),
            StartupResolution::Login(LoginDefaults { url: None, .. })
        ));

        let mut insecure = empty_sources();
        insecure.url = Some("ws://gsv.example/ws".to_string());
        insecure.username = Some("hank".to_string());
        insecure.explicit_password = Some("secret".to_string());
        assert!(matches!(
            resolve_startup(insecure),
            StartupResolution::Login(LoginDefaults { url: None, .. })
        ));
    }

    #[test]
    fn loopback_detection_uses_the_parsed_host() {
        assert!(validate_gateway_url("ws://localhost:8788/ws").is_ok());
        assert!(validate_gateway_url("ws://hank.localhost:8976/ws").is_ok());
        assert!(validate_gateway_url("ws://[::1]:8788/ws").is_ok());
        assert!(validate_gateway_url("ws://127.1.2.3:8788/ws").is_ok());
        assert!(validate_gateway_url("ws://localhost:8788@evil.example/ws").is_err());
    }

    #[test]
    fn remote_password_login_requires_transport_security() {
        let mut flow = LoginFlow::new(LoginDefaults {
            url: None,
            username: None,
        });
        assert!(flow.submit("ws://gsv.example/ws".to_string()).is_err());
        assert!(flow.submit("wss://gsv.example/ws".to_string()).is_ok());
    }

    #[test]
    fn late_failures_do_not_replace_a_newer_attempt() -> Result<(), String> {
        let mut flow = LoginFlow::new(LoginDefaults {
            url: Some("wss://gsv.example/ws".to_string()),
            username: Some("hank".to_string()),
        });
        let first = match flow.submit("first".to_string())? {
            LoginProgress::Connect(settings) => settings,
            LoginProgress::Next => return Err("password should connect".to_string()),
        };
        assert!(!flow.fail_connection(
            first.attempt_id + 1,
            LoginStep::Password,
            "late".to_string()
        ));
        assert_eq!(flow.step(), LoginStep::Connecting);
        Ok(())
    }

    #[test]
    fn a_cancelled_attempt_cannot_complete_the_login() -> Result<(), String> {
        let mut flow = LoginFlow::new(LoginDefaults {
            url: Some("wss://gsv.example/ws".to_string()),
            username: Some("hank".to_string()),
        });
        let attempt_id = match flow.submit("password".to_string())? {
            LoginProgress::Connect(settings) => settings.attempt_id,
            LoginProgress::Next => return Err("password should connect".to_string()),
        };
        assert_eq!(flow.cancel_connection(), Some(attempt_id));
        assert!(!flow.accept_connection(attempt_id));
        assert_eq!(flow.step(), LoginStep::Password);
        Ok(())
    }

    #[test]
    fn connection_debug_output_redacts_credentials() {
        let settings = ConnectionSettings {
            attempt_id: 7,
            url: "wss://gsv.example/ws".to_string(),
            username: "hank".to_string(),
            credential: Credential::Password("do not print me".to_string()),
            remember_identity: true,
        };
        let debug = format!("{settings:?}");
        assert!(!debug.contains("do not print me"));
        assert!(debug.contains("[REDACTED]"));
    }
}
