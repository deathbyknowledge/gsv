use std::collections::BTreeMap;

use assembler::artifact::finalize_artifact;
use assembler::model::{
    PackageAssemblyAnalysis, PackageAssemblyArtifactModuleKind, PackageAssemblyPublicFileEncoding,
    PackageAssemblyRequest, PackageAssemblySource, PackageAssemblyTarget, PackageBackendDefinition,
    PackageBrowserDefinition, PackageCapabilityDefinition, PackageCommandDefinition,
    PackageDefinition, PackageIdentity, PackageJsonDefinition, PackageMetaDefinition,
};
use assembler::npm::{
    install_registry_dependencies, NpmDist, NpmPackument, NpmPackumentVersion, NpmRegistryClient,
    NpmRegistryError,
};
use assembler::pipeline::prepare_request;
use assembler::runtime::build_runtime_assembly;
use flate2::write::GzEncoder;
use flate2::Compression;
use tar::{Builder, Header};

#[derive(Clone, Debug, Default)]
struct EmptyRegistry;

#[derive(Clone, Debug, Default)]
struct MockNpmRegistryClient {
    packuments: BTreeMap<String, NpmPackument>,
    tarballs: BTreeMap<String, Vec<u8>>,
}

impl MockNpmRegistryClient {
    fn with_package(mut self, name: &str, packument: NpmPackument) -> Self {
        self.packuments.insert(name.to_string(), packument);
        self
    }

    fn with_tarball(mut self, url: &str, tarball: Vec<u8>) -> Self {
        self.tarballs.insert(url.to_string(), tarball);
        self
    }
}

impl NpmRegistryClient for EmptyRegistry {
    fn fetch_packument(&self, _package_name: &str) -> Result<NpmPackument, NpmRegistryError> {
        Err(NpmRegistryError::Request("not used".to_string()))
    }

    fn fetch_tarball(&self, _tarball_url: &str) -> Result<Vec<u8>, NpmRegistryError> {
        Err(NpmRegistryError::Request("not used".to_string()))
    }
}

impl NpmRegistryClient for MockNpmRegistryClient {
    fn fetch_packument(&self, package_name: &str) -> Result<NpmPackument, NpmRegistryError> {
        self.packuments.get(package_name).cloned().ok_or_else(|| {
            NpmRegistryError::Request(format!("missing mock packument for {package_name}"))
        })
    }

    fn fetch_tarball(&self, tarball_url: &str) -> Result<Vec<u8>, NpmRegistryError> {
        self.tarballs.get(tarball_url).cloned().ok_or_else(|| {
            NpmRegistryError::Request(format!("missing mock tarball for {tarball_url}"))
        })
    }
}

fn packument(versions: &[(&str, &str)]) -> NpmPackument {
    NpmPackument {
        versions: versions
            .iter()
            .map(|(version, tarball)| {
                (
                    (*version).to_string(),
                    NpmPackumentVersion {
                        version: (*version).to_string(),
                        dist: NpmDist {
                            tarball: (*tarball).to_string(),
                        },
                    },
                )
            })
            .collect(),
        dist_tags: BTreeMap::from([("latest".to_string(), versions.last().unwrap().0.to_string())]),
    }
}

fn tarball(files: &[(&str, &[u8])]) -> Vec<u8> {
    let encoder = GzEncoder::new(Vec::new(), Compression::default());
    let mut archive = Builder::new(encoder);

    for (path, contents) in files {
        let mut header = Header::new_gnu();
        header.set_mode(0o644);
        header.set_size(contents.len() as u64);
        header.set_cksum();
        archive
            .append_data(&mut header, format!("package/{path}"), &mut &contents[..])
            .expect("append tar entry");
    }

    let encoder = archive.into_inner().expect("finalize tar");
    encoder.finish().expect("finish gzip")
}

fn request() -> PackageAssemblyRequest {
    PackageAssemblyRequest {
        analysis: PackageAssemblyAnalysis {
            source: PackageAssemblySource {
                repo: "gsv/example".to_string(),
                r#ref: "main".to_string(),
                resolved_commit: "deadbeef".to_string(),
                subdir: String::new(),
            },
            package_root: "apps/demo".to_string(),
            identity: PackageIdentity {
                package_json_name: "@demo/app".to_string(),
                version: Some("0.1.0".to_string()),
                display_name: "Demo".to_string(),
            },
            package_json: PackageJsonDefinition {
                name: "@demo/app".to_string(),
                version: Some("0.1.0".to_string()),
                package_type: Some("module".to_string()),
                dependencies: BTreeMap::new(),
                dev_dependencies: BTreeMap::new(),
            },
            definition: Some(PackageDefinition {
                meta: PackageMetaDefinition {
                    display_name: "Demo".to_string(),
                    description: Some("Demo package".to_string()),
                    icon: None,
                    window: None,
                    capabilities: PackageCapabilityDefinition::default(),
                },
                commands: Vec::new(),
                browser: Some(PackageBrowserDefinition {
                    entry: "./src/main.tsx".to_string(),
                    assets: vec!["./src/styles.css".to_string()],
                }),
                backend: None,
            }),
            diagnostics: Vec::new(),
            ok: true,
            analysis_hash: "analysis-hash".to_string(),
        },
        target: PackageAssemblyTarget::DynamicWorker,
        files: [
            (
                "apps/demo/src/package.ts".to_string(),
                r#"import { definePackage } from "@gsv/package/manifest";
export default definePackage({
  meta: { displayName: "Demo" },
  browser: { entry: "./src/main.tsx", assets: ["./src/styles.css"] }
});"#
                    .to_string(),
            ),
            (
                "apps/demo/src/main.tsx".to_string(),
                r#"export default function App() { return null; }"#.to_string(),
            ),
            (
                "apps/demo/src/styles.css".to_string(),
                "body { color: red; }".to_string(),
            ),
        ]
        .into_iter()
        .collect(),
        binary_files: BTreeMap::new(),
    }
}

fn declarative_request() -> PackageAssemblyRequest {
    let mut req = request();
    req.analysis.definition = Some(PackageDefinition {
        meta: PackageMetaDefinition {
            display_name: "Demo".to_string(),
            description: Some("Demo package".to_string()),
            icon: None,
            window: None,
            capabilities: PackageCapabilityDefinition::default(),
        },
        commands: vec![PackageCommandDefinition {
            name: "sync".to_string(),
            entry: Some("./src/cli/sync.ts".to_string()),
        }],
        browser: Some(PackageBrowserDefinition {
            entry: "./src/main.tsx".to_string(),
            assets: vec!["./src/styles.css".to_string()],
        }),
        backend: Some(PackageBackendDefinition {
            entry: "./src/backend.ts".to_string(),
            public_routes: vec!["/webhooks/github".to_string()],
        }),
    });
    req.files.insert(
        "apps/demo/src/package.ts".to_string(),
        r#"import { definePackage } from "@gsv/package/manifest";
export default definePackage({
  meta: { displayName: "Demo" },
  browser: { entry: "./src/main.tsx", assets: ["./src/styles.css"] },
  backend: { entry: "./src/backend.ts", public_routes: ["/webhooks/github"] },
  cli: { commands: { sync: "./src/cli/sync.ts" } }
});"#
            .to_string(),
    );
    req.files.insert(
        "apps/demo/src/backend.ts".to_string(),
        r#"export default class DemoBackend {
  async ping(args) { return args; }
  async fetch() { return new Response("ok"); }
}"#
        .to_string(),
    );
    req.files.insert(
        "apps/demo/src/cli/sync.ts".to_string(),
        r#"export default async function run(ctx) {
  await ctx.stdout.write("synced");
}"#
        .to_string(),
    );
    req
}

fn command_only_request() -> PackageAssemblyRequest {
    let mut req = request();
    req.analysis.definition = Some(PackageDefinition {
        meta: PackageMetaDefinition {
            display_name: "Demo".to_string(),
            description: Some("Demo package".to_string()),
            icon: None,
            window: None,
            capabilities: PackageCapabilityDefinition::default(),
        },
        commands: vec![PackageCommandDefinition {
            name: "sync".to_string(),
            entry: Some("./src/cli/sync.ts".to_string()),
        }],
        browser: None,
        backend: None,
    });
    req.files.remove("apps/demo/src/main.tsx");
    req.files.remove("apps/demo/src/styles.css");
    req.files.insert(
        "apps/demo/src/package.ts".to_string(),
        r#"import { definePackage } from "@gsv/package/manifest";
export default definePackage({
  meta: { displayName: "Demo" },
  cli: { commands: { sync: "./src/cli/sync.ts" } }
});"#
            .to_string(),
    );
    req.files.insert(
        "apps/demo/src/cli/sync.ts".to_string(),
        r#"export default async function run(ctx) {
  await ctx.stdout.write("synced");
}"#
        .to_string(),
    );
    req
}

#[test]
fn builds_runtime_artifact_with_wrapper_and_hash() {
    let prepared = prepare_request(&request()).value.expect("prepared");
    let installed = install_registry_dependencies(&prepared, &EmptyRegistry)
        .value
        .expect("installed");
    let runtime = build_runtime_assembly(&request().analysis, &installed)
        .value
        .expect("runtime");
    let artifact = finalize_artifact(&request().analysis, &runtime)
        .value
        .expect("artifact");

    assert_eq!(artifact.main_module, "__gsv__/main.ts");
    assert!(artifact.hash.starts_with("sha256:"));

    let modules = artifact
        .modules
        .iter()
        .map(|module| (module.path.as_str(), module))
        .collect::<BTreeMap<_, _>>();

    assert_eq!(
        modules.get("__gsv__/main.ts").map(|module| &module.kind),
        Some(&PackageAssemblyArtifactModuleKind::SourceModule)
    );
    assert_eq!(
        modules.get("src/package.ts").map(|module| &module.kind),
        Some(&PackageAssemblyArtifactModuleKind::SourceModule)
    );
    assert_eq!(
        modules.get("src/main.tsx").map(|module| &module.kind),
        Some(&PackageAssemblyArtifactModuleKind::SourceModule)
    );
    assert_eq!(
        modules
            .get("__gsv_assets__/0.ts")
            .map(|module| &module.kind),
        Some(&PackageAssemblyArtifactModuleKind::SourceModule)
    );
    assert!(!modules
        .keys()
        .any(|path| path.starts_with("__gsv_browser_assets__/")));
    assert!(artifact
        .public_files
        .iter()
        .any(|file| file.path == "gsv/packages/__GSV_ARTIFACT_HASH__/browser/src/main.js"));

    let wrapper = modules.get("__gsv__/main.ts").unwrap().content.as_str();
    let package_definition = modules.get("src/package.ts").unwrap().content.as_str();
    assert!(wrapper.contains("import definition from \"../src/package.ts\";"));
    assert!(wrapper.contains("class GsvPackageAppBackend extends RpcTarget"));
    assert!(wrapper.contains(
        "const BROWSER_ENTRY = \"/public/gsv/packages/__GSV_ARTIFACT_HASH__/browser/src/main.js\";"
    ));
    assert!(wrapper.contains("const APP_SHELL_HTML = \"<!doctype html>"));
    assert!(!package_definition.contains("\"@gsv/package/manifest\""));
    assert!(package_definition.contains("\"../node_modules/@gsv/package/src/manifest.ts\""));
}

#[test]
fn missing_definition_source_is_reported() {
    let mut req = request();
    req.files.remove("apps/demo/src/package.ts");

    let prepared = prepare_request(&req).value.expect("prepared");
    let installed = install_registry_dependencies(&prepared, &EmptyRegistry)
        .value
        .expect("installed");
    let outcome = build_runtime_assembly(&req.analysis, &installed);

    assert!(outcome.value.is_none());
    assert!(outcome
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == "contract.definition-source-missing"));
}

#[test]
fn builds_runtime_artifact_for_declarative_backend_and_commands() {
    let request = declarative_request();
    let prepared = prepare_request(&request).value.expect("prepared");
    let installed = install_registry_dependencies(&prepared, &EmptyRegistry)
        .value
        .expect("installed");
    let runtime = build_runtime_assembly(&request.analysis, &installed)
        .value
        .expect("runtime");
    let artifact = finalize_artifact(&request.analysis, &runtime)
        .value
        .expect("artifact");

    let modules = artifact
        .modules
        .iter()
        .map(|module| (module.path.as_str(), module))
        .collect::<BTreeMap<_, _>>();

    assert_eq!(
        modules.get("src/backend.ts").map(|module| &module.kind),
        Some(&PackageAssemblyArtifactModuleKind::SourceModule)
    );
    assert_eq!(
        modules.get("src/cli/sync.ts").map(|module| &module.kind),
        Some(&PackageAssemblyArtifactModuleKind::SourceModule)
    );

    let wrapper = modules.get("__gsv__/main.ts").unwrap().content.as_str();
    assert!(wrapper.contains("import GsvPackageBackendModule from \"../src/backend.ts\";"));
    assert!(wrapper.contains("const COMMAND_MODULES = new Map(["));
    assert!(wrapper.contains("[\"sync\", __gsv_command_0],"));
    assert!(wrapper.contains("export class GsvCommandEntrypoint extends WorkerEntrypoint"));
    assert!(wrapper.contains("export class GsvAppSignalEntrypoint extends WorkerEntrypoint"));
    assert!(
        wrapper.contains("function buildDaemonClient(env, props, daemonOverride, triggerOverride)")
    );
    assert!(wrapper.contains("function buildStorageClient(env)"));
    assert!(wrapper.contains("function buildAppClient(env, props)"));
    assert!(wrapper.contains("typeof api.packageSqlExec !== \"function\""));
    assert!(wrapper.contains("async invoke(method, args)"));
    assert!(wrapper.contains("const api = env.GSV_API;"));
}

#[test]
fn builds_runtime_artifact_for_command_only_package() {
    let request = command_only_request();
    let prepared = prepare_request(&request).value.expect("prepared");
    let installed = install_registry_dependencies(&prepared, &EmptyRegistry)
        .value
        .expect("installed");
    let runtime = build_runtime_assembly(&request.analysis, &installed)
        .value
        .expect("runtime");
    let artifact = finalize_artifact(&request.analysis, &runtime)
        .value
        .expect("artifact");

    let modules = artifact
        .modules
        .iter()
        .map(|module| (module.path.as_str(), module))
        .collect::<BTreeMap<_, _>>();

    assert_eq!(
        modules.get("src/cli/sync.ts").map(|module| &module.kind),
        Some(&PackageAssemblyArtifactModuleKind::SourceModule)
    );
    let wrapper = modules.get("__gsv__/main.ts").unwrap().content.as_str();
    assert!(wrapper.contains("const BROWSER_ENTRY = null;"));
    assert!(wrapper.contains("export class GsvCommandEntrypoint extends WorkerEntrypoint"));
}

#[test]
fn runtime_artifact_emits_icon_asset_module() {
    let mut request = declarative_request();
    request.analysis.definition.as_mut().unwrap().meta.icon = Some("./ui/icon.svg".to_string());
    request.files.insert(
        "apps/demo/ui/icon.svg".to_string(),
        r#"<svg viewBox="0 0 16 16"></svg>"#.to_string(),
    );

    let prepared = prepare_request(&request).value.expect("prepared");
    let installed = install_registry_dependencies(&prepared, &EmptyRegistry)
        .value
        .expect("installed");
    let runtime = build_runtime_assembly(&request.analysis, &installed)
        .value
        .expect("runtime");
    let artifact = finalize_artifact(&request.analysis, &runtime)
        .value
        .expect("artifact");

    let modules = artifact
        .modules
        .iter()
        .map(|module| (module.path.as_str(), module))
        .collect::<BTreeMap<_, _>>();

    assert_eq!(
        modules.get("ui/icon.svg").map(|module| &module.kind),
        Some(&PackageAssemblyArtifactModuleKind::Text)
    );
    assert_eq!(
        modules
            .get("ui/icon.svg")
            .map(|module| module.content.as_str()),
        Some(r#"<svg viewBox="0 0 16 16"></svg>"#)
    );
}

#[test]
fn runtime_artifact_transforms_typescript_and_jsx_modules() {
    let mut request = declarative_request();
    request
        .analysis
        .package_json
        .dependencies
        .insert("preact".to_string(), "10.24.1".to_string());
    request.files.insert(
        "apps/demo/src/package.ts".to_string(),
        r#"import { definePackage } from "@gsv/package/manifest";

const publicRoutes: string[] = ["/webhooks/github"];

export default definePackage({
  meta: { displayName: "Demo" },
  browser: { entry: "./src/main.tsx", assets: ["./src/styles.css"] },
  backend: { entry: "./src/backend.ts", public_routes: publicRoutes },
  cli: { commands: { sync: "./src/cli/sync.ts" } }
});"#
            .to_string(),
    );
    request.files.insert(
        "apps/demo/src/main.tsx".to_string(),
        r#"type Props = { name?: string };

export default function App({ name }: Props) {
  return <main>{name ?? "hello"}</main>;
}"#
        .to_string(),
    );
    request.files.insert(
        "apps/demo/src/backend.ts".to_string(),
        r#"export default class DemoBackend {
  async ping(args: { value: string }) {
    return args;
  }
}"#
        .to_string(),
    );
    request.files.insert(
        "apps/demo/src/cli/sync.ts".to_string(),
        r#"export default async function run(ctx: { stdout: { write(value: string): Promise<void> } }) {
  await ctx.stdout.write("synced");
}"#
        .to_string(),
    );

    let tarball_url = "https://registry.example/preact/-/preact-10.24.1.tgz";
    let client = MockNpmRegistryClient::default()
        .with_package("preact", packument(&[("10.24.1", tarball_url)]))
        .with_tarball(
            tarball_url,
            tarball(&[
                (
                    "package.json",
                    br#"{
  "name": "preact",
  "version": "10.24.1",
  "type": "module",
  "exports": {
    ".": "./dist/preact.module.js",
    "./jsx-runtime": "./jsx-runtime/dist/jsxRuntime.module.js"
  }
}"#,
                ),
                (
                    "dist/preact.module.js",
                    br#"export function render() { return null; }"#,
                ),
                (
                    "jsx-runtime/dist/jsxRuntime.module.js",
                    br#"export function jsx(type, props) { return { type, props }; }"#,
                ),
            ]),
        );

    let prepared = prepare_request(&request).value.expect("prepared");
    let installed = install_registry_dependencies(&prepared, &client)
        .value
        .expect("installed");
    let runtime = build_runtime_assembly(&request.analysis, &installed)
        .value
        .expect("runtime");
    let artifact = finalize_artifact(&request.analysis, &runtime)
        .value
        .expect("artifact");

    let modules = artifact
        .modules
        .iter()
        .map(|module| (module.path.as_str(), module))
        .collect::<BTreeMap<_, _>>();

    let package_definition = modules.get("src/package.ts").unwrap().content.as_str();
    assert!(!package_definition.contains(": string[]"));

    let main = modules.get("src/main.tsx").unwrap().content.as_str();
    assert!(main.contains("from\"preact/jsx-runtime\""));
    assert!(!main.contains("type Props"));
    assert!(!main.contains(": Props"));
    assert!(!main.contains("<main>"));
    assert!(modules.contains_key("node_modules/preact/jsx-runtime/dist/jsxRuntime.module.js"));

    let backend = modules.get("src/backend.ts").unwrap().content.as_str();
    assert!(backend.contains("async ping(args)"));
    assert!(!backend.contains(": { value: string }"));

    let command = modules.get("src/cli/sync.ts").unwrap().content.as_str();
    assert!(command.contains("async function run(ctx)"));
    assert!(!command.contains(": { stdout:"));
}

#[test]
fn runtime_artifact_rewrites_browser_asset_specifiers() {
    let mut request = declarative_request();
    request
        .analysis
        .package_json
        .dependencies
        .insert("preact".to_string(), "10.24.1".to_string());
    request.files.insert(
        "apps/demo/src/main.tsx".to_string(),
        r#"import { render } from "preact";
import { App } from "./app/app";

const root = document.getElementById("root");
if (!root) throw new Error("missing root");

render(<App />, root);"#
            .to_string(),
    );
    request.files.insert(
        "apps/demo/src/app/app.tsx".to_string(),
        r#"export function App() {
  return <main>hello</main>;
}"#
        .to_string(),
    );

    let tarball_url = "https://registry.example/preact/-/preact-10.24.1.tgz";
    let client = MockNpmRegistryClient::default()
        .with_package("preact", packument(&[("10.24.1", tarball_url)]))
        .with_tarball(
            tarball_url,
            tarball(&[
                (
                    "package.json",
                    br#"{
  "name": "preact",
  "version": "10.24.1",
  "type": "module",
  "exports": {
    ".": "./dist/preact.module.js",
    "./jsx-runtime": "./jsx-runtime/dist/jsxRuntime.module.js"
  }
}"#,
                ),
                (
                    "dist/preact.module.js",
                    br#"export function render() { return null; }"#,
                ),
                (
                    "jsx-runtime/dist/jsxRuntime.module.js",
                    br#"export function jsx(type, props) { return { type, props }; }"#,
                ),
            ]),
        );

    let prepared = prepare_request(&request).value.expect("prepared");
    let installed = install_registry_dependencies(&prepared, &client)
        .value
        .expect("installed");
    let runtime = build_runtime_assembly(&request.analysis, &installed)
        .value
        .expect("runtime");
    let artifact = finalize_artifact(&request.analysis, &runtime)
        .value
        .expect("artifact");

    let modules = artifact
        .modules
        .iter()
        .map(|module| (module.path.as_str(), module))
        .collect::<BTreeMap<_, _>>();
    let wrapper = modules.get("__gsv__/main.ts").unwrap().content.as_str();
    assert!(
        wrapper.contains("href=\\\"/public/gsv/packages/__GSV_ARTIFACT_HASH__/src/styles.css\\\"")
    );
    assert!(wrapper
        .contains("src=\\\"/public/gsv/packages/__GSV_ARTIFACT_HASH__/browser/src/main.js\\\""));

    let browser_assets = artifact
        .public_files
        .iter()
        .filter(|file| file.path.ends_with(".js"))
        .map(|file| file.content.as_str())
        .collect::<Vec<_>>();
    assert!(browser_assets.iter().any(|content| content
        .contains("/public/gsv/packages/__GSV_ARTIFACT_HASH__/browser/src/app/app.js")));
    assert!(browser_assets
        .iter()
        .any(|content| content.contains("/public/lib/npm/preact/10.24.1/dist/preact.module.js")));
    assert!(browser_assets.iter().any(|content| content
        .contains("/public/lib/npm/preact/10.24.1/jsx-runtime/dist/jsxRuntime.module.js")));
}

#[test]
fn runtime_artifact_rejects_browser_css_module_imports() {
    let mut request = declarative_request();
    request.files.insert(
        "apps/demo/src/main.tsx".to_string(),
        r#"import "./styles.css";

export default function App() { return null; }"#
            .to_string(),
    );

    let prepared = prepare_request(&request).value.expect("prepared");
    let installed = install_registry_dependencies(&prepared, &EmptyRegistry)
        .value
        .expect("installed");
    let outcome = build_runtime_assembly(&request.analysis, &installed);

    assert!(outcome.value.is_none());
    assert!(outcome.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == "browser.unsupported-specifier"
            && diagnostic.message.contains("apps/demo/src/styles.css")
    }));
}

#[test]
fn runtime_artifact_emits_browser_wasm_public_files() {
    let mut request = declarative_request();
    request
        .analysis
        .package_json
        .dependencies
        .insert("wasm-lib".to_string(), "1.0.0".to_string());
    request.files.insert(
        "apps/demo/src/main.ts".to_string(),
        r#"import { wasmUrl } from "wasm-lib";
export default wasmUrl;"#
            .to_string(),
    );
    request.analysis.definition.as_mut().unwrap().browser = Some(PackageBrowserDefinition {
        entry: "./src/main.ts".to_string(),
        assets: vec!["./src/styles.css".to_string()],
    });
    request.files.remove("apps/demo/src/main.tsx");

    let tarball_url = "https://registry.example/wasm-lib/-/wasm-lib-1.0.0.tgz";
    let client = MockNpmRegistryClient::default()
        .with_package("wasm-lib", packument(&[("1.0.0", tarball_url)]))
        .with_tarball(
            tarball_url,
            tarball(&[
                (
                    "package.json",
                    br#"{
  "name": "wasm-lib",
  "version": "1.0.0",
  "type": "module",
  "exports": "./index.js"
}"#,
                ),
                (
                    "index.js",
                    br#"export const wasmUrl = new URL("./module.wasm", import.meta.url);"#,
                ),
                ("module.wasm", &[0x00, 0x61, 0x73, 0x6d]),
            ]),
        );

    let prepared = prepare_request(&request).value.expect("prepared");
    let installed = install_registry_dependencies(&prepared, &client)
        .value
        .expect("installed");
    let runtime = build_runtime_assembly(&request.analysis, &installed)
        .value
        .expect("runtime");
    let artifact = finalize_artifact(&request.analysis, &runtime)
        .value
        .expect("artifact");

    let wasm = artifact
        .public_files
        .iter()
        .find(|file| file.path == "lib/npm/wasm-lib/1.0.0/module.wasm")
        .expect("wasm public file");
    assert_eq!(wasm.content_type, "application/wasm");
    assert_eq!(wasm.encoding, PackageAssemblyPublicFileEncoding::Base64);
    assert_eq!(wasm.content, "AGFzbQ==");

    let wasm_lib_js = artifact
        .public_files
        .iter()
        .find(|file| file.path == "lib/npm/wasm-lib/1.0.0/index.js")
        .expect("wasm lib js");
    assert!(wasm_lib_js
        .content
        .contains("new URL(\"/public/lib/npm/wasm-lib/1.0.0/module.wasm\",import.meta.url)"));
}

#[test]
fn runtime_artifact_emits_registry_browser_wasm_dependency_files() {
    let mut request = declarative_request();
    request
        .analysis
        .package_json
        .dependencies
        .insert("ghostty-web".to_string(), "0.4.0".to_string());
    request.files.insert(
        "apps/demo/src/main.ts".to_string(),
        r#"import { init } from "ghostty-web";
export default init;"#
            .to_string(),
    );
    request.analysis.definition.as_mut().unwrap().browser = Some(PackageBrowserDefinition {
        entry: "./src/main.ts".to_string(),
        assets: vec!["./src/styles.css".to_string()],
    });
    request.files.remove("apps/demo/src/main.tsx");

    let tarball_url = "https://registry.example/ghostty-web/-/ghostty-web-0.4.0.tgz";
    let client = MockNpmRegistryClient::default()
        .with_package("ghostty-web", packument(&[("0.4.0", tarball_url)]))
        .with_tarball(
            tarball_url,
            tarball(&[
                (
                    "package.json",
                    br#"{
  "name": "ghostty-web",
  "version": "0.4.0",
  "type": "module",
  "exports": {
    ".": { "import": "./dist/ghostty-web.js" },
    "./ghostty-vt.wasm": "./ghostty-vt.wasm"
  }
}"#,
                ),
                (
                    "dist/ghostty-web.js",
                    br#"export const wasmUrl = new URL("../ghostty-vt.wasm", import.meta.url);
export async function init() {
  await import("./__vite-browser-external-2447137e.js");
  return fetch(wasmUrl);
}"#,
                ),
                (
                    "dist/__vite-browser-external-2447137e.js",
                    br#"export default {};"#,
                ),
                ("ghostty-vt.wasm", &[0x00, 0x61, 0x73, 0x6d]),
            ]),
        );

    let prepared = prepare_request(&request).value.expect("prepared");
    let installed = install_registry_dependencies(&prepared, &client)
        .value
        .expect("installed");
    let runtime = build_runtime_assembly(&request.analysis, &installed)
        .value
        .expect("runtime");
    let artifact = finalize_artifact(&request.analysis, &runtime)
        .value
        .expect("artifact");

    let wasm = artifact
        .public_files
        .iter()
        .find(|file| file.path == "lib/npm/ghostty-web/0.4.0/ghostty-vt.wasm")
        .expect("ghostty wasm public file");
    assert_eq!(wasm.content_type, "application/wasm");
    assert_eq!(wasm.encoding, PackageAssemblyPublicFileEncoding::Base64);

    let ghostty_js = artifact
        .public_files
        .iter()
        .find(|file| file.path == "lib/npm/ghostty-web/0.4.0/dist/ghostty-web.js")
        .expect("ghostty js public file");
    assert!(ghostty_js.content.contains(
        "new URL(\"/public/lib/npm/ghostty-web/0.4.0/ghostty-vt.wasm\",import.meta.url)"
    ));
    assert!(ghostty_js.content.contains(
        "import(\"/public/lib/npm/ghostty-web/0.4.0/dist/__vite-browser-external-2447137e.js\")"
    ));

    assert!(artifact.public_files.iter().any(|file| {
        file.path == "lib/npm/ghostty-web/0.4.0/dist/__vite-browser-external-2447137e.js"
    }));
}

#[test]
fn runtime_artifact_emits_package_local_binary_public_files() {
    let mut request = declarative_request();
    request.files.insert(
        "apps/demo/src/main.ts".to_string(),
        r#"export const wasmUrl = new URL("./module.wasm", import.meta.url);"#.to_string(),
    );
    request.binary_files.insert(
        "apps/demo/src/module.wasm".to_string(),
        "AGFzbQ==".to_string(),
    );
    request.analysis.definition.as_mut().unwrap().browser = Some(PackageBrowserDefinition {
        entry: "./src/main.ts".to_string(),
        assets: vec!["./src/styles.css".to_string()],
    });
    request.files.remove("apps/demo/src/main.tsx");

    let prepared = prepare_request(&request).value.expect("prepared");
    let installed = install_registry_dependencies(&prepared, &EmptyRegistry)
        .value
        .expect("installed");
    let runtime = build_runtime_assembly(&request.analysis, &installed)
        .value
        .expect("runtime");
    let artifact = finalize_artifact(&request.analysis, &runtime)
        .value
        .expect("artifact");

    let wasm = artifact
        .public_files
        .iter()
        .find(|file| file.path == "gsv/packages/__GSV_ARTIFACT_HASH__/browser/src/module.wasm")
        .expect("local wasm public file");
    assert_eq!(wasm.content_type, "application/wasm");
    assert_eq!(wasm.encoding, PackageAssemblyPublicFileEncoding::Base64);
    assert_eq!(wasm.content, "AGFzbQ==");

    let main = artifact
        .public_files
        .iter()
        .find(|file| file.path == "gsv/packages/__GSV_ARTIFACT_HASH__/browser/src/main.js")
        .expect("main js");
    assert!(main.content.contains(
        "new URL(\"/public/gsv/packages/__GSV_ARTIFACT_HASH__/browser/src/module.wasm\",import.meta.url)"
    ));
}

#[test]
fn runtime_artifact_rewrites_browser_worker_urls() {
    let mut request = declarative_request();
    request.files.insert(
        "apps/demo/src/main.ts".to_string(),
        r#"const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
worker.postMessage({ type: "ping" });
"#
        .to_string(),
    );
    request.files.insert(
        "apps/demo/src/worker.ts".to_string(),
        r#"self.addEventListener("message", () => {
  self.postMessage({ type: "pong" });
});
"#
        .to_string(),
    );
    request.analysis.definition.as_mut().unwrap().browser = Some(PackageBrowserDefinition {
        entry: "./src/main.ts".to_string(),
        assets: vec!["./src/styles.css".to_string()],
    });
    request.files.remove("apps/demo/src/main.tsx");

    let prepared = prepare_request(&request).value.expect("prepared");
    let installed = install_registry_dependencies(&prepared, &EmptyRegistry)
        .value
        .expect("installed");
    let runtime = build_runtime_assembly(&request.analysis, &installed)
        .value
        .expect("runtime");
    let artifact = finalize_artifact(&request.analysis, &runtime)
        .value
        .expect("artifact");

    let browser_assets = artifact
        .public_files
        .iter()
        .filter(|file| file.path.ends_with(".js"))
        .map(|file| file.content.as_str())
        .collect::<Vec<_>>();

    assert!(browser_assets
        .iter()
        .any(|content| content.contains("new URL(\"/public/gsv/packages/__GSV_ARTIFACT_HASH__/browser/src/worker.js\",import.meta.url)")));
    assert!(!browser_assets
        .iter()
        .any(|content| content.contains("new URL(\"./worker.ts\", import.meta.url)")));
}
