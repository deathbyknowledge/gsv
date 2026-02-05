use crate::protocol::ToolDefinition;
use crate::tools::Tool;
use async_trait::async_trait;
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use walkdir::WalkDir;

pub struct GrepTool {
    workspace: PathBuf,
}

impl GrepTool {
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
struct GrepArgs {
    pattern: String,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    include: Option<String>,
}

#[derive(serde::Serialize)]
struct GrepMatch {
    path: String,
    line: usize,
    content: String,
}

#[async_trait]
impl Tool for GrepTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "Grep".to_string(),
            description: "Search file contents using regex. Paths are relative to the workspace unless absolute.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "Regex pattern to search for"
                    },
                    "path": {
                        "type": "string",
                        "description": "Directory to search in (default: workspace root)"
                    },
                    "include": {
                        "type": "string",
                        "description": "File pattern to include (e.g., '*.md', '*.{rs,ts}')"
                    }
                },
                "required": ["pattern"]
            }),
        }
    }

    async fn execute(&self, args: Value) -> Result<Value, String> {
        let args: GrepArgs =
            serde_json::from_value(args).map_err(|e| format!("Invalid arguments: {}", e))?;

        let regex =
            Regex::new(&args.pattern).map_err(|e| format!("Invalid regex pattern: {}", e))?;

        let base_path = args
            .path
            .map(|p| self.resolve_path(&p))
            .unwrap_or_else(|| self.workspace.clone());

        // Parse include pattern if provided
        let include_glob = args
            .include
            .as_ref()
            .map(|inc| glob::Pattern::new(inc).ok())
            .flatten();

        let mut matches: Vec<GrepMatch> = Vec::new();

        for entry in WalkDir::new(&base_path)
            .follow_links(true)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
        {
            let path = entry.path();

            // Apply include filter
            if let Some(ref glob_pattern) = include_glob {
                let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if !glob_pattern.matches(file_name) {
                    continue;
                }
            }

            // Skip binary files (simple heuristic)
            if let Ok(content) = fs::read_to_string(path) {
                for (line_num, line) in content.lines().enumerate() {
                    if regex.is_match(line) {
                        matches.push(GrepMatch {
                            path: path.display().to_string(),
                            line: line_num + 1,
                            content: line.chars().take(200).collect(), // Truncate long lines
                        });

                        // Limit total matches
                        if matches.len() >= 100 {
                            return Ok(json!({
                                "pattern": args.pattern,
                                "basePath": base_path.display().to_string(),
                                "matches": matches,
                                "truncated": true
                            }));
                        }
                    }
                }
            }
        }

        Ok(json!({
            "pattern": args.pattern,
            "basePath": base_path.display().to_string(),
            "matches": matches,
            "count": matches.len()
        }))
    }
}
