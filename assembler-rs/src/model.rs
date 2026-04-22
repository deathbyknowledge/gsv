use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::diagnostics::PackageAssemblyDiagnostic;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(from = "String", into = "String")]
pub enum PackageAssemblyTarget {
    DynamicWorker,
    Unsupported(String),
}

impl PackageAssemblyTarget {
    pub fn as_str(&self) -> &str {
        match self {
            Self::DynamicWorker => "dynamic-worker",
            Self::Unsupported(value) => value.as_str(),
        }
    }
}

impl From<String> for PackageAssemblyTarget {
    fn from(value: String) -> Self {
        match value.as_str() {
            "dynamic-worker" => Self::DynamicWorker,
            other => Self::Unsupported(other.to_string()),
        }
    }
}

impl From<PackageAssemblyTarget> for String {
    fn from(value: PackageAssemblyTarget) -> Self {
        match value {
            PackageAssemblyTarget::DynamicWorker => "dynamic-worker".to_string(),
            PackageAssemblyTarget::Unsupported(other) => other,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageAssemblySource {
    pub repo: String,
    pub r#ref: String,
    pub resolved_commit: String,
    pub subdir: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageIdentity {
    pub package_json_name: String,
    pub version: Option<String>,
    pub display_name: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageJsonDefinition {
    pub name: String,
    pub version: Option<String>,
    #[serde(rename = "type")]
    pub package_type: Option<String>,
    #[serde(default)]
    pub dependencies: BTreeMap<String, String>,
    #[serde(default, rename = "dev_dependencies")]
    pub dev_dependencies: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageWindowDefinition {
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub min_width: Option<u32>,
    pub min_height: Option<u32>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageCapabilityDefinition {
    #[serde(default)]
    pub kernel: Vec<String>,
    #[serde(default)]
    pub outbound: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageMetaDefinition {
    pub display_name: String,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub window: Option<PackageWindowDefinition>,
    #[serde(default)]
    pub capabilities: PackageCapabilityDefinition,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageCommandDefinition {
    pub name: String,
    pub entry: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageAppHandlerDefinition {
    pub export_name: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageBrowserDefinition {
    pub entry: String,
    #[serde(default)]
    pub assets: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageBackendDefinition {
    pub entry: String,
    #[serde(default)]
    pub public_routes: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageAppDefinition {
    pub handler: PackageAppHandlerDefinition,
    pub has_rpc: bool,
    #[serde(default)]
    pub rpc_methods: Vec<String>,
    pub browser_entry: Option<String>,
    #[serde(default)]
    pub assets: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageDefinition {
    pub meta: PackageMetaDefinition,
    #[serde(default)]
    pub commands: Vec<PackageCommandDefinition>,
    pub browser: Option<PackageBrowserDefinition>,
    pub backend: Option<PackageBackendDefinition>,
    pub app: Option<PackageAppDefinition>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageAssemblyAnalysis {
    pub source: PackageAssemblySource,
    pub package_root: String,
    pub identity: PackageIdentity,
    pub package_json: PackageJsonDefinition,
    pub definition: Option<PackageDefinition>,
    #[serde(default)]
    pub diagnostics: Vec<PackageAssemblyDiagnostic>,
    pub ok: bool,
    pub analysis_hash: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageAssemblyRequest {
    pub analysis: PackageAssemblyAnalysis,
    pub target: PackageAssemblyTarget,
    #[serde(default)]
    pub files: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PackageAssemblyArtifactModuleKind {
    SourceModule,
    Commonjs,
    Json,
    Text,
    Data,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageAssemblyArtifactModule {
    pub path: String,
    pub kind: PackageAssemblyArtifactModuleKind,
    pub content: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageAssemblyArtifact {
    pub main_module: String,
    pub modules: Vec<PackageAssemblyArtifactModule>,
    pub hash: String,
}
