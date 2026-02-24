use std::env;
use std::time::{SystemTime, UNIX_EPOCH};

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

    let mut metadata_segments = Vec::new();
    if let Some(value) = channel.as_ref() {
        metadata_segments.push(value.clone());
    }
    if let Some(value) = run_number.as_ref() {
        metadata_segments.push(value.clone());
    }
    if let Some(value) = commit_sha.as_ref() {
        metadata_segments.push(value.clone());
    }

    let build_version = if metadata_segments.is_empty() {
        pkg_version.clone()
    } else {
        format!("{}+{}", pkg_version, metadata_segments.join("."))
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
