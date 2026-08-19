use std::time::Duration;

use gpui::prelude::FluentBuilder as _;
use gpui::{
    div, ease_out_quint, px, Animation, AnimationExt as _, AnyElement, Context, FontWeight,
    InteractiveElement as _, IntoElement, MouseButton, ParentElement as _, Styled, Window,
};
use gpui_component::input::Input;

use crate::startup::LoginStep;
use crate::theme;

use super::GsvApp;

impl GsvApp {
    pub(super) fn render_login(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(login) = &self.login else {
            return div().into_any_element();
        };
        let step = login.step();
        let error = login.error().map(str::to_string);
        let viewport_width = f32::from(window.viewport_size().width);
        let value_size = (viewport_width * 0.038).clamp(36.0, 54.0);
        let (eyebrow, question, hint, progress) = match step {
            LoginStep::Url => (
                "CONNECT · 01 / 03",
                "Where does your GSV live?",
                "ENTER CONTINUES",
                0,
            ),
            LoginStep::Username => (
                "CONNECT · 02 / 03",
                "Who are you?",
                "ENTER CONTINUES · ESC GOES BACK",
                1,
            ),
            LoginStep::Password => (
                "CONNECT · 03 / 03",
                "Your password.",
                "ENTER CONNECTS · ESC GOES BACK",
                2,
            ),
            LoginStep::Connecting => (
                "CONNECTING",
                "Reaching your GSV…",
                "ESTABLISHING A PRIVATE SESSION · ESC CANCELS",
                3,
            ),
            LoginStep::SetupRequired => (
                "SETUP REQUIRED",
                "This GSV needs its first setup.",
                "ENTER CHANGES ADDRESS · ESC GOES BACK",
                3,
            ),
        };

        let input = self.login_input.clone();
        let markers = (0..3)
            .map(|index| {
                div()
                    .w(px(if index == progress { 18.0 } else { 4.0 }))
                    .h(px(4.0))
                    .rounded_full()
                    .bg(theme::color(if index <= progress {
                        theme::ACCENT
                    } else {
                        theme::TEXT_FAINT
                    }))
            })
            .collect::<Vec<_>>();

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
                    .child(eyebrow),
            )
            .child(
                div()
                    .font_family(theme::PROSE_FONT)
                    .font_weight(FontWeight::NORMAL)
                    .text_size(px(22.0))
                    .text_color(theme::color(theme::TEXT_QUIET))
                    .child(question),
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
                        .line_height(gpui::relative(1.5))
                        .text_color(theme::color(theme::ERROR))
                        .child(format!("COULDN’T CONTINUE · {error}")),
                )
            });
        let content = if self.reduced_motion {
            content.into_any_element()
        } else {
            let direction = self.transition_direction;
            content
                .with_animation(
                    ("login-enter", self.transition_epoch),
                    Animation::new(Duration::from_millis(145)).with_easing(ease_out_quint()),
                    move |this, delta| this.top(px(direction * 7.0 * (1.0 - delta))).opacity(delta),
                )
                .into_any_element()
        };

        div()
            .id("login-surface")
            .track_focus(&self.login_focus)
            .when(step == LoginStep::SetupRequired, |this| {
                this.key_context("Input")
            })
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_center()
            .occlude()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, window, cx| {
                    this.focus_active_input(window, cx);
                }),
            )
            .child(content)
            .child(
                div()
                    .absolute()
                    .bottom(px(31.0))
                    .left_0()
                    .right_0()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(15.0))
                    .child(div().flex().gap(px(7.0)).children(markers))
                    .child(
                        div()
                            .font_family(theme::MONO_FONT)
                            .text_size(px(9.0))
                            .text_color(theme::color(theme::TEXT_FAINT))
                            .child(hint),
                    ),
            )
            .into_any_element()
    }
}
