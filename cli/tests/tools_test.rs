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
async fn test_shell_tool_execution() {
    use gsv::tools::{ShellTool, Tool};
    use serde_json::json;

    let workspace = std::env::temp_dir();
    let tool = ShellTool::new(workspace.clone());

    // Test definition
    let def = tool.definition();
    assert_eq!(def.name, "Shell");

    // Test simple command
    let result = tool
        .execute(json!({
            "input": shell_echo_command()
        }))
        .await
        .unwrap();

    assert_eq!(result.data["status"], "completed");
    assert_eq!(result.data["exitCode"], 0);
    assert!(result.data["output"].as_str().unwrap().contains("hello"));
}

#[tokio::test]
async fn test_shell_tool_cwd() {
    use gsv::tools::{ShellTool, Tool};
    use serde_json::json;
    use std::fs;

    let workspace = std::env::temp_dir().join("gsv_test_shell_tool_cwd_workspace");
    let custom_cwd = workspace.join("nested");
    fs::create_dir_all(&custom_cwd).unwrap();
    let tool = ShellTool::new(workspace.clone());

    // Test with custom cwd
    let result = tool
        .execute(json!({
            "input": shell_pwd_command(),
            "cwd": custom_cwd.to_string_lossy().to_string()
        }))
        .await
        .unwrap();

    assert_eq!(result.data["status"], "completed");
    assert_eq!(result.data["exitCode"], 0);
    assert!(
        output_matches_cwd(result.data["output"].as_str().unwrap(), &custom_cwd),
        "expected `{}` to resolve to `{}`",
        result.data["output"].as_str().unwrap().trim(),
        custom_cwd.display()
    );

    let _ = fs::remove_dir_all(&workspace);
}

#[tokio::test]
async fn test_shell_background_returns_session_id() {
    use gsv::tools::{ShellTool, Tool};
    use serde_json::json;

    let workspace = std::env::temp_dir();
    let shell = ShellTool::new(workspace.clone());

    let start = shell
        .execute(json!({
            "input": shell_background_finish_command(),
            "background": true
        }))
        .await
        .unwrap();

    assert_eq!(start.data["status"], "running");
    let session_id = start.data["sessionId"].as_str().unwrap().to_string();
    assert!(!session_id.is_empty());
}

#[tokio::test]
async fn test_shell_session_poll_returns_new_output() {
    use gsv::tools::{ShellTool, Tool};
    use serde_json::json;

    let workspace = std::env::temp_dir();
    let shell = ShellTool::new(workspace.clone());

    let start = shell
        .execute(json!({
            "input": shell_background_finish_command(),
            "background": true
        }))
        .await
        .unwrap();

    let session_id = start.data["sessionId"].as_str().unwrap().to_string();
    tokio::time::sleep(std::time::Duration::from_millis(1200)).await;

    let poll = shell
        .execute(json!({
            "sessionId": session_id,
            "input": ""
        }))
        .await
        .unwrap();

    assert_eq!(poll.data["status"], "completed");
    assert!(poll.data["output"]
        .as_str()
        .unwrap()
        .contains("async-finished"));
}

#[tokio::test]
async fn test_shell_session_is_removed_after_final_poll() {
    use gsv::tools::{ShellTool, Tool};
    use serde_json::json;

    let workspace = std::env::temp_dir();
    let shell = ShellTool::new(workspace.clone());

    let start = shell
        .execute(json!({
            "input": shell_background_finish_command(),
            "background": true
        }))
        .await
        .unwrap();

    let session_id = start.data["sessionId"].as_str().unwrap().to_string();
    tokio::time::sleep(std::time::Duration::from_millis(1200)).await;

    let poll = shell
        .execute(json!({
            "sessionId": session_id,
            "input": ""
        }))
        .await
        .unwrap();

    assert_eq!(poll.data["status"], "completed");
    let err = shell
        .execute(json!({
            "sessionId": poll.data["sessionId"].as_str().unwrap(),
            "input": ""
        }))
        .await
        .unwrap_err();

    assert!(err.contains("Unknown shell session"));
}

#[tokio::test]
async fn test_read_tool() {
    use gsv::tools::{ReadTool, Tool};
    use serde_json::json;
    use std::io::Write;
    use tokio::io::AsyncReadExt;

    let workspace = std::env::temp_dir();
    let tool = ReadTool::new(workspace.clone());

    // Create a test file
    let test_file = workspace.join("gsv_test_read.bin");
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

    assert_eq!(result.data["contentType"], "text/plain");
    assert_eq!(result.data["lines"], 4);
    let mut body = result.body.unwrap();
    let mut bytes = Vec::new();
    body.reader.read_to_end(&mut bytes).await.unwrap();
    let content = String::from_utf8(bytes).unwrap();
    assert_eq!(content, "line 1\nline 2\nline 3\n");

    // Cleanup
    let _ = std::fs::remove_file(&test_file);
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

    assert_eq!(result.data["ok"], true);
    assert_eq!(result.data["directories"][0], "nested");
    assert_eq!(result.data["files"][0], "file.txt");

    let _ = std::fs::remove_dir_all(&workspace);
}

#[tokio::test]
async fn test_read_tool_with_offset_limit() {
    use gsv::tools::{ReadTool, Tool};
    use serde_json::json;
    use std::io::Write;
    use tokio::io::AsyncReadExt;

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

    assert_eq!(result.data["lines"], 3);
    let mut body = result.body.unwrap();
    let mut bytes = Vec::new();
    body.reader.read_to_end(&mut bytes).await.unwrap();
    let content = String::from_utf8(bytes).unwrap();
    assert_eq!(content, "line 3\nline 4\nline 5");

    // Cleanup
    let _ = std::fs::remove_file(&test_file);
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

    assert_eq!(result.data["ok"], true);
    assert_eq!(result.data["size"], 19); // "test content\nline 2" = 19 bytes

    // Verify content
    let content = std::fs::read_to_string(&test_file).unwrap();
    assert_eq!(content, "test content\nline 2");

    // Cleanup
    let _ = std::fs::remove_file(&test_file);
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

    assert_eq!(result.data["replacements"], 1);

    // Verify content
    let content = std::fs::read_to_string(&test_file).unwrap();
    assert!(content.contains("goodbye world"));
    assert!(!content.contains("hello world"));

    // Cleanup
    let _ = std::fs::remove_file(&test_file);
}

#[tokio::test]
async fn test_search_tool() {
    use gsv::tools::{SearchTool, Tool};
    use serde_json::json;
    use std::io::Write;

    let workspace = std::env::temp_dir().join("gsv_search_test");
    std::fs::create_dir_all(&workspace).unwrap();

    let tool = SearchTool::new(workspace.clone());

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
        writeln!(f, "a.c").unwrap();
        writeln!(f, "abc").unwrap();
    }

    // Test searching
    let result = tool
        .execute(json!({
            "query": "hello",
            "path": workspace.to_str().unwrap()
        }))
        .await
        .unwrap();

    let matches = result.data["matches"].as_array().unwrap();
    assert_eq!(matches.len(), 2); // Found in both files

    let literal_result = tool
        .execute(json!({
            "query": "a.c",
            "path": workspace.to_str().unwrap()
        }))
        .await
        .unwrap();

    let literal_matches = literal_result.data["matches"].as_array().unwrap();
    assert_eq!(literal_matches.len(), 1);
    assert_eq!(literal_matches[0]["content"], "a.c");

    // Cleanup
    let _ = std::fs::remove_dir_all(&workspace);
}

#[test]
fn test_all_tools_with_workspace() {
    use gsv::tools::all_tools_with_workspace;

    let workspace = std::env::temp_dir();
    let tools = all_tools_with_workspace(workspace);

    // Should have 8 tools: Shell, Read, Write, Delete, Edit, Copy, Search, Fetch
    assert_eq!(tools.len(), 8);

    let names: Vec<_> = tools.iter().map(|t| t.definition().name).collect();
    assert!(names.contains(&"Shell".to_string()));
    assert!(names.contains(&"Read".to_string()));
    assert!(names.contains(&"Write".to_string()));
    assert!(names.contains(&"Delete".to_string()));
    assert!(names.contains(&"Edit".to_string()));
    assert!(names.contains(&"Copy".to_string()));
    assert!(names.contains(&"Search".to_string()));
    assert!(names.contains(&"Fetch".to_string()));
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
