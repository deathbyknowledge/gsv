use std::collections::{BTreeMap, BTreeSet, VecDeque};

use oxc_resolver::ModuleType;

use crate::diagnostics::{has_errors, PackageAssemblyDiagnostic};
use crate::model::{PackageAssemblyArtifactModule, PackageAssemblyArtifactModuleKind};
use crate::npm::InstalledAssembly;
use crate::oxc::{parse_module_dependencies_with_oxc, OxcResolver};
use crate::pipeline::StageOutcome;
use crate::virtual_fs::extension;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModuleGraph {
    pub main_module: String,
    pub modules: Vec<PackageAssemblyArtifactModule>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct QueueEntry {
    path: String,
    module_type: Option<ModuleType>,
}

pub fn build_module_graph(installed: &InstalledAssembly) -> StageOutcome<ModuleGraph> {
    let mut diagnostics = Vec::new();
    let Some(main_module) = installed.browser_entry.clone() else {
        diagnostics.push(PackageAssemblyDiagnostic::error(
            "runtime-wrapper.missing-handler",
            "Package app is missing a browser entry module.",
            "src/package.ts",
        ));
        return StageOutcome::failure(diagnostics);
    };

    build_module_graph_for_entry(installed, &main_module)
}

pub fn build_module_graph_for_entry(
    installed: &InstalledAssembly,
    entry_path: &str,
) -> StageOutcome<ModuleGraph> {
    let mut diagnostics = Vec::new();
    let main_module = entry_path.to_string();

    let resolver = OxcResolver::new(installed.files.clone());
    let mut queue = VecDeque::from([QueueEntry {
        path: main_module.clone(),
        module_type: None,
    }]);
    let mut visited = BTreeSet::new();
    let mut emitted = BTreeMap::new();

    while let Some(entry) = queue.pop_front() {
        let path = entry.path;
        if !visited.insert(path.clone()) {
            continue;
        }

        let Some(content) = installed.files.get(&path) else {
            diagnostics.push(PackageAssemblyDiagnostic::error(
                "internal.missing-file",
                format!("Resolved module {path} is missing from the virtual file tree."),
                path.clone(),
            ));
            continue;
        };

        let kind = infer_module_kind(&path, entry.module_type);
        match kind {
            Some(PackageAssemblyArtifactModuleKind::SourceModule) => {
                match parse_module_dependencies_with_oxc(&path, content) {
                    Ok(parsed) => {
                        emitted.insert(
                            path.clone(),
                            PackageAssemblyArtifactModule {
                                path: path.clone(),
                                kind: PackageAssemblyArtifactModuleKind::SourceModule,
                                content: content.to_string(),
                            },
                        );
                        for requested in parsed.requested_modules {
                            match resolver.resolve_specifier(&path, &requested) {
                                Ok(resolved) => {
                                    let resolved_kind = infer_module_kind(
                                        &resolved.repo_path,
                                        resolved.module_type,
                                    );
                                    match resolved_kind {
                                        Some(PackageAssemblyArtifactModuleKind::Data) => {
                                            diagnostics.push(PackageAssemblyDiagnostic::error(
                                                "emit.unsupported-module-kind",
                                                format!(
                                                    "Resolved module {} has unsupported binary module kind.",
                                                    resolved.repo_path
                                                ),
                                                resolved.repo_path,
                                            ));
                                        }
                                        Some(_) => {
                                            queue.push_back(QueueEntry {
                                                path: resolved.repo_path,
                                                module_type: resolved.module_type,
                                            });
                                        }
                                        None => {
                                            diagnostics.push(PackageAssemblyDiagnostic::error(
                                                "emit.unsupported-module-kind",
                                                format!(
                                                    "Resolved module {} has an unsupported module kind.",
                                                    resolved.repo_path
                                                ),
                                                resolved.repo_path,
                                            ));
                                        }
                                    }
                                }
                                Err(error) => diagnostics.push(error),
                            }
                        }
                    }
                    Err(error) => diagnostics.push(error),
                }
            }
            Some(kind) => {
                emitted.insert(
                    path.clone(),
                    PackageAssemblyArtifactModule {
                        path: path.clone(),
                        kind,
                        content: content.to_string(),
                    },
                );
            }
            None => diagnostics.push(PackageAssemblyDiagnostic::error(
                "emit.unsupported-module-kind",
                format!("Module {path} has an unsupported module kind."),
                path.clone(),
            )),
        }
    }

    if has_errors(&diagnostics) {
        return StageOutcome::failure(diagnostics);
    }

    StageOutcome::success(
        ModuleGraph {
            main_module,
            modules: emitted.into_values().collect(),
        },
        diagnostics,
    )
}

fn infer_module_kind(
    path: &str,
    module_type: Option<ModuleType>,
) -> Option<PackageAssemblyArtifactModuleKind> {
    match module_type {
        Some(ModuleType::CommonJs) => return Some(PackageAssemblyArtifactModuleKind::Commonjs),
        Some(ModuleType::Json) => return Some(PackageAssemblyArtifactModuleKind::Json),
        Some(ModuleType::Wasm | ModuleType::Addon) => {
            return Some(PackageAssemblyArtifactModuleKind::Data)
        }
        Some(ModuleType::Module) | None => {}
    }

    let extension = extension(path)?.to_ascii_lowercase();
    match extension.as_str() {
        "ts" | "tsx" | "js" | "jsx" | "mts" | "mjs" => {
            Some(PackageAssemblyArtifactModuleKind::SourceModule)
        }
        "cts" | "cjs" => Some(PackageAssemblyArtifactModuleKind::Commonjs),
        "json" => Some(PackageAssemblyArtifactModuleKind::Json),
        "txt" | "md" | "css" | "html" | "svg" => Some(PackageAssemblyArtifactModuleKind::Text),
        _ => None,
    }
}
