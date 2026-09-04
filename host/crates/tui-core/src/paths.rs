//! Path and reference helpers for targets, files, and inline artifacts.

#[allow(unused_imports)]
use crate::prelude::*;

pub(crate) fn media_kind_from_content_type(content_type: &str) -> MediaKind {
    if content_type.starts_with("image/") {
        MediaKind::Image
    } else if content_type.starts_with("audio/") {
        MediaKind::Audio
    } else if content_type.starts_with("video/") {
        MediaKind::Video
    } else {
        MediaKind::Document
    }
}

pub(crate) fn reference_token(reference: &FileReference) -> String {
    format!("@{}", sanitize_label(&reference.filename, "file", 200))
}

pub(crate) fn target_resource_path(value: &str) -> Option<(String, String)> {
    if value.starts_with('/')
        || value.starts_with("~/")
        || value.starts_with("./")
        || value.starts_with("../")
    {
        return None;
    }
    let (target, path) = value.split_once(':')?;
    if target.is_empty()
        || !path.starts_with('/')
        || target.chars().any(|character| {
            character.is_control() || character.is_whitespace() || character == '/'
        })
    {
        return None;
    }
    Some((target.to_string(), path.to_string()))
}

pub(crate) fn resolve_environment_path(path: &str, cwd: Option<&str>) -> String {
    if !(path.starts_with("./") || path.starts_with("../")) {
        return path.to_string();
    }
    let Some(cwd) = cwd.filter(|cwd| !cwd.trim().is_empty()) else {
        return path.to_string();
    };
    normalize_unix_path(&format!(
        "{}/{}",
        cwd.trim_end_matches('/'),
        path.trim_start_matches("./")
    ))
}

pub(crate) fn normalize_unix_path(path: &str) -> String {
    let (prefix, remainder) = if let Some(remainder) = path.strip_prefix("~/") {
        ("~/", remainder)
    } else if let Some(remainder) = path.strip_prefix('/') {
        ("/", remainder)
    } else {
        return path.to_string();
    };
    let mut components = Vec::new();
    for component in remainder.split('/') {
        match component {
            "" | "." => {}
            ".." => {
                components.pop();
            }
            component => components.push(component),
        }
    }
    format!("{prefix}{}", components.join("/"))
}

pub(crate) fn file_reference_from_artifact(artifact: &Artifact) -> Option<FileReference> {
    let (target, path) = artifact.source.as_deref()?.split_once(':')?;
    let revision = artifact.revision.as_deref()?;
    let size = artifact.size?;
    if target.is_empty() || path.is_empty() || revision.is_empty() {
        return None;
    }
    Some(FileReference {
        target: target.to_string(),
        path: path.to_string(),
        revision: revision.to_string(),
        content_type: artifact.mime_type.clone(),
        size,
        filename: artifact.display_name().to_string(),
    })
}

pub(crate) fn draft_references_from_artifacts(
    text: &str,
    artifacts: &[Artifact],
) -> Vec<DraftReference> {
    let mut references = Vec::new();
    for artifact in artifacts {
        let Some(reference) = file_reference_from_artifact(artifact) else {
            continue;
        };
        let token = reference_token(&reference);
        let occurrence = text.match_indices(&token).find(|(start, _)| {
            let end = start.saturating_add(token.len());
            references
                .iter()
                .all(|existing: &DraftReference| existing.end <= *start || existing.start >= end)
        });
        if let Some((start, _)) = occurrence {
            references.push(DraftReference {
                start,
                end: start.saturating_add(token.len()),
                reference,
            });
        }
    }
    references.sort_by_key(|reference| reference.start);
    references
}

pub(crate) fn inline_artifact_occurrences(
    text: &str,
    artifacts: &[Artifact],
) -> Vec<Option<(usize, usize)>> {
    let mut occupied = Vec::<(usize, usize)>::new();
    artifacts
        .iter()
        .map(|artifact| {
            let reference = file_reference_from_artifact(artifact)?;
            let token = reference_token(&reference);
            let (start, _) = text.match_indices(&token).find(|(start, _)| {
                let end = start.saturating_add(token.len());
                occupied
                    .iter()
                    .all(|(left, right)| *right <= *start || *left >= end)
            })?;
            let occurrence = (start, start.saturating_add(token.len()));
            occupied.push(occurrence);
            Some(occurrence)
        })
        .collect()
}

pub(crate) fn unix_parent(path: &str) -> Option<String> {
    let path = path.trim_end_matches('/');
    if path.is_empty() || path == "~" {
        return None;
    }
    if path == "/" {
        return None;
    }
    let separator = path.rfind('/')?;
    if separator == 0 {
        Some("/".to_string())
    } else if separator == 1 && path.starts_with('~') {
        Some("~".to_string())
    } else {
        Some(path[..separator].to_string())
    }
}
