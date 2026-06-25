use std::collections::BTreeMap;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use semver::{Version, VersionReq};
use serde::Deserialize;

use crate::diagnostics::{has_errors, PackageAssemblyDiagnostic};
use crate::model::{
    PackageAssemblyRequest, PackageAssemblyTarget, PackageDefinition, PackageJsonDefinition,
};
use crate::virtual_fs::{dirname, extension, join_posix, resolve_from_root, VirtualFileTree};

const SUPPORTED_BROWSER_ENTRY_EXTENSIONS: &[&str] =
    &["js", "jsx", "ts", "tsx", "mjs", "mts", "cjs", "cts"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StageOutcome<T> {
    pub value: Option<T>,
    pub diagnostics: Vec<PackageAssemblyDiagnostic>,
}

impl<T> StageOutcome<T> {
    pub fn success(value: T, diagnostics: Vec<PackageAssemblyDiagnostic>) -> Self {
        Self {
            value: Some(value),
            diagnostics,
        }
    }

    pub fn failure(diagnostics: Vec<PackageAssemblyDiagnostic>) -> Self {
        Self {
            value: None,
            diagnostics,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidatedRequest {
    pub request: PackageAssemblyRequest,
    pub browser_entry: Option<String>,
    pub backend_entry: Option<String>,
    pub command_entries: BTreeMap<String, String>,
    pub asset_paths: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspacePackageManifest {
    pub name: String,
    pub version: Option<String>,
    pub package_type: Option<String>,
    pub dependencies: BTreeMap<String, String>,
    pub dev_dependencies: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspacePackage {
    pub root: String,
    pub manifest_path: String,
    pub manifest: WorkspacePackageManifest,
    pub locked_dependencies: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreparedSources {
    pub files: VirtualFileTree,
    pub root_package: WorkspacePackage,
    pub workspace_packages: BTreeMap<String, WorkspacePackage>,
    pub browser_entry: Option<String>,
    pub backend_entry: Option<String>,
    pub command_entries: BTreeMap<String, String>,
    pub asset_paths: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegistryDependencyPlanItem {
    pub name: String,
    pub requested_spec: String,
    pub install_spec: String,
    pub requested_by: Vec<String>,
    pub manifest_paths: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InstallPlan {
    pub registry_dependencies: Vec<RegistryDependencyPlanItem>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlannedAssembly {
    pub files: VirtualFileTree,
    pub root_package: WorkspacePackage,
    pub workspace_packages: BTreeMap<String, WorkspacePackage>,
    pub browser_entry: Option<String>,
    pub backend_entry: Option<String>,
    pub command_entries: BTreeMap<String, String>,
    pub asset_paths: Vec<String>,
    pub install_plan: InstallPlan,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct WorkspacePackageManifestFile {
    name: String,
    version: Option<String>,
    #[serde(rename = "type")]
    package_type: Option<String>,
    #[serde(default)]
    dependencies: BTreeMap<String, String>,
    #[serde(default, rename = "devDependencies")]
    dev_dependencies: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct PackageLockFile {
    #[serde(default)]
    packages: BTreeMap<String, LockfilePackageEntry>,
    #[serde(default)]
    dependencies: BTreeMap<String, LockfilePackageEntry>,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct LockfilePackageEntry {
    version: Option<String>,
}

pub fn prepare_request(request: &PackageAssemblyRequest) -> StageOutcome<PlannedAssembly> {
    let validated = validate_request(request);
    let mut diagnostics = validated.diagnostics;
    let Some(validated) = validated.value else {
        return StageOutcome::failure(diagnostics);
    };

    let prepared = prepare_sources(&validated);
    diagnostics.extend(prepared.diagnostics);
    let Some(prepared) = prepared.value else {
        return StageOutcome::failure(diagnostics);
    };

    let installs = plan_installs(&prepared);
    diagnostics.extend(installs.diagnostics);
    let Some(install_plan) = installs.value else {
        return StageOutcome::failure(diagnostics);
    };

    StageOutcome::success(
        PlannedAssembly {
            files: prepared.files,
            root_package: prepared.root_package,
            workspace_packages: prepared.workspace_packages,
            browser_entry: prepared.browser_entry,
            backend_entry: prepared.backend_entry,
            command_entries: prepared.command_entries,
            asset_paths: prepared.asset_paths,
            install_plan,
        },
        diagnostics,
    )
}

pub fn validate_request(request: &PackageAssemblyRequest) -> StageOutcome<ValidatedRequest> {
    let mut diagnostics = request.analysis.diagnostics.clone();
    let mut browser_entry = None;
    let mut backend_entry = None;
    let mut command_entries = BTreeMap::new();
    let mut asset_paths = Vec::new();

    if !request.analysis.ok {
        diagnostics.push(PackageAssemblyDiagnostic::error(
            "analysis.failed",
            "Static package analysis failed; assembly cannot continue.",
            "src/package.ts",
        ));
    }

    if request.analysis.package_json.name.trim().is_empty() {
        diagnostics.push(PackageAssemblyDiagnostic::error(
            "analysis.package-name-missing",
            "Package analysis is missing package.json name.",
            "package.json",
        ));
    }

    if !matches!(request.target, PackageAssemblyTarget::DynamicWorker) {
        diagnostics.push(PackageAssemblyDiagnostic::error(
            "contract.unsupported-target",
            format!("Unsupported assembly target: {}", request.target.as_str()),
            "target",
        ));
    }

    let Some(definition) = request.analysis.definition.as_ref() else {
        diagnostics.push(PackageAssemblyDiagnostic::error(
            "contract.missing-definition",
            "Package analysis did not produce a package definition.",
            "src/package.ts",
        ));
        return StageOutcome::failure(diagnostics);
    };

    if let Some(entry) = browser_entry_spec(definition) {
        browser_entry = validate_module_entry(
            request,
            entry,
            "browser.entry",
            "contract.browser-entry-missing",
            "contract.browser-entry-invalid",
            Some((
                "contract.browser-entry-html",
                "browser.entry must point to a JavaScript or TypeScript module, not HTML.",
            )),
            &mut diagnostics,
        );
    }

    if let Some(entry) = backend_entry_spec(definition) {
        backend_entry = validate_module_entry(
            request,
            entry,
            "backend.entry",
            "contract.backend-entry-missing",
            "contract.backend-entry-invalid",
            None,
            &mut diagnostics,
        );
    }

    for (command_name, entry) in command_entry_specs(definition) {
        if let Some(resolved_entry) = validate_module_entry(
            request,
            entry,
            &format!("cli.commands.{command_name}"),
            "contract.command-entry-missing",
            "contract.command-entry-invalid",
            None,
            &mut diagnostics,
        ) {
            command_entries.insert(command_name, resolved_entry);
        }
    }

    for asset in browser_asset_specs(definition) {
        let resolved_asset = resolve_from_root(&request.analysis.package_root, asset);
        if !request_contains_file(request, &resolved_asset) {
            diagnostics.push(PackageAssemblyDiagnostic::error(
                "contract.asset-missing",
                "browser.assets references a file that is missing from the package snapshot.",
                resolved_asset.clone(),
            ));
        } else {
            asset_paths.push(resolved_asset);
        }
    }

    if let Some(icon_path) = definition
        .meta
        .icon
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        let resolved_icon = resolve_from_root(&request.analysis.package_root, icon_path);
        if !request_contains_file(request, &resolved_icon) {
            diagnostics.push(PackageAssemblyDiagnostic::error(
                "contract.icon-missing",
                "meta.icon references a file that is missing from the package snapshot.",
                resolved_icon,
            ));
        } else if !asset_paths.contains(&resolved_icon) {
            asset_paths.push(resolved_icon);
        }
    }

    if has_errors(&diagnostics) {
        return StageOutcome::failure(diagnostics);
    }

    StageOutcome::success(
        ValidatedRequest {
            request: request.clone(),
            browser_entry,
            backend_entry,
            command_entries,
            asset_paths,
        },
        diagnostics,
    )
}

fn browser_entry_spec<'a>(definition: &'a PackageDefinition) -> Option<&'a str> {
    definition
        .browser
        .as_ref()
        .map(|browser| browser.entry.trim())
        .filter(|entry| !entry.is_empty())
}

fn browser_asset_specs<'a>(definition: &'a PackageDefinition) -> Vec<&'a str> {
    definition
        .browser
        .as_ref()
        .map(|browser| {
            browser
                .assets
                .iter()
                .map(String::as_str)
                .filter(|asset| !asset.trim().is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn backend_entry_spec<'a>(definition: &'a PackageDefinition) -> Option<&'a str> {
    definition
        .backend
        .as_ref()
        .map(|backend| backend.entry.trim())
        .filter(|entry| !entry.is_empty())
}

fn command_entry_specs(definition: &PackageDefinition) -> Vec<(String, &str)> {
    definition
        .commands
        .iter()
        .filter_map(|command| {
            let entry = command.entry.as_deref()?.trim();
            if command.name.trim().is_empty() || entry.is_empty() {
                return None;
            }
            Some((command.name.clone(), entry))
        })
        .collect()
}

fn validate_module_entry(
    request: &PackageAssemblyRequest,
    entry: &str,
    field_name: &str,
    missing_code: &str,
    invalid_code: &str,
    html_error: Option<(&str, &str)>,
    diagnostics: &mut Vec<PackageAssemblyDiagnostic>,
) -> Option<String> {
    let resolved_entry = resolve_from_root(&request.analysis.package_root, entry);
    let entry_extension = extension(&resolved_entry)
        .unwrap_or_default()
        .to_ascii_lowercase();

    if matches!(entry_extension.as_str(), "html" | "htm") {
        if let Some((html_code, html_message)) = html_error {
            diagnostics.push(PackageAssemblyDiagnostic::error(
                html_code,
                html_message,
                resolved_entry.clone(),
            ));
            return None;
        }
    }

    if !SUPPORTED_BROWSER_ENTRY_EXTENSIONS.contains(&entry_extension.as_str()) {
        diagnostics.push(PackageAssemblyDiagnostic::error(
            invalid_code,
            format!(
                "Unsupported {field_name} extension .{entry_extension}. Expected a JS or TS module."
            ),
            resolved_entry.clone(),
        ));
        return None;
    }

    if !request.files.contains_key(&resolved_entry) {
        diagnostics.push(PackageAssemblyDiagnostic::error(
            missing_code,
            format!("{field_name} does not exist in the package snapshot."),
            resolved_entry.clone(),
        ));
        return None;
    }

    Some(resolved_entry)
}

pub fn prepare_sources(validated: &ValidatedRequest) -> StageOutcome<PreparedSources> {
    let mut diagnostics = Vec::new();
    let mut files = VirtualFileTree::new(validated.request.files.clone());
    for (path, content) in &validated.request.binary_files {
        match BASE64_STANDARD.decode(content) {
            Ok(bytes) => files.insert(path, bytes),
            Err(error) => diagnostics.push(PackageAssemblyDiagnostic::error(
                "snapshot.binary-file-invalid",
                format!("Package snapshot binary file {path} is not valid base64: {error}"),
                path.clone(),
            )),
        }
    }

    let root_package = build_root_package(
        &validated.request.analysis.package_root,
        &validated.request.analysis.package_json,
        &files,
        &mut diagnostics,
    );
    let workspace_packages = collect_workspace_packages(&files, &mut diagnostics);
    materialize_workspace_packages(
        &mut files,
        &workspace_packages,
        &validated.request.analysis.package_json.name,
    );

    if has_errors(&diagnostics) {
        return StageOutcome::failure(diagnostics);
    }

    StageOutcome::success(
        PreparedSources {
            files,
            root_package,
            workspace_packages,
            browser_entry: validated.browser_entry.clone(),
            backend_entry: validated.backend_entry.clone(),
            command_entries: validated.command_entries.clone(),
            asset_paths: validated.asset_paths.clone(),
        },
        diagnostics,
    )
}

pub fn plan_installs(prepared: &PreparedSources) -> StageOutcome<InstallPlan> {
    let mut diagnostics = Vec::new();
    let mut planned = BTreeMap::<String, RegistryDependencyPlanItem>::new();

    let mut packages = vec![prepared.root_package.clone()];
    packages.extend(prepared.workspace_packages.values().cloned());

    for package in &packages {
        for (dependency_name, dependency_spec) in &package.manifest.dependencies {
            if is_local_dependency_spec(dependency_spec) {
                continue;
            }

            let install_spec = package
                .locked_dependencies
                .get(dependency_name)
                .cloned()
                .unwrap_or_else(|| dependency_spec.clone());

            match planned.get_mut(dependency_name) {
                Some(existing) => {
                    if existing.install_spec != install_spec {
                        if let Some(merged_spec) =
                            merge_compatible_install_specs(&existing.install_spec, &install_spec)
                        {
                            existing.install_spec = merged_spec;
                            if !existing.requested_by.contains(&package.manifest.name) {
                                existing.requested_by.push(package.manifest.name.clone());
                            }
                            if !existing.manifest_paths.contains(&package.manifest_path) {
                                existing.manifest_paths.push(package.manifest_path.clone());
                            }
                            continue;
                        }

                        diagnostics.push(PackageAssemblyDiagnostic::error(
                            "install.version-conflict",
                            format!(
                                "Dependency {dependency_name} resolves to conflicting install specs: {} vs {}.",
                                existing.install_spec, install_spec
                            ),
                            package.manifest_path.clone(),
                        ));
                        continue;
                    }

                    if !existing.requested_by.contains(&package.manifest.name) {
                        existing.requested_by.push(package.manifest.name.clone());
                    }
                    if !existing.manifest_paths.contains(&package.manifest_path) {
                        existing.manifest_paths.push(package.manifest_path.clone());
                    }
                }
                None => {
                    planned.insert(
                        dependency_name.clone(),
                        RegistryDependencyPlanItem {
                            name: dependency_name.clone(),
                            requested_spec: dependency_spec.clone(),
                            install_spec,
                            requested_by: vec![package.manifest.name.clone()],
                            manifest_paths: vec![package.manifest_path.clone()],
                        },
                    );
                }
            }
        }
    }

    if has_errors(&diagnostics) {
        return StageOutcome::failure(diagnostics);
    }

    StageOutcome::success(
        InstallPlan {
            registry_dependencies: planned.into_values().collect(),
        },
        diagnostics,
    )
}

fn build_root_package(
    package_root: &str,
    package_json: &PackageJsonDefinition,
    files: &VirtualFileTree,
    diagnostics: &mut Vec<PackageAssemblyDiagnostic>,
) -> WorkspacePackage {
    WorkspacePackage {
        root: package_root.to_string(),
        manifest_path: manifest_path(package_root),
        manifest: WorkspacePackageManifest {
            name: package_json.name.clone(),
            version: package_json.version.clone(),
            package_type: package_json.package_type.clone(),
            dependencies: package_json.dependencies.clone(),
            dev_dependencies: package_json.dev_dependencies.clone(),
        },
        locked_dependencies: collect_locked_dependency_versions(files, package_root, diagnostics),
    }
}

fn collect_workspace_packages(
    files: &VirtualFileTree,
    diagnostics: &mut Vec<PackageAssemblyDiagnostic>,
) -> BTreeMap<String, WorkspacePackage> {
    let mut packages = BTreeMap::new();

    for (path, content) in files.iter() {
        if !path.ends_with("/package.json") || path.starts_with("node_modules/") {
            continue;
        }

        let manifest: WorkspacePackageManifestFile = match serde_json::from_str(content) {
            Ok(manifest) => manifest,
            Err(_) => continue,
        };

        if manifest.name.trim().is_empty() {
            continue;
        }

        let root = dirname(path);
        packages.insert(
            manifest.name.clone(),
            WorkspacePackage {
                root: root.clone(),
                manifest_path: path.clone(),
                manifest: WorkspacePackageManifest {
                    name: manifest.name,
                    version: manifest.version,
                    package_type: manifest.package_type,
                    dependencies: manifest.dependencies,
                    dev_dependencies: manifest.dev_dependencies,
                },
                locked_dependencies: collect_locked_dependency_versions(files, &root, diagnostics),
            },
        );
    }

    packages
}

fn collect_locked_dependency_versions(
    files: &VirtualFileTree,
    package_root: &str,
    diagnostics: &mut Vec<PackageAssemblyDiagnostic>,
) -> BTreeMap<String, String> {
    let lockfile_path = if package_root.is_empty() {
        "package-lock.json".to_string()
    } else {
        join_posix(package_root, "package-lock.json")
    };

    let Some(source) = files.get(&lockfile_path) else {
        return BTreeMap::new();
    };

    let parsed: PackageLockFile = match serde_json::from_str(source) {
        Ok(parsed) => parsed,
        Err(_) => {
            diagnostics.push(PackageAssemblyDiagnostic::error(
                "install.lockfile-invalid",
                "package-lock.json could not be parsed.",
                lockfile_path,
            ));
            return BTreeMap::new();
        }
    };

    let mut locked = BTreeMap::new();
    for (entry_path, entry) in parsed.packages {
        let Some(package_name) = top_level_node_modules_package_name(&entry_path) else {
            continue;
        };
        let Some(version) = entry.version.filter(|value| !value.trim().is_empty()) else {
            continue;
        };
        locked.insert(package_name, version);
    }

    for (package_name, entry) in parsed.dependencies {
        let Some(version) = entry.version.filter(|value| !value.trim().is_empty()) else {
            continue;
        };
        locked.entry(package_name).or_insert(version);
    }

    locked
}

fn top_level_node_modules_package_name(path: &str) -> Option<String> {
    let trimmed = path.strip_prefix("node_modules/")?;
    let segments: Vec<&str> = trimmed
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    match segments.as_slice() {
        [name] => Some((*name).to_string()),
        [scope, name] if scope.starts_with('@') => Some(format!("{scope}/{name}")),
        _ => None,
    }
}

fn materialize_workspace_packages(
    files: &mut VirtualFileTree,
    workspace_packages: &BTreeMap<String, WorkspacePackage>,
    root_package_name: &str,
) {
    let file_entries: Vec<(String, crate::virtual_fs::VirtualFileContent)> = files
        .entries()
        .map(|(path, content)| (path.clone(), content.clone()))
        .collect();

    for (package_name, package) in workspace_packages {
        if package_name == root_package_name {
            continue;
        }

        let root_prefix = format!("{}/", package.root);
        let materialized_root = join_posix("node_modules", package_name);

        for (path, content) in &file_entries {
            if !path.starts_with(&root_prefix) {
                continue;
            }

            let relative_path = &path[root_prefix.len()..];
            files.insert(
                join_posix(&materialized_root, relative_path),
                content.clone(),
            );
        }
    }
}

fn request_contains_file(request: &PackageAssemblyRequest, path: &str) -> bool {
    request.files.contains_key(path) || request.binary_files.contains_key(path)
}

fn is_local_dependency_spec(spec: &str) -> bool {
    spec.starts_with("file:") || spec.starts_with("link:") || spec.starts_with("workspace:")
}

fn merge_compatible_install_specs(existing: &str, incoming: &str) -> Option<String> {
    if exact_version_satisfies_requirement(existing, incoming) {
        return Some(existing.to_string());
    }
    if exact_version_satisfies_requirement(incoming, existing) {
        return Some(incoming.to_string());
    }
    None
}

fn exact_version_satisfies_requirement(version_spec: &str, requirement_spec: &str) -> bool {
    let Ok(version) = Version::parse(version_spec.trim()) else {
        return false;
    };
    let Ok(requirement) = VersionReq::parse(requirement_spec.trim()) else {
        return false;
    };
    requirement.matches(&version)
}

fn manifest_path(root: &str) -> String {
    if root.is_empty() {
        "package.json".to_string()
    } else {
        join_posix(root, "package.json")
    }
}

#[cfg(test)]
mod tests {
    use super::{
        is_local_dependency_spec, plan_installs, top_level_node_modules_package_name,
        PreparedSources, WorkspacePackage, WorkspacePackageManifest,
    };
    use crate::virtual_fs::VirtualFileTree;
    use std::collections::BTreeMap;

    #[test]
    fn recognizes_local_dependency_specs() {
        assert!(is_local_dependency_spec("file:../react"));
        assert!(is_local_dependency_spec("link:../react"));
        assert!(is_local_dependency_spec("workspace:*"));
        assert!(!is_local_dependency_spec("^18.3.1"));
        assert!(!is_local_dependency_spec("0.0.2"));
    }

    #[test]
    fn plans_registry_install_for_versioned_workspace_dependency() {
        let root_package = WorkspacePackage {
            root: "packages/gsv-console".to_string(),
            manifest_path: "packages/gsv-console/package.json".to_string(),
            manifest: WorkspacePackageManifest {
                name: "@gsv/gsv".to_string(),
                version: Some("0.2.6".to_string()),
                package_type: Some("module".to_string()),
                dependencies: BTreeMap::from([(
                    "@humansandmachines/gsv".to_string(),
                    "0.0.2".to_string(),
                )]),
                dev_dependencies: BTreeMap::new(),
            },
            locked_dependencies: BTreeMap::new(),
        };

        let sdk_package = WorkspacePackage {
            root: "packages/gsv".to_string(),
            manifest_path: "packages/gsv/package.json".to_string(),
            manifest: WorkspacePackageManifest {
                name: "@humansandmachines/gsv".to_string(),
                version: Some("0.0.2".to_string()),
                package_type: Some("module".to_string()),
                dependencies: BTreeMap::new(),
                dev_dependencies: BTreeMap::new(),
            },
            locked_dependencies: BTreeMap::new(),
        };

        let prepared = PreparedSources {
            files: VirtualFileTree::default(),
            root_package,
            workspace_packages: BTreeMap::from([(
                "@humansandmachines/gsv".to_string(),
                sdk_package,
            )]),
            browser_entry: None,
            backend_entry: None,
            command_entries: BTreeMap::new(),
            asset_paths: Vec::new(),
        };

        let outcome = plan_installs(&prepared);
        assert!(outcome.diagnostics.is_empty());
        let plan = outcome.value.expect("install plan");
        assert_eq!(plan.registry_dependencies.len(), 1);
        assert_eq!(plan.registry_dependencies[0].name, "@humansandmachines/gsv");
        assert_eq!(plan.registry_dependencies[0].install_spec, "0.0.2");
    }

    #[test]
    fn extracts_top_level_lockfile_package_names() {
        assert_eq!(
            top_level_node_modules_package_name("node_modules/react"),
            Some("react".to_string())
        );
        assert_eq!(
            top_level_node_modules_package_name("node_modules/@types/react"),
            Some("@types/react".to_string())
        );
        assert_eq!(
            top_level_node_modules_package_name("node_modules/react/node_modules/scheduler"),
            None
        );
    }
}
