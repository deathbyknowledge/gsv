use assembler_rs::model::{
    PackageAssemblyAnalysis, PackageAssemblyRequest, PackageAssemblySource,
    PackageAssemblyTarget, PackageBrowserDefinition, PackageCapabilityDefinition,
    PackageDefinition, PackageIdentity, PackageJsonDefinition, PackageMetaDefinition,
};
use assembler_rs::npm::{
    install_registry_dependencies, NpmDist, NpmPackument, NpmPackumentVersion, NpmRegistryClient,
    NpmRegistryError,
};
use assembler_rs::oxc::{parse_source_text_with_oxc, transform_source_text_with_oxc, OxcResolver};
use assembler_rs::pipeline::prepare_request;
use flate2::write::GzEncoder;
use flate2::Compression;
use std::collections::BTreeMap;
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
                "apps/demo/src/main.tsx".to_string(),
                entry_source.to_string(),
            ),
            (
                "apps/demo/src/styles.css".to_string(),
                "body { color: red; }".to_string(),
            ),
            (
                "apps/demo/package-lock.json".to_string(),
                r#"{"packages":{"":{"version":"0.1.0"}}}"#.to_string(),
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
fn installs_registry_package_and_resolves_it_with_oxc() {
    let mut request = base_request(
        r#"import React from "react";
export default function App() {
  return React.createElement("div", null, "hello");
}"#,
    );
    request
        .analysis
        .package_json
        .dependencies
        .insert("react".to_string(), "^18.0.0".to_string());
    request.files.insert(
        "apps/demo/package-lock.json".to_string(),
        r#"{
  "packages": {
    "": { "version": "0.1.0" },
    "node_modules/react": { "version": "18.3.1" }
  }
}"#
        .to_string(),
    );

    let react_tarball_url = "https://registry.example/react/-/react-18.3.1.tgz";
    let client = MockNpmRegistryClient::default()
        .with_package("react", packument(&[("18.3.1", react_tarball_url)]))
        .with_tarball(
            react_tarball_url,
            tarball(&[
                (
                    "package.json",
                    br#"{
  "name": "react",
  "version": "18.3.1",
  "type": "module",
  "exports": {
    ".": "./index.js"
  }
}"#,
                ),
                (
                    "index.js",
                    br#"export default { createElement() { return null; } };"#,
                ),
            ]),
        );

    let planned = prepare_request(&request).value.expect("planned request");
    let installed = install_registry_dependencies(&planned, &client)
        .value
        .expect("installed dependencies");

    parse_source_text_with_oxc(
        "apps/demo/src/main.tsx",
        installed.files.get("apps/demo/src/main.tsx").unwrap(),
    )
    .expect("entry parses");
    parse_source_text_with_oxc(
        "node_modules/react/index.js",
        installed.files.get("node_modules/react/index.js").unwrap(),
    )
    .expect("installed package parses");

    let resolver = OxcResolver::new(installed.files.clone());
    let resolved = resolver
        .resolve_specifier("apps/demo/src/main.tsx", "react")
        .expect("resolve react");

    assert_eq!(resolved.repo_path, "node_modules/react/index.js");
    assert_eq!(
        resolved.package_json_path.as_deref(),
        Some("node_modules/react/package.json")
    );
    assert!(resolved.module_type.is_some());
}

#[test]
fn installs_scoped_package_and_resolves_export_subpath() {
    let mut request = base_request(
        r#"import { definePackage } from "@gsv/package/manifest";
import worker from "@scope/demo/worker";
export default worker;"#,
    );
    request
        .analysis
        .package_json
        .dependencies
        .insert("@scope/demo".to_string(), "1.2.0".to_string());

    let tarball_url = "https://registry.example/@scope/demo/-/demo-1.2.0.tgz";
    let client = MockNpmRegistryClient::default()
        .with_package("@scope/demo", packument(&[("1.2.0", tarball_url)]))
        .with_tarball(
            tarball_url,
            tarball(&[
                (
                    "package.json",
                    br#"{
  "name": "@scope/demo",
  "version": "1.2.0",
  "type": "module",
  "exports": {
    "./worker": "./dist/worker.js"
  }
}"#,
                ),
                ("dist/worker.js", br#"export default "worker";"#),
            ]),
        );

    let planned = prepare_request(&request).value.expect("planned request");
    let installed = install_registry_dependencies(&planned, &client)
        .value
        .expect("installed dependencies");

    let resolver = OxcResolver::new(installed.files.clone());
    let resolved = resolver
        .resolve_specifier("apps/demo/src/main.tsx", "@scope/demo/worker")
        .expect("resolve scoped export");

    assert_eq!(
        resolved.repo_path,
        "node_modules/@scope/demo/dist/worker.js"
    );
}

#[test]
fn browser_resolver_prefers_import_export_over_require_export() {
    let mut request = base_request(r#"import qrcode from "qrcode-generator"; export default qrcode;"#);
    request
        .analysis
        .package_json
        .dependencies
        .insert("qrcode-generator".to_string(), "2.0.4".to_string());
    request.files.insert(
        "apps/demo/package-lock.json".to_string(),
        r#"{
  "packages": {
    "": { "version": "0.1.0" },
    "node_modules/qrcode-generator": { "version": "2.0.4" }
  }
}"#
        .to_string(),
    );

    let tarball_url = "https://registry.example/qrcode-generator/-/qrcode-generator-2.0.4.tgz";
    let client = MockNpmRegistryClient::default()
        .with_package("qrcode-generator", packument(&[("2.0.4", tarball_url)]))
        .with_tarball(
            tarball_url,
            tarball(&[
                (
                    "package.json",
                    br#"{
  "name": "qrcode-generator",
  "version": "2.0.4",
  "main": "dist/qrcode.js",
  "module": "dist/qrcode.mjs",
  "exports": {
    "types": "./dist/qrcode.d.ts",
    "require": "./dist/qrcode.js",
    "import": "./dist/qrcode.mjs"
  }
}"#,
                ),
                ("dist/qrcode.js", br#"module.exports = function qrcode() {};"#),
                ("dist/qrcode.mjs", br#"export default function qrcode() {}"#),
                ("dist/qrcode.d.ts", br#"declare const qrcode: unknown; export default qrcode;"#),
            ]),
        );

    let planned = prepare_request(&request).value.expect("planned request");
    let installed = install_registry_dependencies(&planned, &client)
        .value
        .expect("installed dependencies");

    let resolved = OxcResolver::new_browser(installed.files.clone())
        .resolve_specifier("apps/demo/src/main.tsx", "qrcode-generator")
        .expect("resolve qrcode-generator");

    assert_eq!(resolved.repo_path, "node_modules/qrcode-generator/dist/qrcode.mjs");
}

#[test]
fn oxc_resolver_resolves_injected_gsv_sdk_packages() {
    let request = base_request(
        r#"import { definePackage } from "@gsv/package/manifest";
export default definePackage;"#,
    );

    let planned = prepare_request(&request).value.expect("planned request");
    let resolver = OxcResolver::new(planned.files.clone());
    let resolved = resolver
        .resolve_specifier("apps/demo/src/main.tsx", "@gsv/package/manifest")
        .expect("resolve injected sdk");

    assert_eq!(
        resolved.repo_path,
        "node_modules/@gsv/package/src/manifest.ts"
    );
    assert_eq!(
        resolved.package_json_path.as_deref(),
        Some("node_modules/@gsv/package/package.json")
    );
}

#[test]
fn semver_range_selects_highest_matching_published_version() {
    let mut request = base_request(r#"import lib from "left-pad"; export default lib;"#);
    request
        .analysis
        .package_json
        .dependencies
        .insert("left-pad".to_string(), "^1.0.0".to_string());
    request.files.remove("apps/demo/package-lock.json");

    let v1 = "https://registry.example/left-pad/-/left-pad-1.0.0.tgz";
    let v12 = "https://registry.example/left-pad/-/left-pad-1.2.0.tgz";
    let client = MockNpmRegistryClient::default()
        .with_package(
            "left-pad",
            packument(&[("1.0.0", v1), ("1.2.0", v12), ("2.0.0", "unused")]),
        )
        .with_tarball(
            v12,
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
        )
        .with_tarball(
            v1,
            tarball(&[
                (
                    "package.json",
                    br#"{
  "name": "left-pad",
  "version": "1.0.0",
  "main": "./index.js"
}"#,
                ),
                ("index.js", br#"module.exports = function leftPad() {};"#),
            ]),
        );

    let planned = prepare_request(&request).value.expect("planned request");
    let installed = install_registry_dependencies(&planned, &client)
        .value
        .expect("installed dependencies");

    let record = installed
        .install_records
        .iter()
        .find(|record| record.name == "left-pad")
        .expect("left-pad install record");
    assert_eq!(record.version, "1.2.0");
}

#[test]
fn installer_rejects_non_utf8_package_files() {
    let mut request = base_request(r#"import bin from "bad-pkg"; export default bin;"#);
    request
        .analysis
        .package_json
        .dependencies
        .insert("bad-pkg".to_string(), "1.0.0".to_string());
    request.files.remove("apps/demo/package-lock.json");

    let tarball_url = "https://registry.example/bad-pkg/-/bad-pkg-1.0.0.tgz";
    let client = MockNpmRegistryClient::default()
        .with_package("bad-pkg", packument(&[("1.0.0", tarball_url)]))
        .with_tarball(
            tarball_url,
            tarball(&[
                (
                    "package.json",
                    br#"{
  "name": "bad-pkg",
  "version": "1.0.0",
  "main": "./binary.dat"
}"#,
                ),
                ("binary.dat", &[0xff, 0xfe, 0x00, 0x01]),
            ]),
        );

    let planned = prepare_request(&request).value.expect("planned request");
    let outcome = install_registry_dependencies(&planned, &client);

    assert!(outcome.value.is_none());
    assert!(outcome
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == "install.unsupported-package"));
}

#[test]
fn transforms_typescript_and_preact_jsx_with_oxc() {
    let transformed = transform_source_text_with_oxc(
        "apps/demo/src/main.tsx",
        r#"type Props = { name?: string };

export default function App({ name }: Props) {
  return <main>{name ?? "hello"}</main>;
}"#,
    )
    .expect("transform tsx");

    assert!(transformed.contains("from \"preact/jsx-runtime\""));
    assert!(transformed.contains("function App({ name })"));
    assert!(transformed.contains("_jsx(\"main\""));
    assert!(!transformed.contains("type Props"));
    assert!(!transformed.contains(": Props"));
    assert!(!transformed.contains("<main>"));
}
