use gpui::prelude::FluentBuilder as _;
use gpui::{
    div, px, AnyElement, Context, Focusable, FontWeight, InteractiveElement as _, IntoElement,
    MouseButton, ParentElement as _, StatefulInteractiveElement as _, Styled, Window,
};
use gpui_component::input::{Input, InputEvent};

use crate::audio::KeySound;
use crate::client::ClientCommand;
use crate::machine_setup::{
    MachineActivation, MachineRuntimeStatus, MachineSetupFlow, MachineSetupPhase,
};
use crate::theme;

use super::{new_machine_input, GsvApp};

impl GsvApp {
    pub(super) fn begin_machine_management(
        &mut self,
        configured: bool,
        suggested_name: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.machine_configured = configured;
        if self.machine_ready
            || self.machine_setup_dismissed
            || self.machine_setup.is_some()
            || self.active_machine_request_id.is_some()
        {
            return;
        }
        if configured {
            self.send_machine_setup(suggested_name, true, window, cx);
            return;
        }
        self.machine_setup = Some(MachineSetupFlow::new(suggested_name));
        self.refresh_machine_input(window, cx);
        cx.notify();
    }

    pub(super) fn submit_machine_setup(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(setup) = &self.machine_setup else {
            return;
        };
        if setup.phase() == MachineSetupPhase::Installing {
            return;
        }
        let name = self
            .machine_input
            .as_ref()
            .map(|input| input.read(cx).value().to_string())
            .unwrap_or_else(|| setup.name().to_string());
        self.send_machine_setup(name, false, window, cx);
    }

    fn send_machine_setup(
        &mut self,
        name: String,
        automatic: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let request_id = self.next_machine_request_id;
        self.next_machine_request_id = self.next_machine_request_id.wrapping_add(1).max(1);
        let name = if automatic {
            match crate::machine_setup::validate_machine_name(&name) {
                Ok(name) => name,
                Err(message) => {
                    self.conversation.show_error(message);
                    return;
                }
            }
        } else {
            let Some(setup) = &mut self.machine_setup else {
                return;
            };
            match setup.begin(request_id, &name) {
                Ok(name) => name,
                Err(message) => {
                    setup.set_error(message);
                    cx.notify();
                    return;
                }
            }
        };
        self.active_machine_request_id = Some(request_id);
        self.machine_runtime_status = MachineRuntimeStatus::Starting;
        self.refresh_machine_input(window, cx);
        if self
            .commands
            .send(ClientCommand::SetupMachine {
                request_id,
                name,
                automatic,
            })
            .is_err()
        {
            self.handle_machine_setup_failure(
                request_id,
                automatic,
                "The native client stopped before it could connect this computer.".to_string(),
                window,
                cx,
            );
        }
        cx.notify();
    }

    pub(super) fn handle_machine_setup_success(
        &mut self,
        request_id: u64,
        activation: MachineActivation,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.active_machine_request_id != Some(request_id) {
            return;
        }
        if let Some(setup) = &mut self.machine_setup {
            if !setup.finish(request_id) {
                return;
            }
        }
        self.active_machine_request_id = None;
        self.machine_configured = true;
        self.machine_runtime_status = if activation.connected {
            MachineRuntimeStatus::Connected
        } else {
            MachineRuntimeStatus::Connecting
        };
        self.machine_ready = true;
        self.machine_setup = None;
        self.refresh_machine_input(window, cx);
        if !activation.connected {
            self.conversation.show_error(format!(
                "{} is installed and will keep trying to connect in the background.",
                activation.name
            ));
        }
        self.input.focus_handle(cx).focus(window);
        self.begin_transition(1.0);
        cx.notify();
    }

    pub(super) fn handle_machine_setup_failure(
        &mut self,
        request_id: u64,
        automatic: bool,
        message: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.active_machine_request_id != Some(request_id) {
            return;
        }
        self.active_machine_request_id = None;
        if automatic {
            self.machine_configured = true;
            self.machine_runtime_status = MachineRuntimeStatus::NotRunning;
            self.conversation.show_error(format!(
                "This computer could not be connected in the background: {message}"
            ));
            return;
        }
        if let Some(setup) = &mut self.machine_setup {
            if setup.fail(request_id, message) {
                self.refresh_machine_input(window, cx);
            }
        }
        cx.notify();
    }

    pub(super) fn dismiss_machine_setup(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(setup) = &self.machine_setup else {
            return false;
        };
        if setup.phase() == MachineSetupPhase::Installing {
            return true;
        }
        self.machine_setup_dismissed = true;
        self.machine_setup = None;
        self.refresh_machine_input(window, cx);
        self.input.focus_handle(cx).focus(window);
        self.begin_transition(1.0);
        cx.notify();
        true
    }

    fn on_machine_input(
        &mut self,
        event: &InputEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !matches!(event, InputEvent::Change) {
            return;
        }
        let Some(input) = &self.machine_input else {
            return;
        };
        let input_len = input.read(cx).value().chars().count();
        if input_len != self.machine_input_len {
            self.audio.play(if input_len < self.machine_input_len {
                KeySound::Delete
            } else {
                KeySound::Character
            });
            self.machine_input_len = input_len;
        }
        cx.notify();
    }

    fn refresh_machine_input(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self._machine_subscription = None;
        self.machine_input = None;
        self.machine_input_len = 0;
        let Some(setup) = &self.machine_setup else {
            return;
        };
        self.machine_input_len = setup.name().chars().count();
        self.machine_input = new_machine_input(setup, window, cx);
        if let Some(input) = &self.machine_input {
            self._machine_subscription =
                Some(
                    cx.subscribe_in(input, window, |this, _, event, window, cx| {
                        this.on_machine_input(event, window, cx);
                    }),
                );
            input.focus_handle(cx).focus(window);
        } else {
            self.machine_focus.focus(window);
        }
    }

    pub(super) fn render_machine_setup(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(setup) = &self.machine_setup else {
            return div().into_any_element();
        };
        let installing = setup.phase() == MachineSetupPhase::Installing;
        let name = setup.name().to_string();
        let error = setup.error().map(str::to_string);
        let input = self.machine_input.clone();
        let viewport_width = f32::from(window.viewport_size().width);
        let value_size = (viewport_width * 0.038).clamp(36.0, 54.0);

        let content = div()
            .w_full()
            .max_w(px(920.0))
            .px(px(34.0))
            .flex()
            .flex_col()
            .gap(px(18.0))
            .child(
                div()
                    .font_family(theme::MONO_FONT)
                    .text_size(px(10.0))
                    .text_color(theme::color(theme::TEXT_FAINT))
                    .child(if installing {
                        "CONNECTING THIS COMPUTER"
                    } else {
                        "CONNECT THIS COMPUTER"
                    }),
            )
            .child(
                div()
                    .font_family(theme::PROSE_FONT)
                    .font_weight(FontWeight::NORMAL)
                    .text_size(px(22.0))
                    .text_color(theme::color(theme::TEXT_QUIET))
                    .child(if installing {
                        format!("Making {name} available to your personal intelligence…")
                    } else {
                        "What should we call this computer?".to_string()
                    }),
            )
            .when_some(input, |this, input| {
                this.child(
                    Input::new(&input)
                        .appearance(false)
                        .bordered(false)
                        .focus_bordered(false)
                        .w_full()
                        .h(px(value_size * 1.55))
                        .p_0()
                        .font_family(theme::PROSE_FONT)
                        .font_weight(FontWeight::MEDIUM)
                        .text_size(px(value_size))
                        .text_color(theme::color(theme::TEXT)),
                )
            })
            .when_some(error, |this, error| {
                this.child(
                    div()
                        .mt(px(4.0))
                        .max_w(px(760.0))
                        .font_family(theme::MONO_FONT)
                        .text_size(px(11.0))
                        .text_color(theme::color(theme::ERROR))
                        .child(format!("COULDN’T CONNECT · {error}")),
                )
            });

        div()
            .id("machine-setup-surface")
            .track_focus(&self.machine_focus)
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_center()
            .occlude()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, window, cx| {
                    if let Some(input) = &this.machine_input {
                        input.focus_handle(cx).focus(window);
                    }
                }),
            )
            .child(content)
            .when(!installing, |this| {
                this.child(
                    div()
                        .absolute()
                        .bottom(px(31.0))
                        .left_0()
                        .right_0()
                        .flex()
                        .items_center()
                        .justify_center()
                        .gap(px(24.0))
                        .font_family(theme::MONO_FONT)
                        .text_size(px(10.0))
                        .child(
                            div()
                                .id("connect-machine")
                                .cursor_pointer()
                                .text_color(theme::color(theme::ACCENT))
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.submit_machine_setup(window, cx);
                                }))
                                .child("CONNECT COMPUTER · ENTER"),
                        )
                        .child(
                            div()
                                .id("skip-machine")
                                .cursor_pointer()
                                .text_color(theme::color(theme::TEXT_FAINT))
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.dismiss_machine_setup(window, cx);
                                }))
                                .child("NOT NOW · ESC"),
                        ),
                )
            })
            .into_any_element()
    }
}
