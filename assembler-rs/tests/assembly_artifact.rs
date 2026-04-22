use std::collections::BTreeMap;

use assembler_rs::artifact::finalize_artifact;
use assembler_rs::model::{
    PackageAppDefinition, PackageAppHandlerDefinition, PackageAssemblyAnalysis,
    PackageAssemblyArtifactModuleKind, PackageAssemblyRequest, PackageAssemblySource,
    PackageAssemblyTarget, PackageCapabilityDefinition, PackageDefinition, PackageIdentity,
    PackageJsonDefinition, PackageMetaDefinition,
};
use assembler_rs::npm::{
    install_registry_dependencies, NpmPackument, NpmRegistryClient, NpmRegistryError,
};
use assembler_rs::pipeline::prepare_request;
use assembler_rs::runtime::build_runtime_assembly;

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
                commands: Vec::new(),
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
                "apps/demo/src/package.ts".to_string(),
                r#"import { definePackage } from "@gsv/package/worker";
export default definePackage({
  meta: { displayName: "Demo" },
  app: {
    browser: { entry: "./src/main.tsx" },
    assets: ["./src/styles.css"],
    rpc: {
      async ping(args) { return args; }
    }
  }
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
    }
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

    let wrapper = modules.get("__gsv__/main.ts").unwrap().content.as_str();
    assert!(wrapper.contains("import definition from \"../src/package.ts\";"));
    assert!(wrapper.contains("class GsvPackageAppBackend extends RpcTarget"));
    assert!(wrapper.contains("async [\"ping\"](args)"));
    assert!(wrapper.contains("const BROWSER_ENTRY = \"src/main.tsx\";"));
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
