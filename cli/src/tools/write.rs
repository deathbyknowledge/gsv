use crate::protocol::ToolDefinition;
use crate::tools::Tool;
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

pub struct WriteTool {
    workspace: PathBuf,
}

impl WriteTool {
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
struct WriteArgs {
    path: String,
    content: String,
}

impl Tool for WriteTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "Write".to_string(),
            description: "Write content to a file. Creates parent directories if needed. Paths are relative to the workspace unless absolute.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Path to the file to write"
                    },
                    "content": {
                        "type": "string",
                        "description": "Content to write to the file"
                    }
                },
                "required": ["path", "content"]
            }),
        }
    }

    fn execute(&self, args: Value) -> Result<Value, String> {
        let args: WriteArgs =
            serde_json::from_value(args).map_err(|e| format!("Invalid arguments: {}", e))?;

        let resolved = self.resolve_path(&args.path);

        // Create parent directories if needed
        if let Some(parent) = resolved.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directories: {}", e))?;
        }

        fs::write(&resolved, &args.content)
            .map_err(|e| format!("Failed to write '{}': {}", resolved.display(), e))?;

        Ok(json!({
            "path": resolved.display().to_string(),
            "bytes": args.content.len()
        }))
    }
}
