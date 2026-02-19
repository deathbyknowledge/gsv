pub mod app;
pub mod buffer;
pub mod commands;
pub mod events;
pub mod input;
pub mod markdown;
pub mod state;
pub mod system;
pub mod theme;
pub mod widgets;

/// Public entry point -- called from `commands::run_client`.
pub use app::run;
