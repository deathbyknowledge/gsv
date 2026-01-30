use crate::protocol::ToolDefinition;
use crate::tools::Tool;
use serde::Deserialize;
use serde_json::{json, Value};
use std::process::Command;

pub struct BashTool;

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
            description: "Execute a shell command".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The command to execute"
                    },
                    "workdir": {
                        "type": "string",
                        "description": "Working directory (optional)"
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

        if let Some(workdir) = &args.workdir {
            cmd.current_dir(workdir);
        }

        // TODO: implement timeout

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to execute: {}", e))?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();

        Ok(json!({
            "exitCode": output.status.code().unwrap_or(-1),
            "stdout": stdout,
            "stderr": stderr
        }))
    }
}
