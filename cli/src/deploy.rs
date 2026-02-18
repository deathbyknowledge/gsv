use crate::config::CliConfig;
use crate::connection::Connection;
use base64::Engine;
use reqwest::{multipart, StatusCode};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::time::sleep;
use walkdir::WalkDir;

const REPO_OWNER: &str = "deathbyknowledge";
const REPO_NAME: &str = "gsv";

const COMPONENT_GATEWAY: &str = "gateway";
const COMPONENT_CHANNEL_WHATSAPP: &str = "channel-whatsapp";
const COMPONENT_CHANNEL_DISCORD: &str = "channel-discord";
const COMPONENT_CHANNEL_TEST: &str = "channel-test";

const BUNDLE_GATEWAY: &str = "gsv-cloudflare-gateway.tar.gz";
const BUNDLE_CHANNEL_WHATSAPP: &str = "gsv-cloudflare-channel-whatsapp.tar.gz";
const BUNDLE_CHANNEL_DISCORD: &str = "gsv-cloudflare-channel-discord.tar.gz";
const BUNDLE_CHANNEL_TEST: &str = "gsv-cloudflare-channel-test.tar.gz";
const BUNDLE_CHECKSUMS: &str = "cloudflare-checksums.txt";
const DEFAULT_STORAGE_BUCKET_NAME: &str = "gsv-storage";
const SCRIPT_GATEWAY: &str = "gsv";
const SCRIPT_CHANNEL_WHATSAPP: &str = "gsv-channel-whatsapp";
const SCRIPT_CHANNEL_DISCORD: &str = "gsv-channel-discord";
const SCRIPT_CHANNEL_TEST: &str = "gsv-channel-test";
const WORKERS_SUBDOMAIN_API_DATE: &str = "2025-08-01";
const CLOUDFLARE_MAX_ATTEMPTS: usize = 5;
const CLOUDFLARE_RETRY_BASE_MS: u64 = 400;
const MAX_SOURCE_MAP_UPLOAD_BYTES: usize = 2 * 1024 * 1024;
const TEMPLATE_AGENT_ID: &str = "main";
const TEMPLATE_SENTINEL_FILE: &str = "SOUL.md";
static DEPLOY_NOTIFICATION_MODE: AtomicBool = AtomicBool::new(false);

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

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
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
    #[serde(rename = "templatesDir")]
    templates_dir: Option<String>,
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
    ai: Option<WranglerAiBinding>,
    assets: Option<WranglerAssetsConfig>,
    observability: Option<Value>,
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
    source_map: Option<(String, Vec<u8>)>,
}

#[derive(Debug, Clone)]
pub struct DeployApplyResult {
    pub gateway_url: Option<String>,
    pub gateway_existed_before_deploy: bool,
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
        COMPONENT_GATEWAY => Some(BUNDLE_GATEWAY),
        COMPONENT_CHANNEL_WHATSAPP => Some(BUNDLE_CHANNEL_WHATSAPP),
        COMPONENT_CHANNEL_DISCORD => Some(BUNDLE_CHANNEL_DISCORD),
        COMPONENT_CHANNEL_TEST => Some(BUNDLE_CHANNEL_TEST),
        _ => None,
    }
}

fn component_to_script_name(component: &str) -> Option<&'static str> {
    match component {
        COMPONENT_GATEWAY => Some(SCRIPT_GATEWAY),
        COMPONENT_CHANNEL_WHATSAPP => Some(SCRIPT_CHANNEL_WHATSAPP),
        COMPONENT_CHANNEL_DISCORD => Some(SCRIPT_CHANNEL_DISCORD),
        COMPONENT_CHANNEL_TEST => Some(SCRIPT_CHANNEL_TEST),
        _ => None,
    }
}

pub fn available_components() -> &'static [&'static str] {
    &[
        COMPONENT_GATEWAY,
        COMPONENT_CHANNEL_WHATSAPP,
        COMPONENT_CHANNEL_DISCORD,
    ]
}

fn base_release_url(tag: &str) -> String {
    format!(
        "https://github.com/{}/{}/releases/download/{}",
        REPO_OWNER, REPO_NAME, tag
    )
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
    if version != "latest" {
        return Ok(version.to_string());
    }

    let url = format!(
        "https://api.github.com/repos/{}/{}/releases/latest",
        REPO_OWNER, REPO_NAME
    );
    let client = reqwest::Client::builder().http1_only().build()?;
    let release: GitHubRelease = client
        .get(url)
        .header("User-Agent", "gsv-cli")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(release.tag_name)
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
        extract_bundle(bytes.as_ref(), &version_root)?;
        if !component_dir.exists() {
            return Err(format!(
                "Bundle extracted but component directory missing: {}",
                component_dir.display()
            )
            .into());
        }
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
    let release_url = base_release_url(&tag);
    let checksums_url = format!("{}/{}", release_url, BUNDLE_CHECKSUMS);
    let client = reqwest::Client::new();

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
        let bundle_url = format!("{}/{}", release_url, bundle_file);
        let component_dir = version_root.join(component);

        if component_dir.exists() {
            if force {
                fs::remove_dir_all(&component_dir)?;
            } else {
                println!(
                    "Skipping {} (already exists, use --force to overwrite)",
                    component
                );
                continue;
            }
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
        extract_bundle(bytes.as_ref(), &version_root)?;
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
    if let Some(templates_dir) = manifest.templates_dir {
        println!("Templates: {}", bundle_dir.join(templates_dir).display());
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
                "API token can access multiple accounts: {}. Set cloudflare.account_id explicitly.",
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
                    println!(
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
                    println!(
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
    let get_response = send_cloudflare_request_with_retry(
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
    match get_response.status() {
        StatusCode::OK => {
            let _: Value =
                parse_cloudflare_response(get_response, &format!("Get R2 bucket {}", bucket_name))
                    .await?;
            Ok(false)
        }
        StatusCode::NOT_FOUND => {
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
        _ => {
            let error = parse_cloudflare_response::<Value>(
                get_response,
                &format!("Get R2 bucket {}", bucket_name),
            )
            .await
            .err()
            .unwrap_or_else(|| "Unknown R2 lookup failure".into());
            Err(error)
        }
    }
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
    script_name: &str,
    metadata: Value,
    entrypoint_part_name: &str,
    entrypoint_bytes: Vec<u8>,
    source_map: Option<(String, Vec<u8>)>,
) -> Result<(), Box<dyn std::error::Error>> {
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

async fn r2_object_exists(
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
    let head_response = send_cloudflare_request_with_retry(
        || {
            let mut request = client.head(&url).bearer_auth(api_token);
            if let Some(value) = jurisdiction {
                request = request.header("cf-r2-jurisdiction", value);
            }
            request.send()
        },
        &format!("Check R2 object {}", object_key),
    )
    .await?;

    if head_response.status() == StatusCode::NOT_FOUND {
        return Ok(false);
    }

    if head_response.status().is_success() {
        return Ok(true);
    }

    if head_response.status() == StatusCode::METHOD_NOT_ALLOWED {
        let get_response = send_cloudflare_request_with_retry(
            || {
                let mut request = client.get(&url).bearer_auth(api_token);
                if let Some(value) = jurisdiction {
                    request = request.header("cf-r2-jurisdiction", value);
                }
                // Existence probe only; request minimal bytes where supported.
                request = request.header("Range", "bytes=0-0");
                request.send()
            },
            &format!("Check R2 object {} (GET fallback)", object_key),
        )
        .await?;

        if get_response.status() == StatusCode::NOT_FOUND {
            return Ok(false);
        }
        if get_response.status().is_success() {
            return Ok(true);
        }

        let status = get_response.status();
        let body = get_response.text().await.unwrap_or_default();
        return Err(format!(
            "Check R2 object {} failed after HEAD fallback ({}): {}",
            object_key, status, body
        )
        .into());
    }

    let status = head_response.status();
    let body = head_response.text().await.unwrap_or_default();
    Err(format!(
        "Check R2 object {} failed ({}): {}",
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
        COMPONENT_CHANNEL_WHATSAPP => 1,
        COMPONENT_CHANNEL_DISCORD => 2,
        COMPONENT_CHANNEL_TEST => 3,
        COMPONENT_GATEWAY => 10,
        _ => 100,
    }
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
    let wrangler: WranglerConfig = json5::from_str(&raw_wrangler)?;
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

    Ok(PreparedBundle {
        bundle_dir,
        component: component.to_string(),
        manifest,
        script_name: wrangler.name.clone(),
        wrangler,
        entrypoint_part_name,
        entrypoint_bytes,
        source_map,
    })
}

fn service_bindings_for_bundle(
    bundle: &PreparedBundle,
    selected_components: &HashSet<String>,
    available_scripts: &HashSet<String>,
) -> Vec<WranglerServiceBinding> {
    let mut bindings = bundle.wrangler.services.clone();

    if bundle.component == COMPONENT_CHANNEL_WHATSAPP
        && !bindings.iter().any(|binding| binding.binding == "GATEWAY")
        && (selected_components.contains(COMPONENT_GATEWAY)
            || available_scripts.contains(SCRIPT_GATEWAY))
    {
        bindings.push(WranglerServiceBinding {
            binding: "GATEWAY".to_string(),
            service: SCRIPT_GATEWAY.to_string(),
            environment: None,
            entrypoint: Some("GatewayEntrypoint".to_string()),
        });
    }

    if bundle.component == COMPONENT_GATEWAY
        && selected_components.contains(COMPONENT_CHANNEL_TEST)
        && !bindings
            .iter()
            .any(|binding| binding.binding == "CHANNEL_TEST")
    {
        bindings.push(WranglerServiceBinding {
            binding: "CHANNEL_TEST".to_string(),
            service: "gsv-channel-test".to_string(),
            environment: None,
            entrypoint: Some("TestChannel".to_string()),
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
            .map_err(|_| {
                format!(
                    "Failed to resolve relative asset path for {}",
                    absolute_path.display()
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

fn storage_bucket_for_bundle(bundle: &PreparedBundle) -> Option<(String, Option<String>)> {
    bundle
        .wrangler
        .r2_buckets
        .iter()
        .find(|binding| binding.binding == "STORAGE" && binding.bucket_name.is_some())
        .or_else(|| {
            bundle
                .wrangler
                .r2_buckets
                .iter()
                .find(|binding| binding.bucket_name.is_some())
        })
        .and_then(|binding| {
            binding
                .bucket_name
                .as_ref()
                .map(|name| (name.clone(), binding.jurisdiction.clone()))
        })
}

fn collect_files_for_r2_prefix(
    root: &Path,
    key_prefix: &str,
) -> Result<Vec<(String, PathBuf)>, Box<dyn std::error::Error>> {
    if !root.exists() || !root.is_dir() {
        return Ok(Vec::new());
    }

    let mut out = Vec::new();
    let mut skipped = 0usize;
    for entry in WalkDir::new(root).follow_links(false) {
        let entry = entry?;
        if !entry.file_type().is_file() {
            continue;
        }

        let absolute_path = entry.path().to_path_buf();
        let relative = absolute_path.strip_prefix(root).map_err(|_| {
            format!(
                "Failed to resolve template path for {}",
                absolute_path.display()
            )
        })?;
        if is_skippable_bundle_file(relative) {
            skipped += 1;
            continue;
        }
        let relative_key = normalize_relative_path(relative);
        let key = format!("{}{}", key_prefix, relative_key);
        out.push((key, absolute_path));
    }

    out.sort_by(|a, b| a.0.cmp(&b.0));
    if skipped > 0 {
        println!(
            "Note: skipped {} metadata file(s) under {}.",
            skipped,
            root.display()
        );
    }
    Ok(out)
}

async fn put_r2_object(
    client: &reqwest::Client,
    account_id: &str,
    api_token: &str,
    bucket_name: &str,
    jurisdiction: Option<&str>,
    key: &str,
    body: Vec<u8>,
    content_type: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let url = cloudflare_api_url(&format!(
        "/accounts/{}/r2/buckets/{}/objects/{}",
        account_id, bucket_name, key
    ));
    let response = send_cloudflare_request_with_retry(
        || {
            let mut request = client.put(&url).bearer_auth(api_token).body(body.clone());
            if !content_type.is_empty() {
                request = request.header("Content-Type", content_type);
            }
            if let Some(value) = jurisdiction {
                request = request.header("cf-r2-jurisdiction", value);
            }
            request.send()
        },
        &format!("Upload R2 object {}", key),
    )
    .await?;

    if response.status().is_success() {
        return Ok(());
    }

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    Err(format!("Upload R2 object {} failed ({}): {}", key, status, body).into())
}

async fn sync_templates_for_bundle(
    client: &reqwest::Client,
    account_id: &str,
    api_token: &str,
    bundle: &PreparedBundle,
) -> Result<(), Box<dyn std::error::Error>> {
    let Some(templates_dir_rel) = bundle.manifest.templates_dir.as_deref() else {
        return Ok(());
    };

    let templates_root = bundle.bundle_dir.join(templates_dir_rel);
    if !templates_root.exists() || !templates_root.is_dir() {
        println!(
            "Warning: templates directory for {} not found at {}",
            bundle.script_name,
            templates_root.display()
        );
        return Ok(());
    }

    let (bucket_name, jurisdiction) = storage_bucket_for_bundle(bundle).ok_or_else(|| {
        format!(
            "{} bundle includes templates but no R2 bucket binding is configured",
            bundle.script_name
        )
    })?;

    let mut uploads = Vec::new();
    let workspace_prefix = format!("agents/{}/", TEMPLATE_AGENT_ID);
    uploads.extend(collect_files_for_r2_prefix(
        &templates_root.join("workspace"),
        &workspace_prefix,
    )?);
    uploads.extend(collect_files_for_r2_prefix(
        &templates_root.join("skills"),
        "skills/",
    )?);

    if uploads.is_empty() {
        println!(
            "Warning: no template files found for {} in {}",
            bundle.script_name,
            templates_root.display()
        );
        return Ok(());
    }

    let sentinel_key = format!("agents/{}/{}", TEMPLATE_AGENT_ID, TEMPLATE_SENTINEL_FILE);
    if r2_object_exists(
        client,
        account_id,
        api_token,
        &bucket_name,
        jurisdiction.as_deref(),
        &sentinel_key,
    )
    .await?
    {
        println!(
            "Template sentinel {} already exists in {}. Skipping template sync for {}.",
            sentinel_key, bucket_name, bundle.script_name
        );
        return Ok(());
    }

    println!(
        "Syncing {} template object(s) to R2 bucket {} for {}.",
        uploads.len(),
        bucket_name,
        bundle.script_name
    );
    let mut uploaded_count = 0usize;
    for (key, path) in uploads {
        let body = fs::read(&path)?;
        let content_type = mime_guess::from_path(&path)
            .first_raw()
            .unwrap_or("application/octet-stream");
        put_r2_object(
            client,
            account_id,
            api_token,
            &bucket_name,
            jurisdiction.as_deref(),
            &key,
            body,
            content_type,
        )
        .await?;
        uploaded_count += 1;
    }
    if uploaded_count > 0 {
        println!(
            "Uploaded {} template object(s) for {}.",
            uploaded_count, bundle.script_name
        );
    }

    Ok(())
}

fn build_upload_metadata(
    bundle: &PreparedBundle,
    selected_components: &HashSet<String>,
    available_scripts: &HashSet<String>,
    existing_migration_tag: Option<&str>,
    include_migrations: bool,
    script_exists: bool,
    uploaded_assets: Option<&UploadedAssets>,
    keep_assets: bool,
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

    for service in service_bindings_for_bundle(bundle, selected_components, available_scripts) {
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

    if include_migrations {
        if let Some(migrations) =
            build_migrations_payload(&bundle.wrangler.migrations, existing_migration_tag)
        {
            metadata["migrations"] = migrations;
        } else if !script_exists {
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

    if let Some(uploaded_assets) = uploaded_assets {
        metadata["assets"] = json!({
            "jwt": uploaded_assets.jwt,
            "config": uploaded_assets.config
        });
    }

    if keep_assets {
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
) -> Result<DeployApplyResult, Box<dyn std::error::Error>> {
    if components.is_empty() {
        return Err("No components requested for deployment".into());
    }

    let mut prepared = components
        .iter()
        .map(|component| load_prepared_bundle(cfg, version, component))
        .collect::<Result<Vec<_>, _>>()?;
    prepared.sort_by_key(|bundle| deploy_order(&bundle.component));

    let selected_components: HashSet<String> = components.iter().cloned().collect();

    let client = reqwest::Client::new();
    let existing_scripts_with_migrations =
        list_worker_scripts(&client, account_id, api_token).await?;
    let existing_scripts: HashSet<String> =
        existing_scripts_with_migrations.keys().cloned().collect();
    let gateway_existed_before_deploy = existing_scripts.contains(SCRIPT_GATEWAY);
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
        if bundle.manifest.templates_dir.is_some() {
            sync_templates_for_bundle(&client, account_id, api_token, bundle).await?;
        }

        let metadata = build_upload_metadata(
            bundle,
            &selected_components,
            &available_scripts,
            existing_scripts_with_migrations
                .get(&bundle.script_name)
                .and_then(|tag| tag.as_deref()),
            true,
            existing_scripts_with_migrations.contains_key(&bundle.script_name),
            uploaded_assets_by_script.get(&bundle.script_name),
            false,
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
            &bundle.script_name,
            metadata,
            &bundle.entrypoint_part_name,
            bundle.entrypoint_bytes.clone(),
            source_map_for_upload,
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
            &selected_components,
            &available_scripts,
            None,
            false,
            true,
            None,
            bundle.manifest.assets_dir.is_some(),
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
            &bundle.script_name,
            metadata,
            &bundle.entrypoint_part_name,
            bundle.entrypoint_bytes.clone(),
            source_map_for_upload,
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
            (Some(script_name), Some(subdomain)) => {
                let workers_domain = workers_dev_domain(subdomain);
                Some(format!("https://{}.{}", script_name, workers_domain))
            }
            _ => None,
        }
    } else {
        None
    };

    println!("\nDeploy complete.");
    Ok(DeployApplyResult {
        gateway_url,
        gateway_existed_before_deploy,
    })
}

pub async fn destroy_deploy(
    account_id: &str,
    api_token: &str,
    components: &[String],
    delete_bucket_resource: bool,
    purge_bucket_resource: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    if components.is_empty() {
        return Err("No components requested for teardown".into());
    }

    let mut component_order = components.to_vec();
    component_order.sort_by_key(|component| deploy_order(component));

    let mut scripts_to_delete = Vec::new();
    for component in &component_order {
        let script_name = component_to_script_name(component)
            .ok_or_else(|| format!("Unsupported component '{}'", component))?;
        scripts_to_delete.push((component.clone(), script_name.to_string()));
    }

    let selected_components: HashSet<String> = components.iter().cloned().collect();
    let client = reqwest::Client::new();

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
        if purge_bucket_resource {
            println!(
                "Purging objects from R2 bucket {} before deletion...",
                DEFAULT_STORAGE_BUCKET_NAME
            );
            let deleted_objects = purge_r2_bucket_objects(
                &client,
                account_id,
                api_token,
                DEFAULT_STORAGE_BUCKET_NAME,
                None,
            )
            .await?;
            if deleted_objects > 0 {
                println!(
                    "Purged {} object(s) from R2 bucket {}",
                    deleted_objects, DEFAULT_STORAGE_BUCKET_NAME
                );
            } else {
                println!("R2 bucket {} is already empty", DEFAULT_STORAGE_BUCKET_NAME);
            }
        }

        let delete_result = delete_r2_bucket(
            &client,
            account_id,
            api_token,
            DEFAULT_STORAGE_BUCKET_NAME,
            None,
        )
        .await?;
        match delete_result {
            DeleteBucketResult::Deleted => {
                println!("Deleted R2 bucket {}", DEFAULT_STORAGE_BUCKET_NAME);
            }
            DeleteBucketResult::NotFound => {
                println!(
                    "R2 bucket {} was already absent",
                    DEFAULT_STORAGE_BUCKET_NAME
                );
            }
            DeleteBucketResult::NotEmpty => {
                println!(
                    "R2 bucket {} was not deleted because it is not empty.",
                    DEFAULT_STORAGE_BUCKET_NAME
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
    } else if selected_components.contains(COMPONENT_GATEWAY) {
        println!(
            "R2 bucket {} retained (use --delete-bucket to remove)",
            DEFAULT_STORAGE_BUCKET_NAME
        );
    }

    println!("\nTeardown complete.");
    Ok(())
}

pub async fn print_deploy_status(
    account_id: &str,
    api_token: &str,
    components: &[String],
) -> Result<(), Box<dyn std::error::Error>> {
    if components.is_empty() {
        return Err("No components requested for status".into());
    }

    let mut component_order = components.to_vec();
    component_order.sort_by_key(|component| deploy_order(component));

    let client = reqwest::Client::new();
    let scripts = list_worker_scripts(&client, account_id, api_token).await?;
    let gateway_script_name = if scripts.contains_key(SCRIPT_GATEWAY) {
        Some(SCRIPT_GATEWAY.to_string())
    } else if scripts.contains_key("gateway") {
        Some("gateway".to_string())
    } else {
        None
    };

    println!("\nWorkers:");
    for component in &component_order {
        let script_name = if component == COMPONENT_GATEWAY {
            gateway_script_name.as_deref().unwrap_or(SCRIPT_GATEWAY)
        } else {
            component_to_script_name(component)
                .ok_or_else(|| format!("Unsupported component '{}'", component))?
        };

        if let Some(migration_tag) = scripts.get(script_name) {
            if let Some(tag) = migration_tag.as_deref() {
                println!(
                    "  {:<18} {:<24} deployed (migration: {})",
                    component, script_name, tag
                );
            } else {
                println!("  {:<18} {:<24} deployed", component, script_name);
            }
        } else {
            println!("  {:<18} {:<24} missing", component, script_name);
        }
    }

    if component_order.iter().any(|c| c == COMPONENT_GATEWAY) {
        println!("\nShared infrastructure:");
        let bucket_exists = r2_bucket_exists(
            &client,
            account_id,
            api_token,
            DEFAULT_STORAGE_BUCKET_NAME,
            None,
        )
        .await?;
        println!(
            "  r2 bucket {:<26} {}",
            DEFAULT_STORAGE_BUCKET_NAME,
            if bucket_exists { "exists" } else { "missing" }
        );
    }

    Ok(())
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
        match Connection::connect_with_options(
            ws_url,
            "client",
            None,
            None,
            |_| {},
            Some("deploy-bootstrap".to_string()),
            auth_token.map(|token| token.to_string()),
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
    path: &str,
    value: Value,
) -> Result<(), Box<dyn std::error::Error>> {
    let response = conn
        .request(
            "config.set",
            Some(json!({
                "path": path,
                "value": value
            })),
        )
        .await?;

    if response.ok {
        Ok(())
    } else {
        let message = response
            .error
            .map(|err| err.message)
            .unwrap_or_else(|| "Unknown config.set failure".to_string());
        Err(format!("config.set {} failed: {}", path, message).into())
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
) -> Result<(), Box<dyn std::error::Error>> {
    let client = reqwest::Client::new();
    set_worker_secret(
        &client,
        account_id,
        api_token,
        SCRIPT_CHANNEL_DISCORD,
        "DISCORD_BOT_TOKEN",
        bot_token,
    )
    .await
}
