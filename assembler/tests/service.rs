use std::collections::BTreeMap;

use assembler::model::{
    PackageAssemblyAnalysis, PackageAssemblyRequest, PackageAssemblySource, PackageAssemblyTarget,
    PackageBackendDefinition, PackageBrowserDefinition, PackageCapabilityDefinition,
    PackageCommandDefinition, PackageDefinition, PackageIdentity, PackageJsonDefinition,
    PackageMetaDefinition,
};
use assembler::npm::{NpmPackument, NpmRegistryClient, NpmRegistryError};
use assembler::service::assemble_package_with_client;

#[derive(Clone, Debug, Default)]
struct EmptyRegistry;

impl NpmRegistryClient for EmptyRegistry {
    fn fetch_packument(&self, _package_name: &str) -> Result<NpmPackument, NpmRegistryError> {
        Err(NpmRegistryError::Request("not used".to_string()))
    }

    fn fetch_tarball(&self, _tarball_url: &str) -> Result<Vec<u8>, NpmRegistryError> {
        Err(NpmRegistryError::Request("not used".to_string()))
    }
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
  browser: { entry: "./src/main.tsx", assets: ["./src/styles.css"] },
  backend: { entry: "./src/backend.ts", public_routes: ["/webhooks/github"] },
  cli: { commands: { sync: "./src/cli/sync.ts" } }
});"#
                    .to_string(),
            ),
            (
                "apps/demo/src/main.tsx".to_string(),
                r#"export default function App() { return null; }"#.to_string(),
            ),
            (
                "apps/demo/src/backend.ts".to_string(),
                r#"export default class DemoBackend {
  async ping(args) { return args; }
}"#
                .to_string(),
            ),
            (
                "apps/demo/src/cli/sync.ts".to_string(),
                r#"export default async function run(ctx) {
  await ctx.stdout.write("synced");
}"#
                .to_string(),
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

#[test]
fn service_returns_protocol_response_with_artifact() {
    let response = assemble_package_with_client(&request(), &EmptyRegistry);

    assert!(response.ok);
    assert_eq!(response.source.repo, "gsv/example");
    assert_eq!(response.analysis_hash, "analysis-hash");
    assert_eq!(response.target.as_str(), "dynamic-worker");
    let artifact = response.artifact.expect("artifact");
    assert_eq!(artifact.main_module, "__gsv__/main.ts");
    assert!(artifact
        .modules
        .iter()
        .any(|module| module.path == "__gsv__/main.ts"));
    let wrapper = artifact
        .modules
        .iter()
        .find(|module| module.path == "__gsv__/main.ts")
        .expect("wrapper module");
    assert!(wrapper
        .content
        .contains("const BROWSER_ENTRY = \"__gsv_browser__/src/main.js\";"));
}

#[test]
fn service_returns_failure_response_without_artifact() {
    let mut req = request();
    req.analysis.ok = false;

    let response = assemble_package_with_client(&req, &EmptyRegistry);

    assert!(!response.ok);
    assert!(response.artifact.is_none());
    assert!(response
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == "analysis.failed"));
}
