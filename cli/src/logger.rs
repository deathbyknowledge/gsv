use std::fs;
use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::fmt;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

const DEVICE_LOG_FILE_PREFIX: &str = "device.log";
const LEGACY_NODE_LOG_FILE_PREFIX: &str = "node.log";

enum ConsoleLogFormat {
    Text,
    Json,
    Quiet,
}

pub struct DeviceLoggingGuard {
    _file_guard: WorkerGuard,
}

pub fn device_log_dir() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    Ok(home.join(".gsv").join("logs"))
}

pub fn device_log_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    if let Some(path) = latest_device_log_path()? {
        return Ok(path);
    }
    Ok(device_log_dir()?.join(DEVICE_LOG_FILE_PREFIX))
}

pub fn device_log_pattern() -> Result<String, Box<dyn std::error::Error>> {
    Ok(format!(
        "{}{}{}*",
        device_log_dir()?.display(),
        std::path::MAIN_SEPARATOR,
        DEVICE_LOG_FILE_PREFIX,
    ))
}

pub fn init_device_logging() -> Result<DeviceLoggingGuard, Box<dyn std::error::Error>> {
    let log_dir = device_log_dir()?;
    fs::create_dir_all(&log_dir)?;

    let file_appender = tracing_appender::rolling::daily(&log_dir, DEVICE_LOG_FILE_PREFIX);
    let (file_writer, file_guard) = tracing_appender::non_blocking(file_appender);
    let env_filter = tracing_env_filter();
    let console_ansi = std::io::stdout().is_terminal();

    let file_layer = fmt::layer()
        .json()
        .flatten_event(true)
        .with_current_span(true)
        .with_span_list(true)
        .with_ansi(false)
        .with_writer(file_writer);

    let subscriber = tracing_subscriber::registry()
        .with(env_filter)
        .with(file_layer);

    match device_console_log_format() {
        ConsoleLogFormat::Text => subscriber
            .with(
                fmt::layer()
                    .compact()
                    .with_target(false)
                    .with_ansi(console_ansi),
            )
            .try_init()?,
        ConsoleLogFormat::Json => subscriber
            .with(
                fmt::layer()
                    .json()
                    .flatten_event(true)
                    .with_current_span(true)
                    .with_span_list(true)
                    .with_ansi(false),
            )
            .try_init()?,
        ConsoleLogFormat::Quiet => subscriber.try_init()?,
    }

    Ok(DeviceLoggingGuard {
        _file_guard: file_guard,
    })
}

fn tracing_env_filter() -> EnvFilter {
    EnvFilter::try_from_env("GSV_DEVICE_LOG")
        .or_else(|_| EnvFilter::try_from_env("GSV_NODE_LOG"))
        .or_else(|_| EnvFilter::try_from_env("RUST_LOG"))
        .unwrap_or_else(|_| EnvFilter::new("info"))
}

fn device_console_log_format() -> ConsoleLogFormat {
    let value = std::env::var("GSV_DEVICE_CONSOLE_FORMAT")
        .or_else(|_| std::env::var("GSV_DEVICE_LOG_CONSOLE"))
        .or_else(|_| std::env::var("GSV_NODE_CONSOLE_FORMAT"))
        .or_else(|_| std::env::var("GSV_NODE_LOG_CONSOLE"))
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    match value.as_str() {
        "json" | "jsonl" => ConsoleLogFormat::Json,
        "quiet" | "none" | "off" => ConsoleLogFormat::Quiet,
        _ => ConsoleLogFormat::Text,
    }
}

fn latest_device_log_path() -> Result<Option<PathBuf>, Box<dyn std::error::Error>> {
    let log_dir = device_log_dir()?;
    if !log_dir.exists() {
        return Ok(None);
    }

    let mut latest: Option<(SystemTime, PathBuf)> = None;
    for entry in fs::read_dir(log_dir)? {
        let entry = entry?;
        let path = entry.path();
        if !is_device_log_file(&path) {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(UNIX_EPOCH);
        if latest
            .as_ref()
            .map(|(latest_modified, _)| modified > *latest_modified)
            .unwrap_or(true)
        {
            latest = Some((modified, path));
        }
    }

    Ok(latest.map(|(_, path)| path))
}

fn is_device_log_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| {
            name.starts_with(DEVICE_LOG_FILE_PREFIX)
                || name.starts_with(LEGACY_NODE_LOG_FILE_PREFIX)
        })
        .unwrap_or(false)
        && path.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_log_pattern_points_at_rotated_device_logs() {
        let pattern = device_log_pattern().expect("device log pattern");
        assert!(pattern.ends_with("device.log*"));
    }
}
