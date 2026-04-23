use std::collections::BTreeMap;

use sha2::{Digest, Sha256};

use crate::diagnostics::{has_errors, PackageAssemblyDiagnostic};
use crate::model::{
    PackageAssemblyAnalysis, PackageAssemblyArtifact, PackageAssemblyArtifactModule,
};
use crate::pipeline::StageOutcome;
use crate::runtime::RuntimeAssembly;
use crate::virtual_fs::{is_path_within_root, relativize_to_root};

pub fn finalize_artifact(
    analysis: &PackageAssemblyAnalysis,
    runtime: &RuntimeAssembly,
) -> StageOutcome<PackageAssemblyArtifact> {
    let diagnostics = Vec::<PackageAssemblyDiagnostic>::new();
    if has_errors(&diagnostics) {
        return StageOutcome::failure(diagnostics);
    }

    let mut modules = BTreeMap::<String, PackageAssemblyArtifactModule>::new();

    for graph in &runtime.graphs {
        for module in &graph.modules {
            let path = artifact_path_for_module(&module.path, &analysis.package_root);
            modules.insert(
                path.clone(),
                PackageAssemblyArtifactModule {
                    path,
                    kind: module.kind.clone(),
                    content: module.content.clone(),
                },
            );
        }
    }

    for module in &runtime.generated_modules {
        modules.insert(module.path.clone(), module.clone());
    }

    let sorted_modules = modules.into_values().collect::<Vec<_>>();
    let hash_input = serde_json::json!({
        "mainModule": runtime.main_module,
        "modules": sorted_modules,
    });
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(&hash_input).unwrap());
    let hash = format!("sha256:{:x}", hasher.finalize());

    StageOutcome::success(
        PackageAssemblyArtifact {
            main_module: runtime.main_module.clone(),
            modules: hash_input["modules"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| serde_json::from_value(value.clone()).unwrap())
                .collect(),
            hash,
        },
        diagnostics,
    )
}

fn artifact_path_for_module(path: &str, package_root: &str) -> String {
    if is_path_within_root(path, package_root) {
        relativize_to_root(path, package_root)
    } else {
        path.to_string()
    }
}
