use crate::protocol::ToolDefinition;
use crate::tools::Tool;
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

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

        let content = fs::read_to_string(&resolved)
            .map_err(|e| format!("Failed to read '{}': {}", resolved.display(), e))?;

        // Apply line offset/limit if specified
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
}
