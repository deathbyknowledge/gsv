//! Transport-independent state, actions, effects, and rendering for the GSV terminal UI.

mod app;
mod demo;
mod markdown;
mod model;
mod paths;
mod prelude;
mod render;
mod state;
mod text;
mod theme;

pub use app::App;
pub use model::*;
pub use theme::Theme;

pub(crate) const MAX_COMMAND_HISTORY: usize = 500;
pub(crate) const MAX_ACTION_RUNS: usize = 64;
pub(crate) const MAX_ACTIONS_PER_RUN: usize = 64;
pub(crate) const MAX_VISIBLE_LIVE_ACTIONS: usize = 6;
