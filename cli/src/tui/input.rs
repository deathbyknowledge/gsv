use crossterm::event::{KeyCode, KeyModifiers};

use crate::tui::buffer::BufferId;
use crate::tui::state::AppState;
use crate::tui::theme;

// ── Buffer-aware scroll helpers ─────────────────────────────────────────────

fn scroll_active_up(app: &mut AppState, lines: usize) {
    match app.active_buffer {
        BufferId::Chat => app.scroll_chat_up(lines),
        BufferId::System => {
            app.system_buffer.auto_follow = false;
            app.system_buffer.scroll = app.system_buffer.scroll.saturating_sub(lines);
        }
        BufferId::Logs => {
            app.logs_buffer.auto_follow = false;
            app.logs_buffer.scroll = app.logs_buffer.scroll.saturating_sub(lines);
        }
    }
}

fn scroll_active_down(app: &mut AppState, lines: usize) {
    match app.active_buffer {
        BufferId::Chat => app.scroll_chat_down(lines),
        BufferId::System => {
            app.system_buffer.auto_follow = false;
            app.system_buffer.scroll = app.system_buffer.scroll.saturating_add(lines);
        }
        BufferId::Logs => {
            app.logs_buffer.auto_follow = false;
            app.logs_buffer.scroll = app.logs_buffer.scroll.saturating_add(lines);
        }
    }
}

fn scroll_active_top(app: &mut AppState) {
    match app.active_buffer {
        BufferId::Chat => app.scroll_chat_to_top(),
        BufferId::System => {
            app.system_buffer.auto_follow = false;
            app.system_buffer.scroll = 0;
        }
        BufferId::Logs => {
            app.logs_buffer.auto_follow = false;
            app.logs_buffer.scroll = 0;
        }
    }
}

fn scroll_active_bottom(app: &mut AppState) {
    match app.active_buffer {
        BufferId::Chat => app.scroll_chat_to_bottom(),
        BufferId::System => {
            app.system_buffer.auto_follow = true;
        }
        BufferId::Logs => {
            app.logs_buffer.auto_follow = true;
        }
    }
}

/// Actions the main loop should take in response to keyboard input.
pub enum KeyAction {
    /// Submit current input line (Enter).
    Submit(String),
    /// Exit the TUI.
    Quit,
    /// Input was consumed (character, backspace, history nav) -- just redraw.
    Consumed,
    /// Key was not handled.
    Ignored,
}

/// Map a crossterm key event to a `KeyAction`, mutating `AppState` input
/// fields as needed.
pub fn handle_key(
    code: KeyCode,
    modifiers: KeyModifiers,
    app: &mut super::state::AppState,
) -> KeyAction {
    // ── Alt combos: buffer switching ────────────────────────────────
    if modifiers.contains(KeyModifiers::ALT) {
        return match code {
            KeyCode::Char('1') => {
                app.switch_buffer(BufferId::Chat);
                KeyAction::Consumed
            }
            KeyCode::Char('2') => {
                app.switch_buffer(BufferId::System);
                KeyAction::Consumed
            }
            KeyCode::Char('3') => {
                app.switch_buffer(BufferId::Logs);
                KeyAction::Consumed
            }
            _ => KeyAction::Ignored,
        };
    }

    // ── Ctrl combos ─────────────────────────────────────────────────
    if modifiers.contains(KeyModifiers::CONTROL) {
        return match code {
            KeyCode::Char('c') => KeyAction::Quit,
            KeyCode::Char('u') => {
                app.input.clear();
                KeyAction::Consumed
            }
            _ => KeyAction::Ignored,
        };
    }

    // ── Normal keys ─────────────────────────────────────────────────
    match code {
        KeyCode::Enter => {
            let line = app.input.trim().to_string();
            app.input.clear();
            if line.is_empty() {
                return KeyAction::Consumed;
            }
            KeyAction::Submit(line)
        }
        KeyCode::Backspace => {
            app.input.pop();
            KeyAction::Consumed
        }
        KeyCode::Up => {
            app.history_up();
            KeyAction::Consumed
        }
        KeyCode::Down => {
            app.history_down();
            KeyAction::Consumed
        }
        KeyCode::PageUp => {
            scroll_active_up(app, theme::CHAT_SCROLL_PAGE_SIZE);
            KeyAction::Consumed
        }
        KeyCode::PageDown => {
            scroll_active_down(app, theme::CHAT_SCROLL_PAGE_SIZE);
            KeyAction::Consumed
        }
        KeyCode::Home => {
            scroll_active_top(app);
            KeyAction::Consumed
        }
        KeyCode::End => {
            scroll_active_bottom(app);
            KeyAction::Consumed
        }
        KeyCode::Char(ch) => {
            app.input.push(ch);
            KeyAction::Consumed
        }
        _ => KeyAction::Ignored,
    }
}
