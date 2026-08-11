use gpui::prelude::FluentBuilder as _;
use gpui::{
    div, px, relative, AnyElement, Context, Focusable, FontWeight, InteractiveElement as _,
    IntoElement, MouseButton, ParentElement as _, Render, StatefulInteractiveElement, Styled,
    Window,
};
use gpui_component::input::Input;

use crate::model::{adaptive_type_layout, ConnectionState, MomentRole, MomentState, SurfaceMode};
use crate::theme;

use super::GsvApp;

impl GsvApp {
    fn render_timeline(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let selected = self.conversation.selected;
        let markers = self
            .conversation
            .moments
            .iter()
            .enumerate()
            .map(|(index, moment)| {
                let is_selected = index == selected && !self.draft_visible;
                let marker_color = match moment.state {
                    MomentState::Streaming => theme::color(theme::LIVE),
                    MomentState::Error => theme::color(theme::ERROR),
                    MomentState::Approval => theme::color(theme::APPROVAL),
                    MomentState::Complete if is_selected => theme::color(theme::ACCENT),
                    MomentState::Complete => theme::color(theme::TEXT_FAINT),
                };
                let align_user = moment.role == MomentRole::User;
                div()
                    .id(("moment", index))
                    .w(px(24.0))
                    .h(px(if is_selected { 22.0 } else { 16.0 }))
                    .flex()
                    .items_center()
                    .when(align_user, |this| this.justify_end())
                    .when(!align_user, |this| this.justify_start())
                    .cursor_pointer()
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.draft_visible = false;
                        this.conversation.select(index);
                        cx.notify();
                    }))
                    .child(
                        div()
                            .w(px(if is_selected { 5.0 } else { 3.5 }))
                            .h(px(if is_selected { 15.0 } else { 3.5 }))
                            .rounded_full()
                            .bg(marker_color)
                            .when(is_selected, |this| this.shadow_sm()),
                    )
            })
            .collect::<Vec<_>>();

        div()
            .w(px(72.0))
            .h_full()
            .flex()
            .justify_center()
            .overflow_hidden()
            .child(
                div()
                    .id("timeline-scroll")
                    .h_full()
                    .py(px(74.0))
                    .flex()
                    .flex_col()
                    .justify_center()
                    .gap(px(7.0))
                    .overflow_y_scroll()
                    .children(markers),
            )
            .into_any_element()
    }

    fn render_conversation(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let input_value = self.input.read(cx).value().to_string();
        let draft_layout = adaptive_type_layout(&input_value, false);
        let (message, role, state) = match self.conversation.current() {
            Some(moment) => (moment.text.clone(), moment.role, moment.state),
            None if self.conversation.connection == ConnectionState::Connecting => (
                "Reaching your GSV…".to_string(),
                MomentRole::System,
                MomentState::Complete,
            ),
            None => (
                "Begin anywhere.".to_string(),
                MomentRole::Intelligence,
                MomentState::Complete,
            ),
        };
        let message_layout = adaptive_type_layout(&message, state == MomentState::Streaming);
        let message_color = match state {
            MomentState::Error => theme::color(theme::ERROR),
            MomentState::Approval => theme::color(theme::APPROVAL),
            MomentState::Streaming => theme::color(theme::TEXT),
            MomentState::Complete if role == MomentRole::User => theme::color(theme::ACCENT),
            MomentState::Complete if role == MomentRole::System => theme::color(theme::TEXT_QUIET),
            MomentState::Complete => theme::color(theme::TEXT),
        };
        let mode_label = if self.conversation.mode == SurfaceMode::Conversation {
            "TERMINAL"
        } else {
            "CONVERSATION"
        };
        let activity = self.conversation.activity.clone();
        let window_height = f32::from(window.bounds().size.height);
        let vertical_padding = (window_height * 0.11).clamp(54.0, 112.0);

        div()
            .relative()
            .flex_1()
            .h_full()
            .overflow_hidden()
            .child(
                div()
                    .id("message-scroll")
                    .absolute()
                    .inset_0()
                    .px(px(68.0))
                    .py(px(vertical_padding))
                    .flex()
                    .justify_center()
                    .items_center()
                    .overflow_y_scroll()
                    .opacity(if self.draft_visible { 0.0 } else { 1.0 })
                    .child(
                        div()
                            .w_full()
                            .max_w(px(message_layout.width))
                            .font_family(theme::PROSE_FONT)
                            .font_weight(match role {
                                MomentRole::User => FontWeight::MEDIUM,
                                MomentRole::Intelligence => FontWeight::NORMAL,
                                MomentRole::System => FontWeight::NORMAL,
                            })
                            .text_size(px(message_layout.size))
                            .line_height(relative(message_layout.line_height))
                            .text_color(message_color)
                            .child(message),
                    ),
            )
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .px(px(68.0))
                    .py(px(vertical_padding))
                    .flex()
                    .justify_center()
                    .items_center()
                    .opacity(if self.draft_visible { 1.0 } else { 0.0 })
                    .child(
                        Input::new(&self.input)
                            .appearance(false)
                            .bordered(false)
                            .focus_bordered(false)
                            .w_full()
                            .max_w(px(draft_layout.width))
                            .p_0()
                            .font_family(theme::PROSE_FONT)
                            .font_weight(FontWeight::NORMAL)
                            .text_size(px(draft_layout.size))
                            .line_height(relative(draft_layout.line_height))
                            .text_color(theme::color(theme::TEXT)),
                    ),
            )
            .when_some(activity, |this, activity| {
                this.child(
                    div()
                        .absolute()
                        .bottom(px(35.0))
                        .left_0()
                        .right_0()
                        .flex()
                        .justify_center()
                        .font_family(theme::MONO_FONT)
                        .text_size(px(10.0))
                        .text_color(theme::color(theme::TEXT_QUIET))
                        .child(activity),
                )
            })
            .child(
                div()
                    .id("mode-toggle")
                    .absolute()
                    .right(px(30.0))
                    .bottom(px(27.0))
                    .px(px(4.0))
                    .py(px(3.0))
                    .cursor_pointer()
                    .font_family(theme::MONO_FONT)
                    .text_size(px(9.0))
                    .text_color(theme::color(theme::TEXT_FAINT))
                    .hover(|this| this.text_color(theme::color(theme::ACCENT)))
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.toggle_terminal(window, cx);
                    }))
                    .child(mode_label),
            )
            .into_any_element()
    }

    fn render_terminal(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let transcript = self
            .terminal
            .iter()
            .rev()
            .take(24)
            .map(|exchange| {
                let command = exchange.command.clone();
                let output = exchange.output.clone();
                let pending = exchange.pending;
                let exit_color = if exchange.exit_code.is_some_and(|code| code != 0) {
                    theme::color(theme::ERROR)
                } else {
                    theme::color(theme::TEXT_FAINT)
                };
                div()
                    .flex()
                    .flex_col()
                    .gap(px(9.0))
                    .child(
                        div()
                            .text_color(theme::color(theme::ACCENT))
                            .child(format!("› {command}")),
                    )
                    .when(!output.is_empty(), |this| {
                        this.child(
                            div()
                                .text_color(theme::color(theme::TEXT_QUIET))
                                .child(output),
                        )
                    })
                    .when_some(exchange.exit_code, |this, code| {
                        this.child(
                            div()
                                .text_size(px(9.0))
                                .text_color(exit_color)
                                .child(format!("EXIT {code}")),
                        )
                    })
                    .when(pending, |this| {
                        this.child(
                            div()
                                .text_size(px(9.0))
                                .text_color(theme::color(theme::LIVE))
                                .child("RUNNING"),
                        )
                    })
            })
            .collect::<Vec<_>>();

        div()
            .relative()
            .size_full()
            .px(px(84.0))
            .pt(px(76.0))
            .pb(px(60.0))
            .font_family(theme::MONO_FONT)
            .text_size(px(14.0))
            .line_height(relative(1.55))
            .child(
                div()
                    .size_full()
                    .max_w(px(1_020.0))
                    .mx_auto()
                    .flex()
                    .flex_col()
                    .gap(px(34.0))
                    .child(
                        div()
                            .id("terminal-scroll")
                            .flex_1()
                            .flex()
                            .flex_col_reverse()
                            .gap(px(29.0))
                            .overflow_y_scroll()
                            .children(transcript),
                    )
                    .child(
                        div()
                            .flex()
                            .items_start()
                            .gap(px(14.0))
                            .text_size(px(19.0))
                            .child(
                                div()
                                    .pt(px(4.0))
                                    .text_color(theme::color(theme::LIVE))
                                    .child("›"),
                            )
                            .child(
                                Input::new(&self.input)
                                    .appearance(false)
                                    .bordered(false)
                                    .focus_bordered(false)
                                    .flex_1()
                                    .p_0()
                                    .font_family(theme::MONO_FONT)
                                    .text_size(px(19.0))
                                    .line_height(relative(1.45))
                                    .text_color(theme::color(theme::TEXT)),
                            ),
                    ),
            )
            .child(
                div()
                    .id("conversation-toggle")
                    .absolute()
                    .right(px(30.0))
                    .bottom(px(27.0))
                    .cursor_pointer()
                    .font_family(theme::MONO_FONT)
                    .text_size(px(9.0))
                    .text_color(theme::color(theme::TEXT_FAINT))
                    .hover(|this| this.text_color(theme::color(theme::ACCENT)))
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.toggle_terminal(window, cx);
                    }))
                    .child("CONVERSATION"),
            )
            .into_any_element()
    }
}

impl Render for GsvApp {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .id("gsv-native")
            .key_context("GsvNative")
            .size_full()
            .flex()
            .bg(theme::color(theme::VOID))
            .text_color(theme::color(theme::TEXT))
            .on_action(cx.listener(Self::hide_draft))
            .on_action(cx.listener(Self::abort_run))
            .on_action(cx.listener(Self::toggle_terminal_action))
            .on_action(cx.listener(Self::previous_moment))
            .on_action(cx.listener(Self::next_moment))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, window, cx| {
                    this.input.focus_handle(cx).focus(window);
                }),
            )
            .when(
                self.conversation.mode == SurfaceMode::Conversation,
                |this| {
                    this.child(self.render_timeline(cx))
                        .child(self.render_conversation(window, cx))
                },
            )
            .when(self.conversation.mode == SurfaceMode::Terminal, |this| {
                this.child(self.render_terminal(cx))
            })
    }
}
