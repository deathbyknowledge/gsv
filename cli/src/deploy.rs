use crate::config::CliConfig;
use crate::connection::Connection;
use base64::Engine;
use reqwest::{multipart, StatusCode};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::time::sleep;
use walkdir::WalkDir;

const REPO_OWNER: &str = "deathbyknowledge";
const REPO_NAME: &str = "gsv";

const COMPONENT_GATEWAY: &str = "gateway";
const COMPONENT_RIPGIT: &str = "ripgit";
const COMPONENT_ASSEMBLER: &str = "assembler";
const COMPONENT_CHANNEL_WHATSAPP: &str = "channel-whatsapp";
const COMPONENT_CHANNEL_DISCORD: &str = "channel-discord";
const COMPONENT_CHANNEL_TELEGRAM: &str = "channel-telegram";

const BUNDLE_ASSEMBLER: &str = "gsv-cloudflare-assembler.tar.gz";
const BUNDLE_GATEWAY: &str = "gsv-cloudflare-gateway.tar.gz";
const BUNDLE_RIPGIT: &str = "gsv-cloudflare-ripgit.tar.gz";
const BUNDLE_CHANNEL_WHATSAPP: &str = "gsv-cloudflare-channel-whatsapp.tar.gz";
const BUNDLE_CHANNEL_DISCORD: &str = "gsv-cloudflare-channel-discord.tar.gz";
const BUNDLE_CHANNEL_TELEGRAM: &str = "gsv-cloudflare-channel-telegram.tar.gz";
const BUNDLE_CHECKSUMS: &str = "cloudflare-checksums.txt";
pub const DEFAULT_DEPLOY_INSTANCE: &str = "gsv";
const DEFAULT_STORAGE_BUCKET_NAME: &str = "gsv-storage";
const SCRIPT_ASSEMBLER: &str = "gsv-assembler";
const SCRIPT_GATEWAY: &str = "gsv";
const SCRIPT_RIPGIT: &str = "ripgit";
const SCRIPT_CHANNEL_WHATSAPP: &str = "gsv-channel-whatsapp";
const SCRIPT_CHANNEL_DISCORD: &str = "gsv-channel-discord";
const SCRIPT_CHANNEL_TELEGRAM: &str = "gsv-channel-telegram";
const RESERVED_NON_DEFAULT_INSTANCE_NAMES: &[&str] = &[SCRIPT_RIPGIT];
const RESERVED_INSTANCE_NAME_SUFFIXES: &[&str] = &[
    "-assembler",
    "-ripgit",
    "-channel-whatsapp",
    "-channel-discord",
    "-channel-telegram",
];
const DEV_RELEASE_TAG: &str = "dev";
const WORKERS_SUBDOMAIN_API_DATE: &str = "2025-08-01";
const CLOUDFLARE_MAX_ATTEMPTS: usize = 5;
const CLOUDFLARE_RETRY_BASE_MS: u64 = 400;
const WORKERS_DEV_SCRIPT_NAME_MAX_LEN: usize = 63;
const R2_BUCKET_NAME_MAX_LEN: usize = 63;
const DEPLOY_LEASE_SCHEMA_VERSION: u32 = 1;
const DEPLOY_STATUS_SCHEMA_VERSION: u32 = 1;
const MAX_SOURCE_MAP_UPLOAD_BYTES: usize = 2 * 1024 * 1024;
static DEPLOY_NOTIFICATION_MODE: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct DeployInstance {
    name: String,
}

impl DeployInstance {
    pub fn parse(raw: &str) -> Result<Self, Box<dyn std::error::Error>> {
        let name = normalize_instance_name(raw)?;
        let instance = Self { name };
        instance.validate_resource_names()?;
        Ok(instance)
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn is_default(&self) -> bool {
        self.name == DEFAULT_DEPLOY_INSTANCE
    }

    pub fn storage_bucket_name(&self) -> String {
        format!("{}-storage", self.name)
    }

    pub fn script_name(&self, component: &str) -> Option<String> {
        match component {
            COMPONENT_GATEWAY => Some(self.name.clone()),
            COMPONENT_ASSEMBLER => Some(format!("{}-assembler", self.name)),
            COMPONENT_RIPGIT if self.is_default() => Some(SCRIPT_RIPGIT.to_string()),
            COMPONENT_RIPGIT => Some(format!("{}-ripgit", self.name)),
            COMPONENT_CHANNEL_WHATSAPP => Some(format!("{}-channel-whatsapp", self.name)),
            COMPONENT_CHANNEL_DISCORD => Some(format!("{}-channel-discord", self.name)),
            COMPONENT_CHANNEL_TELEGRAM => Some(format!("{}-channel-telegram", self.name)),
            _ => None,
        }
    }

    fn script_name_for_config_service(&self, service: &str) -> String {
        match service {
            SCRIPT_GATEWAY => self
                .script_name(COMPONENT_GATEWAY)
                .unwrap_or_else(|| service.to_string()),
            SCRIPT_ASSEMBLER => self
                .script_name(COMPONENT_ASSEMBLER)
                .unwrap_or_else(|| service.to_string()),
            SCRIPT_RIPGIT => self
                .script_name(COMPONENT_RIPGIT)
                .unwrap_or_else(|| service.to_string()),
            SCRIPT_CHANNEL_WHATSAPP => self
                .script_name(COMPONENT_CHANNEL_WHATSAPP)
                .unwrap_or_else(|| service.to_string()),
            SCRIPT_CHANNEL_DISCORD => self
                .script_name(COMPONENT_CHANNEL_DISCORD)
                .unwrap_or_else(|| service.to_string()),
            SCRIPT_CHANNEL_TELEGRAM => self
                .script_name(COMPONENT_CHANNEL_TELEGRAM)
                .unwrap_or_else(|| service.to_string()),
            _ => service.to_string(),
        }
    }

    fn validate_resource_names(&self) -> Result<(), Box<dyn std::error::Error>> {
        let bucket_name = self.storage_bucket_name();
        if bucket_name.len() > R2_BUCKET_NAME_MAX_LEN {
            return Err(format!(
                "GSV instance '{}' produces R2 bucket name '{}' with {} characters; the maximum is {}",
                self.name,
                bucket_name,
                bucket_name.len(),
                R2_BUCKET_NAME_MAX_LEN
            )
            .into());
        }

        for component in available_components() {
            let script_name = self
                .script_name(component)
                .ok_or_else(|| format!("Unsupported component '{}'", component))?;
            if script_name.len() > WORKERS_DEV_SCRIPT_NAME_MAX_LEN {
                return Err(format!(
                    "GSV instance '{}' produces Worker name '{}' with {} characters; workers.dev names have a maximum of {}",
                    self.name,
                    script_name,
                    script_name.len(),
                    WORKERS_DEV_SCRIPT_NAME_MAX_LEN
                )
                .into());
            }
        }

        Ok(())
    }
}

impl Default for DeployInstance {
    fn default() -> Self {
        Self {
            name: DEFAULT_DEPLOY_INSTANCE.to_string(),
        }
    }
}

fn normalize_instance_name(raw: &str) -> Result<String, Box<dyn std::error::Error>> {
    let normalized = raw.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return Err("GSV instance name cannot be empty".into());
    }
    if normalized.starts_with('-') || normalized.ends_with('-') {
        return Err("GSV instance name cannot start or end with '-'".into());
    }
    if !normalized
        .chars()
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
    {
        return Err(
            "GSV instance name must contain only lowercase letters, numbers, and '-'".into(),
        );
    }
    if normalized != DEFAULT_DEPLOY_INSTANCE
        && (RESERVED_NON_DEFAULT_INSTANCE_NAMES.contains(&normalized.as_str())
            || RESERVED_INSTANCE_NAME_SUFFIXES
                .iter()
                .any(|suffix| normalized.ends_with(suffix)))
    {
        return Err("GSV instance name would collide with generated component worker names".into());
    }
    Ok(normalized)
}

pub fn set_notification_output(enabled: bool) {
    DEPLOY_NOTIFICATION_MODE.store(enabled, Ordering::Relaxed);
}

fn emit_output_line(line: &str, is_error: bool) {
    if !DEPLOY_NOTIFICATION_MODE.load(Ordering::Relaxed) {
        if is_error {
            ::std::eprintln!("{}", line);
        } else {
            ::std::println!("{}", line);
        }
        return;
    }

    for raw_line in line.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }

        if is_error || line.starts_with("Error:") {
            let message = line.strip_prefix("Error:").map(str::trim).unwrap_or(line);
            let _ = cliclack::log::error(message);
            continue;
        }
        if line.starts_with("Warning:") {
            let message = line.strip_prefix("Warning:").map(str::trim).unwrap_or(line);
            let _ = cliclack::log::warning(message);
            continue;
        }
        if line.ends_with(':')
            || line.starts_with("Deploying ")
            || line.starts_with("Finalizing ")
            || line.starts_with("Ensuring ")
            || line.starts_with("Preparing ")
            || line.starts_with("Fetching ")
            || line.starts_with("Installing ")
            || line.starts_with("Deleting ")
            || line.starts_with("Tearing down ")
            || line.starts_with("Applying ")
        {
            let _ = cliclack::log::step(line);
            continue;
        }
        if line.starts_with("Created ")
            || line.starts_with("Updated ")
            || line.starts_with("Uploaded ")
            || line.starts_with("Configured ")
            || line.starts_with("Saved ")
            || line.starts_with("Deleted ")
            || line == "Deploy complete."
            || line == "Teardown complete."
            || line.ends_with(" complete.")
        {
            let _ = cliclack::log::success(line);
            continue;
        }

        let _ = cliclack::log::info(line);
    }
}

fn deploy_println(line: String) {
    emit_output_line(&line, false);
}

macro_rules! println {
    () => {{
        deploy_println(String::new());
    }};
    ($($arg:tt)*) => {{
        deploy_println(format!($($arg)*));
    }};
}

fn is_dev_channel_release_tag(tag: &str) -> bool {
    tag.trim().eq_ignore_ascii_case(DEV_RELEASE_TAG)
}

fn is_latest_channel_release_tag(tag: &str) -> bool {
    tag.trim().eq_ignore_ascii_case("latest")
}

fn is_mutable_release_tag(tag: &str) -> bool {
    is_latest_channel_release_tag(tag) || is_dev_channel_release_tag(tag)
}

#[derive(Debug, Deserialize)]
struct CloudflareApiMessage {
    code: Option<i64>,
    message: String,
}

#[derive(Debug, Deserialize)]
struct CloudflareApiResponse<T> {
    success: bool,
    result: T,
    errors: Option<Vec<CloudflareApiMessage>>,
    messages: Option<Vec<CloudflareApiMessage>>,
}

#[derive(Debug, Deserialize)]
struct CloudflareAccount {
    id: String,
    name: String,
}

#[derive(Debug, Clone)]
pub struct CloudflareAccountSummary {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Deserialize)]
struct WorkerManifest {
    entrypoint: String,
    #[serde(rename = "sourceMap")]
    source_map: Option<String>,
    #[serde(rename = "wranglerConfig")]
    wrangler_config: Option<String>,
}

#[derive(Debug, Deserialize)]
struct BundleManifest {
    component: String,
    worker: WorkerManifest,
    #[serde(rename = "assetsDir")]
    assets_dir: Option<String>,
}

#[derive(Debug, Default, Deserialize, Clone)]
struct WranglerConfig {
    name: String,
    compatibility_date: Option<String>,
    #[serde(default)]
    compatibility_flags: Vec<String>,
    #[serde(default)]
    migrations: Vec<Value>,
    durable_objects: Option<WranglerDurableObjectsConfig>,
    #[serde(default)]
    r2_buckets: Vec<WranglerR2BucketBinding>,
    #[serde(default)]
    services: Vec<WranglerServiceBinding>,
    #[serde(default)]
    worker_loaders: Vec<WranglerWorkerLoaderBinding>,
    ai: Option<WranglerAiBinding>,
    assets: Option<WranglerAssetsConfig>,
    observability: Option<Value>,
    limits: Option<WranglerLimits>,
}

#[derive(Debug, Default, Deserialize, Serialize, Clone)]
struct WranglerLimits {
    #[serde(skip_serializing_if = "Option::is_none")]
    cpu_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    subrequests: Option<u64>,
}

#[derive(Debug, Default, Deserialize, Clone)]
struct WranglerDurableObjectsConfig {
    #[serde(default)]
    bindings: Vec<WranglerDurableObjectBinding>,
}

#[derive(Debug, Deserialize, Clone)]
struct WranglerDurableObjectBinding {
    name: String,
    class_name: String,
    script_name: Option<String>,
    environment: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
struct WranglerR2BucketBinding {
    binding: String,
    bucket_name: Option<String>,
    jurisdiction: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
struct WranglerServiceBinding {
    binding: String,
    service: String,
    environment: Option<String>,
    entrypoint: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
struct WranglerWorkerLoaderBinding {
    binding: String,
}

#[derive(Debug, Deserialize, Clone)]
struct WranglerAiBinding {
    binding: String,
    staging: Option<bool>,
}

#[derive(Debug, Deserialize, Clone)]
struct WranglerAssetsConfig {
    directory: Option<String>,
    binding: Option<String>,
    #[serde(rename = "html_handling")]
    html_handling: Option<String>,
    #[serde(rename = "not_found_handling")]
    not_found_handling: Option<String>,
    #[serde(rename = "run_worker_first")]
    run_worker_first: Option<Value>,
}

#[derive(Debug)]
struct PreparedBundle {
    bundle_dir: PathBuf,
    component: String,
    manifest: BundleManifest,
    wrangler: WranglerConfig,
    script_name: String,
    entrypoint_part_name: String,
    entrypoint_bytes: Vec<u8>,
    additional_modules: Vec<WorkerModuleUpload>,
    source_map: Option<(String, Vec<u8>)>,
}

struct WorkerScriptUpload<'a> {
    script_name: &'a str,
    metadata: Value,
    entrypoint_part_name: &'a str,
    entrypoint_bytes: Vec<u8>,
    additional_modules: &'a [WorkerModuleUpload],
    source_map: Option<(String, Vec<u8>)>,
}

struct UploadMetadataOptions<'a> {
    instance: &'a DeployInstance,
    selected_components: &'a HashSet<String>,
    available_scripts: &'a HashSet<String>,
    account_subdomain: Option<&'a str>,
    existing_migration_tag: Option<&'a str>,
    include_migrations: bool,
    script_exists: bool,
    uploaded_assets: Option<&'a UploadedAssets>,
    keep_assets: bool,
}

#[derive(Debug, Clone)]
struct WorkerModuleUpload {
    part_name: String,
    bytes: Vec<u8>,
    mime_type: String,
}

#[derive(Debug, Clone)]
pub struct DeployApplyResult {
    pub gateway_url: Option<String>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
pub struct DeployLeaseManifest {
    pub schema_version: u32,
    pub instance: String,
    pub release: String,
    pub components: Vec<String>,
    pub workers: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r2_bucket: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gateway_url: Option<String>,
}

impl DeployLeaseManifest {
    pub fn new(
        instance: &DeployInstance,
        release: &str,
        components: &[String],
        gateway_url: Option<String>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        if components.is_empty() {
            return Err("Cannot create a deployment lease without components".into());
        }

        let components = normalize_components(components)?;
        let mut workers = BTreeMap::new();
        for component in &components {
            let script_name = instance
                .script_name(component)
                .ok_or_else(|| format!("Unsupported component '{}'", component))?;
            workers.insert(component.clone(), script_name);
        }
        let includes_gateway = components
            .iter()
            .any(|component| component == COMPONENT_GATEWAY);

        Ok(Self {
            schema_version: DEPLOY_LEASE_SCHEMA_VERSION,
            instance: instance.name().to_string(),
            release: release.to_string(),
            components,
            workers,
            r2_bucket: includes_gateway.then(|| instance.storage_bucket_name()),
            gateway_url: if includes_gateway { gateway_url } else { None },
        })
    }
}

pub fn write_deploy_lease_manifest(
    path: &Path,
    manifest: &DeployLeaseManifest,
) -> Result<(), Box<dyn std::error::Error>> {
    let explicit_parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty());
    if let Some(parent) = explicit_parent {
        fs::create_dir_all(parent)?;
    }
    let parent = explicit_parent.unwrap_or_else(|| Path::new("."));
    let file_name = path.file_name().ok_or_else(|| {
        format!(
            "Deployment lease path '{}' has no file name",
            path.display()
        )
    })?;
    let mut temporary_file_name = file_name.to_os_string();
    temporary_file_name.push(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let temporary_path = parent.join(temporary_file_name);
    let encoded = serde_json::to_string_pretty(manifest)?;
    let write_result = (|| -> Result<(), std::io::Error> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)?;
        file.write_all(encoded.as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        drop(file);
        replace_file_atomically(&temporary_path, path)
    })();

    if let Err(error) = write_result {
        let cleanup_result = fs::remove_file(&temporary_path);
        if let Err(cleanup_error) = cleanup_result {
            if cleanup_error.kind() != std::io::ErrorKind::NotFound {
                return Err(format!(
                    "Failed to write deployment lease {}: {}; also failed to remove temporary file {}: {}",
                    path.display(),
                    error,
                    temporary_path.display(),
                    cleanup_error
                )
                .into());
            }
        }
        return Err(format!(
            "Failed to write deployment lease {}: {}",
            path.display(),
            error
        )
        .into());
    }

    Ok(())
}

#[cfg(not(windows))]
fn replace_file_atomically(source: &Path, destination: &Path) -> Result<(), std::io::Error> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn replace_file_atomically(source: &Path, destination: &Path) -> Result<(), std::io::Error> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: both paths are NUL-terminated UTF-16 buffers that remain alive for the call.
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeployState {
    Absent,
    Partial,
    Deployed,
}

impl std::fmt::Display for DeployState {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let value = match self {
            Self::Absent => "absent",
            Self::Partial => "partial",
            Self::Deployed => "deployed",
        };
        formatter.write_str(value)
    }
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
pub struct DeployWorkerStatus {
    pub component: String,
    pub name: String,
    pub deployed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub migration_tag: Option<String>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
pub struct DeployBucketStatus {
    pub name: String,
    pub exists: bool,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
pub struct DeployStatus {
    pub schema_version: u32,
    pub instance: String,
    pub state: DeployState,
    pub workers: Vec<DeployWorkerStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r2_bucket: Option<DeployBucketStatus>,
}

fn deploy_state(
    workers: &[DeployWorkerStatus],
    r2_bucket: Option<&DeployBucketStatus>,
) -> DeployState {
    let resource_states = workers
        .iter()
        .map(|worker| worker.deployed)
        .chain(r2_bucket.into_iter().map(|bucket| bucket.exists))
        .collect::<Vec<_>>();
    if resource_states.is_empty() {
        DeployState::Absent
    } else if resource_states.iter().all(|exists| *exists) {
        DeployState::Deployed
    } else if resource_states.iter().any(|exists| *exists) {
        DeployState::Partial
    } else {
        DeployState::Absent
    }
}

#[derive(Debug, Clone, Default)]
pub struct GatewayBootstrapConfig {
    pub auth_token: Option<String>,
    pub llm_provider: Option<String>,
    pub llm_model: Option<String>,
    pub llm_api_key: Option<String>,
    pub set_whatsapp_pairing: bool,
}

#[derive(Debug, Deserialize)]
struct WorkerScriptSummary {
    id: String,
    migration_tag: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AssetsUploadSessionResponse {
    jwt: Option<String>,
    #[serde(default)]
    buckets: Vec<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct AssetsUploadBucketResponse {
    jwt: Option<String>,
}

#[derive(Debug, Clone)]
struct AssetFileUpload {
    relative_path: String,
    absolute_path: PathBuf,
    hash: String,
    size: u64,
    content_type: String,
}

#[derive(Debug, Clone)]
struct UploadedAssets {
    jwt: String,
    config: Value,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum DeleteBucketResult {
    Deleted,
    NotFound,
    NotEmpty,
}

#[derive(Debug)]
struct R2ObjectsPage {
    keys: Vec<String>,
    next_cursor: Option<String>,
}

fn component_to_bundle(component: &str) -> Option<&'static str> {
    match component {
        COMPONENT_ASSEMBLER => Some(BUNDLE_ASSEMBLER),
        COMPONENT_GATEWAY => Some(BUNDLE_GATEWAY),
        COMPONENT_RIPGIT => Some(BUNDLE_RIPGIT),
        COMPONENT_CHANNEL_WHATSAPP => Some(BUNDLE_CHANNEL_WHATSAPP),
        COMPONENT_CHANNEL_DISCORD => Some(BUNDLE_CHANNEL_DISCORD),
        COMPONENT_CHANNEL_TELEGRAM => Some(BUNDLE_CHANNEL_TELEGRAM),
        _ => None,
    }
}

pub fn available_components() -> &'static [&'static str] {
    &[
        COMPONENT_RIPGIT,
        COMPONENT_ASSEMBLER,
        COMPONENT_GATEWAY,
        COMPONENT_CHANNEL_WHATSAPP,
        COMPONENT_CHANNEL_DISCORD,
        COMPONENT_CHANNEL_TELEGRAM,
    ]
}

fn base_release_url(tag: &str) -> String {
    if is_latest_channel_release_tag(tag) {
        return format!(
            "https://github.com/{}/{}/releases/latest/download",
            REPO_OWNER, REPO_NAME
        );
    }

    format!(
        "https://github.com/{}/{}/releases/download/{}",
        REPO_OWNER, REPO_NAME, tag
    )
}

fn release_download_url(tag: &str, file_name: &str) -> String {
    let base = format!("{}/{}", base_release_url(tag), file_name);
    if !is_mutable_release_tag(tag) {
        return base;
    }

    let cache_bust = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{}?ts={}", base, cache_bust)
}

fn latest_tag_path(cfg: &CliConfig) -> PathBuf {
    cfg.gsv_home()
        .join("deploy")
        .join("bundles")
        .join("latest.txt")
}

fn bundles_root(cfg: &CliConfig) -> PathBuf {
    cfg.gsv_home().join("deploy").join("bundles")
}

pub fn normalize_components(raw: &[String]) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    if raw.is_empty() {
        return Ok(available_components()
            .iter()
            .map(|c| (*c).to_string())
            .collect());
    }

    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for component in raw {
        if component_to_bundle(component).is_none() {
            return Err(format!(
                "Unknown component '{}'. Valid components: {}",
                component,
                available_components().join(", ")
            )
            .into());
        }

        if seen.insert(component.clone()) {
            out.push(component.clone());
        }
    }

    Ok(out)
}

pub async fn resolve_release_tag(version: &str) -> Result<String, Box<dyn std::error::Error>> {
    let trimmed = version.trim();
    match trimmed.to_ascii_lowercase().as_str() {
        "latest" | "stable" => Ok("latest".to_string()),
        "dev" => Ok(DEV_RELEASE_TAG.to_string()),
        _ => Ok(trimmed.to_string()),
    }
}

fn read_local_latest_tag(cfg: &CliConfig) -> Option<String> {
    let path = latest_tag_path(cfg);
    if !path.exists() {
        return None;
    }

    fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn parse_checksums(content: &str) -> BTreeMap<String, String> {
    let mut checksums = BTreeMap::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        let mut parts = trimmed.split_whitespace();
        let hash = match parts.next() {
            Some(v) => v,
            None => continue,
        };
        let file = match parts.next() {
            Some(v) => v,
            None => continue,
        };
        checksums.insert(file.to_string(), hash.to_lowercase());
    }
    checksums
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    format!("{:x}", digest)
}

fn write_latest_tag(cfg: &CliConfig, tag: &str) -> Result<(), Box<dyn std::error::Error>> {
    let path = latest_tag_path(cfg);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, format!("{}\n", tag))?;
    Ok(())
}

fn extract_bundle(
    bundle_bytes: &[u8],
    destination_root: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    let decoder = flate2::read::GzDecoder::new(Cursor::new(bundle_bytes));
    let mut archive = tar::Archive::new(decoder);
    archive.unpack(destination_root)?;
    Ok(())
}

fn component_staging_dir(version_root: &Path, component: &str) -> PathBuf {
    version_root.join(format!(".{}-staging-{}", component, uuid::Uuid::new_v4()))
}

fn component_backup_dir(version_root: &Path, component: &str) -> PathBuf {
    version_root.join(format!(".{}-backup-{}", component, uuid::Uuid::new_v4()))
}

#[cfg(target_os = "linux")]
fn exchange_component_dirs(
    staged_component_dir: &Path,
    component_dir: &Path,
) -> Result<bool, Box<dyn std::error::Error>> {
    use std::ffi::CString;
    use std::io;
    use std::os::unix::ffi::OsStrExt;

    fn path_to_cstring(path: &Path) -> Result<CString, io::Error> {
        CString::new(path.as_os_str().as_bytes()).map_err(|error| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("path contains a NUL byte: {} ({})", path.display(), error),
            )
        })
    }

    let staged = path_to_cstring(staged_component_dir)?;
    let current = path_to_cstring(component_dir)?;
    // SAFETY: both paths are valid NUL-terminated C strings and renameat2 does not retain them.
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            libc::AT_FDCWD,
            staged.as_ptr(),
            libc::AT_FDCWD,
            current.as_ptr(),
            libc::RENAME_EXCHANGE,
        )
    };

    if result == 0 {
        return Ok(true);
    }

    let error = io::Error::last_os_error();
    match error.raw_os_error() {
        Some(code)
            if code == libc::ENOSYS
                || code == libc::EINVAL
                || code == libc::ENOTSUP
                || code == libc::EOPNOTSUPP =>
        {
            Ok(false)
        }
        _ => Err(format!(
            "Failed to atomically swap bundle directory {} with {}: {}",
            staged_component_dir.display(),
            component_dir.display(),
            error
        )
        .into()),
    }
}

#[cfg(not(target_os = "linux"))]
fn exchange_component_dirs(
    _staged_component_dir: &Path,
    _component_dir: &Path,
) -> Result<bool, Box<dyn std::error::Error>> {
    Ok(false)
}

fn replace_component_dir(
    staged_component_dir: &Path,
    component_dir: &Path,
    backup_dir: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    if !component_dir.exists() {
        fs::rename(staged_component_dir, component_dir)?;
        return Ok(());
    }

    if exchange_component_dirs(staged_component_dir, component_dir)? {
        return Ok(());
    }

    fs::rename(component_dir, backup_dir)?;
    match fs::rename(staged_component_dir, component_dir) {
        Ok(()) => {
            if let Err(error) = fs::remove_dir_all(backup_dir) {
                eprintln!(
                    "Warning: installed replacement but failed to remove old bundle backup {}: {}",
                    backup_dir.display(),
                    error
                );
            }
            Ok(())
        }
        Err(error) => {
            match fs::rename(backup_dir, component_dir) {
                Ok(()) => Err(format!(
                    "Failed to replace bundle directory {}: {}",
                    component_dir.display(),
                    error
                )
                .into()),
                Err(restore_error) => Err(format!(
                    "Failed to replace bundle directory {}: {}; original bundle remains at {} but could not be restored: {}",
                    component_dir.display(),
                    error,
                    backup_dir.display(),
                    restore_error
                )
                .into()),
            }
        }
    }
}

fn install_extracted_component(
    bundle_bytes: &[u8],
    version_root: &Path,
    component: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let component_dir = version_root.join(component);
    let staging_dir = component_staging_dir(version_root, component);
    let backup_dir = component_backup_dir(version_root, component);
    fs::create_dir_all(&staging_dir)?;

    let result = (|| {
        extract_bundle(bundle_bytes, &staging_dir)?;
        let staged_component_dir = staging_dir.join(component);
        if !staged_component_dir.exists() {
            return Err(format!(
                "Bundle extracted but component directory missing: {}",
                staged_component_dir.display()
            )
            .into());
        }

        replace_component_dir(&staged_component_dir, &component_dir, &backup_dir)
    })();

    if staging_dir.exists() {
        if let Err(error) = fs::remove_dir_all(&staging_dir) {
            eprintln!(
                "Warning: failed to remove bundle staging directory {}: {}",
                staging_dir.display(),
                error
            );
        }
    }

    result
}

pub fn local_bundle_version_label(version: &str) -> String {
    if version == "latest" {
        "local".to_string()
    } else {
        version.to_string()
    }
}

pub fn install_bundles_from_dir(
    cfg: &CliConfig,
    bundle_dir: &Path,
    version: &str,
    components: &[String],
    force: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let version_label = local_bundle_version_label(version);
    let checksums_path = bundle_dir.join(BUNDLE_CHECKSUMS);
    let checksums = if checksums_path.exists() {
        let content = fs::read_to_string(&checksums_path)?;
        parse_checksums(&content)
    } else {
        println!(
            "Warning: {} not found in {}. Skipping checksum validation for local bundles.",
            BUNDLE_CHECKSUMS,
            bundle_dir.display()
        );
        BTreeMap::new()
    };

    let version_root = bundles_root(cfg).join(&version_label);
    fs::create_dir_all(&version_root)?;

    for component in components {
        let bundle_file = component_to_bundle(component)
            .ok_or_else(|| format!("Unsupported component '{}'", component))?;
        let bundle_path = bundle_dir.join(bundle_file);
        let component_dir = version_root.join(component);

        if !bundle_path.exists() {
            return Err(format!(
                "Local bundle '{}' not found in {}",
                bundle_file,
                bundle_dir.display()
            )
            .into());
        }

        if component_dir.exists() {
            if force {
                fs::remove_dir_all(&component_dir)?;
            } else {
                println!(
                    "Skipping {} (already exists, use --force/--force-fetch to overwrite)",
                    component
                );
                continue;
            }
        }

        let bytes = fs::read(&bundle_path)?;
        if let Some(expected) = checksums.get(bundle_file) {
            let actual = sha256_hex(&bytes);
            if actual != *expected {
                return Err(format!(
                    "Checksum mismatch for {}: expected {}, got {}",
                    bundle_file, expected, actual
                )
                .into());
            }
            println!("Checksum OK for {}", bundle_file);
        }

        println!(
            "Installing local bundle {} ({})",
            component,
            bundle_path.display()
        );
        install_extracted_component(bytes.as_ref(), &version_root, component)?;
    }

    write_latest_tag(cfg, &version_label)?;
    println!("Saved latest bundle tag: {}", version_label);
    Ok(())
}

pub async fn fetch_bundles(
    cfg: &CliConfig,
    version: &str,
    components: &[String],
    force: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let tag = resolve_release_tag(version).await?;
    let checksums_url = release_download_url(&tag, BUNDLE_CHECKSUMS);
    let client = reqwest::Client::new();
    let refresh_mutable_ref = is_mutable_release_tag(&tag);

    println!("Fetching checksums: {}", checksums_url);
    let checksums_resp = client
        .get(checksums_url)
        .header("User-Agent", "gsv-cli")
        .send()
        .await?;
    if checksums_resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(format!(
            "Cloudflare bundle metadata not found for release {} (missing {}). \
Use a newer release tag or publish a release that includes Cloudflare bundles.",
            tag, BUNDLE_CHECKSUMS
        )
        .into());
    }
    let checksums_text = checksums_resp.error_for_status()?.text().await?;
    let checksums = parse_checksums(&checksums_text);

    let version_root = bundles_root(cfg).join(&tag);
    fs::create_dir_all(&version_root)?;

    for component in components {
        let bundle_file = component_to_bundle(component)
            .ok_or_else(|| format!("Unsupported component '{}'", component))?;
        let bundle_url = release_download_url(&tag, bundle_file);
        let component_dir = version_root.join(component);

        if component_dir.exists() && !(force || refresh_mutable_ref) {
            println!(
                "Skipping {} (already exists, use --force to overwrite)",
                component
            );
            continue;
        }

        let expected = checksums.get(bundle_file).ok_or_else(|| {
            format!(
                "Missing checksum entry for '{}' in {}",
                bundle_file, BUNDLE_CHECKSUMS
            )
        })?;

        println!("Downloading {} from {}", component, bundle_url);
        let bundle_resp = client
            .get(bundle_url)
            .header("User-Agent", "gsv-cli")
            .send()
            .await?;
        if bundle_resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(format!(
                "Bundle '{}' not found on release {}. \
This release likely predates Cloudflare bundle publishing.",
                bundle_file, tag
            )
            .into());
        }
        let bytes = bundle_resp.error_for_status()?.bytes().await?;

        let actual = sha256_hex(&bytes);
        if actual != *expected {
            return Err(format!(
                "Checksum mismatch for {}: expected {}, got {}",
                bundle_file, expected, actual
            )
            .into());
        }

        println!("Checksum OK for {}", bundle_file);
        install_extracted_component(bytes.as_ref(), &version_root, component)?;
        println!("Extracted {} to {}", component, component_dir.display());
    }

    write_latest_tag(cfg, &tag)?;
    println!("Saved latest bundle tag: {}", tag);
    Ok(())
}

pub async fn inspect_bundle(
    cfg: &CliConfig,
    version: &str,
    component: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    if component_to_bundle(component).is_none() {
        return Err(format!(
            "Unknown component '{}'. Valid components: {}",
            component,
            available_components().join(", ")
        )
        .into());
    }

    let tag = if version == "latest" {
        if let Some(local_tag) = read_local_latest_tag(cfg) {
            local_tag
        } else {
            resolve_release_tag("latest").await?
        }
    } else {
        version.to_string()
    };

    let bundle_dir = bundles_root(cfg).join(&tag).join(component);
    let manifest_path = bundle_dir.join("manifest.json");
    if !manifest_path.exists() {
        return Err(format!(
            "Bundle manifest not found at {}. Run `gsv deploy bundle fetch --version {} --component {}` first.",
            manifest_path.display(),
            tag,
            component
        )
        .into());
    }

    let raw = fs::read_to_string(&manifest_path)?;
    let manifest: BundleManifest = serde_json::from_str(&raw)?;

    println!("Component: {}", manifest.component);
    println!("Version:   {}", tag);
    println!("Path:      {}", bundle_dir.display());
    println!(
        "Entrypoint: {}",
        bundle_dir.join(&manifest.worker.entrypoint).display()
    );
    if let Some(source_map) = manifest.worker.source_map {
        println!("SourceMap: {}", bundle_dir.join(source_map).display());
    }
    if let Some(wrangler_config) = manifest.worker.wrangler_config {
        println!("Wrangler:  {}", bundle_dir.join(wrangler_config).display());
    }
    if let Some(assets_dir) = manifest.assets_dir {
        println!("Assets:    {}", bundle_dir.join(assets_dir).display());
    }

    Ok(())
}

pub async fn resolve_cloudflare_account_id(
    api_token: &str,
    configured_account_id: Option<&str>,
) -> Result<String, Box<dyn std::error::Error>> {
    if let Some(account_id) = configured_account_id {
        let trimmed = account_id.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }

    let accounts = list_cloudflare_accounts(api_token).await?;
    match accounts.len() {
        0 => Err("API token has no accessible Cloudflare accounts".into()),
        1 => Ok(accounts[0].id.clone()),
        _ => {
            let mut details = String::new();
            for account in &accounts {
                if !details.is_empty() {
                    details.push_str(", ");
                }
                details.push_str(&format!("{} ({})", account.name, account.id));
            }
            Err(format!(
                "API token can access multiple accounts: {}. Rerun with --account-id <id> or set cloudflare.account_id explicitly.",
                details
            )
            .into())
        }
    }
}

pub async fn list_cloudflare_accounts(
    api_token: &str,
) -> Result<Vec<CloudflareAccountSummary>, Box<dyn std::error::Error>> {
    let client = reqwest::Client::new();
    let response = send_cloudflare_request_with_retry(
        || {
            client
                .get("https://api.cloudflare.com/client/v4/accounts")
                .header("Authorization", format!("Bearer {}", api_token))
                .header("Content-Type", "application/json")
                .send()
        },
        "List Cloudflare accounts",
    )
    .await?;
    let response: CloudflareApiResponse<Vec<CloudflareAccount>> =
        response.error_for_status()?.json().await?;

    if !response.success {
        return Err("Cloudflare API returned success=false for accounts endpoint".into());
    }

    Ok(response
        .result
        .into_iter()
        .map(|account| CloudflareAccountSummary {
            id: account.id,
            name: account.name,
        })
        .collect())
}

fn cloudflare_api_url(path: &str) -> String {
    format!("https://api.cloudflare.com/client/v4{}", path)
}

fn is_retryable_cloudflare_status(status: StatusCode) -> bool {
    status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
}

fn is_retryable_transport_error(error: &reqwest::Error) -> bool {
    error.is_timeout() || error.is_connect() || error.is_request() || error.is_body()
}

fn retry_delay_ms(attempt: usize) -> u64 {
    let exp = 2u64.saturating_pow((attempt.saturating_sub(1)) as u32);
    CLOUDFLARE_RETRY_BASE_MS.saturating_mul(exp).min(5_000)
}

async fn send_cloudflare_request_with_retry<F, Fut>(
    mut make_request: F,
    action: &str,
) -> Result<reqwest::Response, Box<dyn std::error::Error>>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<reqwest::Response, reqwest::Error>>,
{
    for attempt in 1..=CLOUDFLARE_MAX_ATTEMPTS {
        match make_request().await {
            Ok(response) => {
                let status = response.status();
                if is_retryable_cloudflare_status(status) && attempt < CLOUDFLARE_MAX_ATTEMPTS {
                    let delay = retry_delay_ms(attempt);
                    eprintln!(
                        "Warning: {} returned {} (attempt {}/{}). Retrying in {}ms...",
                        action, status, attempt, CLOUDFLARE_MAX_ATTEMPTS, delay
                    );
                    tokio::time::sleep(Duration::from_millis(delay)).await;
                    continue;
                }
                return Ok(response);
            }
            Err(error) => {
                if is_retryable_transport_error(&error) && attempt < CLOUDFLARE_MAX_ATTEMPTS {
                    let delay = retry_delay_ms(attempt);
                    eprintln!(
                        "Warning: {} transport error on attempt {}/{}: {}. Retrying in {}ms...",
                        action, attempt, CLOUDFLARE_MAX_ATTEMPTS, error, delay
                    );
                    tokio::time::sleep(Duration::from_millis(delay)).await;
                    continue;
                }
                return Err(error.into());
            }
        }
    }

    Err(format!(
        "{} failed after {} attempts",
        action, CLOUDFLARE_MAX_ATTEMPTS
    )
    .into())
}

fn summarize_cloudflare_messages(
    errors: Option<&[CloudflareApiMessage]>,
    messages: Option<&[CloudflareApiMessage]>,
) -> String {
    let mut parts = Vec::new();
    if let Some(errors) = errors {
        for err in errors {
            if let Some(code) = err.code {
                parts.push(format!("{} ({})", err.message, code));
            } else {
                parts.push(err.message.clone());
            }
        }
    }
    if let Some(messages) = messages {
        for msg in messages {
            if let Some(code) = msg.code {
                parts.push(format!("{} ({})", msg.message, code));
            } else {
                parts.push(msg.message.clone());
            }
        }
    }
    if parts.is_empty() {
        "Unknown Cloudflare API error".to_string()
    } else {
        parts.join("; ")
    }
}

fn decode_list_from_value<T: DeserializeOwned>(
    value: Value,
    keys: &[&str],
) -> Result<Vec<T>, Box<dyn std::error::Error>> {
    if value.is_array() {
        return Ok(serde_json::from_value(value)?);
    }

    if let Some(object) = value.as_object() {
        for key in keys {
            if let Some(candidate) = object.get(*key) {
                if candidate.is_array() {
                    return Ok(serde_json::from_value(candidate.clone())?);
                }
            }
        }
    }

    Err(format!("Cloudflare API list shape is unexpected: {}", value).into())
}

async fn parse_cloudflare_response<T: DeserializeOwned>(
    response: reqwest::Response,
    context: &str,
) -> Result<T, Box<dyn std::error::Error>> {
    let status = response.status();
    let body = response.text().await?;

    if !status.is_success() {
        if let Ok(envelope) = serde_json::from_str::<CloudflareApiResponse<Value>>(&body) {
            return Err(format!(
                "{} failed ({}): {}",
                context,
                status,
                summarize_cloudflare_messages(
                    envelope.errors.as_deref(),
                    envelope.messages.as_deref(),
                )
            )
            .into());
        }

        return Err(format!("{} failed ({}): {}", context, status, body).into());
    }

    let envelope: CloudflareApiResponse<T> = serde_json::from_str(&body).map_err(|e| {
        format!(
            "{} returned an unexpected response: {} (body: {})",
            context, e, body
        )
    })?;

    if !envelope.success {
        return Err(format!(
            "{} failed: {}",
            context,
            summarize_cloudflare_messages(envelope.errors.as_deref(), envelope.messages.as_deref(),)
        )
        .into());
    }

    Ok(envelope.result)
}

async fn list_worker_scripts(
    client: &reqwest::Client,
    account_id: &str,
    api_token: &str,
) -> Result<HashMap<String, Option<String>>, Box<dyn std::error::Error>> {
    let url = cloudflare_api_url(&format!("/accounts/{}/workers/scripts", account_id));
    let response = send_cloudflare_request_with_retry(
        || {
            client
                .get(&url)
                .bearer_auth(api_token)
                .header("Content-Type", "application/json")
                .send()
        },
        "List workers scripts",
    )
    .await?;
    let result: Value = parse_cloudflare_response(response, "List workers scripts").await?;
    let scripts: Vec<WorkerScriptSummary> = decode_list_from_value(result, &["scripts", "items"])?;

    let mut out = HashMap::new();
    for script in scripts {
        out.insert(script.id, script.migration_tag);
    }
    Ok(out)
}

async fn ensure_r2_bucket_exists(
    client: &reqwest::Client,
    account_id: &str,
    api_token: &str,
    bucket_name: &str,
    jurisdiction: Option<&str>,
) -> Result<bool, Box<dyn std::error::Error>> {
    if r2_bucket_exists(client, account_id, api_token, bucket_name, jurisdiction).await? {
        return Ok(false);
    }

    let create_response = send_cloudflare_request_with_retry(
        || {
            let mut request = client
                .post(cloudflare_api_url(&format!(
                    "/accounts/{}/r2/buckets",
                    account_id
                )))
                .bearer_auth(api_token)
                .json(&json!({ "name": bucket_name }));
            if let Some(value) = jurisdiction {
                request = request.header("cf-r2-jurisdiction", value);
            }
            request.send()
        },
        &format!("Create R2 bucket {}", bucket_name),
    )
    .await?;
    let _: Value = parse_cloudflare_response(
        create_response,
        &format!("Create R2 bucket {}", bucket_name),
    )
    .await?;
    Ok(true)
}

async fn fetch_account_workers_subdomain(
    client: &reqwest::Client,
    account_id: &str,
    api_token: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    let url = cloudflare_api_url(&format!("/accounts/{}/workers/subdomain", account_id));
    let response = send_cloudflare_request_with_retry(
        || {
            client
                .get(&url)
                .bearer_auth(api_token)
                .header("Content-Type", "application/json")
                .send()
        },
        "Get workers subdomain",
    )
    .await?;
    let result: Value = parse_cloudflare_response(response, "Get workers subdomain").await?;
    let subdomain = result
        .get("subdomain")
        .and_then(Value::as_str)
        .ok_or("Cloudflare workers subdomain is missing from API response")?;
    Ok(subdomain.to_string())
}

fn workers_dev_domain(subdomain: &str) -> String {
    let trimmed = subdomain.trim().trim_end_matches('.');
    if trimmed.ends_with(".workers.dev") {
        trimmed.to_string()
    } else {
        format!("{}.workers.dev", trimmed)
    }
}

fn workers_dev_url(script_name: &str, subdomain: &str) -> String {
    format!("https://{}.{}", script_name, workers_dev_domain(subdomain))
}

async fn enable_workers_dev_for_script(
    client: &reqwest::Client,
    account_id: &str,
    api_token: &str,
    script_name: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let url = cloudflare_api_url(&format!(
        "/accounts/{}/workers/scripts/{}/subdomain",
        account_id, script_name
    ));
    let response = send_cloudflare_request_with_retry(
        || {
            client
                .post(&url)
                .bearer_auth(api_token)
                .header(
                    "Cloudflare-Workers-Script-Api-Date",
                    WORKERS_SUBDOMAIN_API_DATE,
                )
                .json(&json!({
                    "enabled": true,
                    "previews_enabled": true
                }))
                .send()
        },
        &format!("Enable workers.dev for {}", script_name),
    )
    .await?;
    let _: Value =
        parse_cloudflare_response(response, &format!("Enable workers.dev for {}", script_name))
            .await?;
    Ok(())
}

async fn upload_worker_script(
    client: &reqwest::Client,
    account_id: &str,
    api_token: &str,
    upload: WorkerScriptUpload<'_>,
) -> Result<(), Box<dyn std::error::Error>> {
    let WorkerScriptUpload {
        script_name,
        metadata,
        entrypoint_part_name,
        entrypoint_bytes,
        additional_modules,
        source_map,
    } = upload;
    let metadata_text = metadata.to_string();
    let url = cloudflare_api_url(&format!(
        "/accounts/{}/workers/scripts/{}",
        account_id, script_name
    ));
    let response = send_cloudflare_request_with_retry(
        || async {
            let metadata_part =
                multipart::Part::text(metadata_text.clone()).mime_str("application/json")?;
            let mut form = multipart::Form::new().part("metadata", metadata_part);

            let entrypoint_part = multipart::Part::bytes(entrypoint_bytes.clone())
                .file_name(entrypoint_part_name.to_string())
                .mime_str("application/javascript+module")?;
            form = form.part(entrypoint_part_name.to_string(), entrypoint_part);

            for module in additional_modules {
                let module_part = multipart::Part::bytes(module.bytes.clone())
                    .file_name(module.part_name.clone())
                    .mime_str(module.mime_type.as_str())?;
                form = form.part(module.part_name.clone(), module_part);
            }

            if let Some((source_map_name, source_map_bytes)) = &source_map {
                let source_map_part = multipart::Part::bytes(source_map_bytes.clone())
                    .file_name(source_map_name.clone())
                    .mime_str("application/source-map")?;
                form = form.part(source_map_name.clone(), source_map_part);
            }

            client
                .put(&url)
                .bearer_auth(api_token)
                .query(&[("excludeScript", "true")])
                .multipart(form)
                .send()
                .await
        },
        &format!("Upload script {}", script_name),
    )
    .await?;

    let _: Value =
        parse_cloudflare_response(response, &format!("Upload script {}", script_name)).await?;
    Ok(())
}

async fn delete_worker_script(
    client: &reqwest::Client,
    account_id: &str,
    api_token: &str,
    script_name: &str,
    force: bool,
) -> Result<bool, Box<dyn std::error::Error>> {
    let url = cloudflare_api_url(&format!(
        "/accounts/{}/workers/scripts/{}",
        account_id, script_name
    ));
    let response = send_cloudflare_request_with_retry(
        || {
            let mut request = client.delete(&url).bearer_auth(api_token);
            if force {
                request = request.query(&[("force", "true")]);
            }
            request.send()
        },
        &format!(
            "Delete worker script {}{}",
            script_name,
            if force { " (force)" } else { "" }
        ),
    )
    .await?;

    if response.status() == StatusCode::NOT_FOUND {
        return Ok(false);
    }

    let _: Value = parse_cloudflare_response(
        response,
        &format!(
            "Delete worker script {}{}",
            script_name,
            if force { " (force)" } else { "" }
        ),
    )
    .await?;
    Ok(true)
}

async fn delete_r2_bucket(
    client: &reqwest::Client,
    account_id: &str,
    api_token: &str,
    bucket_name: &str,
    jurisdiction: Option<&str>,
) -> Result<DeleteBucketResult, Box<dyn std::error::Error>> {
    let url = cloudflare_api_url(&format!(
        "/accounts/{}/r2/buckets/{}",
        account_id, bucket_name
    ));
    let response = send_cloudflare_request_with_retry(
        || {
            let mut request = client.delete(&url).bearer_auth(api_token);
            if let Some(value) = jurisdiction {
                request = request.header("cf-r2-jurisdiction", value);
            }
            request.send()
        },
        &format!("Delete R2 bucket {}", bucket_name),
    )
    .await?;

    if response.status() == StatusCode::NOT_FOUND {
        return Ok(DeleteBucketResult::NotFound);
    }

    if response.status() == StatusCode::CONFLICT {
        let body = response.text().await.unwrap_or_default();
        if body.to_ascii_lowercase().contains("not empty") {
            return Ok(DeleteBucketResult::NotEmpty);
        }
        return Err(format!(
            "Delete R2 bucket {} failed ({}): {}",
            bucket_name,
            StatusCode::CONFLICT,
            body
        )
        .into());
    }

    let _: Value =
        parse_cloudflare_response(response, &format!("Delete R2 bucket {}", bucket_name)).await?;
    Ok(DeleteBucketResult::Deleted)
}

async fn r2_bucket_exists(
    client: &reqwest::Client,
    account_id: &str,
    api_token: &str,
    bucket_name: &str,
    jurisdiction: Option<&str>,
) -> Result<bool, Box<dyn std::error::Error>> {
    let response = send_cloudflare_request_with_retry(
        || {
            let mut request = client
                .get(cloudflare_api_url(&format!(
                    "/accounts/{}/r2/buckets/{}",
                    account_id, bucket_name
                )))
                .bearer_auth(api_token);
            if let Some(value) = jurisdiction {
                request = request.header("cf-r2-jurisdiction", value);
            }
            request.send()
        },
        &format!("Get R2 bucket {}", bucket_name),
    )
    .await?;

    match response.status() {
        StatusCode::OK => {
            let _: Value =
                parse_cloudflare_response(response, &format!("Get R2 bucket {}", bucket_name))
                    .await?;
            Ok(true)
        }
        StatusCode::NOT_FOUND => Ok(false),
        _ => {
            let error = parse_cloudflare_response::<Value>(
                response,
                &format!("Get R2 bucket {}", bucket_name),
            )
            .await
            .err()
            .unwrap_or_else(|| "Unknown R2 lookup failure".into());
            Err(error)
        }
    }
}

fn extract_r2_object_keys_from_result(result: &Value) -> Vec<String> {
    let object_values: Vec<Value> = if result.is_array() {
        result.as_array().cloned().unwrap_or_default()
    } else if let Some(object) = result.as_object() {
        object
            .get("objects")
            .and_then(Value::as_array)
            .or_else(|| object.get("items").and_then(Value::as_array))
            .cloned()
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    let mut out = Vec::new();
    for value in object_values {
        if let Some(key) = value
            .as_object()
            .and_then(|obj| obj.get("key").and_then(Value::as_str))
            .or_else(|| {
                value
                    .as_object()
                    .and_then(|obj| obj.get("name").and_then(Value::as_str))
            })
        {
            if !key.is_empty() {
                out.push(key.to_string());
            }
        }
    }

    out
}

fn extract_r2_next_cursor_from_result(result: &Value) -> Option<String> {
    if let Some(object) = result.as_object() {
        if let Some(cursor) = object.get("cursor").and_then(Value::as_str) {
            if !cursor.is_empty() {
                return Some(cursor.to_string());
            }
        }
        if let Some(cursor) = object.get("next_cursor").and_then(Value::as_str) {
            if !cursor.is_empty() {
                return Some(cursor.to_string());
            }
        }
        if let Some(cursor) = object.get("continuation_token").and_then(Value::as_str) {
            if !cursor.is_empty() {
                return Some(cursor.to_string());
            }
        }

        if let Some(result_info) = object.get("result_info").and_then(Value::as_object) {
            if let Some(cursor) = result_info.get("cursor").and_then(Value::as_str) {
                if !cursor.is_empty() {
                    return Some(cursor.to_string());
                }
            }
            if let Some(cursor) = result_info.get("next_cursor").and_then(Value::as_str) {
                if !cursor.is_empty() {
                    return Some(cursor.to_string());
                }
            }
            if let Some(cursor) = result_info
                .get("cursors")
                .and_then(Value::as_object)
                .and_then(|cursors| cursors.get("after"))
                .and_then(Value::as_str)
            {
                if !cursor.is_empty() {
                    return Some(cursor.to_string());
                }
            }
        }
    }

    None
}

async fn list_r2_objects_page(
    client: &reqwest::Client,
    account_id: &str,
    api_token: &str,
    bucket_name: &str,
    jurisdiction: Option<&str>,
    cursor: Option<&str>,
) -> Result<R2ObjectsPage, Box<dyn std::error::Error>> {
    let url = cloudflare_api_url(&format!(
        "/accounts/{}/r2/buckets/{}/objects",
        account_id, bucket_name
    ));
    let response = send_cloudflare_request_with_retry(
        || {
            let mut request = client.get(&url).bearer_auth(api_token);
            if let Some(value) = jurisdiction {
                request = request.header("cf-r2-jurisdiction", value);
            }
            if let Some(cursor) = cursor {
                request = request.query(&[("cursor", cursor)]);
            }
            request.send()
        },
        &format!("List R2 objects in bucket {}", bucket_name),
    )
    .await?;

    if response.status() == StatusCode::NOT_FOUND {
        return Ok(R2ObjectsPage {
            keys: Vec::new(),
            next_cursor: None,
        });
    }

    let result: Value =
        parse_cloudflare_response(response, &format!("List R2 objects in {}", bucket_name)).await?;
    Ok(R2ObjectsPage {
        keys: extract_r2_object_keys_from_result(&result),
        next_cursor: extract_r2_next_cursor_from_result(&result),
    })
}

async fn delete_r2_object(
    client: &reqwest::Client,
    account_id: &str,
    api_token: &str,
    bucket_name: &str,
    jurisdiction: Option<&str>,
    object_key: &str,
) -> Result<bool, Box<dyn std::error::Error>> {
    let url = cloudflare_api_url(&format!(
        "/accounts/{}/r2/buckets/{}/objects/{}",
        account_id, bucket_name, object_key
    ));
    let response = send_cloudflare_request_with_retry(
        || {
            let mut request = client.delete(&url).bearer_auth(api_token);
            if let Some(value) = jurisdiction {
                request = request.header("cf-r2-jurisdiction", value);
            }
            request.send()
        },
        &format!("Delete R2 object {}", object_key),
    )
    .await?;

    if response.status() == StatusCode::NOT_FOUND {
        return Ok(false);
    }

    if response.status().is_success() {
        return Ok(true);
    }

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    Err(format!(
        "Delete R2 object {} failed ({}): {}",
        object_key, status, body
    )
    .into())
}

async fn purge_r2_bucket_objects(
    client: &reqwest::Client,
    account_id: &str,
    api_token: &str,
    bucket_name: &str,
    jurisdiction: Option<&str>,
) -> Result<usize, Box<dyn std::error::Error>> {
    let mut total_deleted = 0usize;
    let mut cursor: Option<String> = None;
    let mut seen_cursors = HashSet::new();

    loop {
        let page = list_r2_objects_page(
            client,
            account_id,
            api_token,
            bucket_name,
            jurisdiction,
            cursor.as_deref(),
        )
        .await?;

        if page.keys.is_empty() && page.next_cursor.is_none() {
            break;
        }

        for key in &page.keys {
            if delete_r2_object(
                client,
                account_id,
                api_token,
                bucket_name,
                jurisdiction,
                key,
            )
            .await?
            {
                total_deleted += 1;
            }
        }

        if let Some(next_cursor) = page.next_cursor {
            if !seen_cursors.insert(next_cursor.clone()) {
                println!(
                    "Warning: repeated cursor while purging bucket {}, stopping pagination.",
                    bucket_name
                );
                break;
            }
            cursor = Some(next_cursor);
        } else {
            break;
        }
    }

    Ok(total_deleted)
}

fn deploy_order(component: &str) -> usize {
    match component {
        COMPONENT_RIPGIT => 0,
        COMPONENT_ASSEMBLER => 1,
        COMPONENT_CHANNEL_WHATSAPP => 2,
        COMPONENT_CHANNEL_DISCORD => 3,
        COMPONENT_CHANNEL_TELEGRAM => 4,
        COMPONENT_GATEWAY => 10,
        _ => 100,
    }
}

fn teardown_order(component: &str) -> usize {
    match component {
        COMPONENT_CHANNEL_WHATSAPP => 0,
        COMPONENT_CHANNEL_DISCORD => 1,
        COMPONENT_CHANNEL_TELEGRAM => 2,
        COMPONENT_GATEWAY => 10,
        COMPONENT_ASSEMBLER => 20,
        COMPONENT_RIPGIT => 21,
        _ => 100,
    }
}

fn parse_wrangler_config(
    path: &Path,
    raw: &str,
) -> Result<WranglerConfig, Box<dyn std::error::Error>> {
    match path.extension().and_then(|value| value.to_str()) {
        Some("toml") => Ok(toml::from_str(raw)?),
        _ => Ok(json5::from_str(raw)?),
    }
}

fn worker_module_mime_type(part_name: &str) -> &'static str {
    match Path::new(part_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("js") | Some("mjs") => "application/javascript+module",
        Some("cjs") => "application/javascript",
        Some("wasm") => "application/wasm",
        Some("txt") | Some("html") | Some("sql") | Some("md") => "text/plain",
        _ => "application/octet-stream",
    }
}

fn collect_additional_worker_modules(
    bundle_dir: &Path,
    entrypoint_rel: &str,
) -> Result<Vec<WorkerModuleUpload>, Box<dyn std::error::Error>> {
    let entrypoint_path = bundle_dir.join(entrypoint_rel);
    let worker_root = entrypoint_path.parent().ok_or_else(|| {
        format!(
            "Could not resolve worker output directory from {}",
            entrypoint_path.display()
        )
    })?;
    let entrypoint_within_worker = entrypoint_path.strip_prefix(worker_root).map_err(|error| {
        format!(
            "Could not resolve worker-relative entrypoint path from {}: {}",
            entrypoint_path.display(),
            error
        )
    })?;

    let mut modules = Vec::new();
    for entry in WalkDir::new(worker_root).follow_links(false) {
        let entry = entry?;
        if !entry.file_type().is_file() {
            continue;
        }

        let absolute_path = entry.path();
        let relative_path = absolute_path.strip_prefix(worker_root).map_err(|error| {
            format!(
                "Could not resolve worker-relative module path from {}: {}",
                absolute_path.display(),
                error
            )
        })?;
        if is_skippable_bundle_file(relative_path)
            || relative_path == entrypoint_within_worker
            || relative_path
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("map"))
        {
            continue;
        }

        let part_name = normalize_relative_path(relative_path);
        modules.push(WorkerModuleUpload {
            mime_type: worker_module_mime_type(&part_name).to_string(),
            part_name,
            bytes: fs::read(absolute_path)?,
        });
    }

    modules.sort_by(|a, b| a.part_name.cmp(&b.part_name));
    Ok(modules)
}

fn load_prepared_bundle(
    cfg: &CliConfig,
    version: &str,
    component: &str,
) -> Result<PreparedBundle, Box<dyn std::error::Error>> {
    let bundle_dir = bundles_root(cfg).join(version).join(component);
    if !bundle_dir.exists() {
        return Err(format!(
            "Bundle directory not found: {}. Run `gsv deploy bundle fetch --version {} --component {}` first.",
            bundle_dir.display(),
            version,
            component
        )
        .into());
    }

    let manifest_path = bundle_dir.join("manifest.json");
    let raw_manifest = fs::read_to_string(&manifest_path)?;
    let manifest: BundleManifest = serde_json::from_str(&raw_manifest)?;
    let wrangler_path = bundle_dir.join(
        manifest
            .worker
            .wrangler_config
            .as_deref()
            .unwrap_or("wrangler.jsonc"),
    );
    let raw_wrangler = fs::read_to_string(&wrangler_path)?;
    let wrangler = parse_wrangler_config(&wrangler_path, &raw_wrangler)?;
    if wrangler.name.trim().is_empty() {
        return Err(format!(
            "Wrangler config in {} is missing worker name",
            wrangler_path.display()
        )
        .into());
    }

    let entrypoint_path = bundle_dir.join(&manifest.worker.entrypoint);
    let entrypoint_bytes = fs::read(&entrypoint_path)?;
    let entrypoint_part_name = Path::new(&manifest.worker.entrypoint)
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or_else(|| {
            format!(
                "Could not resolve entrypoint file name from {}",
                manifest.worker.entrypoint
            )
        })?
        .to_string();

    let source_map = if let Some(source_map_rel) = &manifest.worker.source_map {
        let source_map_path = bundle_dir.join(source_map_rel);
        if source_map_path.exists() {
            let source_map_part_name = Path::new(source_map_rel)
                .file_name()
                .and_then(|v| v.to_str())
                .ok_or_else(|| {
                    format!(
                        "Could not resolve source map file name from {}",
                        source_map_rel
                    )
                })?
                .to_string();
            Some((source_map_part_name, fs::read(source_map_path)?))
        } else {
            None
        }
    } else {
        None
    };
    let additional_modules =
        collect_additional_worker_modules(&bundle_dir, &manifest.worker.entrypoint)?;

    Ok(PreparedBundle {
        bundle_dir,
        component: component.to_string(),
        manifest,
        script_name: wrangler.name.clone(),
        wrangler,
        entrypoint_part_name,
        entrypoint_bytes,
        additional_modules,
        source_map,
    })
}

fn apply_instance_names_to_bundle(
    bundle: &mut PreparedBundle,
    instance: &DeployInstance,
) -> Result<(), Box<dyn std::error::Error>> {
    let script_name = instance
        .script_name(&bundle.component)
        .ok_or_else(|| format!("Unsupported component '{}'", bundle.component))?;
    bundle.wrangler.name = script_name.clone();
    bundle.script_name = script_name;

    let storage_bucket_name = instance.storage_bucket_name();
    for bucket in &mut bundle.wrangler.r2_buckets {
        if bucket.bucket_name.as_deref() == Some(DEFAULT_STORAGE_BUCKET_NAME) {
            bucket.bucket_name = Some(storage_bucket_name.clone());
        }
    }

    Ok(())
}

fn service_bindings_for_bundle(
    bundle: &PreparedBundle,
    instance: &DeployInstance,
    selected_components: &HashSet<String>,
    available_scripts: &HashSet<String>,
) -> Vec<WranglerServiceBinding> {
    let mut bindings = bundle.wrangler.services.clone();
    let gateway_script_name = instance
        .script_name(COMPONENT_GATEWAY)
        .unwrap_or_else(|| SCRIPT_GATEWAY.to_string());
    let telegram_script_name = instance
        .script_name(COMPONENT_CHANNEL_TELEGRAM)
        .unwrap_or_else(|| SCRIPT_CHANNEL_TELEGRAM.to_string());

    if bundle.component == COMPONENT_CHANNEL_WHATSAPP
        && !bindings.iter().any(|binding| binding.binding == "GATEWAY")
        && (selected_components.contains(COMPONENT_GATEWAY)
            || available_scripts.contains(&gateway_script_name))
    {
        bindings.push(WranglerServiceBinding {
            binding: "GATEWAY".to_string(),
            service: gateway_script_name.clone(),
            environment: None,
            entrypoint: Some("GatewayEntrypoint".to_string()),
        });
    }

    if bundle.component == COMPONENT_GATEWAY
        && !bindings
            .iter()
            .any(|binding| binding.binding == "CHANNEL_TELEGRAM")
        && (selected_components.contains(COMPONENT_CHANNEL_TELEGRAM)
            || available_scripts.contains(&telegram_script_name))
    {
        bindings.push(WranglerServiceBinding {
            binding: "CHANNEL_TELEGRAM".to_string(),
            service: telegram_script_name.clone(),
            environment: None,
            entrypoint: Some("TelegramChannel".to_string()),
        });
    }

    let mut filtered = Vec::new();
    for mut binding in bindings {
        if bundle.component == COMPONENT_GATEWAY
            && binding.binding == "CHANNEL_WHATSAPP"
            && binding.entrypoint.as_deref() == Some("WhatsAppChannel")
        {
            binding.entrypoint = Some("WhatsAppChannelEntrypoint".to_string());
        }

        binding.service = instance.script_name_for_config_service(&binding.service);
        let keep = available_scripts.contains(&binding.service);
        if keep {
            filtered.push(binding);
        } else {
            println!(
                "Warning: dropping service binding {} -> {} for {} because target worker is not yet available in account.",
                binding.binding, binding.service, bundle.script_name
            );
        }
    }

    filtered
}

fn migration_tag(step: &Value) -> Option<&str> {
    step.as_object()
        .and_then(|obj| obj.get("tag"))
        .and_then(Value::as_str)
}

fn migration_step_without_tag(step: &Value) -> Option<Value> {
    let mut map = step.as_object()?.clone();
    map.remove("tag");
    Some(Value::Object(map))
}

fn build_migrations_payload(
    config_migrations: &[Value],
    current_tag: Option<&str>,
) -> Option<Value> {
    if config_migrations.is_empty() {
        return None;
    }

    let new_tag = migration_tag(config_migrations.last()?)?.to_string();
    let all_steps: Vec<Value> = config_migrations
        .iter()
        .filter_map(migration_step_without_tag)
        .collect();
    if all_steps.is_empty() {
        return None;
    }

    if let Some(current_tag) = current_tag {
        if let Some(index) = config_migrations
            .iter()
            .position(|step| migration_tag(step) == Some(current_tag))
        {
            if index == config_migrations.len() - 1 {
                return None;
            }

            let incremental_steps: Vec<Value> = config_migrations
                .iter()
                .skip(index + 1)
                .filter_map(migration_step_without_tag)
                .collect();
            if incremental_steps.is_empty() {
                return None;
            }

            Some(json!({
                "old_tag": current_tag,
                "new_tag": new_tag,
                "steps": incremental_steps
            }))
        } else {
            Some(json!({
                "old_tag": current_tag,
                "new_tag": new_tag,
                "steps": all_steps
            }))
        }
    } else {
        Some(json!({
            "new_tag": new_tag,
            "steps": all_steps
        }))
    }
}

fn build_inferred_do_migration(config: &WranglerConfig) -> Option<Value> {
    let mut classes = config
        .durable_objects
        .as_ref()?
        .bindings
        .iter()
        .map(|binding| binding.class_name.clone())
        .collect::<Vec<_>>();
    if classes.is_empty() {
        return None;
    }

    classes.sort();
    classes.dedup();
    Some(json!({
        "new_tag": "auto-v1",
        "steps": [
            {
                "new_sqlite_classes": classes
            }
        ]
    }))
}

fn normalize_relative_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn is_skippable_bundle_file(path: &Path) -> bool {
    let normalized = normalize_relative_path(path);
    normalized
        .split('/')
        .any(|part| part == "__MACOSX" || part == ".DS_Store" || part.starts_with("._"))
}

fn build_asset_hash(path: &Path, bytes: &[u8]) -> String {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let base64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    let hash_input = format!("{}{}", base64, extension);
    let digest = blake3::hash(hash_input.as_bytes()).to_hex().to_string();
    digest.chars().take(32).collect()
}

fn collect_asset_files(
    assets_dir: &Path,
) -> Result<Vec<AssetFileUpload>, Box<dyn std::error::Error>> {
    if !assets_dir.exists() {
        return Err(format!("Assets directory not found: {}", assets_dir.display()).into());
    }
    if !assets_dir.is_dir() {
        return Err(format!("Assets path is not a directory: {}", assets_dir.display()).into());
    }

    let mut files = Vec::new();
    let mut skipped = 0usize;
    for entry in WalkDir::new(assets_dir).follow_links(false) {
        let entry = entry?;
        if !entry.file_type().is_file() {
            continue;
        }

        let absolute_path = entry.path().to_path_buf();
        let relative = absolute_path
            .strip_prefix(assets_dir)
            .map_err(|error| {
                format!(
                    "Failed to resolve relative asset path for {}: {}",
                    absolute_path.display(),
                    error
                )
            })?
            .to_path_buf();
        if is_skippable_bundle_file(&relative) {
            skipped += 1;
            continue;
        }
        let mut relative_path = normalize_relative_path(&relative);
        if !relative_path.starts_with('/') {
            relative_path = format!("/{}", relative_path);
        }
        let bytes = fs::read(&absolute_path)?;
        let hash = build_asset_hash(&absolute_path, &bytes);
        let size = bytes.len() as u64;
        let content_type = mime_guess::from_path(&absolute_path)
            .first_raw()
            .unwrap_or("application/null")
            .to_string();

        files.push(AssetFileUpload {
            relative_path,
            absolute_path,
            hash,
            size,
            content_type,
        });
    }

    files.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    if skipped > 0 {
        println!(
            "Note: skipped {} metadata file(s) in assets directory {}.",
            skipped,
            assets_dir.display()
        );
    }
    Ok(files)
}

fn build_assets_metadata_config(
    bundle: &PreparedBundle,
    assets_dir: &Path,
) -> Result<Value, Box<dyn std::error::Error>> {
    let mut config = serde_json::Map::new();

    if let Some(assets) = &bundle.wrangler.assets {
        if let Some(html_handling) = &assets.html_handling {
            config.insert(
                "html_handling".to_string(),
                Value::String(html_handling.clone()),
            );
        }
        if let Some(not_found_handling) = &assets.not_found_handling {
            config.insert(
                "not_found_handling".to_string(),
                Value::String(not_found_handling.clone()),
            );
        }
        if let Some(run_worker_first) = &assets.run_worker_first {
            config.insert("run_worker_first".to_string(), run_worker_first.clone());
        }
    }

    let redirects_path = assets_dir.join("_redirects");
    if redirects_path.exists() && redirects_path.is_file() {
        config.insert(
            "_redirects".to_string(),
            Value::String(fs::read_to_string(&redirects_path)?),
        );
    }

    let headers_path = assets_dir.join("_headers");
    if headers_path.exists() && headers_path.is_file() {
        config.insert(
            "_headers".to_string(),
            Value::String(fs::read_to_string(&headers_path)?),
        );
    }

    Ok(Value::Object(config))
}

async fn sync_assets_for_bundle(
    client: &reqwest::Client,
    account_id: &str,
    api_token: &str,
    bundle: &PreparedBundle,
) -> Result<Option<UploadedAssets>, Box<dyn std::error::Error>> {
    let Some(assets_dir_rel) = bundle.manifest.assets_dir.as_deref() else {
        return Ok(None);
    };

    let assets_binding = bundle
        .wrangler
        .assets
        .as_ref()
        .and_then(|assets| assets.binding.as_deref())
        .ok_or_else(|| {
            format!(
                "{} bundle includes assetsDir but wrangler assets.binding is missing",
                bundle.component
            )
        })?;

    if let Some(configured_dir) = bundle
        .wrangler
        .assets
        .as_ref()
        .and_then(|assets| assets.directory.as_deref())
    {
        let configured = configured_dir.trim();
        if !configured.is_empty() && configured != assets_dir_rel {
            println!(
                "Note: {} assets directory in wrangler is '{}', using bundled assets directory '{}'.",
                bundle.script_name,
                configured,
                assets_dir_rel
            );
        }
    }

    let assets_dir = bundle.bundle_dir.join(assets_dir_rel);
    let files = collect_asset_files(&assets_dir)?;
    println!(
        "Syncing static assets for {} ({} files, binding {}).",
        bundle.script_name,
        files.len(),
        assets_binding
    );

    let mut manifest = serde_json::Map::new();
    for file in &files {
        manifest.insert(
            file.relative_path.clone(),
            json!({
                "hash": file.hash,
                "size": file.size
            }),
        );
    }
    let session_payload = json!({
        "manifest": Value::Object(manifest)
    });

    let session_url = cloudflare_api_url(&format!(
        "/accounts/{}/workers/scripts/{}/assets-upload-session",
        account_id, bundle.script_name
    ));
    let session_response = send_cloudflare_request_with_retry(
        || {
            client
                .post(&session_url)
                .bearer_auth(api_token)
                .json(&session_payload)
                .send()
        },
        &format!("Start assets upload for {}", bundle.script_name),
    )
    .await?;
    let session: AssetsUploadSessionResponse =
        parse_cloudflare_response(session_response, "Start assets upload").await?;

    let mut completion_jwt = session.jwt.clone();
    if !session.buckets.is_empty() {
        let upload_jwt = session.jwt.as_deref().ok_or_else(|| {
            format!(
                "Assets upload session for {} did not return an upload jwt",
                bundle.script_name
            )
        })?;
        println!(
            "Uploading {} static asset bucket(s) for {}.",
            session.buckets.len(),
            bundle.script_name
        );

        let mut files_by_hash = HashMap::new();
        for file in &files {
            files_by_hash
                .entry(file.hash.clone())
                .or_insert(file.clone());
        }

        let upload_url =
            cloudflare_api_url(&format!("/accounts/{}/workers/assets/upload", account_id));
        for (bucket_index, bucket) in session.buckets.iter().enumerate() {
            let mut bucket_parts = Vec::new();
            for hash in bucket {
                let file = files_by_hash.get(hash).ok_or_else(|| {
                    format!(
                        "Cloudflare requested unknown asset hash {} for {}",
                        hash, bundle.script_name
                    )
                })?;
                let bytes = fs::read(&file.absolute_path)?;
                bucket_parts.push((
                    hash.clone(),
                    base64::engine::general_purpose::STANDARD.encode(bytes),
                    file.content_type.clone(),
                ));
            }

            let action = format!(
                "Upload assets bucket {}/{} for {}",
                bucket_index + 1,
                session.buckets.len(),
                bundle.script_name
            );
            let response = send_cloudflare_request_with_retry(
                || async {
                    let mut form = multipart::Form::new();
                    for (hash, encoded, content_type) in &bucket_parts {
                        let part = multipart::Part::text(encoded.clone())
                            .file_name(hash.clone())
                            .mime_str(content_type)?;
                        form = form.part(hash.clone(), part);
                    }

                    client
                        .post(&upload_url)
                        .bearer_auth(upload_jwt)
                        .query(&[("base64", "true")])
                        .multipart(form)
                        .send()
                        .await
                },
                &action,
            )
            .await?;
            let upload_result: AssetsUploadBucketResponse =
                parse_cloudflare_response(response, &action).await?;
            if let Some(jwt) = upload_result.jwt {
                completion_jwt = Some(jwt);
            }
        }
    }

    let jwt = completion_jwt.ok_or_else(|| {
        format!(
            "Assets upload for {} did not return a completion jwt",
            bundle.script_name
        )
    })?;
    let config = build_assets_metadata_config(bundle, &assets_dir)?;

    Ok(Some(UploadedAssets { jwt, config }))
}

fn build_upload_metadata(
    bundle: &PreparedBundle,
    options: UploadMetadataOptions<'_>,
) -> Result<Value, Box<dyn std::error::Error>> {
    let compatibility_date = bundle
        .wrangler
        .compatibility_date
        .as_deref()
        .ok_or_else(|| format!("{} is missing compatibility_date", bundle.script_name))?;

    let mut metadata_bindings = Vec::new();

    if let Some(durable_objects) = &bundle.wrangler.durable_objects {
        for binding in &durable_objects.bindings {
            let mut value = json!({
                "name": binding.name,
                "type": "durable_object_namespace",
                "class_name": binding.class_name
            });
            if let Some(script_name) = &binding.script_name {
                value["script_name"] = Value::String(script_name.clone());
            }
            if let Some(environment) = &binding.environment {
                value["environment"] = Value::String(environment.clone());
            }
            metadata_bindings.push(value);
        }
    }

    for r2 in &bundle.wrangler.r2_buckets {
        let bucket_name = r2.bucket_name.as_deref().ok_or_else(|| {
            format!(
                "{} has r2 binding '{}' without bucket_name",
                bundle.script_name, r2.binding
            )
        })?;
        let mut value = json!({
            "name": r2.binding,
            "type": "r2_bucket",
            "bucket_name": bucket_name
        });
        if let Some(jurisdiction) = &r2.jurisdiction {
            value["jurisdiction"] = Value::String(jurisdiction.clone());
        }
        metadata_bindings.push(value);
    }

    for service in service_bindings_for_bundle(
        bundle,
        options.instance,
        options.selected_components,
        options.available_scripts,
    ) {
        let mut value = json!({
            "name": service.binding,
            "type": "service",
            "service": service.service
        });
        if let Some(environment) = service.environment {
            value["environment"] = Value::String(environment);
        }
        if let Some(entrypoint) = service.entrypoint {
            value["entrypoint"] = Value::String(entrypoint);
        }
        metadata_bindings.push(value);
    }

    for loader in &bundle.wrangler.worker_loaders {
        metadata_bindings.push(json!({
            "name": loader.binding,
            "type": "worker_loader"
        }));
    }

    if let Some(ai) = &bundle.wrangler.ai {
        let mut value = json!({
            "name": ai.binding,
            "type": "ai"
        });
        if let Some(staging) = ai.staging {
            value["staging"] = json!(staging);
        }
        metadata_bindings.push(value);
    }

    if bundle.component == COMPONENT_CHANNEL_TELEGRAM {
        if let Some(subdomain) = options.account_subdomain {
            metadata_bindings.push(json!({
                "name": "TELEGRAM_WEBHOOK_BASE_URL",
                "type": "plain_text",
                "text": workers_dev_url(&bundle.script_name, subdomain)
            }));
        }
    }

    if let Some(assets) = &bundle.wrangler.assets {
        if let Some(binding) = &assets.binding {
            metadata_bindings.push(json!({
                "name": binding,
                "type": "assets"
            }));
        }
    }

    let mut metadata = json!({
        "main_module": bundle.entrypoint_part_name,
        "bindings": metadata_bindings,
        "compatibility_date": compatibility_date
    });

    if !bundle.wrangler.compatibility_flags.is_empty() {
        metadata["compatibility_flags"] = json!(bundle.wrangler.compatibility_flags);
    }

    if options.include_migrations {
        if let Some(migrations) =
            build_migrations_payload(&bundle.wrangler.migrations, options.existing_migration_tag)
        {
            metadata["migrations"] = migrations;
        } else if !options.script_exists {
            if let Some(migrations) = build_inferred_do_migration(&bundle.wrangler) {
                println!(
                    "Warning: {} has Durable Objects but no explicit migrations; using inferred migration tag auto-v1.",
                    bundle.script_name
                );
                metadata["migrations"] = migrations;
            }
        }
    }

    if let Some(observability) = &bundle.wrangler.observability {
        metadata["observability"] = observability.clone();
    }

    if let Some(limits) = &bundle.wrangler.limits {
        metadata["limits"] = serde_json::to_value(limits)?;
    }

    if let Some(uploaded_assets) = options.uploaded_assets {
        metadata["assets"] = json!({
            "jwt": uploaded_assets.jwt,
            "config": uploaded_assets.config
        });
    }

    if options.keep_assets {
        metadata["keep_assets"] = json!(true);
    }

    Ok(metadata)
}

pub async fn apply_deploy(
    cfg: &CliConfig,
    account_id: &str,
    api_token: &str,
    version: &str,
    components: &[String],
    instance: &DeployInstance,
) -> Result<DeployApplyResult, Box<dyn std::error::Error>> {
    if components.is_empty() {
        return Err("No components requested for deployment".into());
    }

    let mut prepared = components
        .iter()
        .map(|component| load_prepared_bundle(cfg, version, component))
        .collect::<Result<Vec<_>, _>>()?;
    for bundle in &mut prepared {
        apply_instance_names_to_bundle(bundle, instance)?;
    }
    prepared.sort_by_key(|bundle| deploy_order(&bundle.component));

    let selected_components: HashSet<String> = components.iter().cloned().collect();
    let ripgit_script_name = instance
        .script_name(COMPONENT_RIPGIT)
        .ok_or("Unsupported ripgit component")?;
    let assembler_script_name = instance
        .script_name(COMPONENT_ASSEMBLER)
        .ok_or("Unsupported assembler component")?;

    let client = reqwest::Client::new();
    let existing_scripts_with_migrations =
        list_worker_scripts(&client, account_id, api_token).await?;
    let existing_scripts: HashSet<String> =
        existing_scripts_with_migrations.keys().cloned().collect();
    let ripgit_available = selected_components.contains(COMPONENT_RIPGIT)
        || existing_scripts.contains(&ripgit_script_name);
    let assembler_available = selected_components.contains(COMPONENT_ASSEMBLER)
        || existing_scripts.contains(&assembler_script_name);
    if selected_components.contains(COMPONENT_GATEWAY) && !ripgit_available {
        return Err(
            "Deploying `gateway` requires the `ripgit` worker. Include `--component ripgit` or deploy ripgit first."
                .into(),
        );
    }
    if selected_components.contains(COMPONENT_GATEWAY) && !assembler_available {
        return Err(
            "Deploying `gateway` requires the `assembler` worker. Include `--component assembler` or deploy assembler first."
                .into(),
        );
    }
    let mut available_scripts = existing_scripts.clone();

    let mut required_buckets = HashSet::new();

    for bundle in &prepared {
        for bucket in &bundle.wrangler.r2_buckets {
            if let Some(bucket_name) = &bucket.bucket_name {
                required_buckets.insert((bucket_name.clone(), bucket.jurisdiction.clone()));
            }
        }
    }

    if !required_buckets.is_empty() {
        println!("\nEnsuring R2 buckets:");
        let mut sorted_buckets: Vec<(String, Option<String>)> =
            required_buckets.into_iter().collect();
        sorted_buckets.sort_by(|a, b| a.0.cmp(&b.0));
        for (bucket_name, jurisdiction) in sorted_buckets {
            let created = ensure_r2_bucket_exists(
                &client,
                account_id,
                api_token,
                &bucket_name,
                jurisdiction.as_deref(),
            )
            .await?;
            if created {
                println!("Created R2 bucket {}", bucket_name);
            } else {
                println!("R2 bucket {} already exists", bucket_name);
            }
        }
    }

    let account_subdomain =
        match fetch_account_workers_subdomain(&client, account_id, api_token).await {
            Ok(subdomain) => Some(subdomain),
            Err(error) => {
                println!(
                    "Warning: could not fetch workers.dev subdomain ({}). Deploy will continue.",
                    error
                );
                None
            }
        };
    if selected_components.contains(COMPONENT_CHANNEL_TELEGRAM) && account_subdomain.is_none() {
        println!(
            "Warning: TELEGRAM_WEBHOOK_BASE_URL was not configured because the workers.dev subdomain is unavailable."
        );
    }

    let mut uploaded_assets_by_script: HashMap<String, UploadedAssets> = HashMap::new();

    println!("\nDeploying workers (pass 1/2):");
    for bundle in &prepared {
        println!("Deploying {} ({})", bundle.component, bundle.script_name);

        if bundle.manifest.assets_dir.is_some() {
            if let Some(uploaded_assets) =
                sync_assets_for_bundle(&client, account_id, api_token, bundle).await?
            {
                uploaded_assets_by_script.insert(bundle.script_name.clone(), uploaded_assets);
            }
        }

        let metadata = build_upload_metadata(
            bundle,
            UploadMetadataOptions {
                instance,
                selected_components: &selected_components,
                available_scripts: &available_scripts,
                account_subdomain: account_subdomain.as_deref(),
                existing_migration_tag: existing_scripts_with_migrations
                    .get(&bundle.script_name)
                    .and_then(|tag| tag.as_deref()),
                include_migrations: true,
                script_exists: existing_scripts_with_migrations.contains_key(&bundle.script_name),
                uploaded_assets: uploaded_assets_by_script.get(&bundle.script_name),
                keep_assets: false,
            },
        )?;
        let source_map_for_upload = bundle.source_map.as_ref().and_then(|(name, bytes)| {
            if bytes.len() <= MAX_SOURCE_MAP_UPLOAD_BYTES {
                Some((name.clone(), bytes.clone()))
            } else {
                println!(
                    "Warning: skipping large source map {} ({} bytes) for {} upload.",
                    name,
                    bytes.len(),
                    bundle.script_name
                );
                None
            }
        });

        upload_worker_script(
            &client,
            account_id,
            api_token,
            WorkerScriptUpload {
                script_name: &bundle.script_name,
                metadata,
                entrypoint_part_name: &bundle.entrypoint_part_name,
                entrypoint_bytes: bundle.entrypoint_bytes.clone(),
                additional_modules: &bundle.additional_modules,
                source_map: source_map_for_upload,
            },
        )
        .await?;
        println!("Uploaded {}", bundle.script_name);
        available_scripts.insert(bundle.script_name.clone());

        match enable_workers_dev_for_script(&client, account_id, api_token, &bundle.script_name)
            .await
        {
            Ok(()) => {
                if let Some(subdomain) = account_subdomain.as_deref() {
                    let workers_domain = workers_dev_domain(subdomain);
                    println!(
                        "workers.dev URL: https://{}.{}",
                        bundle.script_name, workers_domain
                    );
                    if bundle.component == COMPONENT_CHANNEL_TELEGRAM {
                        println!(
                            "Configured TELEGRAM_WEBHOOK_BASE_URL: {}",
                            workers_dev_url(&bundle.script_name, subdomain)
                        );
                    }
                } else {
                    println!("workers.dev enabled for {}", bundle.script_name);
                }
            }
            Err(error) => {
                println!(
                    "Warning: failed to enable workers.dev for {}: {}",
                    bundle.script_name, error
                );
            }
        }
    }

    println!("\nFinalizing service bindings (pass 2/2):");
    for bundle in &prepared {
        println!("Finalizing {} ({})", bundle.component, bundle.script_name);
        let metadata = build_upload_metadata(
            bundle,
            UploadMetadataOptions {
                instance,
                selected_components: &selected_components,
                available_scripts: &available_scripts,
                account_subdomain: account_subdomain.as_deref(),
                existing_migration_tag: None,
                include_migrations: false,
                script_exists: true,
                uploaded_assets: None,
                keep_assets: bundle.manifest.assets_dir.is_some(),
            },
        )?;
        let source_map_for_upload = bundle.source_map.as_ref().and_then(|(name, bytes)| {
            if bytes.len() <= MAX_SOURCE_MAP_UPLOAD_BYTES {
                Some((name.clone(), bytes.clone()))
            } else {
                None
            }
        });

        upload_worker_script(
            &client,
            account_id,
            api_token,
            WorkerScriptUpload {
                script_name: &bundle.script_name,
                metadata,
                entrypoint_part_name: &bundle.entrypoint_part_name,
                entrypoint_bytes: bundle.entrypoint_bytes.clone(),
                additional_modules: &bundle.additional_modules,
                source_map: source_map_for_upload,
            },
        )
        .await?;
        println!("Updated bindings for {}", bundle.script_name);
    }

    let gateway_script_name = prepared
        .iter()
        .find(|bundle| bundle.component == COMPONENT_GATEWAY)
        .map(|bundle| bundle.script_name.clone());

    let gateway_url = if selected_components.contains(COMPONENT_GATEWAY) {
        match (gateway_script_name.as_deref(), account_subdomain.as_deref()) {
            (Some(script_name), Some(subdomain)) => Some(workers_dev_url(script_name, subdomain)),
            _ => None,
        }
    } else {
        None
    };

    println!("\nDeploy complete.");
    Ok(DeployApplyResult { gateway_url })
}

pub async fn destroy_deploy(
    account_id: &str,
    api_token: &str,
    components: &[String],
    delete_bucket_resource: bool,
    purge_bucket_resource: bool,
    verify_destroyed_resources: bool,
    instance: &DeployInstance,
) -> Result<(), Box<dyn std::error::Error>> {
    if components.is_empty() {
        return Err("No components requested for teardown".into());
    }

    let mut component_order = components.to_vec();
    component_order.sort_by_key(|component| teardown_order(component));

    let mut scripts_to_delete = Vec::new();
    for component in &component_order {
        let script_name = instance
            .script_name(component)
            .ok_or_else(|| format!("Unsupported component '{}'", component))?;
        scripts_to_delete.push((component.clone(), script_name));
    }

    let selected_components: HashSet<String> = components.iter().cloned().collect();
    let client = reqwest::Client::new();
    let storage_bucket_name = instance.storage_bucket_name();

    println!("\nDeleting workers:");
    for (component, script_name) in scripts_to_delete {
        let deleted =
            delete_worker_script(&client, account_id, api_token, &script_name, true).await?;
        if deleted {
            println!("Deleted {} ({})", component, script_name);
        } else {
            println!("Skipped {} ({} not found)", component, script_name);
        }
    }

    if delete_bucket_resource {
        let bucket_exists =
            r2_bucket_exists(&client, account_id, api_token, &storage_bucket_name, None).await?;
        if bucket_exists && purge_bucket_resource {
            println!(
                "Purging objects from R2 bucket {} before deletion...",
                storage_bucket_name
            );
            let deleted_objects =
                purge_r2_bucket_objects(&client, account_id, api_token, &storage_bucket_name, None)
                    .await?;
            if deleted_objects > 0 {
                println!(
                    "Purged {} object(s) from R2 bucket {}",
                    deleted_objects, storage_bucket_name
                );
            } else {
                println!("R2 bucket {} is already empty", storage_bucket_name);
            }
        }

        if bucket_exists {
            let delete_result =
                delete_r2_bucket(&client, account_id, api_token, &storage_bucket_name, None)
                    .await?;
            match delete_result {
                DeleteBucketResult::Deleted => {
                    println!("Deleted R2 bucket {}", storage_bucket_name);
                }
                DeleteBucketResult::NotFound => {
                    println!("R2 bucket {} was already absent", storage_bucket_name);
                }
                DeleteBucketResult::NotEmpty => {
                    println!(
                        "R2 bucket {} was not deleted because it is not empty.",
                        storage_bucket_name
                    );
                    if purge_bucket_resource {
                        println!(
                            "Warning: bucket still reported non-empty after purge. Retry shortly; R2 can be eventually consistent."
                        );
                    } else {
                        println!(
                            "Tip: rerun with `--purge-bucket` to delete objects automatically before removing the bucket."
                        );
                    }
                }
            }
        } else {
            println!("R2 bucket {} was already absent", storage_bucket_name);
        }
    } else if selected_components.contains(COMPONENT_GATEWAY) {
        println!(
            "R2 bucket {} retained (use --delete-bucket to remove)",
            storage_bucket_name
        );
    }

    if verify_destroyed_resources {
        println!("\nVerifying teardown...");
        verify_deploy_destroyed(
            &client,
            account_id,
            api_token,
            components,
            delete_bucket_resource,
            purge_bucket_resource,
            instance,
        )
        .await?;
        println!("Verified selected infrastructure is absent.");
    }

    println!("\nTeardown complete.");
    Ok(())
}

async fn verify_deploy_destroyed(
    client: &reqwest::Client,
    account_id: &str,
    api_token: &str,
    components: &[String],
    verify_bucket_absent: bool,
    purge_bucket_resource: bool,
    instance: &DeployInstance,
) -> Result<(), Box<dyn std::error::Error>> {
    let storage_bucket_name = instance.storage_bucket_name();
    let mut remaining_workers = Vec::new();
    let mut bucket_exists = false;

    for attempt in 1..=CLOUDFLARE_MAX_ATTEMPTS {
        remaining_workers = get_deploy_worker_statuses_with_client(
            client, account_id, api_token, components, instance,
        )
        .await?
        .into_iter()
        .filter(|worker| worker.deployed)
        .map(|worker| format!("{} ({})", worker.component, worker.name))
        .collect();

        bucket_exists = if verify_bucket_absent {
            r2_bucket_exists(client, account_id, api_token, &storage_bucket_name, None).await?
        } else {
            false
        };

        if bucket_exists {
            if purge_bucket_resource {
                let deleted_objects = purge_r2_bucket_objects(
                    client,
                    account_id,
                    api_token,
                    &storage_bucket_name,
                    None,
                )
                .await?;
                if deleted_objects > 0 {
                    println!(
                        "Purged {} additional object(s) from R2 bucket {} during verification",
                        deleted_objects, storage_bucket_name
                    );
                }
            }

            let _ =
                delete_r2_bucket(client, account_id, api_token, &storage_bucket_name, None).await?;
            bucket_exists =
                r2_bucket_exists(client, account_id, api_token, &storage_bucket_name, None).await?;
        }

        if remaining_workers.is_empty() && !bucket_exists {
            return Ok(());
        }

        if attempt < CLOUDFLARE_MAX_ATTEMPTS {
            let delay = retry_delay_ms(attempt);
            eprintln!(
                "Warning: teardown residue remains (attempt {}/{}). Retrying in {}ms...",
                attempt, CLOUDFLARE_MAX_ATTEMPTS, delay
            );
            sleep(Duration::from_millis(delay)).await;
        }
    }

    let mut residue = Vec::new();
    if !remaining_workers.is_empty() {
        residue.push(format!("Workers: {}", remaining_workers.join(", ")));
    }
    if bucket_exists {
        residue.push(format!("R2 bucket: {}", storage_bucket_name));
    }

    Err(format!(
        "Teardown verification failed after {} attempts; remaining resources: {}",
        CLOUDFLARE_MAX_ATTEMPTS,
        residue.join("; ")
    )
    .into())
}

pub async fn get_deploy_status(
    account_id: &str,
    api_token: &str,
    components: &[String],
    instance: &DeployInstance,
) -> Result<DeployStatus, Box<dyn std::error::Error>> {
    let client = reqwest::Client::new();
    get_deploy_status_with_client(&client, account_id, api_token, components, instance).await
}

async fn get_deploy_status_with_client(
    client: &reqwest::Client,
    account_id: &str,
    api_token: &str,
    components: &[String],
    instance: &DeployInstance,
) -> Result<DeployStatus, Box<dyn std::error::Error>> {
    if components.is_empty() {
        return Err("No components requested for status".into());
    }

    let workers =
        get_deploy_worker_statuses_with_client(client, account_id, api_token, components, instance)
            .await?;
    let r2_bucket = if components
        .iter()
        .any(|component| component == COMPONENT_GATEWAY)
    {
        let storage_bucket_name = instance.storage_bucket_name();
        let exists =
            r2_bucket_exists(client, account_id, api_token, &storage_bucket_name, None).await?;
        Some(DeployBucketStatus {
            name: storage_bucket_name,
            exists,
        })
    } else {
        None
    };

    let state = deploy_state(&workers, r2_bucket.as_ref());

    Ok(DeployStatus {
        schema_version: DEPLOY_STATUS_SCHEMA_VERSION,
        instance: instance.name().to_string(),
        state,
        workers,
        r2_bucket,
    })
}

async fn get_deploy_worker_statuses_with_client(
    client: &reqwest::Client,
    account_id: &str,
    api_token: &str,
    components: &[String],
    instance: &DeployInstance,
) -> Result<Vec<DeployWorkerStatus>, Box<dyn std::error::Error>> {
    if components.is_empty() {
        return Err("No components requested for status".into());
    }

    let mut component_order = components.to_vec();
    component_order.sort_by_key(|component| deploy_order(component));

    let scripts = list_worker_scripts(client, account_id, api_token).await?;
    let configured_gateway_script_name = instance
        .script_name(COMPONENT_GATEWAY)
        .ok_or("Unsupported gateway component")?;
    let gateway_script_name = if instance.is_default()
        && !scripts.contains_key(&configured_gateway_script_name)
        && scripts.contains_key("gateway")
    {
        "gateway".to_string()
    } else {
        configured_gateway_script_name
    };

    let mut workers = Vec::with_capacity(component_order.len());
    for component in &component_order {
        let script_name = if component == COMPONENT_GATEWAY {
            gateway_script_name.clone()
        } else {
            instance
                .script_name(component)
                .ok_or_else(|| format!("Unsupported component '{}'", component))?
        };

        let migration_tag = scripts.get(&script_name).cloned().flatten();
        workers.push(DeployWorkerStatus {
            component: component.clone(),
            name: script_name.clone(),
            deployed: scripts.contains_key(&script_name),
            migration_tag,
        });
    }

    Ok(workers)
}

pub fn print_deploy_status(status: &DeployStatus) {
    println!("\nWorkers:");
    for worker in &status.workers {
        if worker.deployed {
            if let Some(tag) = worker.migration_tag.as_deref() {
                println!(
                    "  {:<18} {:<24} deployed (migration: {})",
                    worker.component, worker.name, tag
                );
            } else {
                println!("  {:<18} {:<24} deployed", worker.component, worker.name);
            }
        } else {
            println!("  {:<18} {:<24} missing", worker.component, worker.name);
        }
    }

    if let Some(bucket) = &status.r2_bucket {
        println!("\nShared infrastructure:");
        println!(
            "  r2 bucket {:<26} {}",
            bucket.name,
            if bucket.exists { "exists" } else { "missing" }
        );
    }

    println!("\nState: {}", status.state);
}

fn gateway_http_url_to_ws_url(gateway_url: &str) -> String {
    let mut ws_url = if let Some(rest) = gateway_url.strip_prefix("https://") {
        format!("wss://{}", rest)
    } else if let Some(rest) = gateway_url.strip_prefix("http://") {
        format!("ws://{}", rest)
    } else {
        gateway_url.to_string()
    };

    if !ws_url.ends_with("/ws") {
        ws_url = ws_url.trim_end_matches('/').to_string();
        ws_url.push_str("/ws");
    }

    ws_url
}

async fn connect_gateway_with_retry(
    ws_url: &str,
    auth_token: Option<&str>,
) -> Result<Connection, Box<dyn std::error::Error>> {
    let max_attempts = 8usize;
    let delay = Duration::from_secs(5);
    let mut last_error: Option<Box<dyn std::error::Error>> = None;

    for attempt in 1..=max_attempts {
        match Connection::connect(
            crate::connection::ConnectOptions {
                url: ws_url.to_string(),
                role: "user".to_string(),
                client_id: Some("deploy-bootstrap".to_string()),
                implements: None,
                auth_username: None,
                auth_password: None,
                auth_token: auth_token.map(|t| t.to_string()),
            },
            |_| {},
        )
        .await
        {
            Ok(conn) => return Ok(conn),
            Err(error) => {
                let error_message = error.to_string();
                last_error = Some(error);
                if attempt < max_attempts {
                    println!(
                        "Warning: failed to connect to gateway config endpoint (attempt {}/{}): {}. Retrying in {}s...",
                        attempt,
                        max_attempts,
                        error_message,
                        delay.as_secs()
                    );
                    sleep(delay).await;
                }
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "Failed to connect to gateway config endpoint".into()))
}

async fn gateway_config_set(
    conn: &Connection,
    key: &str,
    value: Value,
) -> Result<(), Box<dyn std::error::Error>> {
    let response = conn
        .request(
            "sys.config.set",
            Some(json!({
                "key": key,
                "value": if let Some(text) = value.as_str() {
                    text.to_string()
                } else {
                    value.to_string()
                }
            })),
        )
        .await?;

    if response.ok {
        Ok(())
    } else {
        let message = response
            .error
            .map(|err| err.message)
            .unwrap_or_else(|| "Unknown sys.config.set failure".to_string());
        Err(format!("sys.config.set {} failed: {}", key, message).into())
    }
}

pub async fn bootstrap_gateway_config(
    gateway_url: &str,
    connect_auth_token: Option<&str>,
    config: &GatewayBootstrapConfig,
) -> Result<(), Box<dyn std::error::Error>> {
    if config.auth_token.is_none()
        && config.llm_provider.is_none()
        && config.llm_model.is_none()
        && config.llm_api_key.is_none()
        && !config.set_whatsapp_pairing
    {
        return Ok(());
    }

    let ws_url = gateway_http_url_to_ws_url(gateway_url);
    let conn = connect_gateway_with_retry(&ws_url, connect_auth_token).await?;

    if let Some(auth_token) = config.auth_token.as_deref() {
        gateway_config_set(&conn, "auth.token", json!(auth_token)).await?;
        println!("Configured gateway auth token.");
    }

    if let Some(provider) = config.llm_provider.as_deref() {
        gateway_config_set(&conn, "model.provider", json!(provider)).await?;
        println!("Configured LLM provider: {}", provider);
    }

    if let Some(model) = config.llm_model.as_deref() {
        gateway_config_set(&conn, "model.id", json!(model)).await?;
        println!("Configured LLM model: {}", model);
    }

    if let Some(api_key) = config.llm_api_key.as_deref() {
        let provider = config
            .llm_provider
            .as_deref()
            .ok_or("LLM provider is required when setting llm_api_key")?;
        gateway_config_set(&conn, &format!("apiKeys.{}", provider), json!(api_key)).await?;
        println!("Configured API key for provider: {}", provider);
    }

    if config.set_whatsapp_pairing {
        gateway_config_set(&conn, "channels.whatsapp.dmPolicy", json!("pairing")).await?;
        println!("Configured WhatsApp DM policy: pairing");
    }

    Ok(())
}

async fn set_worker_secret(
    client: &reqwest::Client,
    account_id: &str,
    api_token: &str,
    script_name: &str,
    secret_name: &str,
    secret_value: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let url = cloudflare_api_url(&format!(
        "/accounts/{}/workers/scripts/{}/secrets",
        account_id, script_name
    ));
    let response = send_cloudflare_request_with_retry(
        || {
            client
                .put(&url)
                .bearer_auth(api_token)
                .json(&json!({
                    "name": secret_name,
                    "text": secret_value,
                    "type": "secret_text"
                }))
                .send()
        },
        &format!("Set worker secret {} on {}", secret_name, script_name),
    )
    .await?;

    let _: Value = parse_cloudflare_response(
        response,
        &format!("Set worker secret {} on {}", secret_name, script_name),
    )
    .await?;
    Ok(())
}

pub async fn set_discord_bot_token_secret(
    account_id: &str,
    api_token: &str,
    bot_token: &str,
    instance: &DeployInstance,
) -> Result<(), Box<dyn std::error::Error>> {
    set_channel_bot_token_secret(
        account_id,
        api_token,
        bot_token,
        instance,
        COMPONENT_CHANNEL_DISCORD,
        "DISCORD_BOT_TOKEN",
        "Discord",
    )
    .await
}

pub async fn set_telegram_bot_token_secret(
    account_id: &str,
    api_token: &str,
    bot_token: &str,
    instance: &DeployInstance,
) -> Result<(), Box<dyn std::error::Error>> {
    set_channel_bot_token_secret(
        account_id,
        api_token,
        bot_token,
        instance,
        COMPONENT_CHANNEL_TELEGRAM,
        "TELEGRAM_BOT_TOKEN",
        "Telegram",
    )
    .await
}

async fn set_channel_bot_token_secret(
    account_id: &str,
    api_token: &str,
    bot_token: &str,
    instance: &DeployInstance,
    component: &str,
    secret_name: &str,
    label: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let client = reqwest::Client::new();
    let script_name = instance
        .script_name(component)
        .ok_or_else(|| format!("Unsupported {} channel component", label))?;
    set_worker_secret(
        &client,
        account_id,
        api_token,
        &script_name,
        secret_name,
        bot_token,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_channel_release_detection_accepts_fixed_dev_tag() {
        assert!(is_dev_channel_release_tag("dev"));
        assert!(is_dev_channel_release_tag("DEV"));
        assert!(!is_dev_channel_release_tag("v0.1.0-dev.42"));
    }

    #[tokio::test]
    async fn release_resolution_uses_direct_channel_refs() {
        assert_eq!(resolve_release_tag("latest").await.unwrap(), "latest");
        assert_eq!(resolve_release_tag("stable").await.unwrap(), "latest");
        assert_eq!(resolve_release_tag("dev").await.unwrap(), "dev");
        assert_eq!(resolve_release_tag(" v0.2.9 ").await.unwrap(), "v0.2.9");
    }

    #[test]
    fn release_download_url_uses_direct_channel_asset_urls() {
        let latest = release_download_url("latest", BUNDLE_CHECKSUMS);
        assert!(latest.starts_with(
            "https://github.com/deathbyknowledge/gsv/releases/latest/download/cloudflare-checksums.txt?ts="
        ));

        let dev = release_download_url("dev", BUNDLE_CHECKSUMS);
        assert!(dev.starts_with(
            "https://github.com/deathbyknowledge/gsv/releases/download/dev/cloudflare-checksums.txt?ts="
        ));

        assert_eq!(
            release_download_url("v0.2.9", BUNDLE_CHECKSUMS),
            "https://github.com/deathbyknowledge/gsv/releases/download/v0.2.9/cloudflare-checksums.txt"
        );
    }

    fn temp_test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gsv-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn test_bundle(component: &str, files: &[(&str, &[u8])]) -> Vec<u8> {
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        let mut builder = tar::Builder::new(encoder);

        for (path, contents) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(contents.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder
                .append_data(
                    &mut header,
                    format!("{component}/{path}"),
                    std::io::Cursor::new(*contents),
                )
                .unwrap();
        }

        builder.into_inner().unwrap().finish().unwrap()
    }

    #[test]
    fn install_extracted_component_replaces_existing_after_staged_extract() {
        let version_root = temp_test_dir("bundle-replace");
        let component_dir = version_root.join(COMPONENT_GATEWAY);
        fs::create_dir_all(&component_dir).unwrap();
        fs::write(component_dir.join("old.txt"), "old").unwrap();

        let bundle = test_bundle(COMPONENT_GATEWAY, &[("new.txt", b"new")]);

        install_extracted_component(&bundle, &version_root, COMPONENT_GATEWAY).unwrap();

        assert_eq!(
            fs::read_to_string(version_root.join(COMPONENT_GATEWAY).join("new.txt")).unwrap(),
            "new"
        );
        assert!(!version_root
            .join(COMPONENT_GATEWAY)
            .join("old.txt")
            .exists());

        let _ = fs::remove_dir_all(version_root);
    }

    #[test]
    fn install_extracted_component_preserves_existing_when_archive_is_invalid() {
        let version_root = temp_test_dir("bundle-preserve");
        let component_dir = version_root.join(COMPONENT_GATEWAY);
        fs::create_dir_all(&component_dir).unwrap();
        fs::write(component_dir.join("old.txt"), "old").unwrap();

        let bundle = test_bundle(COMPONENT_RIPGIT, &[("new.txt", b"new")]);
        let error = install_extracted_component(&bundle, &version_root, COMPONENT_GATEWAY)
            .unwrap_err()
            .to_string();

        assert!(
            error.contains("Bundle extracted but component directory missing"),
            "unexpected error: {error}"
        );
        assert_eq!(
            fs::read_to_string(version_root.join(COMPONENT_GATEWAY).join("old.txt")).unwrap(),
            "old"
        );

        let _ = fs::remove_dir_all(version_root);
    }

    #[test]
    fn normalize_components_rejects_removed_channel_test_component() {
        let error = normalize_components(&["channel-test".to_string()]).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("Unknown component 'channel-test'"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn normalize_components_accepts_ripgit() {
        let components = normalize_components(&["ripgit".to_string()]).unwrap();
        assert_eq!(components, vec!["ripgit".to_string()]);
    }

    #[test]
    fn teardown_orders_adapters_before_gateway_and_backing_workers() {
        let mut components = vec![
            COMPONENT_RIPGIT,
            COMPONENT_GATEWAY,
            COMPONENT_CHANNEL_TELEGRAM,
            COMPONENT_ASSEMBLER,
            COMPONENT_CHANNEL_WHATSAPP,
            COMPONENT_CHANNEL_DISCORD,
        ];

        components.sort_by_key(|component| teardown_order(component));

        assert_eq!(
            components,
            vec![
                COMPONENT_CHANNEL_WHATSAPP,
                COMPONENT_CHANNEL_DISCORD,
                COMPONENT_CHANNEL_TELEGRAM,
                COMPONENT_GATEWAY,
                COMPONENT_ASSEMBLER,
                COMPONENT_RIPGIT,
            ]
        );
    }

    #[test]
    fn deploy_instance_default_preserves_legacy_names() {
        let instance = DeployInstance::parse("gsv").unwrap();

        assert_eq!(instance.name(), "gsv");
        assert_eq!(
            instance.script_name(COMPONENT_GATEWAY).as_deref(),
            Some("gsv")
        );
        assert_eq!(
            instance.script_name(COMPONENT_RIPGIT).as_deref(),
            Some("ripgit")
        );
        assert_eq!(
            instance.script_name(COMPONENT_CHANNEL_WHATSAPP).as_deref(),
            Some("gsv-channel-whatsapp")
        );
        assert_eq!(instance.storage_bucket_name(), "gsv-storage");
    }

    #[test]
    fn deploy_instance_named_scopes_worker_and_bucket_names() {
        let instance = DeployInstance::parse("gsv-personal").unwrap();

        assert_eq!(
            instance.script_name(COMPONENT_GATEWAY).as_deref(),
            Some("gsv-personal")
        );
        assert_eq!(
            instance.script_name(COMPONENT_RIPGIT).as_deref(),
            Some("gsv-personal-ripgit")
        );
        assert_eq!(
            instance.script_name(COMPONENT_CHANNEL_TELEGRAM).as_deref(),
            Some("gsv-personal-channel-telegram")
        );
        assert_eq!(instance.storage_bucket_name(), "gsv-personal-storage");
    }

    #[test]
    fn deploy_instance_rejects_invalid_names() {
        for value in ["", "-gsv", "gsv-", "gsv_test", "GSV!"] {
            assert!(
                DeployInstance::parse(value).is_err(),
                "expected invalid instance name: {value}"
            );
        }
    }

    #[test]
    fn deploy_instance_rejects_component_worker_collision_names() {
        for value in [
            "ripgit",
            "team-ripgit",
            "team-assembler",
            "gsv-channel-whatsapp",
            "team-channel-discord",
            "team-channel-telegram",
        ] {
            assert!(
                DeployInstance::parse(value).is_err(),
                "expected reserved instance name: {value}"
            );
        }

        DeployInstance::parse(DEFAULT_DEPLOY_INSTANCE).unwrap();
        DeployInstance::parse("team-channel").unwrap();
    }

    #[test]
    fn deploy_instance_validates_derived_cloudflare_name_lengths() {
        let longest_worker_suffix = "-channel-whatsapp";
        let maximum_instance_length = WORKERS_DEV_SCRIPT_NAME_MAX_LEN - longest_worker_suffix.len();
        DeployInstance::parse(&"a".repeat(maximum_instance_length)).unwrap();

        let worker_error = DeployInstance::parse(&"a".repeat(maximum_instance_length + 1))
            .unwrap_err()
            .to_string();
        assert!(worker_error.contains("Worker name"));
        assert!(worker_error.contains("channel-whatsapp"));
        assert!(worker_error.contains("maximum of 63"));

        let bucket_error = DeployInstance::parse(&"a".repeat(R2_BUCKET_NAME_MAX_LEN))
            .unwrap_err()
            .to_string();
        assert!(bucket_error.contains("R2 bucket name"));
        assert!(bucket_error.contains("maximum is 63"));
    }

    #[test]
    fn deploy_lease_manifest_contains_only_resource_inventory() {
        let instance = DeployInstance::parse("gsv-e2e-42").unwrap();
        let components = vec![
            COMPONENT_RIPGIT.to_string(),
            COMPONENT_ASSEMBLER.to_string(),
            COMPONENT_GATEWAY.to_string(),
        ];
        let manifest = DeployLeaseManifest::new(
            &instance,
            "local-sha-123",
            &components,
            Some("https://gsv-e2e-42.example.workers.dev".to_string()),
        )
        .unwrap();
        let value = serde_json::to_value(&manifest).unwrap();

        assert_eq!(value["schema_version"], DEPLOY_LEASE_SCHEMA_VERSION);
        assert_eq!(value["instance"], "gsv-e2e-42");
        assert_eq!(value["release"], "local-sha-123");
        assert_eq!(value["r2_bucket"], "gsv-e2e-42-storage");
        assert_eq!(value["workers"][COMPONENT_GATEWAY], "gsv-e2e-42");
        assert_eq!(value["workers"][COMPONENT_RIPGIT], "gsv-e2e-42-ripgit");
        assert_eq!(
            value["gateway_url"],
            "https://gsv-e2e-42.example.workers.dev"
        );
        assert!(value.get("api_token").is_none());
        assert!(value.get("account_id").is_none());
    }

    #[test]
    fn deploy_lease_writer_creates_parent_and_omits_gateway_resources() {
        let root = temp_test_dir("lease-manifest");
        let path = root.join("nested").join("lease.json");
        let instance = DeployInstance::parse("gsv-e2e-43").unwrap();
        let manifest = DeployLeaseManifest::new(
            &instance,
            "v0.4.0",
            &[COMPONENT_RIPGIT.to_string()],
            Some("https://ignored.example".to_string()),
        )
        .unwrap();

        write_deploy_lease_manifest(&path, &manifest).unwrap();
        let decoded: DeployLeaseManifest =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();

        assert_eq!(decoded, manifest);
        assert!(decoded.r2_bucket.is_none());
        assert!(decoded.gateway_url.is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn deploy_lease_writer_atomically_replaces_existing_manifest() {
        let root = temp_test_dir("lease-replace");
        let path = root.join("lease.json");
        let instance = DeployInstance::parse("gsv-e2e-45").unwrap();
        let planned =
            DeployLeaseManifest::new(&instance, "sha-123", &[COMPONENT_GATEWAY.to_string()], None)
                .unwrap();
        let completed = DeployLeaseManifest::new(
            &instance,
            "sha-123",
            &[COMPONENT_GATEWAY.to_string()],
            Some("https://gsv-e2e-45.example.workers.dev".to_string()),
        )
        .unwrap();

        write_deploy_lease_manifest(&path, &planned).unwrap();
        write_deploy_lease_manifest(&path, &completed).unwrap();

        let decoded: DeployLeaseManifest =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(decoded, completed);
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn deploy_lease_writer_cleans_temporary_file_after_replace_failure() {
        let root = temp_test_dir("lease-cleanup");
        let path = root.join("lease.json");
        fs::create_dir(&path).unwrap();
        let instance = DeployInstance::parse("gsv-e2e-46").unwrap();
        let manifest =
            DeployLeaseManifest::new(&instance, "sha-456", &[COMPONENT_GATEWAY.to_string()], None)
                .unwrap();

        assert!(write_deploy_lease_manifest(&path, &manifest).is_err());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn deploy_status_state_covers_absent_partial_and_deployed_inventory() {
        let mut workers = vec![DeployWorkerStatus {
            component: COMPONENT_RIPGIT.to_string(),
            name: "gsv-e2e-ripgit".to_string(),
            deployed: false,
            migration_tag: None,
        }];
        let mut bucket = DeployBucketStatus {
            name: "gsv-e2e-storage".to_string(),
            exists: false,
        };

        assert_eq!(deploy_state(&workers, Some(&bucket)), DeployState::Absent);
        workers[0].deployed = true;
        assert_eq!(deploy_state(&workers, Some(&bucket)), DeployState::Partial);
        bucket.exists = true;
        assert_eq!(deploy_state(&workers, Some(&bucket)), DeployState::Deployed);
    }

    #[test]
    fn absent_deploy_status_serializes_as_machine_readable_success_state() {
        let status = DeployStatus {
            schema_version: DEPLOY_STATUS_SCHEMA_VERSION,
            instance: "gsv-e2e-44".to_string(),
            state: DeployState::Absent,
            workers: vec![DeployWorkerStatus {
                component: COMPONENT_GATEWAY.to_string(),
                name: "gsv-e2e-44".to_string(),
                deployed: false,
                migration_tag: None,
            }],
            r2_bucket: Some(DeployBucketStatus {
                name: "gsv-e2e-44-storage".to_string(),
                exists: false,
            }),
        };
        let value = serde_json::to_value(status).unwrap();

        assert_eq!(value["schema_version"], DEPLOY_STATUS_SCHEMA_VERSION);
        assert_eq!(value["state"], "absent");
        assert_eq!(value["workers"][0]["deployed"], false);
        assert_eq!(value["r2_bucket"]["exists"], false);
        assert!(value["workers"][0].get("migration_tag").is_none());
    }

    #[test]
    fn parse_wrangler_config_supports_toml() {
        let config = parse_wrangler_config(
            Path::new("wrangler.toml"),
            r#"
name = "ripgit"
compatibility_date = "2026-03-18"

[durable_objects]
bindings = [{ name = "REPOSITORY", class_name = "Repository" }]

[limits]
cpu_ms = 300000
"#,
        )
        .unwrap();

        assert_eq!(config.name, "ripgit");
        assert_eq!(
            config
                .durable_objects
                .as_ref()
                .map(|config| config.bindings.len()),
            Some(1)
        );
        assert_eq!(
            config.limits.and_then(|limits| limits.cpu_ms),
            Some(300_000)
        );
    }

    #[test]
    fn parse_wrangler_config_supports_worker_loaders() {
        let config = parse_wrangler_config(
            Path::new("wrangler.jsonc"),
            r#"
{
  "name": "gsv",
  "compatibility_date": "2026-01-28",
  "worker_loaders": [
    { "binding": "LOADER" }
  ]
}
"#,
        )
        .unwrap();

        assert_eq!(config.name, "gsv");
        assert_eq!(config.worker_loaders.len(), 1);
        assert_eq!(config.worker_loaders[0].binding, "LOADER");
    }

    #[test]
    fn build_upload_metadata_includes_worker_config() {
        let instance = DeployInstance::default();
        let bundle = PreparedBundle {
            bundle_dir: PathBuf::from("/tmp/gsv-test-bundle"),
            component: COMPONENT_GATEWAY.to_string(),
            manifest: BundleManifest {
                component: COMPONENT_GATEWAY.to_string(),
                worker: WorkerManifest {
                    entrypoint: "worker/index.js".to_string(),
                    source_map: None,
                    wrangler_config: None,
                },
                assets_dir: None,
            },
            wrangler: WranglerConfig {
                name: SCRIPT_GATEWAY.to_string(),
                compatibility_date: Some("2026-01-28".to_string()),
                worker_loaders: vec![WranglerWorkerLoaderBinding {
                    binding: "LOADER".to_string(),
                }],
                limits: Some(WranglerLimits {
                    cpu_ms: Some(300_000),
                    subrequests: Some(1_000),
                }),
                ..WranglerConfig::default()
            },
            script_name: SCRIPT_GATEWAY.to_string(),
            entrypoint_part_name: "worker/index.js".to_string(),
            entrypoint_bytes: Vec::new(),
            additional_modules: Vec::new(),
            source_map: None,
        };

        let metadata = build_upload_metadata(
            &bundle,
            UploadMetadataOptions {
                instance: &instance,
                selected_components: &HashSet::new(),
                available_scripts: &HashSet::new(),
                account_subdomain: None,
                existing_migration_tag: None,
                include_migrations: false,
                script_exists: false,
                uploaded_assets: None,
                keep_assets: false,
            },
        )
        .unwrap();

        let bindings = metadata["bindings"].as_array().unwrap();
        assert!(bindings
            .iter()
            .any(|binding| { binding["name"] == "LOADER" && binding["type"] == "worker_loader" }));
        assert_eq!(metadata["limits"]["cpu_ms"], 300_000);
        assert_eq!(metadata["limits"]["subrequests"], 1_000);
    }

    #[test]
    fn service_bindings_inject_telegram_gateway_binding_when_worker_available() {
        let instance = DeployInstance::default();
        let bundle = PreparedBundle {
            bundle_dir: PathBuf::from("/tmp/gsv-test-bundle"),
            component: COMPONENT_GATEWAY.to_string(),
            manifest: BundleManifest {
                component: COMPONENT_GATEWAY.to_string(),
                worker: WorkerManifest {
                    entrypoint: "worker/index.js".to_string(),
                    source_map: None,
                    wrangler_config: None,
                },
                assets_dir: None,
            },
            wrangler: WranglerConfig {
                name: SCRIPT_GATEWAY.to_string(),
                compatibility_date: Some("2026-01-28".to_string()),
                ..WranglerConfig::default()
            },
            script_name: SCRIPT_GATEWAY.to_string(),
            entrypoint_part_name: "worker/index.js".to_string(),
            entrypoint_bytes: Vec::new(),
            additional_modules: Vec::new(),
            source_map: None,
        };

        let available_scripts = HashSet::from([SCRIPT_CHANNEL_TELEGRAM.to_string()]);
        let bindings =
            service_bindings_for_bundle(&bundle, &instance, &HashSet::new(), &available_scripts);

        assert!(bindings.iter().any(|binding| {
            binding.binding == "CHANNEL_TELEGRAM"
                && binding.service == SCRIPT_CHANNEL_TELEGRAM
                && binding.entrypoint.as_deref() == Some("TelegramChannel")
        }));
    }

    #[test]
    fn service_bindings_use_instance_scoped_targets() {
        let instance = DeployInstance::parse("gsv-personal").unwrap();
        let bundle = PreparedBundle {
            bundle_dir: PathBuf::from("/tmp/gsv-test-bundle"),
            component: COMPONENT_GATEWAY.to_string(),
            manifest: BundleManifest {
                component: COMPONENT_GATEWAY.to_string(),
                worker: WorkerManifest {
                    entrypoint: "worker/index.js".to_string(),
                    source_map: None,
                    wrangler_config: None,
                },
                assets_dir: None,
            },
            wrangler: WranglerConfig {
                name: SCRIPT_GATEWAY.to_string(),
                compatibility_date: Some("2026-01-28".to_string()),
                services: vec![
                    WranglerServiceBinding {
                        binding: "RIPGIT".to_string(),
                        service: SCRIPT_RIPGIT.to_string(),
                        environment: None,
                        entrypoint: None,
                    },
                    WranglerServiceBinding {
                        binding: "ASSEMBLER".to_string(),
                        service: SCRIPT_ASSEMBLER.to_string(),
                        environment: None,
                        entrypoint: None,
                    },
                ],
                ..WranglerConfig::default()
            },
            script_name: SCRIPT_GATEWAY.to_string(),
            entrypoint_part_name: "worker/index.js".to_string(),
            entrypoint_bytes: Vec::new(),
            additional_modules: Vec::new(),
            source_map: None,
        };

        let available_scripts = HashSet::from([
            "gsv-personal-ripgit".to_string(),
            "gsv-personal-assembler".to_string(),
        ]);
        let bindings =
            service_bindings_for_bundle(&bundle, &instance, &HashSet::new(), &available_scripts);

        assert!(
            bindings
                .iter()
                .any(|binding| binding.binding == "RIPGIT"
                    && binding.service == "gsv-personal-ripgit")
        );
        assert!(bindings.iter().any(|binding| {
            binding.binding == "ASSEMBLER" && binding.service == "gsv-personal-assembler"
        }));
    }

    #[test]
    fn apply_instance_names_scopes_bundle_script_and_r2_bucket() {
        let instance = DeployInstance::parse("gsv-work").unwrap();
        let mut bundle = PreparedBundle {
            bundle_dir: PathBuf::from("/tmp/gsv-test-bundle"),
            component: COMPONENT_GATEWAY.to_string(),
            manifest: BundleManifest {
                component: COMPONENT_GATEWAY.to_string(),
                worker: WorkerManifest {
                    entrypoint: "worker/index.js".to_string(),
                    source_map: None,
                    wrangler_config: None,
                },
                assets_dir: None,
            },
            wrangler: WranglerConfig {
                name: SCRIPT_GATEWAY.to_string(),
                compatibility_date: Some("2026-01-28".to_string()),
                r2_buckets: vec![WranglerR2BucketBinding {
                    binding: "STORAGE".to_string(),
                    bucket_name: Some(DEFAULT_STORAGE_BUCKET_NAME.to_string()),
                    jurisdiction: None,
                }],
                ..WranglerConfig::default()
            },
            script_name: SCRIPT_GATEWAY.to_string(),
            entrypoint_part_name: "worker/index.js".to_string(),
            entrypoint_bytes: Vec::new(),
            additional_modules: Vec::new(),
            source_map: None,
        };

        apply_instance_names_to_bundle(&mut bundle, &instance).unwrap();

        assert_eq!(bundle.script_name, "gsv-work");
        assert_eq!(
            bundle.wrangler.r2_buckets[0].bucket_name.as_deref(),
            Some("gsv-work-storage")
        );
    }

    #[test]
    fn service_bindings_skip_telegram_gateway_binding_when_worker_missing() {
        let instance = DeployInstance::default();
        let bundle = PreparedBundle {
            bundle_dir: PathBuf::from("/tmp/gsv-test-bundle"),
            component: COMPONENT_GATEWAY.to_string(),
            manifest: BundleManifest {
                component: COMPONENT_GATEWAY.to_string(),
                worker: WorkerManifest {
                    entrypoint: "worker/index.js".to_string(),
                    source_map: None,
                    wrangler_config: None,
                },
                assets_dir: None,
            },
            wrangler: WranglerConfig {
                name: SCRIPT_GATEWAY.to_string(),
                compatibility_date: Some("2026-01-28".to_string()),
                ..WranglerConfig::default()
            },
            script_name: SCRIPT_GATEWAY.to_string(),
            entrypoint_part_name: "worker/index.js".to_string(),
            entrypoint_bytes: Vec::new(),
            additional_modules: Vec::new(),
            source_map: None,
        };

        let bindings =
            service_bindings_for_bundle(&bundle, &instance, &HashSet::new(), &HashSet::new());

        assert!(!bindings
            .iter()
            .any(|binding| binding.binding == "CHANNEL_TELEGRAM"));
    }

    #[test]
    fn build_upload_metadata_includes_telegram_webhook_url_binding() {
        let instance = DeployInstance::default();
        let bundle = PreparedBundle {
            bundle_dir: PathBuf::from("/tmp/gsv-test-bundle"),
            component: COMPONENT_CHANNEL_TELEGRAM.to_string(),
            manifest: BundleManifest {
                component: COMPONENT_CHANNEL_TELEGRAM.to_string(),
                worker: WorkerManifest {
                    entrypoint: "worker/index.js".to_string(),
                    source_map: None,
                    wrangler_config: None,
                },
                assets_dir: None,
            },
            wrangler: WranglerConfig {
                name: SCRIPT_CHANNEL_TELEGRAM.to_string(),
                compatibility_date: Some("2026-01-28".to_string()),
                ..WranglerConfig::default()
            },
            script_name: SCRIPT_CHANNEL_TELEGRAM.to_string(),
            entrypoint_part_name: "worker/index.js".to_string(),
            entrypoint_bytes: Vec::new(),
            additional_modules: Vec::new(),
            source_map: None,
        };

        let metadata = build_upload_metadata(
            &bundle,
            UploadMetadataOptions {
                instance: &instance,
                selected_components: &HashSet::new(),
                available_scripts: &HashSet::new(),
                account_subdomain: Some("example-subdomain"),
                existing_migration_tag: None,
                include_migrations: false,
                script_exists: false,
                uploaded_assets: None,
                keep_assets: false,
            },
        )
        .unwrap();

        let bindings = metadata["bindings"].as_array().unwrap();
        assert!(bindings.iter().any(|binding| {
            binding["name"] == "TELEGRAM_WEBHOOK_BASE_URL"
                && binding["type"] == "plain_text"
                && binding["text"] == "https://gsv-channel-telegram.example-subdomain.workers.dev"
        }));
    }

    #[test]
    fn collect_additional_worker_modules_includes_wasm_sidecars() {
        let temp_root =
            std::env::temp_dir().join(format!("gsv-ripgit-bundle-{}", uuid::Uuid::new_v4()));
        let worker_dir = temp_root.join("worker");
        fs::create_dir_all(&worker_dir).unwrap();
        fs::write(
            worker_dir.join("index.js"),
            r#"import wasm from "./module.wasm";"#,
        )
        .unwrap();
        fs::write(worker_dir.join("module.wasm"), b"\0asm").unwrap();
        fs::write(worker_dir.join("index.js.map"), "{}").unwrap();

        let modules = collect_additional_worker_modules(&temp_root, "worker/index.js").unwrap();

        assert_eq!(modules.len(), 1);
        assert_eq!(modules[0].part_name, "module.wasm");
        assert_eq!(modules[0].mime_type, "application/wasm");

        let _ = fs::remove_dir_all(temp_root);
    }
}
