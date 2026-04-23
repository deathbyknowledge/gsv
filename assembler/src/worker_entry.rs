use serde_json::json;
use wasm_bindgen::prelude::*;
use worker::{event, Context, Request, Response};

use crate::artifact::finalize_artifact;
use crate::model::{PackageAssemblyRequest, PackageAssemblyResponse};
use crate::npm::install_registry_dependencies_with_fetch;
use crate::pipeline::prepare_request;
use crate::runtime::{build_runtime_assembly, RUNTIME_WRAPPER_MARKER};
use crate::service::build_assembly_response;

#[event(fetch)]
async fn fetch(_req: Request, _env: worker::Env, _ctx: Context) -> worker::Result<Response> {
    Response::from_json(&json!({
        "name": "gsv-assembler",
        "version": env!("CARGO_PKG_VERSION"),
        "runtime_wrapper_marker": RUNTIME_WRAPPER_MARKER,
        "status": "ready"
    }))
}

#[wasm_bindgen(js_name = assemblePackage)]
pub async fn assemble_package(input: JsValue) -> Result<JsValue, JsValue> {
    let request =
        serde_wasm_bindgen::from_value::<PackageAssemblyRequest>(input).map_err(|error| {
            JsValue::from_str(&format!("invalid package assembly request: {error}"))
        })?;

    let response = assemble_package_response(request).await;
    serde_wasm_bindgen::to_value(&response)
        .map_err(|error| JsValue::from_str(&format!("invalid package assembly response: {error}")))
}

async fn assemble_package_response(request: PackageAssemblyRequest) -> PackageAssemblyResponse {
    worker::console_log!(
        "[assembler] assemble start package_root={} analysis_hash={} wrapper={}",
        request.analysis.package_root,
        request.analysis.analysis_hash,
        RUNTIME_WRAPPER_MARKER,
    );
    let prepared = prepare_request(&request);
    let mut diagnostics = prepared.diagnostics;
    let Some(planned) = prepared.value else {
        worker::console_log!(
            "[assembler] assemble failed package_root={} stage=prepare wrapper={}",
            request.analysis.package_root,
            RUNTIME_WRAPPER_MARKER,
        );
        return build_assembly_response(&request, None, diagnostics);
    };

    let installed = install_registry_dependencies_with_fetch(&planned).await;
    diagnostics.extend(installed.diagnostics);
    let Some(installed) = installed.value else {
        worker::console_log!(
            "[assembler] assemble failed package_root={} stage=install wrapper={}",
            request.analysis.package_root,
            RUNTIME_WRAPPER_MARKER,
        );
        return build_assembly_response(&request, None, diagnostics);
    };

    let runtime = build_runtime_assembly(&request.analysis, &installed);
    diagnostics.extend(runtime.diagnostics);
    let Some(runtime) = runtime.value else {
        worker::console_log!(
            "[assembler] assemble failed package_root={} stage=runtime wrapper={}",
            request.analysis.package_root,
            RUNTIME_WRAPPER_MARKER,
        );
        return build_assembly_response(&request, None, diagnostics);
    };

    let artifact = finalize_artifact(&request.analysis, &runtime);
    diagnostics.extend(artifact.diagnostics);

    if let Some(artifact) = artifact.value.as_ref() {
        worker::console_log!(
            "[assembler] assemble ok package_root={} hash={} wrapper={}",
            request.analysis.package_root,
            artifact.hash,
            RUNTIME_WRAPPER_MARKER,
        );
    } else {
        worker::console_log!(
            "[assembler] assemble failed package_root={} stage=finalize wrapper={}",
            request.analysis.package_root,
            RUNTIME_WRAPPER_MARKER,
        );
    }

    build_assembly_response(&request, artifact.value, diagnostics)
}
