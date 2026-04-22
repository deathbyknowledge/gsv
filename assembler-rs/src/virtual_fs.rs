use std::collections::BTreeMap;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct VirtualFileTree {
    files: BTreeMap<String, String>,
}

impl VirtualFileTree {
    pub fn new(files: BTreeMap<String, String>) -> Self {
        let mut tree = Self::default();
        for (path, content) in files {
            tree.insert(path, content);
        }
        tree
    }

    pub fn insert(&mut self, path: impl AsRef<str>, content: impl Into<String>) {
        let normalized = normalize_repo_path(path.as_ref());
        self.files.insert(normalized, content.into());
    }

    pub fn insert_if_missing(&mut self, path: impl AsRef<str>, content: impl Into<String>) {
        let normalized = normalize_repo_path(path.as_ref());
        self.files
            .entry(normalized)
            .or_insert_with(|| content.into());
    }

    pub fn contains(&self, path: impl AsRef<str>) -> bool {
        let normalized = normalize_repo_path(path.as_ref());
        self.files.contains_key(&normalized)
    }

    pub fn get(&self, path: impl AsRef<str>) -> Option<&str> {
        let normalized = normalize_repo_path(path.as_ref());
        self.files.get(&normalized).map(String::as_str)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&String, &String)> {
        self.files.iter()
    }

    pub fn into_inner(self) -> BTreeMap<String, String> {
        self.files
    }
}

pub fn normalize_repo_path(path: &str) -> String {
    let mut segments = Vec::new();
    let replaced = path.replace('\\', "/");

    for segment in replaced.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            value => segments.push(value.to_string()),
        }
    }

    segments.join("/")
}

pub fn join_posix(base: &str, suffix: &str) -> String {
    if base.is_empty() {
        return normalize_repo_path(suffix);
    }
    if suffix.is_empty() {
        return normalize_repo_path(base);
    }
    normalize_repo_path(&format!("{base}/{suffix}"))
}

pub fn dirname(path: &str) -> String {
    let normalized = normalize_repo_path(path);
    match normalized.rsplit_once('/') {
        Some((dir, _)) => dir.to_string(),
        None => String::new(),
    }
}

pub fn resolve_from_root(root: &str, value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return normalize_repo_path(root);
    }
    if root.is_empty() {
        return normalize_repo_path(trimmed);
    }
    join_posix(root, trimmed)
}

pub fn extension(path: &str) -> Option<String> {
    let normalized = normalize_repo_path(path);
    normalized.rsplit_once('.').map(|(_, ext)| ext.to_string())
}

pub fn is_path_within_root(path: &str, root: &str) -> bool {
    if root.is_empty() {
        return true;
    }
    let normalized_path = normalize_repo_path(path);
    let normalized_root = normalize_repo_path(root);
    normalized_path == normalized_root
        || normalized_path.starts_with(&format!("{normalized_root}/"))
}

pub fn relativize_to_root(path: &str, root: &str) -> String {
    let normalized_path = normalize_repo_path(path);
    let normalized_root = normalize_repo_path(root);
    if normalized_root.is_empty() {
        return normalized_path;
    }
    normalized_path
        .strip_prefix(&format!("{normalized_root}/"))
        .unwrap_or(&normalized_path)
        .to_string()
}

pub fn relative_specifier(from_path: &str, to_path: &str) -> String {
    let from_parts = split_segments(&dirname(from_path));
    let to_parts = split_segments(to_path);
    let mut common = 0;
    while common < from_parts.len()
        && common < to_parts.len()
        && from_parts[common] == to_parts[common]
    {
        common += 1;
    }

    let mut parts = Vec::new();
    for _ in common..from_parts.len() {
        parts.push("..".to_string());
    }
    for part in to_parts.iter().skip(common) {
        parts.push(part.clone());
    }

    if parts.is_empty() {
        return "./".to_string();
    }
    let joined = parts.join("/");
    if joined.starts_with("../") {
        joined
    } else {
        format!("./{joined}")
    }
}

fn split_segments(path: &str) -> Vec<String> {
    normalize_repo_path(path)
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(ToString::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        dirname, extension, is_path_within_root, join_posix, normalize_repo_path,
        relative_specifier, relativize_to_root, resolve_from_root,
    };

    #[test]
    fn normalizes_repo_paths() {
        assert_eq!(
            normalize_repo_path("./src/../src\\main.tsx"),
            "src/main.tsx"
        );
        assert_eq!(
            normalize_repo_path("/apps/demo/./src/index.ts"),
            "apps/demo/src/index.ts"
        );
    }

    #[test]
    fn joins_paths_deterministically() {
        assert_eq!(
            join_posix("apps/demo", "./src/main.tsx"),
            "apps/demo/src/main.tsx"
        );
        assert_eq!(resolve_from_root("", "./src/main.ts"), "src/main.ts");
    }

    #[test]
    fn resolves_directory_and_extension() {
        assert_eq!(dirname("apps/demo/src/main.tsx"), "apps/demo/src");
        assert_eq!(extension("apps/demo/src/main.tsx").as_deref(), Some("tsx"));
    }

    #[test]
    fn relativizes_and_computes_specifiers() {
        assert!(is_path_within_root("apps/demo/src/main.tsx", "apps/demo"));
        assert_eq!(
            relativize_to_root("apps/demo/src/main.tsx", "apps/demo"),
            "src/main.tsx"
        );
        assert_eq!(
            relative_specifier("__gsv__/main.ts", "src/package.ts"),
            "../src/package.ts"
        );
    }
}
