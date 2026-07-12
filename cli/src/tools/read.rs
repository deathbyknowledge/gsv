use crate::protocol::ToolDefinition;
use crate::tools::{Tool, ToolBody, ToolOutput};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

pub struct ReadTool {
    workspace: PathBuf,
}

impl ReadTool {
    pub fn new(workspace: PathBuf) -> Self {
        Self { workspace }
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
        let content_type = infer_content_type(&resolved);

        if content_type.starts_with("image/") {
            let file = tokio::fs::File::open(&resolved)
                .await
                .map_err(|e| format!("Failed to read '{}': {}", resolved.display(), e))?;
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
        let bytes = tokio::fs::read(&resolved)
            .await
            .map_err(|e| format!("Failed to read '{}': {}", resolved.display(), e))?;
        let content = String::from_utf8(bytes).map_err(|_error| binary_error())?;
        let offset = args.offset.unwrap_or(0);
        let selected = content
            .split('\n')
            .skip(offset)
            .take(args.limit.unwrap_or(usize::MAX))
            .enumerate()
            .map(|(index, line)| format!("{:6}\t{}", offset + index + 1, line))
            .collect::<Vec<_>>();
        let body = selected.join("\n").into_bytes();

        Ok(ToolOutput::with_body(
            json!({
                "ok": true,
                "path": resolved.display().to_string(),
                "size": size,
                "kind": "text",
                "contentType": content_type,
                "lines": selected.len(),
            }),
            ToolBody::bytes(body, resolved.display().to_string()),
        ))
    }
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
        )
        || content_type.ends_with("+json")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    #[tokio::test]
    async fn returns_raw_image_bytes_as_a_body() {
        let root = std::env::temp_dir().join(format!("gsv-read-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        fs::write(root.join("image.png"), &bytes).unwrap();

        let result = ReadTool::new(root.clone())
            .execute(json!({ "path": "image.png" }))
            .await
            .unwrap();

        assert_eq!(result.data["contentType"], "image/png");
        let mut body = result.body.unwrap();
        assert_eq!(body.length, Some(bytes.len() as u64));
        let mut actual = Vec::new();
        body.reader.read_to_end(&mut actual).await.unwrap();
        assert_eq!(actual, bytes);

        fs::remove_dir_all(root).unwrap();
    }
}
