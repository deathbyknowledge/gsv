use crate::protocol::ToolDefinition;
use crate::tools::Tool;
use async_trait::async_trait;
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

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

    async fn execute(&self, args: Value) -> Result<Value, String> {
        let args: ReadArgs =
            serde_json::from_value(args).map_err(|e| format!("Invalid arguments: {}", e))?;

        let resolved = self.resolve_path(&args.path);

        match fs::read_to_string(&resolved) {
            Ok(content) => {
                let lines: Vec<&str> = content.lines().collect();
                let offset = args.offset.unwrap_or(0);
                let limit = args.limit.unwrap_or(lines.len());

                let selected: Vec<String> = lines
                    .into_iter()
                    .skip(offset)
                    .take(limit)
                    .enumerate()
                    .map(|(i, line)| format!("{:6}\t{}", offset + i + 1, line))
                    .collect();

                Ok(json!({
                    "path": resolved.display().to_string(),
                    "content": selected.join("\n"),
                    "lines": selected.len()
                }))
            }
            Err(text_read_err) => {
                let raw_bytes = fs::read(&resolved)
                    .map_err(|e| format!("Failed to read '{}': {}", resolved.display(), e))?;

                let byte_count = raw_bytes.len() as u64;
                let human_size = format_byte_size(byte_count);
                let mime_type = infer::get(&raw_bytes).map(|ft| ft.mime_type().to_string());

                match &mime_type {
                    Some(mime) if mime.starts_with("image/") => {
                        if byte_count > MAX_IMAGE_BYTES {
                            return Err(format!(
                                "Image file too large ({}, max {})",
                                human_size,
                                format_byte_size(MAX_IMAGE_BYTES)
                            ));
                        }

                        let encoded = base64::engine::general_purpose::STANDARD.encode(&raw_bytes);

                        Ok(json!({
                            "content": [
                                {
                                    "type": "text",
                                    "text": format!(
                                        "Read image file {} [{}, {}]",
                                        resolved.display(),
                                        mime,
                                        human_size
                                    )
                                },
                                {
                                    "type": "image",
                                    "data": encoded,
                                    "mimeType": mime
                                }
                            ]
                        }))
                    }
                    Some(mime) => Err(format!(
                        "Binary file ({}, {}) - not a text file",
                        mime, human_size
                    )),
                    None => {
                        if text_read_err.kind() == std::io::ErrorKind::NotFound {
                            Err(format!(
                                "Failed to read '{}': {}",
                                resolved.display(),
                                text_read_err
                            ))
                        } else {
                            Err(format!(
                                "Binary file (unknown type, {}) - not a text file",
                                human_size
                            ))
                        }
                    }
                }
            }
        }
    }
}
