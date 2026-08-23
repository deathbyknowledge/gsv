use std::env;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdapterCatalog {
    version: u8,
    adapters: Vec<AdapterCatalogEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdapterCatalogEntry {
    id: String,
    display_name: String,
    description: String,
    component: String,
    default_script: String,
    instance_suffix: String,
    gateway_binding: String,
    entrypoint: String,
    deploy_order: usize,
}

fn sanitize_segment(raw: &str) -> String {
    raw.trim()
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
        .collect()
}

fn optional_env(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn main() {
    println!("cargo:rerun-if-env-changed=GSV_BUILD_CHANNEL");
    println!("cargo:rerun-if-env-changed=GSV_BUILD_SHA");
    println!("cargo:rerun-if-env-changed=GSV_BUILD_RUN_NUMBER");
    println!("cargo:rerun-if-env-changed=GSV_BUILD_TAG");
    println!("cargo:rerun-if-env-changed=GSV_BUILD_TIMESTAMP");

    generate_adapter_catalog();

    let pkg_version = env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "0.0.0".to_string());
    let channel = optional_env("GSV_BUILD_CHANNEL")
        .map(|value| sanitize_segment(&value))
        .filter(|value| !value.is_empty());
    let run_number = optional_env("GSV_BUILD_RUN_NUMBER")
        .map(|value| sanitize_segment(&value))
        .filter(|value| !value.is_empty());
    let release_tag = optional_env("GSV_BUILD_TAG")
        .map(|value| sanitize_segment(&value))
        .filter(|value| !value.is_empty());
    let commit_sha = optional_env("GSV_BUILD_SHA")
        .map(|value| sanitize_segment(&value))
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(12).collect::<String>());
    let timestamp = optional_env("GSV_BUILD_TIMESTAMP").unwrap_or_else(|| {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        now.to_string()
    });

    let build_version = match channel.as_deref() {
        Some("stable") | None => pkg_version.clone(),
        Some(value) => {
            let mut prerelease_segments = vec![value.to_string()];
            if let Some(run) = run_number.as_ref() {
                prerelease_segments.push(run.clone());
            }
            let mut build = format!("{}-{}", pkg_version, prerelease_segments.join("."));
            if let Some(sha) = commit_sha.as_ref() {
                build.push('+');
                build.push_str(sha);
            }
            build
        }
    };

    println!("cargo:rustc-env=GSV_BUILD_VERSION={}", build_version);
    println!(
        "cargo:rustc-env=GSV_BUILD_CHANNEL={}",
        channel.unwrap_or_default()
    );
    println!(
        "cargo:rustc-env=GSV_BUILD_SHA={}",
        commit_sha.unwrap_or_default()
    );
    println!(
        "cargo:rustc-env=GSV_BUILD_RUN_NUMBER={}",
        run_number.unwrap_or_default()
    );
    println!(
        "cargo:rustc-env=GSV_BUILD_TAG={}",
        release_tag.unwrap_or_default()
    );
    println!("cargo:rustc-env=GSV_BUILD_TIMESTAMP={}", timestamp);
}

fn generate_adapter_catalog() {
    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".to_string()));
    let catalog_path = manifest_dir.join("../../../adapters/catalog.json");
    println!("cargo:rerun-if-changed={}", catalog_path.display());
    let source = fs::read_to_string(&catalog_path)
        .unwrap_or_else(|error| panic!("failed to read adapter catalog: {error}"));
    let catalog: AdapterCatalog = serde_json::from_str(&source)
        .unwrap_or_else(|error| panic!("failed to parse adapter catalog: {error}"));
    assert_eq!(catalog.version, 1, "unsupported adapter catalog version");
    assert!(
        !catalog.adapters.is_empty(),
        "adapter catalog cannot be empty"
    );

    let mut ids = std::collections::BTreeSet::new();
    let mut components = std::collections::BTreeSet::new();
    let mut bindings = std::collections::BTreeSet::new();
    let mut generated = String::new();
    let mut component_constants = Vec::new();
    let mut entries = Vec::new();

    for adapter in catalog.adapters {
        validate_catalog_entry(&adapter);
        assert!(ids.insert(adapter.id.clone()), "duplicate adapter id");
        assert!(
            components.insert(adapter.component.clone()),
            "duplicate adapter component"
        );
        assert!(
            bindings.insert(adapter.gateway_binding.clone()),
            "duplicate adapter binding"
        );

        let identifier = adapter
            .id
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() {
                    character.to_ascii_uppercase()
                } else {
                    '_'
                }
            })
            .collect::<String>();
        let component_constant = format!("COMPONENT_CHANNEL_{identifier}");
        let script_constant = format!("SCRIPT_CHANNEL_{identifier}");
        let bundle_constant = format!("BUNDLE_CHANNEL_{identifier}");
        generated.push_str(&format!(
            "const {component_constant}: &str = {:?};\nconst {script_constant}: &str = {:?};\nconst {bundle_constant}: &str = {:?};\n",
            adapter.component,
            adapter.default_script,
            format!("gsv-cloudflare-{}.tar.gz", adapter.component),
        ));
        component_constants.push(component_constant.clone());
        entries.push(format!(
            "    AdapterDeploymentSpec {{ description: {:?}, component: {component_constant}, bundle: {bundle_constant}, default_script: {script_constant}, script_suffix: {:?}, gateway_binding: {:?}, adapter_entrypoint: {:?}, deploy_order: {} }},",
            adapter.description,
            adapter.instance_suffix,
            adapter.gateway_binding,
            adapter.entrypoint,
            adapter.deploy_order,
        ));
    }

    generated.push_str("const ADAPTER_DEPLOYMENTS: &[AdapterDeploymentSpec] = &[\n");
    for entry in entries {
        generated.push_str(&entry);
        generated.push('\n');
    }
    generated.push_str(
        "];\nconst AVAILABLE_COMPONENTS: &[&str] = &[COMPONENT_RIPGIT, COMPONENT_GATEWAY",
    );
    for component in component_constants {
        generated.push_str(", ");
        generated.push_str(&component);
    }
    generated.push_str("];\n");

    let output_path =
        PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR is required")).join("adapter_catalog.rs");
    fs::write(output_path, generated)
        .unwrap_or_else(|error| panic!("failed to generate adapter catalog: {error}"));
}

fn validate_catalog_entry(adapter: &AdapterCatalogEntry) {
    let id_valid = !adapter.id.is_empty()
        && adapter.id.len() <= 64
        && adapter
            .id
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_lowercase())
        && adapter.id.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        });
    assert!(id_valid, "invalid adapter id");
    assert!(
        !adapter.display_name.trim().is_empty(),
        "missing adapter display name"
    );
    assert!(
        !adapter.description.trim().is_empty(),
        "missing adapter description"
    );
    assert_eq!(adapter.component, format!("channel-{}", adapter.id));
    assert_eq!(adapter.instance_suffix, adapter.component);
    assert_eq!(
        adapter.gateway_binding,
        format!(
            "CHANNEL_{}",
            adapter.id.replace('-', "_").to_ascii_uppercase()
        )
    );
    assert!(
        !adapter.entrypoint.trim().is_empty(),
        "missing adapter entrypoint"
    );
}
