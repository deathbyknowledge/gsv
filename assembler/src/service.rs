use crate::artifact::finalize_artifact;
use crate::diagnostics::{has_errors, PackageAssemblyDiagnostic};
use crate::model::{PackageAssemblyArtifact, PackageAssemblyRequest, PackageAssemblyResponse};
use crate::npm::{install_registry_dependencies, NpmRegistryClient};
use crate::pipeline::{prepare_request, StageOutcome};
use crate::runtime::build_runtime_assembly;

pub fn assemble_package_with_client<C: NpmRegistryClient>(
    request: &PackageAssemblyRequest,
    client: &C,
) -> PackageAssemblyResponse {
    let prepared = prepare_request(request);
    let mut diagnostics = prepared.diagnostics;
    let Some(planned) = prepared.value else {
        return build_assembly_response(request, None, diagnostics);
    };

    let installed = install_registry_dependencies(&planned, client);
    diagnostics.extend(installed.diagnostics);
    let Some(installed) = installed.value else {
        return build_assembly_response(request, None, diagnostics);
    };

    let runtime = build_runtime_assembly(&request.analysis, &installed);
    diagnostics.extend(runtime.diagnostics);
    let Some(runtime) = runtime.value else {
        return build_assembly_response(request, None, diagnostics);
    };

    let artifact = finalize_artifact(&request.analysis, &runtime);
    diagnostics.extend(artifact.diagnostics);

    build_assembly_response(request, artifact.value, diagnostics)
}

pub fn build_assembly_response(
    request: &PackageAssemblyRequest,
    artifact: Option<PackageAssemblyArtifact>,
    diagnostics: Vec<PackageAssemblyDiagnostic>,
) -> PackageAssemblyResponse {
    PackageAssemblyResponse {
        source: request.analysis.source.clone(),
        analysis_hash: request.analysis.analysis_hash.clone(),
        target: request.target.clone(),
        artifact,
        ok: !has_errors(&diagnostics),
        diagnostics,
    }
}

pub fn extend_stage_diagnostics<T>(
    diagnostics: &mut Vec<PackageAssemblyDiagnostic>,
    outcome: StageOutcome<T>,
) -> Option<T> {
    diagnostics.extend(outcome.diagnostics);
    outcome.value
}
