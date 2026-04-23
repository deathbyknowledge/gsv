use std::collections::BTreeMap;

use assembler_rs::diagnostics::PackageAssemblyDiagnostic;
use assembler_rs::model::{
    PackageAssemblyAnalysis, PackageAssemblyRequest, PackageAssemblySource,
    PackageAssemblyTarget, PackageBackendDefinition, PackageBrowserDefinition,
    PackageCapabilityDefinition, PackageCommandDefinition, PackageDefinition, PackageIdentity,
    PackageJsonDefinition, PackageMetaDefinition,
};
use assembler_rs::pipeline::{
    plan_installs, prepare_request, prepare_sources, validate_request, RegistryDependencyPlanItem,
};

fn base_request() -> PackageAssemblyRequest {
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
        files: files([
            (
                "apps/demo/src/main.tsx",
                "export default function App() { return null; }",
            ),
            ("apps/demo/src/styles.css", "body { color: red; }"),
            (
                "apps/demo/package-lock.json",
                r#"{
  "packages": {
    "": { "version": "0.1.0" }
  }
}"#,
            ),
        ]),
    }
}

fn files<const N: usize>(entries: [(&str, &str); N]) -> BTreeMap<String, String> {
    entries
        .into_iter()
        .map(|(path, content)| (path.to_string(), content.to_string()))
        .collect()
}

fn diagnostic_codes(diagnostics: &[PackageAssemblyDiagnostic]) -> Vec<&str> {
    diagnostics
        .iter()
        .map(|diagnostic| diagnostic.code.as_str())
        .collect()
}

fn find_plan_item<'a>(
    items: &'a [RegistryDependencyPlanItem],
    name: &str,
) -> &'a RegistryDependencyPlanItem {
    items
        .iter()
        .find(|item| item.name == name)
        .expect("missing plan item")
}

#[test]
fn rejects_failed_analysis() {
    let mut request = base_request();
    request.analysis.ok = false;
    request
        .analysis
        .diagnostics
        .push(PackageAssemblyDiagnostic::error(
            "analysis.parse-failed",
            "package.ts could not be parsed",
            "apps/demo/src/package.ts",
        ));

    let outcome = validate_request(&request);

    assert!(outcome.value.is_none());
    assert!(diagnostic_codes(&outcome.diagnostics).contains(&"analysis.parse-failed"));
    assert!(diagnostic_codes(&outcome.diagnostics).contains(&"analysis.failed"));
}

#[test]
fn rejects_html_browser_entry() {
    let mut request = base_request();
    request.analysis.definition.as_mut().unwrap().browser = Some(PackageBrowserDefinition {
        entry: "./src/index.html".to_string(),
        assets: vec!["./src/styles.css".to_string()],
    });
    request.files.insert(
        "apps/demo/src/index.html".to_string(),
        "<html></html>".to_string(),
    );

    let outcome = validate_request(&request);

    assert!(outcome.value.is_none());
    assert!(diagnostic_codes(&outcome.diagnostics).contains(&"contract.browser-entry-html"));
}

#[test]
fn rejects_missing_browser_entry_file() {
    let mut request = base_request();
    request.files.remove("apps/demo/src/main.tsx");

    let outcome = validate_request(&request);

    assert!(outcome.value.is_none());
    assert!(diagnostic_codes(&outcome.diagnostics).contains(&"contract.browser-entry-missing"));
}

#[test]
fn accepts_declarative_browser_definition() {
    let mut request = base_request();
    request.analysis.definition.as_mut().unwrap().meta.icon = Some("./ui/icon.svg".to_string());
    request.files.insert(
        "apps/demo/ui/icon.svg".to_string(),
        "<svg></svg>".to_string(),
    );

    let outcome = validate_request(&request);

    assert!(outcome.value.is_some());
    let validated = outcome.value.unwrap();
    assert_eq!(
        validated.browser_entry.as_deref(),
        Some("apps/demo/src/main.tsx")
    );
    assert_eq!(
        validated.asset_paths,
        vec![
            "apps/demo/src/styles.css".to_string(),
            "apps/demo/ui/icon.svg".to_string(),
        ]
    );
}

#[test]
fn accepts_declarative_backend_and_command_definitions() {
    let mut request = base_request();
    request.analysis.definition.as_mut().unwrap().backend = Some(PackageBackendDefinition {
        entry: "./src/backend.ts".to_string(),
        public_routes: vec!["/webhooks/github".to_string()],
    });
    request.analysis.definition.as_mut().unwrap().commands = vec![PackageCommandDefinition {
        name: "sync".to_string(),
        entry: Some("./src/cli/sync.ts".to_string()),
    }];
    request.files.extend(files([
        (
            "apps/demo/src/backend.ts",
            "export default class DemoBackend { async ping(args) { return args; } }",
        ),
        (
            "apps/demo/src/cli/sync.ts",
            "export default async function run(ctx) { await ctx.stdout.write('ok'); }",
        ),
    ]));

    let outcome = validate_request(&request);

    assert!(outcome.value.is_some());
    let validated = outcome.value.unwrap();
    assert_eq!(
        validated.backend_entry.as_deref(),
        Some("apps/demo/src/backend.ts")
    );
    assert_eq!(
        validated.command_entries.get("sync").map(String::as_str),
        Some("apps/demo/src/cli/sync.ts")
    );
}

#[test]
fn rejects_missing_backend_and_command_entry_files() {
    let mut request = base_request();
    request.analysis.definition.as_mut().unwrap().backend = Some(PackageBackendDefinition {
        entry: "./src/backend.ts".to_string(),
        public_routes: Vec::new(),
    });
    request.analysis.definition.as_mut().unwrap().commands = vec![PackageCommandDefinition {
        name: "sync".to_string(),
        entry: Some("./src/cli/sync.ts".to_string()),
    }];

    let outcome = validate_request(&request);

    assert!(outcome.value.is_none());
    assert!(diagnostic_codes(&outcome.diagnostics).contains(&"contract.backend-entry-missing"));
    assert!(diagnostic_codes(&outcome.diagnostics).contains(&"contract.command-entry-missing"));
}

#[test]
fn rejects_missing_asset_file() {
    let mut request = base_request();
    request.files.remove("apps/demo/src/styles.css");

    let outcome = validate_request(&request);

    assert!(outcome.value.is_none());
    assert!(diagnostic_codes(&outcome.diagnostics).contains(&"contract.asset-missing"));
}

#[test]
fn rejects_missing_icon_file() {
    let mut request = base_request();
    request.analysis.definition.as_mut().unwrap().meta.icon = Some("./ui/icon.svg".to_string());

    let outcome = validate_request(&request);

    assert!(outcome.value.is_none());
    assert!(diagnostic_codes(&outcome.diagnostics).contains(&"contract.icon-missing"));
}

#[test]
fn prepare_sources_injects_sdk_fallbacks_and_materializes_workspace_packages() {
    let mut request = base_request();
    request.files.extend(files([
        (
            "packages/local-ui/package.json",
            r#"{
  "name": "local-ui",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "@gsv/package": "^0.1.0"
  }
}"#,
        ),
        (
            "packages/local-ui/src/index.ts",
            "export const localUi = true;",
        ),
    ]));

    let validated = validate_request(&request);
    let prepared = prepare_sources(validated.value.as_ref().expect("validated"));
    let prepared = prepared.value.expect("prepared");

    assert!(prepared
        .files
        .contains("node_modules/@gsv/package/src/worker.ts"));
    assert!(prepared
        .files
        .contains("node_modules/@gsv/app-link/src/index.ts"));
    assert!(prepared
        .files
        .contains("node_modules/local-ui/src/index.ts"));
}

#[test]
fn prepare_sources_uses_repo_sdk_packages_when_declared() {
    let mut request = base_request();
    request.files.extend(files([
        (
            "vendor/gsv-package/package.json",
            r#"{
  "name": "@gsv/package",
  "version": "9.9.9",
  "type": "module"
}"#,
        ),
        (
            "vendor/gsv-package/src/index.ts",
            "export const source = 'repo';",
        ),
        (
            "vendor/app-link/package.json",
            r#"{
  "name": "@gsv/app-link",
  "version": "9.9.9",
  "type": "module"
}"#,
        ),
        (
            "vendor/app-link/src/index.ts",
            "export const source = 'repo';",
        ),
    ]));

    let validated = validate_request(&request);
    let prepared = prepare_sources(validated.value.as_ref().expect("validated"));
    let prepared = prepared.value.expect("prepared");

    assert!(!prepared
        .files
        .contains("__gsv_sdk/@gsv/package/package.json"));
    assert_eq!(
        prepared.files.get("node_modules/@gsv/package/src/index.ts"),
        Some("export const source = 'repo';")
    );
    assert_eq!(
        prepared
            .files
            .get("node_modules/@gsv/app-link/src/index.ts"),
        Some("export const source = 'repo';")
    );
}

#[test]
fn install_plan_prefers_lockfile_versions() {
    let mut request = base_request();
    request.analysis.package_json.dependencies.extend(
        [("react".to_string(), "^18.0.0".to_string())]
            .into_iter()
            .collect::<BTreeMap<_, _>>(),
    );
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
    request.files.extend(files([
        (
            "packages/local-ui/package.json",
            r#"{
  "name": "local-ui",
  "version": "1.0.0",
  "dependencies": {
    "lodash": "^4.17.0"
  }
}"#,
        ),
        ("packages/local-ui/src/index.ts", "export {};"),
        (
            "packages/local-ui/package-lock.json",
            r#"{
  "packages": {
    "": { "version": "1.0.0" },
    "node_modules/lodash": { "version": "4.17.21" }
  }
}"#,
        ),
    ]));

    let planned = prepare_request(&request).value.expect("planned");

    assert_eq!(
        find_plan_item(&planned.install_plan.registry_dependencies, "react").install_spec,
        "18.3.1"
    );
    assert_eq!(
        find_plan_item(&planned.install_plan.registry_dependencies, "lodash").install_spec,
        "4.17.21"
    );
}

#[test]
fn install_plan_skips_local_file_workspace_and_dev_dependencies() {
    let mut request = base_request();
    request.analysis.package_json.dependencies.extend(
        [
            ("local-ui".to_string(), "workspace:*".to_string()),
            ("linked-ui".to_string(), "file:../linked-ui".to_string()),
            ("@gsv/package".to_string(), "^0.1.0".to_string()),
            ("react".to_string(), "^18.0.0".to_string()),
        ]
        .into_iter()
        .collect::<BTreeMap<_, _>>(),
    );
    request
        .analysis
        .package_json
        .dev_dependencies
        .insert("react-dom".to_string(), "^18.0.0".to_string());
    request.files.extend(files([
        (
            "packages/local-ui/package.json",
            r#"{
  "name": "local-ui",
  "version": "1.0.0"
}"#,
        ),
        ("packages/local-ui/src/index.ts", "export {};"),
    ]));

    let planned = prepare_request(&request).value.expect("planned");
    let names: Vec<&str> = planned
        .install_plan
        .registry_dependencies
        .iter()
        .map(|item| item.name.as_str())
        .collect();

    assert_eq!(names, vec!["react"]);
}

#[test]
fn install_plan_merges_matching_dependency_requests() {
    let mut request = base_request();
    request
        .analysis
        .package_json
        .dependencies
        .insert("react".to_string(), "^18.0.0".to_string());
    request.files.insert(
        "apps/demo/package-lock.json".to_string(),
        r#"{
  "packages": {
    "node_modules/react": { "version": "18.3.1" }
  }
}"#
        .to_string(),
    );
    request.files.extend(files([
        (
            "packages/local-ui/package.json",
            r#"{
  "name": "local-ui",
  "version": "1.0.0",
  "dependencies": {
    "react": "^18.0.0"
  }
}"#,
        ),
        ("packages/local-ui/src/index.ts", "export {};"),
        (
            "packages/local-ui/package-lock.json",
            r#"{
  "packages": {
    "node_modules/react": { "version": "18.3.1" }
  }
}"#,
        ),
    ]));

    let planned = prepare_request(&request).value.expect("planned");
    let react = find_plan_item(&planned.install_plan.registry_dependencies, "react");

    assert_eq!(react.install_spec, "18.3.1");
    assert_eq!(react.requested_by, vec!["@demo/app", "local-ui"]);
}

#[test]
fn install_plan_reports_conflicting_dependency_specs() {
    let mut request = base_request();
    request
        .analysis
        .package_json
        .dependencies
        .insert("react".to_string(), "^18.0.0".to_string());
    request.files.extend(files([
        (
            "packages/local-ui/package.json",
            r#"{
  "name": "local-ui",
  "version": "1.0.0",
  "dependencies": {
    "react": "^17.0.0"
  }
}"#,
        ),
        ("packages/local-ui/src/index.ts", "export {};"),
    ]));

    let validated = validate_request(&request);
    let prepared = prepare_sources(validated.value.as_ref().expect("validated"));
    let installs = plan_installs(prepared.value.as_ref().expect("prepared"));

    assert!(installs.value.is_none());
    assert!(diagnostic_codes(&installs.diagnostics).contains(&"install.version-conflict"));
}

#[test]
fn prepare_request_carries_normalized_browser_entry_and_assets() {
    let planned = prepare_request(&base_request()).value.expect("planned");

    assert_eq!(
        planned.browser_entry.as_deref(),
        Some("apps/demo/src/main.tsx")
    );
    assert_eq!(planned.asset_paths, vec!["apps/demo/src/styles.css"]);
}

#[test]
fn invalid_lockfile_surfaces_a_diagnostic() {
    let mut request = base_request();
    request
        .files
        .insert("apps/demo/package-lock.json".to_string(), "{".to_string());

    let validated = validate_request(&request);
    let prepared = prepare_sources(validated.value.as_ref().expect("validated"));

    assert!(prepared.value.is_none());
    assert!(diagnostic_codes(&prepared.diagnostics).contains(&"install.lockfile-invalid"));
}
