// Integration tests for CLI tools

use std::path::Path;

fn shell_echo_command() -> &'static str {
    #[cfg(windows)]
    {
        "Write-Output hello"
    }
    #[cfg(not(windows))]
    {
        "echo hello"
    }
}

fn shell_pwd_command() -> &'static str {
    #[cfg(windows)]
    {
        "[System.IO.Directory]::GetCurrentDirectory()"
    }
    #[cfg(not(windows))]
    {
        "pwd"
    }
}

fn shell_background_finish_command() -> &'static str {
    #[cfg(windows)]
    {
        "Start-Sleep -Seconds 1; Write-Output async-finished"
    }
    #[cfg(not(windows))]
    {
        "sleep 1; echo async-finished"
    }
}

fn normalize_shell_path(value: &str) -> String {
    #[cfg(windows)]
    {
        return value
            .trim()
            .replace('/', "\\")
            .trim_start_matches(r"\\?\")
            .trim_end_matches('\\')
            .to_ascii_lowercase();
    }

    #[cfg(not(windows))]
    {
        value.trim().trim_end_matches('/').to_string()
    }
}

fn output_matches_cwd(output: &str, expected: &Path) -> bool {
    #[cfg(windows)]
    {
        let actual = std::path::PathBuf::from(output.trim().replace('/', "\\"));
        let actual = std::fs::canonicalize(actual);
        let expected = std::fs::canonicalize(expected);
        if let (Ok(actual), Ok(expected)) = (actual, expected) {
            return actual == expected;
        }
    }

    #[cfg(not(windows))]
    {
        let _ = expected;
    }

    let actual = normalize_shell_path(output);
    let expected = normalize_shell_path(expected.to_string_lossy().as_ref());
    actual.contains(&expected)
}

#[tokio::test]
async fn test_bash_tool_execution() {
    use gsv::tools::{BashTool, Tool};
    use serde_json::json;

    let workspace = std::env::temp_dir();
    let tool = BashTool::new(workspace.clone());

    // Test definition
    let def = tool.definition();
    assert_eq!(def.name, "Bash");

    // Test simple command
    let result = tool
        .execute(json!({
            "input": shell_echo_command()
        }))
        .await
        .unwrap();

    assert_eq!(result["status"], "completed");
    assert_eq!(result["exitCode"], 0);
    assert!(result["output"].as_str().unwrap().contains("hello"));
}

#[tokio::test]
async fn test_bash_tool_cwd() {
    use gsv::tools::{BashTool, Tool};
    use serde_json::json;
    use std::fs;

    let workspace = std::env::temp_dir().join("gsv_test_bash_tool_cwd_workspace");
    let custom_cwd = workspace.join("nested");
    fs::create_dir_all(&custom_cwd).unwrap();
    let tool = BashTool::new(workspace.clone());

    // Test with custom cwd
    let result = tool
        .execute(json!({
            "input": shell_pwd_command(),
            "cwd": custom_cwd.to_string_lossy().to_string()
        }))
        .await
        .unwrap();

    assert_eq!(result["status"], "completed");
    assert_eq!(result["exitCode"], 0);
    assert!(
        output_matches_cwd(result["output"].as_str().unwrap(), &custom_cwd),
        "expected `{}` to resolve to `{}`",
        result["output"].as_str().unwrap().trim(),
        custom_cwd.display()
    );

    fs::remove_dir_all(&workspace).ok();
}

#[tokio::test]
async fn test_bash_background_returns_session_id() {
    use gsv::tools::{BashTool, Tool};
    use serde_json::json;

    let workspace = std::env::temp_dir();
    let bash = BashTool::new(workspace.clone());

    let start = bash
        .execute(json!({
            "input": shell_background_finish_command(),
            "background": true
        }))
        .await
        .unwrap();

    assert_eq!(start["status"], "running");
    let session_id = start["sessionId"].as_str().unwrap().to_string();
    assert!(!session_id.is_empty());
}

#[tokio::test]
async fn test_bash_session_poll_returns_new_output() {
    use gsv::tools::{BashTool, Tool};
    use serde_json::json;

    let workspace = std::env::temp_dir();
    let bash = BashTool::new(workspace.clone());

    let start = bash
        .execute(json!({
            "input": shell_background_finish_command(),
            "background": true
        }))
        .await
        .unwrap();

    let session_id = start["sessionId"].as_str().unwrap().to_string();
    tokio::time::sleep(std::time::Duration::from_millis(1200)).await;

    let poll = bash
        .execute(json!({
            "sessionId": session_id,
            "input": ""
        }))
        .await
        .unwrap();

    assert_eq!(poll["status"], "completed");
    assert!(poll["output"].as_str().unwrap().contains("async-finished"));
}

#[tokio::test]
async fn test_read_tool() {
    use gsv::tools::{ReadTool, Tool};
    use serde_json::json;
    use std::io::Write;

    let workspace = std::env::temp_dir();
    let tool = ReadTool::new(workspace.clone());

    // Create a test file
    let test_file = workspace.join("gsv_test_read.txt");
    {
        let mut f = std::fs::File::create(&test_file).unwrap();
        writeln!(f, "line 1").unwrap();
        writeln!(f, "line 2").unwrap();
        writeln!(f, "line 3").unwrap();
    }

    // Test reading
    let result = tool
        .execute(json!({
            "path": test_file.to_str().unwrap()
        }))
        .await
        .unwrap();

    let content = result["content"].as_str().unwrap();
    assert!(content.contains("line 1"));
    assert!(content.contains("line 2"));
    assert_eq!(result["lines"], 3);

    // Cleanup
    std::fs::remove_file(&test_file).ok();
}

#[tokio::test]
async fn test_read_tool_directory() {
    use gsv::tools::{ReadTool, Tool};
    use serde_json::json;

    let workspace = std::env::temp_dir().join("gsv_test_read_dir");
    std::fs::create_dir_all(workspace.join("nested")).unwrap();
    std::fs::write(workspace.join("file.txt"), "hello").unwrap();

    let tool = ReadTool::new(std::env::temp_dir());

    let result = tool
        .execute(json!({
            "path": workspace.to_str().unwrap()
        }))
        .await
        .unwrap();

    assert_eq!(result["ok"], true);
    assert_eq!(result["directories"][0], "nested");
    assert_eq!(result["files"][0], "file.txt");

    std::fs::remove_dir_all(&workspace).ok();
}

#[tokio::test]
async fn test_read_tool_with_offset_limit() {
    use gsv::tools::{ReadTool, Tool};
    use serde_json::json;
    use std::io::Write;

    let workspace = std::env::temp_dir();
    let tool = ReadTool::new(workspace.clone());

    // Create a test file
    let test_file = workspace.join("gsv_test_read_offset.txt");
    {
        let mut f = std::fs::File::create(&test_file).unwrap();
        for i in 1..=10 {
            writeln!(f, "line {}", i).unwrap();
        }
    }

    // Test with offset and limit
    let result = tool
        .execute(json!({
            "path": test_file.to_str().unwrap(),
            "offset": 2,
            "limit": 3
        }))
        .await
        .unwrap();

    let content = result["content"].as_str().unwrap();
    assert!(content.contains("line 3"));
    assert!(content.contains("line 4"));
    assert!(content.contains("line 5"));
    assert!(!content.contains("line 1"));
    assert!(!content.contains("line 6"));
    assert_eq!(result["lines"], 3);

    // Cleanup
    std::fs::remove_file(&test_file).ok();
}

#[tokio::test]
async fn test_write_tool() {
    use gsv::tools::{Tool, WriteTool};
    use serde_json::json;

    let workspace = std::env::temp_dir();
    let tool = WriteTool::new(workspace.clone());

    let test_file = workspace.join("gsv_test_write.txt");

    // Test writing - returns native fs.write shape
    let result = tool
        .execute(json!({
            "path": test_file.to_str().unwrap(),
            "content": "test content\nline 2"
        }))
        .await
        .unwrap();

    assert_eq!(result["ok"], true);
    assert_eq!(result["size"], 19); // "test content\nline 2" = 19 bytes

    // Verify content
    let content = std::fs::read_to_string(&test_file).unwrap();
    assert_eq!(content, "test content\nline 2");

    // Cleanup
    std::fs::remove_file(&test_file).ok();
}

#[tokio::test]
async fn test_edit_tool() {
    use gsv::tools::{EditTool, Tool};
    use serde_json::json;
    use std::io::Write;

    let workspace = std::env::temp_dir();
    let tool = EditTool::new(workspace.clone());

    // Create a test file
    let test_file = workspace.join("gsv_test_edit.txt");
    {
        let mut f = std::fs::File::create(&test_file).unwrap();
        writeln!(f, "hello world").unwrap();
        writeln!(f, "foo bar").unwrap();
    }

    // Test editing - returns "path" and "replacements"
    let result = tool
        .execute(json!({
            "path": test_file.to_str().unwrap(),
            "oldString": "hello world",
            "newString": "goodbye world"
        }))
        .await
        .unwrap();

    assert_eq!(result["replacements"], 1);

    // Verify content
    let content = std::fs::read_to_string(&test_file).unwrap();
    assert!(content.contains("goodbye world"));
    assert!(!content.contains("hello world"));

    // Cleanup
    std::fs::remove_file(&test_file).ok();
}

#[tokio::test]
async fn test_glob_tool() {
    use gsv::tools::{GlobTool, Tool};
    use serde_json::json;

    let workspace = std::env::temp_dir().join("gsv_glob_test");
    std::fs::create_dir_all(&workspace).unwrap();

    let tool = GlobTool::new(workspace.clone());

    // Create test files
    std::fs::File::create(workspace.join("test1.txt")).unwrap();
    std::fs::File::create(workspace.join("test2.txt")).unwrap();
    std::fs::File::create(workspace.join("other.md")).unwrap();

    // Test globbing
    let result = tool
        .execute(json!({
            "pattern": "*.txt",
            "path": workspace.to_str().unwrap()
        }))
        .await
        .unwrap();

    let matches = result["matches"].as_array().unwrap();
    assert_eq!(matches.len(), 2);

    // Cleanup
    std::fs::remove_dir_all(&workspace).ok();
}

#[tokio::test]
async fn test_grep_tool() {
    use gsv::tools::{GrepTool, Tool};
    use serde_json::json;
    use std::io::Write;

    let workspace = std::env::temp_dir().join("gsv_grep_test");
    std::fs::create_dir_all(&workspace).unwrap();

    let tool = GrepTool::new(workspace.clone());

    // Create test files
    {
        let mut f = std::fs::File::create(workspace.join("file1.txt")).unwrap();
        writeln!(f, "hello world").unwrap();
        writeln!(f, "foo bar").unwrap();
    }
    {
        let mut f = std::fs::File::create(workspace.join("file2.txt")).unwrap();
        writeln!(f, "hello again").unwrap();
        writeln!(f, "baz qux").unwrap();
    }

    // Test grepping
    let result = tool
        .execute(json!({
            "pattern": "hello",
            "path": workspace.to_str().unwrap()
        }))
        .await
        .unwrap();

    let matches = result["matches"].as_array().unwrap();
    assert_eq!(matches.len(), 2); // Found in both files

    // Cleanup
    std::fs::remove_dir_all(&workspace).ok();
}

#[test]
fn test_all_tools_with_workspace() {
    use gsv::tools::all_tools_with_workspace;

    let workspace = std::env::temp_dir();
    let tools = all_tools_with_workspace(workspace);

    // Should have 7 tools: Bash, Read, Write, Delete, Edit, Glob, Grep
    assert_eq!(tools.len(), 7);

    let names: Vec<_> = tools.iter().map(|t| t.definition().name).collect();
    assert!(names.contains(&"Bash".to_string()));
    assert!(names.contains(&"Read".to_string()));
    assert!(names.contains(&"Write".to_string()));
    assert!(names.contains(&"Delete".to_string()));
    assert!(names.contains(&"Edit".to_string()));
    assert!(names.contains(&"Glob".to_string()));
    assert!(names.contains(&"Grep".to_string()));
}

#[test]
fn test_config_load_default() {
    use gsv::config::CliConfig;

    // Should return default config when file doesn't exist
    let cfg = CliConfig::load();

    assert_eq!(cfg.default_session(), "agent:main:cli:dm:main");
    // Default URL is ws://localhost:8787/ws
    let url = cfg.gateway_url();
    assert!(url.starts_with("ws://") || url.starts_with("wss://"));
}

#[test]
fn test_config_sample() {
    use gsv::config::sample_config;

    let sample = sample_config();

    // Should contain expected sections
    assert!(sample.contains("[gateway]"));
    assert!(sample.contains("[r2]"));
    assert!(sample.contains("[session]"));
}
