//! Crate-internal imports shared by every module of the core.
#![allow(unused_imports)]

pub(crate) use std::cmp::Ordering;
pub(crate) use std::collections::HashSet;

pub(crate) use ratatui::layout::{
    Alignment, Constraint, Direction, Layout, Margin, Position, Rect,
};
pub(crate) use ratatui::style::{Color, Modifier, Style};
pub(crate) use ratatui::text::{Line, Span, Text};
pub(crate) use ratatui::widgets::{Block, BorderType, Borders, Clear, Padding, Paragraph, Wrap};
pub(crate) use ratatui::Frame;
pub(crate) use unicode_segmentation::UnicodeSegmentation;
pub(crate) use unicode_width::UnicodeWidthStr;

pub(crate) use crate::app::App;
pub(crate) use crate::demo::*;
pub(crate) use crate::markdown::{
    extract_references, render_artifacts, render_markdown, render_plain, ExtractedReference,
};
pub(crate) use crate::model::*;
pub(crate) use crate::paths::*;
pub(crate) use crate::render::*;
pub(crate) use crate::state::*;
pub(crate) use crate::text::*;
pub(crate) use crate::theme::Palette;
pub(crate) use crate::theme::Theme;
pub(crate) use crate::{
    MAX_ACTIONS_PER_RUN, MAX_ACTION_RUNS, MAX_COMMAND_HISTORY, MAX_VISIBLE_LIVE_ACTIONS,
};
