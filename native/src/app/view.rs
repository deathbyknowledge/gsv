use std::time::Duration;

use gpui::prelude::FluentBuilder as _;
use gpui::{
    div, ease_out_quint, point, px, relative, Animation, AnimationExt as _, AnyElement, Context,
    Focusable, FontWeight, InteractiveElement as _, IntoElement, MouseButton, ParentElement as _,
    Render, ScrollWheelEvent, StatefulInteractiveElement, Styled, Window,
};
use gpui_component::input::Input;

use crate::content::{MediaAttachment, RichDocument};
use crate::interaction::CanvasLayer;
use crate::model::{ConnectionState, MomentRole, MomentState, SurfaceMode};
use crate::theme;
use crate::typography::{fit_type_layout, TypeLayout};

use super::media::release_assets;
use super::rich::{document_for_moment, media_descriptors, needs_rich_renderer, render_document};
use super::{type_content_hash, CachedTypeLayout, GsvApp};

#[derive(Clone, Copy)]
struct CanvasGeometry {
    left: f32,
    right: f32,
    vertical: f32,
    available_height: f32,
}

struct TypeFit<'a> {
    key: &'a str,
    text: &'a str,
    available_width: f32,
    available_height: f32,
    maximum_size: Option<f32>,
    weight: FontWeight,
}

struct MessageCanvas {
    message: String,
    rich_document: Option<RichDocument>,
    layout: TypeLayout,
    weight: FontWeight,
    color: gpui::Hsla,
    geometry: CanvasGeometry,
}

const HISTORY_SCROLL_THRESHOLD: f32 = 36.0;
const TYPE_LAYOUT_CACHE_LIMIT: usize = 64;

fn message_measurement_text(message: &str, media: &[MediaAttachment]) -> String {
    if !message.is_empty() {
        return message.to_string();
    }
    media
        .iter()
        .find_map(|attachment| {
            attachment
                .description
                .as_deref()
                .or(attachment.filename.as_deref())
        })
        .unwrap_or("Media")
        .to_string()
}

impl GsvApp {
    fn fit_cached_type_layout(&mut self, window: &Window, request: TypeFit<'_>) -> TypeLayout {
        let TypeFit {
            key,
            text,
            available_width,
            available_height,
            maximum_size,
            weight,
        } = request;
        if let Some(cached) = self
            .type_layouts
            .get(key)
            .copied()
            .filter(|cached| cached.matches(text, maximum_size, weight))
        {
            return cached.layout;
        }

        let layout = fit_type_layout(
            window,
            text,
            available_width,
            available_height,
            maximum_size,
            weight,
        );
        if self.type_layouts.len() >= TYPE_LAYOUT_CACHE_LIMIT
            && !self.type_layouts.contains_key(key)
        {
            self.type_layouts.clear();
        }
        self.type_layouts.insert(
            key.to_string(),
            CachedTypeLayout {
                content_hash: type_content_hash(text),
                maximum_size: maximum_size.map(f32::to_bits),
                weight: weight.0.to_bits(),
                layout,
            },
        );
        layout
    }

    fn render_timeline(&mut self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let selected = self.conversation.selected;
        let draft_visible = self.interaction.layer == CanvasLayer::Draft;
        let mut markers = self
            .conversation
            .moments
            .iter()
            .enumerate()
            .map(|(index, moment)| {
                let is_selected = index == selected && !draft_visible;
                let marker_color = match moment.state {
                    MomentState::Sending | MomentState::Streaming => theme::color(theme::LIVE),
                    MomentState::Error | MomentState::Uncertain => theme::color(theme::ERROR),
                    MomentState::Approval => theme::color(theme::APPROVAL),
                    MomentState::Complete if is_selected => theme::color(theme::ACCENT),
                    MomentState::Complete => theme::color(theme::TEXT_FAINT),
                };
                let align_user = moment.role == MomentRole::User;
                div()
                    .id(("moment", index))
                    .w(px(32.0))
                    .h(px(20.0))
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .when(align_user, |this| this.justify_end())
                    .when(!align_user, |this| this.justify_start())
                    .cursor_pointer()
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.select_moment(index, cx);
                    }))
                    .child(
                        div()
                            .w(px(if is_selected { 4.5 } else { 3.0 }))
                            .h(px(if is_selected { 14.0 } else { 3.0 }))
                            .rounded_full()
                            .bg(marker_color)
                            .when(is_selected, |this| this.shadow_sm()),
                    )
                    .into_any_element()
            })
            .collect::<Vec<_>>();

        if !self.interaction.conversation_draft().is_empty() {
            let held = self.interaction.held_draft();
            markers.push(
                div()
                    .id("held-draft")
                    .w(px(32.0))
                    .h(px(20.0))
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .justify_end()
                    .cursor_pointer()
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.show_held_draft(cx);
                    }))
                    .child(
                        div()
                            .w(px(if draft_visible { 4.5 } else { 3.0 }))
                            .h(px(if draft_visible { 14.0 } else { 7.0 }))
                            .rounded_full()
                            .when(!held, |this| this.bg(theme::color(theme::ACCENT)))
                            .when(held, |this| {
                                this.border_1()
                                    .border_color(theme::color(theme::TEXT_QUIET))
                            }),
                    )
                    .into_any_element(),
            );
        }
        let marker_count = markers.len() as f32;
        let marker_height = marker_count * 20.0 + (marker_count - 1.0).max(0.0) * 5.0;
        let center_markers = marker_height + 140.0 <= f32::from(window.viewport_size().height);

        div()
            .absolute()
            .left_0()
            .top_0()
            .w(px(82.0))
            .h_full()
            .flex()
            .justify_center()
            .overflow_hidden()
            .child(
                div()
                    .id("timeline-scroll")
                    .h_full()
                    .py(px(70.0))
                    .flex()
                    .flex_col()
                    .when(center_markers, |this| this.justify_center())
                    .gap(px(5.0))
                    .overflow_y_scroll()
                    .track_scroll(&self.timeline_scroll)
                    .occlude()
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|this, _, window, cx| {
                            this.input.focus_handle(cx).focus(window);
                        }),
                    )
                    .children(markers),
            )
            .into_any_element()
    }

    fn render_conversation(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let viewport = window.viewport_size();
        let viewport_width = f32::from(viewport.width);
        let viewport_height = f32::from(viewport.height);
        let viewport_key = (
            viewport_width.round() as u32,
            viewport_height.round() as u32,
        );
        if self.type_viewport != Some(viewport_key) {
            self.stream_type_sizes.clear();
            self.type_layouts.clear();
            self.draft_type_size = None;
            self.type_viewport = Some(viewport_key);
        }
        let left_padding = (viewport_width * 0.065).clamp(108.0, 142.0);
        let right_padding = (viewport_width * 0.065).clamp(46.0, 142.0);
        let vertical_padding = (viewport_height * 0.105).clamp(50.0, 108.0);
        let available_width = (viewport_width - left_padding - right_padding).max(1.0);
        let available_height = (viewport_height - vertical_padding * 2.0 - 34.0).max(1.0);
        let geometry = CanvasGeometry {
            left: left_padding,
            right: right_padding,
            vertical: vertical_padding,
            available_height,
        };

        let current = if self.interaction.is_approval() {
            self.conversation
                .moments
                .iter()
                .rev()
                .find(|moment| moment.state == MomentState::Approval)
        } else {
            self.conversation.current().filter(|moment| {
                moment.state != MomentState::Streaming
                    || !moment.text.trim().is_empty()
                    || !moment.media.is_empty()
            })
        };
        let (message, media, moment_id, run_id, role, state) = match current {
            Some(moment) => (
                moment.text.clone(),
                moment.media.clone(),
                moment.id.clone(),
                moment.run_id.clone(),
                moment.role,
                moment.state,
            ),
            None if self.conversation.connection == ConnectionState::Connecting => (
                "Reaching your GSV…".to_string(),
                Vec::new(),
                "system:connecting".to_string(),
                None,
                MomentRole::System,
                MomentState::Complete,
            ),
            None => (
                "Begin anywhere.".to_string(),
                Vec::new(),
                "system:begin".to_string(),
                None,
                MomentRole::Intelligence,
                MomentState::Complete,
            ),
        };
        let document = document_for_moment(
            &mut self.rich_documents,
            &moment_id,
            role,
            state,
            &message,
            &media,
        );
        let rich_message = needs_rich_renderer(&document);
        if self.message_scroll_moment.as_deref() != Some(moment_id.as_str()) {
            self.message_scroll.set_offset(point(px(0.0), px(0.0)));
            self.message_scroll_moment = Some(moment_id.clone());
            self.history_scroll_accumulator = 0.0;
            self.history_scroll_last_event = None;
        }

        let message_weight = if role == MomentRole::User {
            FontWeight::MEDIUM
        } else {
            FontWeight::NORMAL
        };
        let moment_type_key = format!("moment:{moment_id}");
        let run_type_key = run_id.map(|run_id| format!("run:{run_id}"));
        let maximum_size = if role == MomentRole::Intelligence {
            self.stream_type_sizes
                .get(&moment_type_key)
                .copied()
                .or_else(|| {
                    (state == MomentState::Streaming)
                        .then(|| {
                            run_type_key
                                .as_ref()
                                .and_then(|key| self.stream_type_sizes.get(key).copied())
                        })
                        .flatten()
                })
        } else {
            None
        };
        self.stream_type_sizes.clear();
        let measurement_text = message_measurement_text(&message, &media);
        let message_layout = self.fit_cached_type_layout(
            window,
            TypeFit {
                key: &moment_type_key,
                text: &measurement_text,
                available_width,
                available_height,
                maximum_size,
                weight: message_weight,
            },
        );
        if role == MomentRole::Intelligence
            && (state == MomentState::Streaming || maximum_size.is_some())
        {
            self.stream_type_sizes
                .insert(moment_type_key, message_layout.size);
            if state == MomentState::Streaming {
                if let Some(run_type_key) = run_type_key {
                    self.stream_type_sizes
                        .insert(run_type_key, message_layout.size);
                }
            }
        }

        let message_color = match state {
            MomentState::Error => theme::color(theme::ERROR),
            MomentState::Approval => theme::color(theme::APPROVAL),
            MomentState::Sending | MomentState::Uncertain => theme::color(theme::TEXT_QUIET),
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
        let draft = self.interaction.visible_draft().map(str::to_string);
        let draft_visible = draft.is_some();
        if draft_visible {
            release_assets(self.media_cache.sync([], &self.commands), cx);
        } else {
            release_assets(
                self.media_cache
                    .sync(media_descriptors(&document), &self.commands),
                cx,
            );
        }
        let activity = self.conversation.activity.clone().or_else(|| {
            (!draft_visible && state == MomentState::Uncertain)
                .then(|| "DELIVERY NOT CONFIRMED · CHECKING HISTORY".to_string())
        });
        let show_hint = !self.interaction.has_interacted()
            && activity.is_none()
            && !self.interaction.is_approval();

        let canvas = if let Some(draft) = draft {
            let draft_layout = self.fit_cached_type_layout(
                window,
                TypeFit {
                    key: "draft",
                    text: &draft,
                    available_width,
                    available_height,
                    maximum_size: self.draft_type_size,
                    weight: FontWeight::NORMAL,
                },
            );
            self.draft_type_size = Some(draft_layout.size);
            self.render_draft_canvas(
                draft_layout,
                geometry,
                self.interaction.layer == CanvasLayer::ApprovalDraft,
            )
        } else {
            self.render_message_canvas(
                MessageCanvas {
                    message,
                    rich_document: rich_message.then_some(document),
                    layout: message_layout,
                    weight: message_weight,
                    color: message_color,
                    geometry,
                },
                cx,
            )
        };

        let sink_layout = if draft_visible {
            None
        } else {
            let sink_value = self.input.read(cx).value().to_string();
            let layout = self.fit_cached_type_layout(
                window,
                TypeFit {
                    key: "draft",
                    text: &sink_value,
                    available_width,
                    available_height,
                    maximum_size: self.draft_type_size,
                    weight: FontWeight::NORMAL,
                },
            );
            self.draft_type_size = Some(layout.size);
            Some(layout)
        };

        div()
            .relative()
            .size_full()
            .overflow_hidden()
            .when_some(sink_layout, |this, sink_layout| {
                this.child(self.render_input_sink(sink_layout, geometry))
            })
            .child(canvas)
            .when_some(activity, |this, activity| {
                this.child(
                    div()
                        .absolute()
                        .bottom(px(34.0))
                        .left_0()
                        .right_0()
                        .flex()
                        .justify_center()
                        .font_family(theme::MONO_FONT)
                        .text_size(px(9.0))
                        .text_color(theme::color(theme::TEXT_QUIET))
                        .child(activity),
                )
            })
            .when(show_hint, |this| {
                this.child(
                    div()
                        .absolute()
                        .bottom(px(34.0))
                        .left_0()
                        .right_0()
                        .flex()
                        .justify_center()
                        .font_family(theme::MONO_FONT)
                        .text_size(px(9.0))
                        .text_color(theme::color(theme::TEXT_FAINT))
                        .child(
                            "TYPE ANYWHERE   ·   ENTER SENDS   ·   SHIFT ENTER NEW LINE   ·   SCROLL HISTORY",
                        ),
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

    fn render_input_sink(&self, layout: TypeLayout, geometry: CanvasGeometry) -> AnyElement {
        div()
            .absolute()
            .inset_0()
            .pl(px(geometry.left))
            .pr(px(geometry.right))
            .py(px(geometry.vertical))
            .flex()
            .items_center()
            .justify_center()
            .overflow_hidden()
            .opacity(0.0)
            .child(
                Input::new(&self.input)
                    .appearance(false)
                    .bordered(false)
                    .focus_bordered(false)
                    .w_full()
                    .max_w(px(layout.width))
                    .p_0()
                    .font_family(theme::PROSE_FONT)
                    .text_size(px(layout.size))
                    .line_height(relative(layout.line_height)),
            )
            .into_any_element()
    }

    fn render_message_canvas(
        &mut self,
        request: MessageCanvas,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let MessageCanvas {
            message,
            rich_document,
            layout,
            weight,
            color,
            geometry,
        } = request;
        let is_rich = rich_document.is_some();
        let is_long = layout.scrolls || is_rich;
        let content = if let Some(document) = rich_document {
            div()
                .w_full()
                .min_h(px(geometry.available_height))
                .flex()
                .flex_col()
                .justify_center()
                .child(render_document(
                    document,
                    &self.media_cache,
                    self.message_scroll_moment.as_deref().unwrap_or("message"),
                    layout.size,
                    color,
                    geometry.available_height,
                ))
                .into_any_element()
        } else {
            message.into_any_element()
        };
        let message = div()
            .relative()
            .w_full()
            .max_w(px(layout.width))
            .font_family(theme::PROSE_FONT)
            .font_weight(weight)
            .text_size(px(layout.size))
            .line_height(relative(layout.line_height))
            .text_color(color)
            .child(content);
        let direction = self.transition_direction;
        let message = if self.reduced_motion {
            message.into_any_element()
        } else {
            message
                .with_animation(
                    ("message-enter", self.transition_epoch),
                    Animation::new(Duration::from_millis(175)).with_easing(ease_out_quint()),
                    move |this, delta| {
                        let offset = direction * 12.0 * (1.0 - delta);
                        this.top(px(offset)).opacity(delta)
                    },
                )
                .into_any_element()
        };

        div()
            .id(("message-scroll", self.transition_epoch))
            .absolute()
            .inset_0()
            .pl(px(geometry.left))
            .pr(px(geometry.right))
            .pt(px(geometry.vertical))
            .pb(px(geometry.vertical + 24.0))
            .flex()
            .justify_center()
            .when(is_long, |this| this.items_start())
            .when(!is_long, |this| this.items_center())
            .overflow_hidden()
            .track_scroll(&self.message_scroll)
            .occlude()
            .on_scroll_wheel(cx.listener(Self::scroll_moments))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, window, cx| {
                    this.input.focus_handle(cx).focus(window);
                }),
            )
            .child(message)
            .into_any_element()
    }

    fn scroll_moments(&mut self, event: &ScrollWheelEvent, _: &mut Window, cx: &mut Context<Self>) {
        let delta = event.delta.pixel_delta(px(16.0));
        let vertical = f32::from(delta.y);
        let horizontal = f32::from(delta.x);
        if vertical.abs() <= horizontal.abs() || vertical == 0.0 {
            return;
        }
        let now = std::time::Instant::now();
        if self
            .history_scroll_last_event
            .is_none_or(|previous| now.duration_since(previous) > Duration::from_millis(180))
        {
            self.history_scroll_accumulator = 0.0;
        }
        self.history_scroll_last_event = Some(now);

        let maximum = f32::from(self.message_scroll.max_offset().height);
        let offset = f32::from(self.message_scroll.offset().y).clamp(-maximum, 0.0);
        let target = (offset + vertical).clamp(-maximum, 0.0);
        cx.stop_propagation();

        if (target - offset).abs() > 0.5 {
            self.message_scroll.set_offset(point(px(0.0), px(target)));
            self.history_scroll_accumulator = 0.0;
            cx.notify();
            return;
        }

        if self.history_scroll_accumulator != 0.0
            && self.history_scroll_accumulator.signum() != vertical.signum()
        {
            self.history_scroll_accumulator = 0.0;
        }
        self.history_scroll_accumulator += vertical;

        if self.history_scroll_accumulator.abs() < HISTORY_SCROLL_THRESHOLD {
            return;
        }
        let direction = if self.history_scroll_accumulator > 0.0 {
            -1
        } else {
            1
        };
        self.history_scroll_accumulator = 0.0;
        self.move_moment(direction, cx);
    }

    fn render_draft_canvas(
        &self,
        layout: TypeLayout,
        geometry: CanvasGeometry,
        approval: bool,
    ) -> AnyElement {
        let is_long = layout.scrolls;
        div()
            .id(("draft-scroll", self.transition_epoch))
            .absolute()
            .inset_0()
            .pl(px(geometry.left))
            .pr(px(geometry.right))
            .pt(px(geometry.vertical))
            .pb(px(geometry.vertical + 24.0))
            .flex()
            .justify_center()
            .when(is_long, |this| this.items_start())
            .when(!is_long, |this| this.items_center())
            .overflow_hidden()
            .child(
                Input::new(&self.input)
                    .appearance(false)
                    .bordered(false)
                    .focus_bordered(false)
                    .w_full()
                    .max_w(px(layout.width))
                    .max_h(px(geometry.available_height))
                    .p_0()
                    .font_family(theme::PROSE_FONT)
                    .font_weight(FontWeight::NORMAL)
                    .text_size(px(layout.size))
                    .line_height(relative(layout.line_height))
                    .text_color(if approval {
                        theme::color(theme::APPROVAL)
                    } else {
                        theme::color(theme::TEXT)
                    }),
            )
            .into_any_element()
    }

    fn render_terminal(&mut self, cx: &mut Context<Self>) -> AnyElement {
        release_assets(self.media_cache.sync([], &self.commands), cx);
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
        let login_visible = self.login.is_some();
        div()
            .id("gsv-native")
            .key_context("GsvNative")
            .relative()
            .size_full()
            .bg(theme::color(theme::VOID))
            .text_color(theme::color(theme::TEXT))
            .on_action(cx.listener(Self::hide_draft))
            .on_action(cx.listener(Self::submit_thought_action))
            .on_action(cx.listener(Self::insert_newline_action))
            .on_action(cx.listener(Self::abort_run))
            .on_action(cx.listener(Self::toggle_terminal_action))
            .on_action(cx.listener(Self::previous_moment))
            .on_action(cx.listener(Self::next_moment))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, window, cx| {
                    this.focus_active_input(window, cx);
                }),
            )
            .when(login_visible, |this| {
                this.child(self.render_login(window, cx))
            })
            .when(
                !login_visible && self.conversation.mode == SurfaceMode::Conversation,
                |this| {
                    this.child(self.render_conversation(window, cx))
                        .child(self.render_timeline(window, cx))
                },
            )
            .when(
                !login_visible && self.conversation.mode == SurfaceMode::Terminal,
                |this| this.child(self.render_terminal(cx)),
            )
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::rc::Rc;

    use gpui::{
        point, AppContext as _, Modifiers, ScrollDelta, ScrollWheelEvent, TestAppContext,
        VisualTestContext, WindowOptions,
    };
    use gpui_component::Root;

    use super::*;
    use crate::app::{bind_keys, HideDraft};
    use crate::client::ClientCommand;

    #[gpui::test]
    fn hidden_draft_does_not_receive_canvas_pointer_events(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            bind_keys(cx);
            crate::register_fonts(cx);
            crate::configure_theme(cx);
        });

        let app = Rc::new(RefCell::new(None));
        let app_for_window = app.clone();
        let client = crate::client::start(true);
        let window = cx.update(|cx| {
            cx.open_window(WindowOptions::default(), move |window, cx| {
                let view = cx.new(|cx| GsvApp::new(window, cx, client, true, false, true));
                *app_for_window.borrow_mut() = Some(view.clone());
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("the GPUI surface should open")
        });
        let mut cx = VisualTestContext::from_window(window.into(), cx);
        cx.run_until_parked();

        cx.simulate_input("held draft words");
        cx.dispatch_action(HideDraft);
        cx.run_until_parked();

        let app = app.borrow().clone().expect("app entity should be retained");
        let input = cx.cx.update(|cx| app.read(cx).input.clone());
        let cursor_before = cx.cx.update(|cx| {
            assert_eq!(app.read(cx).interaction.layer, CanvasLayer::Moment);
            input.read(cx).cursor()
        });
        assert!(cursor_before > 0);

        let viewport = cx.update(|window, _| window.viewport_size());
        let viewport_width = f32::from(viewport.width);
        let left_padding = (viewport_width * 0.065).clamp(108.0, 142.0);
        let right_padding = (viewport_width * 0.065).clamp(46.0, 142.0);
        let available_width = viewport_width - left_padding - right_padding;
        let input_width = 820.0_f32.min(available_width);
        let input_left = left_padding + (available_width - input_width) / 2.0;
        cx.simulate_click(
            point(px(input_left + 4.0), px(f32::from(viewport.height) / 2.0)),
            Modifiers::default(),
        );

        let cursor_after = cx.cx.update(|cx| input.read(cx).cursor());
        assert_eq!(cursor_after, cursor_before);
    }

    #[gpui::test]
    fn mouse_wheel_moves_between_conversation_moments(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            bind_keys(cx);
            crate::register_fonts(cx);
            crate::configure_theme(cx);
        });

        let app = Rc::new(RefCell::new(None));
        let app_for_window = app.clone();
        let client = crate::client::start(true);
        let window = cx.update(|cx| {
            cx.open_window(WindowOptions::default(), move |window, cx| {
                let view = cx.new(|cx| GsvApp::new(window, cx, client, true, false, true));
                *app_for_window.borrow_mut() = Some(view.clone());
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("the GPUI surface should open")
        });
        let mut cx = VisualTestContext::from_window(window.into(), cx);
        cx.run_until_parked();

        let app = app.borrow().clone().expect("app entity should be retained");
        cx.cx.update(|cx| {
            let app = app.read(cx);
            assert_eq!(app.conversation.selected, 2);
            assert_eq!(app.audio.request_count(crate::audio::KeySound::Navigate), 0);
        });
        let viewport = cx.update(|window, _| window.viewport_size());
        let position = point(
            px(f32::from(viewport.width) / 2.0),
            px(f32::from(viewport.height) / 2.0),
        );

        cx.simulate_event(ScrollWheelEvent {
            position,
            delta: ScrollDelta::Lines(point(0.0, 3.0)),
            ..Default::default()
        });
        cx.cx.update(|cx| {
            let app = app.read(cx);
            assert_eq!(app.conversation.selected, 1);
            assert_eq!(app.audio.request_count(crate::audio::KeySound::Navigate), 1);
        });

        cx.simulate_event(ScrollWheelEvent {
            position,
            delta: ScrollDelta::Lines(point(0.0, -3.0)),
            ..Default::default()
        });
        cx.cx.update(|cx| {
            let app = app.read(cx);
            assert_eq!(app.conversation.selected, 2);
            assert_eq!(app.audio.request_count(crate::audio::KeySound::Navigate), 2);
        });

        cx.simulate_event(ScrollWheelEvent {
            position: point(px(40.0), px(f32::from(viewport.height) / 2.0)),
            delta: ScrollDelta::Lines(point(0.0, 3.0)),
            ..Default::default()
        });
        cx.cx.update(|cx| {
            let app = app.read(cx);
            assert_eq!(app.conversation.selected, 2);
            assert_eq!(app.audio.request_count(crate::audio::KeySound::Navigate), 2);
        });
    }

    #[gpui::test]
    fn long_message_scroll_reaches_the_edge_before_moving_to_the_next_moment(
        cx: &mut TestAppContext,
    ) {
        cx.update(|cx| {
            gpui_component::init(cx);
            bind_keys(cx);
            crate::register_fonts(cx);
            crate::configure_theme(cx);
        });

        let app = Rc::new(RefCell::new(None));
        let app_for_window = app.clone();
        let client = crate::client::start(true);
        let window = cx.update(|cx| {
            cx.open_window(WindowOptions::default(), move |window, cx| {
                let view = cx.new(|cx| GsvApp::new(window, cx, client, true, false, true));
                *app_for_window.borrow_mut() = Some(view.clone());
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("the GPUI surface should open")
        });
        let mut cx = VisualTestContext::from_window(window.into(), cx);
        cx.run_until_parked();

        let app = app.borrow().clone().expect("app entity should be retained");
        cx.cx.update(|cx| {
            app.update(cx, |app, cx| {
                app.conversation.moments[1].text = "A long message. ".repeat(2_000);
                app.conversation.select(1);
                cx.notify();
            });
        });
        cx.run_until_parked();
        let maximum = cx.cx.update(|cx| {
            let app = app.read(cx);
            assert_eq!(app.conversation.selected, 1);
            app.message_scroll.max_offset().height
        });
        assert!(maximum > px(0.0));

        let viewport = cx.update(|window, _| window.viewport_size());
        let position = point(
            px(f32::from(viewport.width) / 2.0),
            px(f32::from(viewport.height) / 2.0),
        );
        cx.simulate_event(ScrollWheelEvent {
            position,
            delta: ScrollDelta::Pixels(point(px(0.0), -maximum - px(100.0))),
            ..Default::default()
        });
        cx.cx.update(|cx| {
            let app = app.read(cx);
            assert_eq!(app.conversation.selected, 1);
            assert_eq!(app.message_scroll.offset().y, -maximum);
            assert_eq!(app.audio.request_count(crate::audio::KeySound::Navigate), 0);
        });

        cx.simulate_event(ScrollWheelEvent {
            position,
            delta: ScrollDelta::Lines(point(0.0, -3.0)),
            ..Default::default()
        });
        cx.cx.update(|cx| {
            let app = app.read(cx);
            assert_eq!(app.conversation.selected, 2);
            assert_eq!(app.audio.request_count(crate::audio::KeySound::Navigate), 1);
        });
    }

    #[gpui::test]
    fn completed_stream_size_is_retained_until_navigation(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            bind_keys(cx);
            crate::register_fonts(cx);
            crate::configure_theme(cx);
        });

        let app = Rc::new(RefCell::new(None));
        let app_for_window = app.clone();
        let client = crate::client::start(true);
        let window = cx.update(|cx| {
            cx.open_window(WindowOptions::default(), move |window, cx| {
                let view = cx.new(|cx| GsvApp::new(window, cx, client, true, false, true));
                *app_for_window.borrow_mut() = Some(view.clone());
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("the GPUI surface should open")
        });
        let cx = VisualTestContext::from_window(window.into(), cx);
        cx.run_until_parked();

        let app = app.borrow().clone().expect("app entity should be retained");
        cx.cx.update(|cx| {
            app.update(cx, |app, cx| {
                app.conversation.start_run("run-1");
                app.conversation
                    .stream_text(Some("run-1"), &"A measured response. ".repeat(160));
                cx.notify();
            });
        });
        cx.run_until_parked();
        let live_size = cx.cx.update(|cx| {
            let app = app.read(cx);
            assert_eq!(app.stream_type_sizes.len(), 2);
            let mut sizes = app.stream_type_sizes.values().copied();
            let size = sizes.next().expect("live stream size should be cached");
            assert!(sizes.all(|other| other == size));
            size
        });

        cx.cx.update(|cx| {
            app.update(cx, |app, cx| {
                assert!(app.conversation.finish_run(Some("run-1"), None));
                cx.notify();
            });
        });
        cx.run_until_parked();
        cx.cx.update(|cx| {
            let app = app.read(cx);
            assert_eq!(app.stream_type_sizes.len(), 1);
            assert_eq!(app.stream_type_sizes.values().next(), Some(&live_size));
        });

        cx.cx.update(|cx| {
            app.update(cx, |app, cx| {
                app.conversation.select_previous();
                cx.notify();
            });
        });
        cx.run_until_parked();
        cx.cx
            .update(|cx| assert!(app.read(cx).stream_type_sizes.is_empty()));
    }

    #[gpui::test]
    fn completed_message_layouts_survive_navigation_and_repaints(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            bind_keys(cx);
            crate::register_fonts(cx);
            crate::configure_theme(cx);
        });

        let app = Rc::new(RefCell::new(None));
        let app_for_window = app.clone();
        let client = crate::client::start(true);
        let window = cx.update(|cx| {
            cx.open_window(WindowOptions::default(), move |window, cx| {
                let view = cx.new(|cx| GsvApp::new(window, cx, client, true, false, true));
                *app_for_window.borrow_mut() = Some(view.clone());
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("the GPUI surface should open")
        });
        let cx = VisualTestContext::from_window(window.into(), cx);
        cx.run_until_parked();

        let app = app.borrow().clone().expect("app entity should be retained");
        let latest_key = "moment:demo-3";
        cx.cx.update(|cx| {
            assert!(app.read(cx).type_layouts.contains_key(latest_key));
            app.update(cx, |app, cx| {
                app.conversation.select_previous();
                cx.notify();
            });
        });
        cx.run_until_parked();
        let cached = cx.cx.update(|cx| {
            let app = app.read(cx);
            assert!(app.type_layouts.contains_key(latest_key));
            assert!(app.type_layouts.contains_key("moment:demo-2"));
            app.type_layouts.clone()
        });

        cx.cx.update(|cx| app.update(cx, |_, cx| cx.notify()));
        cx.run_until_parked();
        cx.cx
            .update(|cx| assert_eq!(app.read(cx).type_layouts, cached));
    }

    #[gpui::test]
    fn selected_remote_markdown_images_load_and_cancel_with_the_moment(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            bind_keys(cx);
            crate::register_fonts(cx);
            crate::configure_theme(cx);
        });

        let (commands, mut command_rx) = tokio::sync::mpsc::unbounded_channel();
        let (_events, event_rx) = tokio::sync::mpsc::unbounded_channel();
        let client = crate::client::ClientHandle {
            commands,
            events: event_rx,
            login: None,
        };
        let app = Rc::new(RefCell::new(None));
        let app_for_window = app.clone();
        let window = cx.update(|cx| {
            cx.open_window(WindowOptions::default(), move |window, cx| {
                let view = cx.new(|cx| GsvApp::new(window, cx, client, true, false, true));
                *app_for_window.borrow_mut() = Some(view.clone());
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("the GPUI surface should open")
        });
        let cx = VisualTestContext::from_window(window.into(), cx);
        cx.run_until_parked();

        let app = app.borrow().clone().expect("app entity should be retained");
        cx.cx.update(|cx| {
            app.update(cx, |app, cx| {
                app.conversation.moments[2].text =
                    "# Result\n\n![map](https://example.com/map.png)".to_string();
                cx.notify();
            });
        });
        cx.run_until_parked();

        let command = command_rx.try_recv().expect("remote image load");
        assert!(matches!(command, ClientCommand::LoadMedia { .. }));
        let ClientCommand::LoadMedia { request_id, source } = command else {
            return;
        };
        assert_eq!(
            source,
            crate::client::MediaSource::Remote {
                url: "https://example.com/map.png".to_string()
            }
        );
        cx.cx.update(|cx| {
            let app = app.read(cx);
            assert!(app.rich_documents.contains_key("demo-3"));
        });

        cx.cx.update(|cx| {
            app.update(cx, |app, cx| {
                app.conversation.select_previous();
                cx.notify();
            });
        });
        cx.run_until_parked();
        assert!(matches!(
            command_rx.try_recv(),
            Ok(ClientCommand::CancelMedia { request_id: cancelled }) if cancelled == request_id
        ));
    }
}
