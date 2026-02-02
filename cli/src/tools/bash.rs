use crate::protocol::ToolDefinition;
use crate::tools::Tool;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Command;

pub struct BashTool {
    workspace: PathBuf,
}

impl BashTool {
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
struct BashArgs {
    command: String,
    #[serde(default)]
    workdir: Option<String>,
    #[serde(default)]
    timeout: Option<u64>,
}

impl Tool for BashTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "Bash".to_string(),
            description: "Execute a shell command. Working directory defaults to the workspace."
                .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The command to execute"
                    },
                    "workdir": {
                        "type": "string",
                        "description": "Working directory (default: workspace)"
                    },
                    "timeout": {
                        "type": "number",
                        "description": "Timeout in milliseconds (optional)"
                    }
                },
                "required": ["command"]
            }),
        }
    }

    fn execute(&self, args: Value) -> Result<Value, String> {
        let args: BashArgs =
            serde_json::from_value(args).map_err(|e| format!("Invalid arguments: {}", e))?;

        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg(&args.command);

        // Use provided workdir, or fall back to workspace
        let workdir = args
            .workdir
            .map(|w| self.resolve_path(&w))
            .unwrap_or_else(|| self.workspace.clone());
        cmd.current_dir(&workdir);

        // TODO: implement timeout

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to execute: {}", e))?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();

        Ok(json!({
            "exitCode": output.status.code().unwrap_or(-1),
            "stdout": stdout,
            "stderr": stderr,
            "workdir": workdir.display().to_string()
        }))
    }
}
