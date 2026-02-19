use crossterm::event::{KeyCode, KeyModifiers};

use crate::tui::buffer::BufferId;
use crate::tui::theme;

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
            app.scroll_chat_up(theme::CHAT_SCROLL_PAGE_SIZE);
            KeyAction::Consumed
        }
        KeyCode::PageDown => {
            app.scroll_chat_down(theme::CHAT_SCROLL_PAGE_SIZE);
            KeyAction::Consumed
        }
        KeyCode::Home => {
            app.scroll_chat_to_top();
            KeyAction::Consumed
        }
        KeyCode::End => {
            app.scroll_chat_to_bottom();
            KeyAction::Consumed
        }
        KeyCode::Char(ch) => {
            app.input.push(ch);
            KeyAction::Consumed
        }
        _ => KeyAction::Ignored,
    }
}
