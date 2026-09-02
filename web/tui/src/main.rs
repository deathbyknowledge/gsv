use std::cell::RefCell;
use std::rc::Rc;

use gsv_tui_core::{Action, App, ApprovalDecision, CapabilityEnvironment, Effect, Theme};
use ratzilla::backend::webgl2::WebGl2BackendOptions;
use ratzilla::ratatui::Terminal;
use ratzilla::{FontAtlasConfig, SelectionMode, WebGl2Backend, WebRenderer};
use wasm_bindgen::closure::Closure;
use wasm_bindgen::{JsCast, JsValue};
use web_sys::{Event, HtmlTextAreaElement, InputEvent, KeyboardEvent, MouseEvent, WheelEvent};

fn main() {
    console_error_panic_hook::set_once();
    if let Err(error) = run() {
        web_sys::console::error_1(&error);
    }
}

fn run() -> Result<(), JsValue> {
    let mut state = App::demo();
    state.set_theme(Theme::Gsv);
    state.set_environments(vec![
        CapabilityEnvironment::gsv(),
        CapabilityEnvironment::new("macbook", "MacBook"),
        CapabilityEnvironment::new("browser", "Browser"),
    ]);
    let app = Rc::new(RefCell::new(state));
    let options = WebGl2BackendOptions::new()
        .grid_id("terminal")
        .font_atlas_config(FontAtlasConfig::dynamic(
            &["Departure Mono", "ui-monospace", "monospace"],
            17.0,
        ))
        .canvas_padding_color(ratzilla::ratatui::style::Color::Rgb(8, 9, 11))
        .enable_mouse_selection_with_mode(SelectionMode::Linear)
        .disable_auto_css_resize();
    let backend = WebGl2Backend::new_with_options(options).map_err(display_error)?;
    let terminal = Terminal::new(backend).map_err(display_error)?;

    install_input_bridge(Rc::clone(&app))?;

    terminal.draw_web(move |frame| {
        app.borrow_mut().render(frame);
    });
    Ok(())
}

fn install_input_bridge(app: Rc<RefCell<App>>) -> Result<(), JsValue> {
    let window = web_sys::window().ok_or_else(|| JsValue::from_str("Missing browser window"))?;
    let document = window
        .document()
        .ok_or_else(|| JsValue::from_str("Missing browser document"))?;
    let input = document
        .get_element_by_id("gsv-input")
        .ok_or_else(|| JsValue::from_str("Missing GSV input bridge"))?
        .dyn_into::<HtmlTextAreaElement>()?;
    let terminal = document
        .get_element_by_id("terminal")
        .ok_or_else(|| JsValue::from_str("Missing terminal mount"))?;

    let input_for_text = input.clone();
    let app_for_text = Rc::clone(&app);
    let on_input = Closure::<dyn FnMut(InputEvent)>::new(move |event: InputEvent| {
        if event.is_composing() {
            return;
        }
        let value = input_for_text.value();
        if value.is_empty() {
            return;
        }
        input_for_text.set_value("");
        if app_for_text.borrow().vim_enabled() && !app_for_text.borrow().draft_visible() {
            return;
        }
        dispatch_action(&app_for_text, Action::Insert(value));
    });
    input.add_event_listener_with_callback("input", on_input.as_ref().unchecked_ref())?;
    on_input.forget();

    let app_for_key = Rc::clone(&app);
    let on_key = Closure::<dyn FnMut(KeyboardEvent)>::new(move |event: KeyboardEvent| {
        if event.is_composing() {
            return;
        }
        let (action, vim_browse) = {
            let app = app_for_key.borrow();
            (
                keyboard_action(&app, &event),
                app.vim_enabled() && !app.draft_visible(),
            )
        };
        if let Some(action) = action {
            event.prevent_default();
            dispatch_action(&app_for_key, action);
        } else if vim_browse && key_is_text(&event.key()) {
            event.prevent_default();
        }
    });
    input.add_event_listener_with_callback("keydown", on_key.as_ref().unchecked_ref())?;
    on_key.forget();

    let app_for_wheel = Rc::clone(&app);
    let on_wheel = Closure::<dyn FnMut(WheelEvent)>::new(move |event: WheelEvent| {
        event.prevent_default();
        let action = if event.delta_y() < 0.0 {
            Action::ScrollUp
        } else {
            Action::ScrollDown
        };
        dispatch_action(&app_for_wheel, action);
    });
    terminal.add_event_listener_with_callback("wheel", on_wheel.as_ref().unchecked_ref())?;
    on_wheel.forget();

    let input_for_focus = input.clone();
    let on_pointer = Closure::<dyn FnMut(MouseEvent)>::new(move |_event: MouseEvent| {
        let _ = input_for_focus.focus();
    });
    terminal.add_event_listener_with_callback("mousedown", on_pointer.as_ref().unchecked_ref())?;
    on_pointer.forget();

    let input_for_window_focus = input.clone();
    let on_focus = Closure::<dyn FnMut(Event)>::new(move |_event: Event| {
        let _ = input_for_window_focus.focus();
    });
    window.add_event_listener_with_callback("focus", on_focus.as_ref().unchecked_ref())?;
    on_focus.forget();

    input.focus()?;
    Ok(())
}

fn dispatch_action(app: &Rc<RefCell<App>>, action: Action) {
    let effects = app.borrow_mut().dispatch(action);
    for effect in effects {
        match effect {
            Effect::Submit {
                id,
                text,
                target: _,
                cwd: _,
            } => {
                app.borrow_mut().complete_demo_submission(id, &text);
            }
            Effect::Shell {
                id,
                input,
                target: _,
                cwd: _,
            } => {
                app.borrow_mut().complete_demo_shell(id, &input);
            }
            Effect::Abort => {
                app.borrow_mut().set_activity(None);
            }
            Effect::DecideApproval {
                request_id,
                decision: _,
                remember: _,
            } => {
                app.borrow_mut().leave_approval(&request_id);
            }
            Effect::Quit => {
                app.borrow_mut()
                    .set_activity(Some("CLOSE THIS TAB WHEN YOU ARE READY".to_string()));
            }
        }
    }
}

fn keyboard_action(app: &App, event: &KeyboardEvent) -> Option<Action> {
    let key = event.key();
    let normalized = key.to_ascii_lowercase();
    let command = event.ctrl_key() || event.meta_key();

    if app.approval().is_some() && !command && !event.alt_key() {
        return match normalized.as_str() {
            "o" => Some(Action::DecideApproval {
                decision: ApprovalDecision::Approve,
                remember: false,
            }),
            "a" => Some(Action::DecideApproval {
                decision: ApprovalDecision::Approve,
                remember: true,
            }),
            "d" => Some(Action::DecideApproval {
                decision: ApprovalDecision::Deny,
                remember: false,
            }),
            "?" => Some(Action::ToggleHelp),
            _ => None,
        };
    }

    if app.environment_picker_visible() {
        return match normalized.as_str() {
            "escape" => Some(Action::Escape),
            "enter" => Some(Action::Submit),
            "backspace" | "delete" => Some(Action::Backspace),
            "arrowup" => Some(Action::PreviousChoice),
            "arrowdown" => Some(Action::NextChoice),
            "p" if command => Some(Action::PreviousChoice),
            "n" if command => Some(Action::NextChoice),
            _ => None,
        };
    }

    if normalized == "v" && event.alt_key() {
        return Some(Action::ToggleVim);
    }
    if normalized == "tab" && !command && !event.alt_key() {
        return Some(Action::ToggleShell);
    }
    if normalized == "pageup" {
        return Some(Action::ScrollPageUp);
    }
    if normalized == "pagedown" {
        return Some(Action::ScrollPageDown);
    }

    if app.vim_enabled() && !app.draft_visible() && !command && !event.alt_key() {
        return match key.as_str() {
            "i" | "a" => Some(Action::BeginCompose),
            "h" => Some(Action::PreviousMedia),
            "j" => Some(Action::NextTurn),
            "k" => Some(Action::PreviousTurn),
            "l" => Some(Action::NextMedia),
            "g" => Some(Action::FirstTurn),
            "G" => Some(Action::LastTurn),
            "Enter" => Some(Action::ToggleMedia),
            "?" => Some(Action::ToggleHelp),
            _ => None,
        };
    }

    match normalized.as_str() {
        "q" if command => Some(Action::Quit),
        "." if command => Some(Action::Abort),
        "p" if command => Some(Action::PreviousTurn),
        "n" if command => Some(Action::NextTurn),
        "u" if command && app.vim_enabled() && !app.draft_visible() => Some(Action::ScrollUp),
        "d" if command && app.vim_enabled() && !app.draft_visible() => Some(Action::ScrollDown),
        "a" if command => Some(Action::MoveCursorHome),
        "e" if command => Some(Action::MoveCursorEnd),
        "b" if command => Some(Action::MoveCursorLeft),
        "f" if command => Some(Action::MoveCursorRight),
        "backspace" if command => Some(Action::DeleteWord),
        "m" if event.alt_key() => Some(Action::ToggleMarkdown),
        "?" if !app.draft_visible() && !command => Some(Action::ToggleHelp),
        "enter" if event.shift_key() || command => Some(Action::Newline),
        "enter" if !app.draft_visible() => Some(Action::ToggleMedia),
        "enter" => Some(Action::Submit),
        "escape" => Some(Action::Escape),
        "backspace" => Some(Action::Backspace),
        "delete" => Some(Action::Delete),
        "arrowleft" if !app.draft_visible() => Some(Action::PreviousMedia),
        "arrowright" if !app.draft_visible() => Some(Action::NextMedia),
        "arrowleft" => Some(Action::MoveCursorLeft),
        "arrowright" => Some(Action::MoveCursorRight),
        "home" => Some(Action::MoveCursorHome),
        "end" => Some(Action::MoveCursorEnd),
        "arrowup" if event.alt_key() => Some(Action::PreviousTurn),
        "arrowdown" if event.alt_key() => Some(Action::NextTurn),
        "arrowup" if !app.draft_visible() => Some(Action::ScrollUp),
        "arrowdown" if !app.draft_visible() => Some(Action::ScrollDown),
        _ => None,
    }
}

fn key_is_text(key: &str) -> bool {
    key.chars().count() == 1
}

fn display_error(error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&error.to_string())
}
