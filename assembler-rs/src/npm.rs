use std::collections::BTreeMap;
use std::io::Read;

use flate2::read::GzDecoder;
use semver::{Version, VersionReq};
use serde::Deserialize;
use tar::Archive;
use thiserror::Error;

use crate::diagnostics::{has_errors, PackageAssemblyDiagnostic};
use crate::pipeline::{PlannedAssembly, StageOutcome};
use crate::virtual_fs::{join_posix, normalize_repo_path, VirtualFileTree};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstalledDependencyRecord {
    pub name: String,
    pub version: String,
    pub package_root: String,
    pub tarball_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstalledAssembly {
    pub files: VirtualFileTree,
    pub browser_entry: Option<String>,
    pub asset_paths: Vec<String>,
    pub install_records: Vec<InstalledDependencyRecord>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct NpmPackument {
    #[serde(default)]
    pub versions: BTreeMap<String, NpmPackumentVersion>,
    #[serde(default, rename = "dist-tags")]
    pub dist_tags: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct NpmPackumentVersion {
    pub version: String,
    pub dist: NpmDist,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct NpmDist {
    pub tarball: String,
}

#[derive(Debug, Error)]
pub enum NpmRegistryError {
    #[error("registry request failed: {0}")]
    Request(String),
    #[error("registry response could not be parsed: {0}")]
    InvalidResponse(String),
}

pub trait NpmRegistryClient {
    fn fetch_packument(&self, package_name: &str) -> Result<NpmPackument, NpmRegistryError>;
    fn fetch_tarball(&self, tarball_url: &str) -> Result<Vec<u8>, NpmRegistryError>;
}

#[cfg(not(target_arch = "wasm32"))]
#[derive(Clone, Debug)]
pub struct HttpNpmRegistryClient {
    client: reqwest::blocking::Client,
    registry_base_url: String,
}

#[cfg(not(target_arch = "wasm32"))]
impl Default for HttpNpmRegistryClient {
    fn default() -> Self {
        Self {
            client: reqwest::blocking::Client::builder()
                .build()
                .expect("build reqwest client"),
            registry_base_url: "https://registry.npmjs.org".to_string(),
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl HttpNpmRegistryClient {
    pub fn with_registry_base_url(registry_base_url: impl Into<String>) -> Self {
        Self {
            registry_base_url: registry_base_url.into(),
            ..Self::default()
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl NpmRegistryClient for HttpNpmRegistryClient {
    fn fetch_packument(&self, package_name: &str) -> Result<NpmPackument, NpmRegistryError> {
        let encoded = urlencoding::encode(package_name);
        let url = format!(
            "{}/{}",
            self.registry_base_url.trim_end_matches('/'),
            encoded
        );
        self.client
            .get(url)
            .send()
            .map_err(|error| NpmRegistryError::Request(error.to_string()))?
            .error_for_status()
            .map_err(|error| NpmRegistryError::Request(error.to_string()))?
            .json::<NpmPackument>()
            .map_err(|error| NpmRegistryError::InvalidResponse(error.to_string()))
    }

    fn fetch_tarball(&self, tarball_url: &str) -> Result<Vec<u8>, NpmRegistryError> {
        self.client
            .get(tarball_url)
            .send()
            .map_err(|error| NpmRegistryError::Request(error.to_string()))?
            .error_for_status()
            .map_err(|error| NpmRegistryError::Request(error.to_string()))?
            .bytes()
            .map(|bytes| bytes.to_vec())
            .map_err(|error| NpmRegistryError::Request(error.to_string()))
    }
}

pub fn install_registry_dependencies<C: NpmRegistryClient>(
    planned: &PlannedAssembly,
    client: &C,
) -> StageOutcome<InstalledAssembly> {
    let mut diagnostics = Vec::new();
    let mut files = planned.files.clone();
    let mut install_records = Vec::new();

    for dependency in &planned.install_plan.registry_dependencies {
        let packument = match client.fetch_packument(&dependency.name) {
            Ok(packument) => packument,
            Err(error) => {
                diagnostics.push(PackageAssemblyDiagnostic::error(
                    "install.registry-unreachable",
                    format!(
                        "Could not fetch package metadata for {}: {error}",
                        dependency.name
                    ),
                    dependency
                        .manifest_paths
                        .first()
                        .cloned()
                        .unwrap_or_else(|| "package.json".to_string()),
                ));
                continue;
            }
        };

        let Some(published) = resolve_packument_version(&packument, &dependency.install_spec)
        else {
            diagnostics.push(PackageAssemblyDiagnostic::error(
                "install.version-unsatisfied",
                format!(
                    "No published version of {} satisfies install spec {}.",
                    dependency.name, dependency.install_spec
                ),
                dependency
                    .manifest_paths
                    .first()
                    .cloned()
                    .unwrap_or_else(|| "package.json".to_string()),
            ));
            continue;
        };

        let tarball = match client.fetch_tarball(&published.dist.tarball) {
            Ok(bytes) => bytes,
            Err(error) => {
                diagnostics.push(PackageAssemblyDiagnostic::error(
                    "install.registry-unreachable",
                    format!(
                        "Could not fetch tarball for {}@{}: {error}",
                        dependency.name, published.version
                    ),
                    dependency
                        .manifest_paths
                        .first()
                        .cloned()
                        .unwrap_or_else(|| "package.json".to_string()),
                ));
                continue;
            }
        };

        match extract_tarball_into_tree(&dependency.name, &tarball, &mut files) {
            Ok(()) => install_records.push(InstalledDependencyRecord {
                name: dependency.name.clone(),
                version: published.version.clone(),
                package_root: join_posix("node_modules", &dependency.name),
                tarball_url: published.dist.tarball.clone(),
            }),
            Err(error) => diagnostics.push(PackageAssemblyDiagnostic::error(
                error.code(),
                error.to_string(),
                dependency
                    .manifest_paths
                    .first()
                    .cloned()
                    .unwrap_or_else(|| "package.json".to_string()),
            )),
        }
    }

    if has_errors(&diagnostics) {
        return StageOutcome::failure(diagnostics);
    }

    StageOutcome::success(
        InstalledAssembly {
            files,
            browser_entry: planned.browser_entry.clone(),
            asset_paths: planned.asset_paths.clone(),
            install_records,
        },
        diagnostics,
    )
}

fn resolve_packument_version<'a>(
    packument: &'a NpmPackument,
    install_spec: &str,
) -> Option<&'a NpmPackumentVersion> {
    if let Some(version) = packument.dist_tags.get(install_spec) {
        return packument.versions.get(version);
    }

    if let Some(exact) = packument.versions.get(install_spec) {
        return Some(exact);
    }

    let Ok(version_req) = VersionReq::parse(install_spec) else {
        return None;
    };

    packument
        .versions
        .iter()
        .filter_map(|(version, published)| {
            let parsed = Version::parse(version).ok()?;
            version_req.matches(&parsed).then_some((parsed, published))
        })
        .max_by(|(left, _), (right, _)| left.cmp(right))
        .map(|(_, published)| published)
}

fn extract_tarball_into_tree(
    package_name: &str,
    tarball_bytes: &[u8],
    files: &mut VirtualFileTree,
) -> Result<(), TarballExtractError> {
    let decoder = GzDecoder::new(tarball_bytes);
    let mut archive = Archive::new(decoder);
    let mut extracted = BTreeMap::<String, String>::new();

    for entry in archive
        .entries()
        .map_err(|error| TarballExtractError::InvalidTarball(error.to_string()))?
    {
        let mut entry =
            entry.map_err(|error| TarballExtractError::InvalidTarball(error.to_string()))?;
        let entry_type = entry.header().entry_type();
        if entry_type.is_dir() {
            continue;
        }
        if !entry_type.is_file() {
            return Err(TarballExtractError::UnsupportedPackage(format!(
                "Tarball for {package_name} contains unsupported non-file entries."
            )));
        }

        let path = entry
            .path()
            .map_err(|error| TarballExtractError::InvalidTarball(error.to_string()))?;
        let archive_path = path.to_string_lossy().to_string();
        let Some(relative_path) = archive_path.strip_prefix("package/") else {
            continue;
        };
        if !is_safe_archive_member_path(relative_path) {
            return Err(TarballExtractError::UnsupportedPackage(format!(
                "Tarball for {package_name} contains an unsafe archive path."
            )));
        }
        let destination_path =
            join_posix("node_modules", &format!("{package_name}/{relative_path}"));

        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(|error| TarballExtractError::InvalidTarball(error.to_string()))?;
        let content = String::from_utf8(bytes).map_err(|_| {
            TarballExtractError::UnsupportedPackage(format!(
                "Tarball for {package_name} contains non-UTF-8 file content, which v1 does not support."
            ))
        })?;
        extracted.insert(destination_path, content);
    }

    if extracted.is_empty() {
        return Err(TarballExtractError::InvalidTarball(format!(
            "Tarball for {package_name} did not contain any package files."
        )));
    }

    for (path, content) in extracted {
        files.insert(path, content);
    }

    Ok(())
}

fn is_safe_archive_member_path(path: &str) -> bool {
    if path.is_empty() || path.starts_with('/') || path.contains('\\') {
        return false;
    }
    let normalized = normalize_repo_path(path);
    !normalized.is_empty()
        && !normalized.starts_with("../")
        && !normalized.contains("/../")
        && !normalized.starts_with("..")
}

#[derive(Debug, Error)]
enum TarballExtractError {
    #[error("{0}")]
    InvalidTarball(String),
    #[error("{0}")]
    UnsupportedPackage(String),
}

impl TarballExtractError {
    fn code(&self) -> &'static str {
        match self {
            Self::InvalidTarball(_) => "install.tarball-invalid",
            Self::UnsupportedPackage(_) => "install.unsupported-package",
        }
    }
}
