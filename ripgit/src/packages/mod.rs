mod analyze;
mod snapshot;

use serde::{Deserialize, Serialize};
use worker::{Error, Result, SqlStorage};

pub(crate) use analyze::analyze_package;
pub(crate) use snapshot::snapshot_package;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PackageDiagnosticSeverity {
    Error,
    Warning,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PackageDiagnostic {
    pub severity: PackageDiagnosticSeverity,
    pub code: String,
    pub message: String,
    pub path: String,
    pub line: u32,
    pub column: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PackageSourceLocator {
    pub repo: String,
    #[serde(rename = "ref")]
    pub requested_ref: String,
    pub subdir: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResolvedPackageSource {
    pub repo: String,
    #[serde(rename = "ref")]
    pub requested_ref: String,
    pub resolved_commit: String,
    pub subdir: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PackageSnapshot {
    pub source: ResolvedPackageSource,
    pub package_root: String,
    pub files: std::collections::BTreeMap<String, String>,
}

pub(crate) fn resolve_source(
    sql: &SqlStorage,
    locator: &PackageSourceLocator,
) -> Result<ResolvedPackageSource> {
    let resolved_commit = crate::api::resolve_ref(sql, &locator.requested_ref)?
        .ok_or_else(|| Error::RustError(format!("ref not found: {}", locator.requested_ref)))?;

    Ok(ResolvedPackageSource {
        repo: locator.repo.clone(),
        requested_ref: locator.requested_ref.clone(),
        resolved_commit,
        subdir: normalize_subdir(&locator.subdir)?,
    })
}

pub(crate) fn normalize_subdir(subdir: &str) -> Result<String> {
    let normalized = subdir.replace('\\', "/");
    let mut segments: Vec<&str> = Vec::new();

    for segment in normalized.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            return Err(Error::RustError(format!(
                "invalid package subdir: {}",
                subdir
            )));
        }
        segments.push(segment);
    }

    if segments.is_empty() {
        return Ok(".".to_string());
    }

    Ok(segments.join("/"))
}
