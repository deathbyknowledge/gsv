use gpui::{
    div, px, relative, AnyElement, Context, FontWeight, InteractiveElement as _, IntoElement,
    MouseButton, ParentElement as _, StatefulInteractiveElement as _, Styled, Window,
};

use crate::theme;

use super::{GsvApp, ToggleGestureGuide};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct GestureGuideRow {
    action: &'static str,
    posture: &'static str,
    timing: &'static str,
    effect: &'static str,
}

const VOICE_GESTURE_ROWS: [GestureGuideRow; 3] = [
    GestureGuideRow {
        action: "ARM / DISARM",
        posture: "BOTH HANDS · CLOSED FISTS",
        timing: "HOLD 700 MS",
        effect: "Works in the background. Open either fist after it toggles.",
    },
    GestureGuideRow {
        action: "START / FINISH",
        posture: "1 · INDEX ONLY",
        timing: "HOLD 350 MS",
        effect: "Starts while idle; finishes while listening.",
    },
    GestureGuideRow {
        action: "SEND",
        posture: "2 · INDEX + MIDDLE",
        timing: "HOLD 350 MS",
        effect: "Sends the current utterance and keeps listening.",
    },
];

const EDIT_GESTURE_ROWS: [GestureGuideRow; 4] = [
    GestureGuideRow {
        action: "DELETE",
        posture: "3 · INDEX + MIDDLE + RING",
        timing: "HOLD 350 MS",
        effect: "Deletes one visible character from unsent dictation.",
    },
    GestureGuideRow {
        action: "CLEAR DICTATION",
        posture: "4 · FOUR FINGERS, THUMB CLOSED",
        timing: "HOLD 1 SECOND",
        effect: "Clears dictated text; typed text and files stay.",
    },
    GestureGuideRow {
        action: "MUTE / UNMUTE",
        posture: "5 · OPEN ALL FIVE FINGERS",
        timing: "HOLD 350 MS",
        effect: "Changes only after the microphone acknowledges it.",
    },
    GestureGuideRow {
        action: "SCROLL",
        posture: "RIGHT FIST · SETTLE, THEN MOVE UP / DOWN",
        timing: "HOLD + DRAG",
        effect: "Scrolls this conversation. Open to release; fist again before a number.",
    },
];

impl GsvApp {
    pub(super) fn gesture_guide_available(&self) -> bool {
        self.vision_context.is_some() || self.vision_lifecycle.is_some()
    }

    pub(super) fn toggle_gesture_guide_action(
        &mut self,
        _: &ToggleGestureGuide,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.toggle_gesture_guide(cx);
    }

    fn toggle_gesture_guide(&mut self, cx: &mut Context<Self>) {
        if self.gesture_guide_open {
            self.close_gesture_guide(cx);
        } else if self.gesture_guide_available()
            && self.login.is_none()
            && self.microphone_chooser.is_none()
        {
            self.gesture_guide_open = true;
            cx.notify();
        }
    }

    pub(super) fn close_gesture_guide(&mut self, cx: &mut Context<Self>) -> bool {
        if !self.gesture_guide_open {
            return false;
        }
        self.gesture_guide_open = false;
        cx.notify();
        true
    }

    pub(super) fn render_gesture_guide_toggle(&self, cx: &mut Context<Self>) -> AnyElement {
        div()
            .id("gesture-guide-toggle")
            .absolute()
            .right(px(124.0))
            .bottom(px(27.0))
            .px(px(4.0))
            .py(px(3.0))
            .cursor_pointer()
            .font_family(theme::MONO_FONT)
            .text_size(px(9.0))
            .text_color(theme::color(theme::TEXT_FAINT))
            .hover(|this| this.text_color(theme::color(theme::ACCENT)))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|_, _, _, cx| cx.stop_propagation()),
            )
            .on_click(cx.listener(|this, _, _, cx| {
                cx.stop_propagation();
                this.toggle_gesture_guide(cx);
            }))
            .child("GESTURES · ⌘⇧G")
            .into_any_element()
    }

    pub(super) fn render_gesture_guide(&self, cx: &mut Context<Self>) -> AnyElement {
        let voice_rows = VOICE_GESTURE_ROWS.map(render_gesture_guide_row);
        let edit_rows = EDIT_GESTURE_ROWS.map(render_gesture_guide_row);
        let live_status = self
            .voice_notice
            .clone()
            .unwrap_or_else(|| "GESTURE CONTROL · DISARMED".to_string());

        div()
            .id("gesture-guide")
            .absolute()
            .inset_0()
            .px(px(48.0))
            .py(px(40.0))
            .flex()
            .items_center()
            .justify_center()
            .bg(theme::color(theme::VOID).opacity(0.96))
            .occlude()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, _, cx| {
                    cx.stop_propagation();
                    this.close_gesture_guide(cx);
                }),
            )
            .child(
                div()
                    .w_full()
                    .max_w(px(980.0))
                    .flex()
                    .flex_col()
                    .gap(px(18.0))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|_, _, _, cx| cx.stop_propagation()),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .font_family(theme::MONO_FONT)
                            .text_size(px(9.0))
                            .text_color(theme::color(theme::TEXT_FAINT))
                            .child("GESTURE CHEAT SHEET")
                            .child("ESC OR ⌘⇧G CLOSES"),
                    )
                    .child(
                        div()
                            .font_family(theme::PROSE_FONT)
                            .font_weight(FontWeight::NORMAL)
                            .text_size(px(25.0))
                            .line_height(relative(1.2))
                            .text_color(theme::color(theme::TEXT_QUIET))
                            .child(
                                "Hold both fists to arm. Then control everything with your right hand.",
                            ),
                    )
                    .child(
                        div()
                            .w_full()
                            .px(px(16.0))
                            .py(px(12.0))
                            .bg(theme::color(theme::SELECTION).opacity(0.38))
                            .flex()
                            .items_center()
                            .gap(px(18.0))
                            .font_family(theme::MONO_FONT)
                            .child(
                                div()
                                    .text_size(px(10.0))
                                    .text_color(theme::color(theme::ACCENT))
                                    .child("AUTHORITY · TOGGLE"),
                            )
                            .child(
                                div()
                                    .text_size(px(11.0))
                                    .text_color(theme::color(theme::TEXT_QUIET))
                                    .child(
                                        "BOTH FISTS · 700 MS · ARM OR DISARM FROM THE BACKGROUND",
                                    ),
                            ),
                    )
                    .child(
                        div()
                            .w_full()
                            .flex()
                            .gap(px(42.0))
                            .child(render_gesture_guide_column("VOICE", voice_rows))
                            .child(render_gesture_guide_column(
                                "EDITING + AUDIO",
                                edit_rows,
                            )),
                    )
                    .child(
                        div()
                            .font_family(theme::MONO_FONT)
                            .text_size(px(9.0))
                            .text_color(theme::color(theme::LIVE))
                            .child(live_status),
                    )
                    .child(
                        div()
                            .font_family(theme::MONO_FONT)
                            .text_size(px(9.0))
                            .line_height(relative(1.4))
                            .text_color(theme::color(theme::TEXT_FAINT))
                            .child(
                                "RIGHT FIST REARMS · SETTLE + DRAG THAT FIST TO SCROLL · OPEN TO RELEASE · BOTH FISTS DISARM",
                            ),
                    ),
            )
            .into_any_element()
    }
}

fn render_gesture_guide_column<const N: usize>(
    heading: &'static str,
    rows: [AnyElement; N],
) -> AnyElement {
    div()
        .flex_1()
        .min_w(px(0.0))
        .flex()
        .flex_col()
        .child(
            div()
                .pb(px(3.0))
                .font_family(theme::MONO_FONT)
                .text_size(px(9.0))
                .text_color(theme::color(theme::TEXT_FAINT))
                .child(heading),
        )
        .children(rows)
        .into_any_element()
}

fn render_gesture_guide_row(row: GestureGuideRow) -> AnyElement {
    div()
        .w_full()
        .py(px(10.0))
        .border_b_1()
        .border_color(theme::color(theme::TEXT_FAINT).opacity(0.52))
        .flex()
        .flex_col()
        .gap(px(4.0))
        .font_family(theme::MONO_FONT)
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(12.0))
                .child(
                    div()
                        .text_size(px(12.0))
                        .text_color(theme::color(theme::ACCENT))
                        .child(row.action),
                )
                .child(
                    div()
                        .text_size(px(9.0))
                        .text_color(theme::color(theme::TEXT_FAINT))
                        .child(row.timing),
                ),
        )
        .child(
            div()
                .text_size(px(10.0))
                .text_color(theme::color(theme::TEXT))
                .child(row.posture),
        )
        .child(
            div()
                .text_size(px(9.0))
                .line_height(relative(1.35))
                .text_color(theme::color(theme::TEXT_QUIET))
                .child(row.effect),
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::rc::Rc;

    use gpui::{AppContext as _, TestAppContext, VisualTestContext, WindowOptions};
    use gpui_component::Root;

    use crate::app::HideDraft;
    use crate::interaction::CanvasLayer;

    use super::*;

    #[test]
    fn cheat_sheet_covers_every_authored_action_without_legacy_pose_names() {
        let rows = VOICE_GESTURE_ROWS
            .into_iter()
            .chain(EDIT_GESTURE_ROWS)
            .collect::<Vec<_>>();
        assert_eq!(rows.len(), 7);
        assert_eq!(
            rows.iter().map(|row| row.action).collect::<Vec<_>>(),
            [
                "ARM / DISARM",
                "START / FINISH",
                "SEND",
                "DELETE",
                "CLEAR DICTATION",
                "MUTE / UNMUTE",
                "SCROLL",
            ]
        );
        let vocabulary = rows
            .iter()
            .flat_map(|row| [row.action, row.posture, row.timing, row.effect])
            .collect::<Vec<_>>()
            .join(" ")
            .to_ascii_lowercase();
        for legacy in [
            "open palm",
            "victory",
            "thumbs-up",
            "thumbs-down",
            "pinch",
            "flick",
        ] {
            assert!(!vocabulary.contains(legacy));
        }
    }

    #[gpui::test]
    fn guide_requires_gestures_and_escape_closes_it_before_the_draft(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::app::bind_keys(cx);
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

        cx.dispatch_action(ToggleGestureGuide);
        cx.run_until_parked();
        cx.cx.update(|cx| assert!(!app.read(cx).gesture_guide_open));

        cx.cx.update(|cx| {
            app.update(cx, |app, _| {
                app.vision_context = Some(crate::vision_debug::VisionContextSender::for_test());
            });
        });
        cx.simulate_input("draft stays");
        cx.dispatch_action(ToggleGestureGuide);
        cx.run_until_parked();
        cx.cx.update(|cx| {
            let app = app.read(cx);
            assert!(app.gesture_guide_open);
            assert_eq!(app.interaction.layer, CanvasLayer::Draft);
            assert_eq!(app.interaction.visible_draft(), Some("draft stays"));
        });

        cx.dispatch_action(HideDraft);
        cx.run_until_parked();
        cx.cx.update(|cx| {
            let app = app.read(cx);
            assert!(!app.gesture_guide_open);
            assert_eq!(app.interaction.layer, CanvasLayer::Draft);
            assert_eq!(app.interaction.visible_draft(), Some("draft stays"));
        });

        cx.dispatch_action(HideDraft);
        cx.run_until_parked();
        cx.cx.update(|cx| {
            assert_eq!(app.read(cx).interaction.layer, CanvasLayer::Moment);
        });
    }
}
