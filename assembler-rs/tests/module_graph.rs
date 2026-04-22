use std::collections::BTreeMap;

use assembler_rs::graph::build_module_graph;
use assembler_rs::model::{
    PackageAppDefinition, PackageAppHandlerDefinition, PackageAssemblyAnalysis,
    PackageAssemblyArtifactModuleKind, PackageAssemblyRequest, PackageAssemblySource,
    PackageAssemblyTarget, PackageCapabilityDefinition, PackageDefinition, PackageIdentity,
    PackageJsonDefinition, PackageMetaDefinition,
};
use assembler_rs::npm::{
    install_registry_dependencies, NpmDist, NpmPackument, NpmPackumentVersion, NpmRegistryClient,
    NpmRegistryError,
};
use assembler_rs::pipeline::prepare_request;
use flate2::write::GzEncoder;
use flate2::Compression;
use tar::{Builder, Header};

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

fn base_request(entry_source: &str) -> PackageAssemblyRequest {
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
                browser: None,
                backend: None,
                app: Some(PackageAppDefinition {
                    handler: PackageAppHandlerDefinition {
                        export_name: "App".to_string(),
                    },
                    has_rpc: true,
                    rpc_methods: vec!["ping".to_string()],
                    browser_entry: Some("./src/main.tsx".to_string()),
                    assets: vec!["./src/styles.css".to_string()],
                }),
            }),
            diagnostics: Vec::new(),
            ok: true,
            analysis_hash: "analysis-hash".to_string(),
        },
        target: PackageAssemblyTarget::DynamicWorker,
        files: [
            (
                "apps/demo/src/main.tsx".to_string(),
                entry_source.to_string(),
            ),
            (
                "apps/demo/src/styles.css".to_string(),
                "body { color: red; }".to_string(),
            ),
        ]
        .into_iter()
        .collect(),
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

#[test]
fn builds_recursive_local_module_graph() {
    let mut request = base_request(
        r#"import "./side-effect";
import { value } from "./lib";
export default value;"#,
    );
    request.files.extend(BTreeMap::from([
        (
            "apps/demo/src/lib.ts".to_string(),
            r#"export { value } from "./nested";"#.to_string(),
        ),
        (
            "apps/demo/src/nested.ts".to_string(),
            r#"export const value = 42;"#.to_string(),
        ),
        (
            "apps/demo/src/side-effect.ts".to_string(),
            r#"console.log("loaded");"#.to_string(),
        ),
    ]));

    let planned = prepare_request(&request).value.expect("planned");
    let installed = install_registry_dependencies(&planned, &MockNpmRegistryClient::default())
        .value
        .expect("installed");
    let graph = build_module_graph(&installed).value.expect("graph");

    let paths = graph
        .modules
        .iter()
        .map(|module| module.path.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        paths,
        vec![
            "apps/demo/src/lib.ts",
            "apps/demo/src/main.tsx",
            "apps/demo/src/nested.ts",
            "apps/demo/src/side-effect.ts",
        ]
    );
    assert!(graph
        .modules
        .iter()
        .all(|module| module.kind == PackageAssemblyArtifactModuleKind::SourceModule));
}

#[test]
fn graph_emits_commonjs_and_json_modules() {
    let mut request = base_request(
        r#"import data from "./data.json";
import pad from "left-pad";
export default [data, pad];"#,
    );
    request.files.insert(
        "apps/demo/src/data.json".to_string(),
        r#"{"hello":"world"}"#.to_string(),
    );
    request
        .analysis
        .package_json
        .dependencies
        .insert("left-pad".to_string(), "1.2.0".to_string());

    let tarball_url = "https://registry.example/left-pad/-/left-pad-1.2.0.tgz";
    let client = MockNpmRegistryClient::default()
        .with_package("left-pad", packument(&[("1.2.0", tarball_url)]))
        .with_tarball(
            tarball_url,
            tarball(&[
                (
                    "package.json",
                    br#"{
  "name": "left-pad",
  "version": "1.2.0",
  "main": "./index.js"
}"#,
                ),
                ("index.js", br#"module.exports = function leftPad() {};"#),
            ]),
        );

    let planned = prepare_request(&request).value.expect("planned");
    let installed = install_registry_dependencies(&planned, &client)
        .value
        .expect("installed");
    let graph = build_module_graph(&installed).value.expect("graph");

    let kinds = graph
        .modules
        .iter()
        .map(|module| (module.path.as_str(), &module.kind))
        .collect::<BTreeMap<_, _>>();
    assert_eq!(
        kinds.get("apps/demo/src/main.tsx"),
        Some(&&PackageAssemblyArtifactModuleKind::SourceModule)
    );
    assert_eq!(
        kinds.get("apps/demo/src/data.json"),
        Some(&&PackageAssemblyArtifactModuleKind::Json)
    );
    assert_eq!(
        kinds.get("node_modules/left-pad/index.js"),
        Some(&&PackageAssemblyArtifactModuleKind::Commonjs)
    );
}

#[test]
fn graph_reports_unresolved_imports() {
    let request = base_request(
        r#"import { missing } from "./missing";
export default missing;"#,
    );

    let planned = prepare_request(&request).value.expect("planned");
    let installed = install_registry_dependencies(&planned, &MockNpmRegistryClient::default())
        .value
        .expect("installed");
    let outcome = build_module_graph(&installed);

    assert!(outcome.value.is_none());
    assert!(outcome
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == "resolve.not-found"));
}

#[test]
fn jsx_graph_requires_declared_preact_dependency() {
    let request = base_request(
        r#"export default function App() {
  return <main>hello</main>;
}"#,
    );

    let planned = prepare_request(&request).value.expect("planned");
    let installed = install_registry_dependencies(&planned, &MockNpmRegistryClient::default())
        .value
        .expect("installed");
    let outcome = build_module_graph(&installed);

    assert!(outcome.value.is_none());
    assert!(outcome
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == "resolve.not-found"
            && diagnostic.message.contains("preact/jsx-runtime")));
}

#[test]
fn graph_transforms_typescript_and_jsx_modules() {
    let mut request = base_request(
        r#"type Props = { name?: string };

export default function App({ name }: Props) {
  return <main>{name ?? "hello"}</main>;
}"#,
    );
    request
        .analysis
        .package_json
        .dependencies
        .insert("preact".to_string(), "10.24.1".to_string());

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

    let planned = prepare_request(&request).value.expect("planned");
    let installed = install_registry_dependencies(&planned, &client)
        .value
        .expect("installed");
    let graph = build_module_graph(&installed).value.expect("graph");

    let main = graph
        .modules
        .iter()
        .find(|module| module.path == "apps/demo/src/main.tsx")
        .expect("main module");

    assert!(main.content.contains("from \"preact/jsx-runtime\""));
    assert!(!main.content.contains("type Props"));
    assert!(!main.content.contains(": Props"));
    assert!(!main.content.contains("<main>"));
    assert!(graph
        .modules
        .iter()
        .any(|module| module.path == "node_modules/preact/jsx-runtime/dist/jsxRuntime.module.js"));
}
