use crate::protocol::ToolDefinition;
use crate::tools::Tool;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;

pub struct GlobTool {
    workspace: PathBuf,
}

impl GlobTool {
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
struct GlobArgs {
    pattern: String,
    #[serde(default)]
    path: Option<String>,
}

impl Tool for GlobTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "Glob".to_string(),
            description: "Find files matching a glob pattern. Returns paths sorted by modification time (newest first). Paths are relative to the workspace unless absolute.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "Glob pattern to match files (e.g., '**/*.md', 'src/**/*.rs')"
                    },
                    "path": {
                        "type": "string",
                        "description": "Directory to search in (default: workspace root)"
                    }
                },
                "required": ["pattern"]
            }),
        }
    }

    fn execute(&self, args: Value) -> Result<Value, String> {
        let args: GlobArgs =
            serde_json::from_value(args).map_err(|e| format!("Invalid arguments: {}", e))?;

        let base_path = args
            .path
            .map(|p| self.resolve_path(&p))
            .unwrap_or_else(|| self.workspace.clone());

        let pattern = base_path.join(&args.pattern);
        let pattern_str = pattern.to_string_lossy();

        let mut entries: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();

        for entry in glob::glob(&pattern_str).map_err(|e| format!("Invalid pattern: {}", e))? {
            match entry {
                Ok(path) => {
                    let mtime = path
                        .metadata()
                        .and_then(|m| m.modified())
                        .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                    entries.push((path, mtime));
                }
                Err(e) => {
                    eprintln!("Glob error: {}", e);
                }
            }
        }

        // Sort by modification time (newest first)
        entries.sort_by(|a, b| b.1.cmp(&a.1));

        let paths: Vec<String> = entries
            .into_iter()
            .map(|(p, _)| p.display().to_string())
            .collect();

        Ok(json!({
            "pattern": args.pattern,
            "basePath": base_path.display().to_string(),
            "matches": paths,
            "count": paths.len()
        }))
    }
}
