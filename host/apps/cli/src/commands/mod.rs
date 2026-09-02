mod adapter;
mod auth;
mod chat;
mod config;
mod proc;
mod tui;

pub(crate) use adapter::run_adapter;
pub(crate) use auth::run_auth;
pub(crate) use chat::run_client;
pub(crate) use config::run_config;
pub(crate) use proc::run_proc;
pub(crate) use tui::run_tui;

use chrono::{TimeZone, Utc};

fn format_unix_ms(timestamp_ms: i64) -> String {
    Utc.timestamp_millis_opt(timestamp_ms)
        .single()
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_else(|| timestamp_ms.to_string())
}
