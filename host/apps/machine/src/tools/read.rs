use crate::file_revision::file_revision;
use crate::protocol::ToolDefinition;
use crate::tools::{Tool, ToolBody, ToolOutput};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

const MIME_SNIFF_BYTES: u64 = 8192;

pub struct ReadTool {
    workspace: PathBuf,
    device_id: String,
}

impl ReadTool {
    pub fn new(workspace: PathBuf) -> Self {
        Self::for_device(workspace, "local".to_string())
    }

    pub fn for_device(workspace: PathBuf, device_id: String) -> Self {
        Self {
            workspace,
            device_id,
        }
    }

    fn resolve_path(&self, path: &str) -> PathBuf {
        let path = PathBuf::from(path);
        if path.is_absolute() {
            path
        } else {
            self.workspace.join(path)
        }
    }
}

#[derive(Deserialize)]
struct ReadArgs {
    path: String,
    #[serde(default)]
    offset: Option<usize>,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(rename = "maxBytes", default)]
    max_bytes: Option<usize>,
    #[serde(default)]
    representation: Option<String>,
}

struct TextSelection {
    content: String,
    lines: usize,
    truncated: bool,
    next_offset: Option<usize>,
}

fn format_byte_size(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{} bytes", bytes)
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

fn read_directory(path: &Path) -> Result<ToolOutput, String> {
    let entries =
        fs::read_dir(path).map_err(|e| format!("Failed to read '{}': {}", path.display(), e))?;

    let mut files = Vec::new();
    let mut directories = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read '{}': {}", path.display(), e))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let file_type = entry
            .file_type()
            .map_err(|e| format!("Failed to inspect '{}': {}", entry.path().display(), e))?;

        if file_type.is_dir() {
            directories.push(name);
        } else {
            files.push(name);
        }
    }

    directories.sort();
    files.sort();

    Ok(ToolOutput::json(json!({
        "ok": true,
        "path": path.display().to_string(),
        "files": files,
        "directories": directories
    })))
}

#[async_trait]
impl Tool for ReadTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "Read".to_string(),
            description: "Read file contents. Paths are relative to the workspace unless absolute."
                .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Path to the file to read"
                    },
                    "offset": {
                        "type": "number",
                        "description": "Line number to start reading from (0-based, optional)"
                    },
                    "limit": {
                        "type": "number",
                        "description": "Maximum number of lines to read (optional)"
                    }
                },
                "required": ["path"]
            }),
        }
    }

    async fn execute(&self, args: Value) -> Result<ToolOutput, String> {
        let args: ReadArgs =
            serde_json::from_value(args).map_err(|e| format!("Invalid arguments: {}", e))?;

        let resolved = self.resolve_path(&args.path);
        let metadata = tokio::fs::metadata(&resolved)
            .await
            .map_err(|e| format!("Failed to read '{}': {}", resolved.display(), e))?;

        if metadata.is_dir() {
            return read_directory(&resolved);
        }

        let size = metadata.len();
        let mut file = tokio::fs::File::open(&resolved)
            .await
            .map_err(|e| format!("Failed to read '{}': {}", resolved.display(), e))?;
        let mut header = Vec::new();
        (&mut file)
            .take(MIME_SNIFF_BYTES)
            .read_to_end(&mut header)
            .await
            .map_err(|e| format!("Failed to read '{}': {}", resolved.display(), e))?;
        file.rewind()
            .await
            .map_err(|e| format!("Failed to read '{}': {}", resolved.display(), e))?;
        let content_type = infer::get(&header)
            .map(|kind| kind.mime_type())
            .unwrap_or_else(|| infer_content_type(&resolved));

        if content_type.starts_with("image/") && !is_text_content_type(content_type) {
            if args.representation.as_deref() == Some("resource") {
                return Ok(ToolOutput::json(json!({
                    "ok": true,
                    "path": resolved.display().to_string(),
                    "size": size,
                    "kind": "image",
                    "contentType": content_type,
                    "resource": {
                        "type": "file",
                        "target": self.device_id,
                        "path": resolved.display().to_string(),
                        "revision": file_revision(&metadata),
                        "contentType": content_type,
                        "size": size,
                    },
                })));
            }
            return Ok(ToolOutput::with_body(
                json!({
                    "ok": true,
                    "path": resolved.display().to_string(),
                    "size": size,
                    "kind": "image",
                    "contentType": content_type,
                }),
                ToolBody::reader(file, Some(size), None, resolved.display().to_string()),
            ));
        }

        let binary_error = || {
            format!(
                "Binary file ({}, {}) - not a text file",
                content_type,
                format_byte_size(size)
            )
        };
        if !is_text_content_type(content_type) {
            return Err(binary_error());
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .await
            .map_err(|e| format!("Failed to read '{}': {}", resolved.display(), e))?;
        let content = String::from_utf8(bytes).map_err(|_error| binary_error())?;
        let offset = args.offset.unwrap_or(0);
        let selection = select_text_lines(&content, offset, args.limit, args.max_bytes)?;
        let body = selection.content.into_bytes();
        let mut data = json!({
            "ok": true,
            "path": resolved.display().to_string(),
            "size": size,
            "kind": "text",
            "contentType": content_type,
            "lines": selection.lines,
        });
        if selection.truncated {
            data["truncated"] = json!(true);
        }
        if let Some(next_offset) = selection.next_offset {
            data["nextOffset"] = json!(next_offset);
        }

        Ok(ToolOutput::with_body(
            data,
            ToolBody::bytes(body, resolved.display().to_string()),
        ))
    }
}

fn select_text_lines(
    content: &str,
    offset: usize,
    limit: Option<usize>,
    max_bytes: Option<usize>,
) -> Result<TextSelection, String> {
    if max_bytes == Some(0) {
        return Err("fs.read maxBytes must be a positive integer".to_string());
    }
    let all_lines = content.split('\n').collect::<Vec<_>>();
    let start = offset.min(all_lines.len());
    let end = start
        .saturating_add(limit.unwrap_or(usize::MAX))
        .min(all_lines.len());
    let requested = &all_lines[start..end];
    let byte_limit = max_bytes.unwrap_or(usize::MAX);
    let mut selected = Vec::new();
    let mut used_bytes = 0_usize;
    let mut partial = false;

    for line in requested {
        let separator_bytes = usize::from(!selected.is_empty());
        if used_bytes
            .saturating_add(separator_bytes)
            .saturating_add(line.len())
            <= byte_limit
        {
            selected.push(*line);
            used_bytes += separator_bytes + line.len();
            continue;
        }
        if selected.is_empty() {
            let mut prefix_end = byte_limit.min(line.len());
            while prefix_end > 0 && !line.is_char_boundary(prefix_end) {
                prefix_end -= 1;
            }
            selected.push(&line[..prefix_end]);
            partial = true;
        }
        break;
    }

    let lines = selected.len();
    let truncated = partial || lines < requested.len() || end < all_lines.len();
    let next_offset = (!partial && truncated && lines > 0).then_some(start + lines);
    Ok(TextSelection {
        content: selected.join("\n"),
        lines,
        truncated,
        next_offset,
    })
}

fn infer_content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("md") => "text/markdown",
        Some("json" | "map") => "application/json",
        Some("yaml" | "yml") => "application/yaml",
        Some("xml") => "application/xml",
        Some("toml") => "application/toml",
        Some("js" | "cjs" | "mjs" | "jsx") => "application/javascript",
        Some("ts" | "tsx") => "application/typescript",
        Some("html" | "htm") => "text/html",
        Some("css") => "text/css",
        Some("txt" | "log") => "text/plain",
        Some("csv") => "text/csv",
        Some("sh") => "text/x-shellscript",
        Some("py") => "text/x-python",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("wasm") => "application/wasm",
        Some("data") => "application/octet-stream",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("ogg") => "audio/ogg",
        Some("webm") => "audio/webm",
        Some("m4a") => "audio/mp4",
        Some("mp4") => "video/mp4",
        Some("mov") => "video/quicktime",
        Some("pdf") => "application/pdf",
        _ => "text/plain",
    }
}

fn is_text_content_type(content_type: &str) -> bool {
    let content_type = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    content_type.starts_with("text/")
        || matches!(
            content_type.as_str(),
            "application/json"
                | "application/yaml"
                | "application/xml"
                | "application/javascript"
                | "application/x-javascript"
                | "application/typescript"
                | "application/toml"
                | "image/svg+xml"
        )
        || content_type.ends_with("+json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn detects_raw_images_from_content() {
        let root = std::env::temp_dir().join(format!("gsv-read-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        for name in ["image.png", "image", "image.txt"] {
            fs::write(root.join(name), &bytes).unwrap();
            let result = ReadTool::new(root.clone())
                .execute(json!({ "path": name }))
                .await
                .unwrap();

            assert_eq!(result.data["contentType"], "image/png");
            let mut body = result.body.unwrap();
            assert_eq!(body.length, Some(bytes.len() as u64));
            let mut actual = Vec::new();
            body.reader.read_to_end(&mut actual).await.unwrap();
            assert_eq!(actual, bytes);
        }

        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn returns_svg_as_text() {
        let root = std::env::temp_dir().join(format!("gsv-read-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let svg = r#"<svg xmlns="http://www.w3.org/2000/svg"><text>hello</text></svg>"#;
        fs::write(root.join("image.svg"), svg).unwrap();

        let result = ReadTool::new(root.clone())
            .execute(json!({ "path": "image.svg" }))
            .await
            .unwrap();

        assert_eq!(result.data["kind"], "text");
        assert_eq!(result.data["contentType"], "image/svg+xml");
        let mut body = result.body.unwrap();
        let mut actual = String::new();
        body.reader.read_to_string(&mut actual).await.unwrap();
        assert_eq!(actual, svg);

        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn returns_versioned_image_resources_for_connected_devices() {
        let root = std::env::temp_dir().join(format!("gsv-read-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        fs::write(root.join("image.png"), &bytes).unwrap();

        let result = ReadTool::for_device(root.clone(), "laptop".to_string())
            .execute(json!({ "path": "image.png", "representation": "resource" }))
            .await
            .unwrap();

        assert!(result.body.is_none());
        assert_eq!(result.data["resource"]["target"], "laptop");
        assert_eq!(
            result.data["resource"]["path"],
            root.join("image.png").display().to_string()
        );
        assert_eq!(result.data["resource"]["contentType"], "image/png");
        assert_eq!(result.data["resource"]["size"], bytes.len());
        assert!(result.data["resource"]["revision"]
            .as_str()
            .is_some_and(|revision| !revision.is_empty()));

        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn bounds_text_by_utf8_bytes_and_reports_continuation() {
        let root = std::env::temp_dir().join(format!("gsv-read-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("bounded.txt"), "zero\néé\nthird\nfourth").unwrap();

        let result = ReadTool::new(root.clone())
            .execute(json!({ "path": "bounded.txt", "limit": 3, "maxBytes": 9 }))
            .await
            .unwrap();

        assert_eq!(result.data["lines"], 2);
        assert_eq!(result.data["truncated"], true);
        assert_eq!(result.data["nextOffset"], 2);
        let mut body = result.body.unwrap();
        let mut actual = String::new();
        body.reader.read_to_string(&mut actual).await.unwrap();
        assert_eq!(actual, "zero\néé");

        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn returns_a_utf8_safe_prefix_for_an_oversized_line() {
        let root = std::env::temp_dir().join(format!("gsv-read-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("long.txt"), "ééé").unwrap();

        let result = ReadTool::new(root.clone())
            .execute(json!({ "path": "long.txt", "maxBytes": 3 }))
            .await
            .unwrap();

        assert_eq!(result.data["truncated"], true);
        assert!(result.data.get("nextOffset").is_none());
        let mut body = result.body.unwrap();
        let mut actual = String::new();
        body.reader.read_to_string(&mut actual).await.unwrap();
        assert_eq!(actual, "é");

        fs::remove_dir_all(root).unwrap();
    }
}
