use std::f32::consts::TAU;
use std::time::Duration;

use gpui::prelude::FluentBuilder as _;
use gpui::{
    canvas, div, point, px, relative, Animation, AnimationExt as _, AnyElement, Context,
    InteractiveElement as _, IntoElement, ParentElement as _, PathBuilder, Render, Styled, Window,
};

use crate::theme;

pub(super) const PRESENCE_LANE_TOP: f32 = 24.0;
pub(super) const PRESENCE_LANE_HEIGHT: f32 = 92.0;
pub(super) const MAX_VISIBLE_ACTIVITY_LINES: usize = 3;

const MAX_PRESENCE_LINES: usize = MAX_VISIBLE_ACTIVITY_LINES + 1;
const MAX_PRESENCE_LABEL_CHARS: usize = 96;
const PRESENCE_TEXT_SIZE: f32 = 16.5;
const INDICATOR_WIDTH: f32 = 18.0;
const DWELL_DISK_SIZE: f32 = 13.0;
const DWELL_ARC_SEGMENTS: usize = 48;

#[cfg(target_os = "macos")]
const STOP_HINT: &str = "⌘ . TO STOP";
#[cfg(not(target_os = "macos"))]
const STOP_HINT: &str = "CTRL + . TO STOP";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum PresenceMotion {
    None,
    Breathe,
    Search,
    Read,
    Mutate,
    Execute,
    /// Exact normalized dwell progress supplied by the operation that owns
    /// acceptance. The presence lane only paints it; it never advances time.
    Dwell(u16),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct PresenceLine {
    pub(super) label: String,
    pub(super) motion: PresenceMotion,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PresenceState {
    lines: Vec<PresenceLine>,
    show_stop_hint: bool,
    reduced_motion: bool,
}

/// Owns the bounded presence state and stable animation identities independently of message
/// preparation. GPUI still dirties ancestor views for animation frames, so callers must keep the
/// parent render path cached and free of cold parsing.
///
/// Callers should retain one `Entity<PresenceLane>` and update it with [`Self::set_state`].
/// The visible state is intentionally small and bounded; it must contain status summaries, never
/// tool arguments, paths, prompts, or other user content.
pub(super) struct PresenceLane {
    state: PresenceState,
    animation_epoch: u64,
}

impl PresenceLane {
    pub(super) fn new(
        lines: Vec<PresenceLine>,
        show_stop_hint: bool,
        reduced_motion: bool,
    ) -> Self {
        Self {
            state: PresenceState {
                lines: normalize_lines(lines),
                show_stop_hint,
                reduced_motion,
            },
            animation_epoch: 0,
        }
    }

    /// Replaces the bounded presentation state and notifies only when something visible changed.
    ///
    /// Status and indicator-kind changes advance the animation epoch. Exact dwell samples and
    /// stop-hint-only changes keep it stable, so neither restarts unrelated activity indicators.
    pub(super) fn set_state(
        &mut self,
        lines: Vec<PresenceLine>,
        show_stop_hint: bool,
        reduced_motion: bool,
        cx: &mut Context<Self>,
    ) -> bool {
        let changed = self.replace_state(lines, show_stop_hint, reduced_motion);
        if changed {
            cx.notify();
        }
        changed
    }

    fn replace_state(
        &mut self,
        lines: Vec<PresenceLine>,
        show_stop_hint: bool,
        reduced_motion: bool,
    ) -> bool {
        let lines = normalize_lines(lines);
        let restart_animation = self.state.reduced_motion != reduced_motion
            || !same_animation_identity(&self.state.lines, &lines);
        let changed = self.state.lines != lines
            || self.state.reduced_motion != reduced_motion
            || self.state.show_stop_hint != show_stop_hint;
        if !changed {
            return false;
        }

        self.state = PresenceState {
            lines,
            show_stop_hint,
            reduced_motion,
        };
        if restart_animation {
            self.animation_epoch = self.animation_epoch.wrapping_add(1);
        }
        true
    }

    fn render_line(&self, index: usize, line: &PresenceLine) -> AnyElement {
        div()
            .flex()
            .items_start()
            .gap(px(9.0))
            .text_size(px(PRESENCE_TEXT_SIZE))
            .line_height(relative(1.28))
            .text_color(theme::color(theme::LIVE))
            .child(render_indicator(
                line.motion,
                index,
                self.animation_epoch,
                self.state.reduced_motion,
            ))
            .child(line.label.clone())
            .into_any_element()
    }
}

fn same_animation_identity(previous: &[PresenceLine], next: &[PresenceLine]) -> bool {
    previous.len() == next.len()
        && previous.iter().zip(next).all(|(previous, next)| {
            previous.label == next.label
                && match (previous.motion, next.motion) {
                    // A new normalized sample repaints the disk but must not
                    // restart unrelated bounded presence animations.
                    (PresenceMotion::Dwell(_), PresenceMotion::Dwell(_)) => true,
                    (previous, next) => previous == next,
                }
        })
}

impl Render for PresenceLane {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let activity = self
            .state
            .lines
            .iter()
            .enumerate()
            .map(|(index, line)| self.render_line(index, line))
            .collect::<Vec<_>>();

        div()
            .id("presence-lane")
            .absolute()
            .top(px(PRESENCE_LANE_TOP))
            .left(px(82.0))
            .right(px(82.0))
            .h(px(PRESENCE_LANE_HEIGHT))
            .flex()
            .justify_center()
            .font_family(theme::MONO_FONT)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .items_start()
                    .gap(px(2.0))
                    .children(activity),
            )
            .when(self.state.show_stop_hint, |this| {
                this.child(
                    div()
                        .absolute()
                        .right_0()
                        .top(px(5.0))
                        .text_size(px(9.0))
                        .text_color(theme::color(theme::TEXT_FAINT))
                        .child(STOP_HINT),
                )
            })
    }
}

fn normalize_lines(lines: Vec<PresenceLine>) -> Vec<PresenceLine> {
    lines
        .into_iter()
        .take(MAX_PRESENCE_LINES)
        .map(|line| PresenceLine {
            label: normalize_label(&line.label),
            motion: line.motion,
        })
        .collect()
}

fn normalize_label(label: &str) -> String {
    let mut normalized = String::with_capacity(label.len().min(MAX_PRESENCE_LABEL_CHARS));
    let mut truncated = false;
    for (index, character) in label.chars().enumerate() {
        if index == MAX_PRESENCE_LABEL_CHARS {
            truncated = true;
            break;
        }
        match character {
            '\n' | '\r' | '\t' => normalized.push(' '),
            character if character.is_control() => {}
            character => normalized.push(character),
        }
    }
    if truncated {
        normalized.pop();
        normalized.push('…');
    }
    normalized
}

fn render_indicator(
    motion: PresenceMotion,
    line_index: usize,
    animation_epoch: u64,
    reduced_motion: bool,
) -> AnyElement {
    let indicator = match motion {
        PresenceMotion::None => render_still_indicator(),
        PresenceMotion::Breathe => {
            render_breathe_indicator(line_index, animation_epoch, reduced_motion)
        }
        PresenceMotion::Search => {
            render_search_indicator(line_index, animation_epoch, reduced_motion)
        }
        PresenceMotion::Read => render_read_indicator(line_index, animation_epoch, reduced_motion),
        PresenceMotion::Mutate => {
            render_mutate_indicator(line_index, animation_epoch, reduced_motion)
        }
        PresenceMotion::Execute => {
            render_execute_indicator(line_index, animation_epoch, reduced_motion)
        }
        PresenceMotion::Dwell(progress_permille) => render_dwell_indicator(progress_permille),
    };

    div()
        .relative()
        .mt(px(2.5))
        .w(px(INDICATOR_WIDTH))
        .h(px(16.0))
        .flex_shrink_0()
        .child(indicator)
        .into_any_element()
}

fn render_dwell_indicator(progress_permille: u16) -> AnyElement {
    let progress = f32::from(progress_permille.min(1_000)) / 1_000.0;
    let fill = theme::color(theme::LIVE);

    div()
        .absolute()
        .left(px((INDICATOR_WIDTH - DWELL_DISK_SIZE) / 2.0))
        .top(px((16.0 - DWELL_DISK_SIZE) / 2.0))
        .size(px(DWELL_DISK_SIZE))
        .rounded_full()
        .bg(theme::color(theme::TEXT_FAINT).opacity(0.28))
        .child(
            canvas(
                move |_, _, _| {},
                move |bounds, _, window, _| {
                    if progress <= 0.0 {
                        return;
                    }

                    let center = point(
                        bounds.origin.x + bounds.size.width / 2.0,
                        bounds.origin.y + bounds.size.height / 2.0,
                    );
                    let radius = DWELL_DISK_SIZE / 2.0;
                    let start_angle = -TAU / 4.0;
                    let sweep = TAU * progress;
                    let mut builder = PathBuilder::fill();
                    builder.move_to(center);
                    for step in 0..=DWELL_ARC_SEGMENTS {
                        let angle = start_angle + sweep * (step as f32 / DWELL_ARC_SEGMENTS as f32);
                        builder.line_to(point(
                            center.x + px(angle.cos() * radius),
                            center.y + px(angle.sin() * radius),
                        ));
                    }
                    builder.close();
                    if let Ok(path) = builder.build() {
                        window.paint_path(path, fill);
                    }
                },
            )
            .size_full(),
        )
        .into_any_element()
}

fn render_still_indicator() -> AnyElement {
    div()
        .absolute()
        .left(px(7.0))
        .top(px(5.0))
        .size(px(4.0))
        .rounded_full()
        .bg(theme::color(theme::LIVE))
        .into_any_element()
}

fn render_breathe_indicator(
    line_index: usize,
    animation_epoch: u64,
    reduced_motion: bool,
) -> AnyElement {
    let dots = (0..3)
        .map(|dot_index| {
            let dot = div()
                .size(px(3.5))
                .rounded_full()
                .bg(theme::color(theme::LIVE))
                .opacity(if reduced_motion {
                    [0.55, 1.0, 0.55][dot_index]
                } else {
                    1.0
                });
            if reduced_motion {
                dot.into_any_element()
            } else {
                dot.with_animation(
                    (
                        "presence-breathe",
                        animation_key(animation_epoch, line_index, dot_index),
                    ),
                    // A bounded entrance pulse communicates life without keeping the
                    // ancestor message surface on GPUI's frame loop indefinitely.
                    Animation::new(Duration::from_millis(1_600))
                        .with_easing(phase_pulse(dot_index as f32 / 3.0, 0.38)),
                    |this, delta| this.opacity(delta),
                )
                .into_any_element()
            }
        })
        .collect::<Vec<_>>();

    div()
        .absolute()
        .left(px(1.0))
        .top(px(5.5))
        .flex()
        .items_center()
        .gap(px(2.5))
        .children(dots)
        .into_any_element()
}

fn render_search_indicator(
    line_index: usize,
    animation_epoch: u64,
    reduced_motion: bool,
) -> AnyElement {
    let sweep = div()
        .absolute()
        .left(px(if reduced_motion { 5.0 } else { 0.0 }))
        .top_0()
        .w(px(7.0))
        .h(px(2.0))
        .rounded_full()
        .bg(theme::color(theme::LIVE));
    let sweep = if reduced_motion {
        sweep.into_any_element()
    } else {
        sweep
            .with_animation(
                (
                    "presence-search",
                    animation_key(animation_epoch, line_index, 0),
                ),
                Animation::new(Duration::from_millis(1_050)).with_easing(triangle_wave),
                |this, delta| this.left(px(delta * 10.0)),
            )
            .into_any_element()
    };

    div()
        .absolute()
        .left(px(0.5))
        .top(px(7.0))
        .w(px(17.0))
        .h(px(2.0))
        .rounded_full()
        .bg(theme::color(theme::TEXT_FAINT).opacity(0.72))
        .child(sweep)
        .into_any_element()
}

fn render_read_indicator(
    line_index: usize,
    animation_epoch: u64,
    reduced_motion: bool,
) -> AnyElement {
    let scan = div()
        .absolute()
        .left(px(1.0))
        .top(px(if reduced_motion { 6.0 } else { 1.0 }))
        .w(px(12.0))
        .h(px(1.5))
        .rounded_full()
        .bg(theme::color(theme::LIVE));
    let scan = if reduced_motion {
        scan.into_any_element()
    } else {
        scan.with_animation(
            (
                "presence-read",
                animation_key(animation_epoch, line_index, 0),
            ),
            Animation::new(Duration::from_millis(1_250)).with_easing(triangle_wave),
            |this, delta| {
                this.top(px(1.0 + delta * 10.0))
                    .opacity(0.55 + delta * 0.45)
            },
        )
        .into_any_element()
    };

    div()
        .absolute()
        .left(px(2.0))
        .top(px(1.0))
        .w(px(14.0))
        .h(px(14.0))
        .border_l_1()
        .border_r_1()
        .border_color(theme::color(theme::TEXT_FAINT).opacity(0.62))
        .child(scan)
        .into_any_element()
}

fn render_mutate_indicator(
    line_index: usize,
    animation_epoch: u64,
    reduced_motion: bool,
) -> AnyElement {
    let caret = div()
        .absolute()
        .left(px(7.5))
        .top(px(if reduced_motion { 2.0 } else { 3.0 }))
        .w(px(2.0))
        .h(px(11.0))
        .rounded_full()
        .bg(theme::color(theme::LIVE));
    if reduced_motion {
        caret.into_any_element()
    } else {
        caret
            .with_animation(
                (
                    "presence-mutate",
                    animation_key(animation_epoch, line_index, 0),
                ),
                Animation::new(Duration::from_millis(900)).with_easing(soft_hop),
                |this, delta| this.top(px(3.0 - delta * 3.0)).opacity(0.65 + delta * 0.35),
            )
            .into_any_element()
    }
}

fn render_execute_indicator(
    line_index: usize,
    animation_epoch: u64,
    reduced_motion: bool,
) -> AnyElement {
    let ring = div()
        .absolute()
        .left(px(if reduced_motion { 2.5 } else { 4.5 }))
        .top(px(if reduced_motion { 1.5 } else { 3.5 }))
        .size(px(if reduced_motion { 13.0 } else { 9.0 }))
        .rounded_full()
        .border_1()
        .border_color(theme::color(theme::LIVE));
    let ring = if reduced_motion {
        ring.into_any_element()
    } else {
        ring.with_animation(
            (
                "presence-execute",
                animation_key(animation_epoch, line_index, 0),
            ),
            Animation::new(Duration::from_millis(850)).with_easing(phase_pulse(0.0, 0.0)),
            |this, delta| {
                let size = 9.0 + delta * 5.0;
                this.left(px((18.0 - size) / 2.0))
                    .top(px((16.0 - size) / 2.0))
                    .size(px(size))
                    .opacity(1.0 - delta * 0.5)
            },
        )
        .into_any_element()
    };

    div()
        .relative()
        .size_full()
        .child(
            div()
                .absolute()
                .left(px(7.0))
                .top(px(6.0))
                .size(px(4.0))
                .rounded_full()
                .bg(theme::color(theme::LIVE)),
        )
        .child(ring)
        .into_any_element()
}

fn animation_key(epoch: u64, line_index: usize, part_index: usize) -> u64 {
    epoch
        .wrapping_mul(64)
        .wrapping_add((line_index as u64).wrapping_mul(8))
        .wrapping_add(part_index as u64)
}

fn phase_pulse(phase: f32, floor: f32) -> impl Fn(f32) -> f32 {
    move |delta| {
        let wave = ((delta + phase) * TAU).sin() * 0.5 + 0.5;
        floor + wave * (1.0 - floor)
    }
}

fn triangle_wave(delta: f32) -> f32 {
    1.0 - (2.0 * delta - 1.0).abs()
}

fn soft_hop(delta: f32) -> f32 {
    (delta * TAU).sin().max(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(label: impl Into<String>, motion: PresenceMotion) -> PresenceLine {
        PresenceLine {
            label: label.into(),
            motion,
        }
    }

    #[test]
    fn visible_presence_is_bounded_and_single_line() {
        let lines = normalize_lines(vec![
            line("Thinking\nquietly", PresenceMotion::Breathe),
            line("Searching", PresenceMotion::Search),
            line("Reading", PresenceMotion::Read),
            line("Writing", PresenceMotion::Mutate),
            line("Never rendered", PresenceMotion::Execute),
        ]);

        assert_eq!(lines.len(), MAX_PRESENCE_LINES);
        assert_eq!(lines[0].label, "Thinking quietly");
        assert!(lines.iter().all(|line| !line.label.contains('\n')));
    }

    #[test]
    fn labels_are_bounded_by_unicode_scalars() {
        let normalized = normalize_label(&"β".repeat(MAX_PRESENCE_LABEL_CHARS + 20));

        assert_eq!(normalized.chars().count(), MAX_PRESENCE_LABEL_CHARS);
        assert!(normalized.ends_with('…'));
    }

    #[test]
    fn steady_state_does_not_repaint_or_restart_animation() {
        let lines = vec![line("Thinking…", PresenceMotion::Breathe)];
        let mut lane = PresenceLane::new(lines.clone(), true, false);

        assert!(!lane.replace_state(lines, true, false));
        assert_eq!(lane.animation_epoch, 0);
    }

    #[test]
    fn status_changes_restart_but_stop_hint_changes_do_not() {
        let mut lane = PresenceLane::new(
            vec![line("Thinking…", PresenceMotion::Breathe)],
            false,
            false,
        );

        assert!(lane.replace_state(
            vec![line("Thinking…", PresenceMotion::Breathe)],
            true,
            false,
        ));
        assert_eq!(lane.animation_epoch, 0);

        assert!(lane.replace_state(
            vec![line("Searching…", PresenceMotion::Search)],
            true,
            false,
        ));
        assert_eq!(lane.animation_epoch, 1);

        assert!(lane.replace_state(vec![line("Searching…", PresenceMotion::Search)], true, true,));
        assert_eq!(lane.animation_epoch, 2);
    }

    #[test]
    fn dwell_samples_repaint_without_restarting_presence_animations() {
        let mut lane = PresenceLane::new(
            vec![line("Preparing to send", PresenceMotion::Dwell(125))],
            false,
            false,
        );

        assert!(lane.replace_state(
            vec![line("Preparing to send", PresenceMotion::Dwell(725))],
            false,
            false,
        ));
        assert_eq!(lane.animation_epoch, 0);
        assert_eq!(lane.state.lines[0].motion, PresenceMotion::Dwell(725));

        assert!(lane.replace_state(
            vec![line("Gestures ready", PresenceMotion::Breathe)],
            false,
            false,
        ));
        assert_eq!(lane.animation_epoch, 1);
    }

    #[test]
    fn motion_curves_remain_in_the_animation_range() {
        for step in 0..=100 {
            let delta = step as f32 / 100.0;
            for value in [
                phase_pulse(0.0, 0.38)(delta),
                phase_pulse(1.0 / 3.0, 0.38)(delta),
                triangle_wave(delta),
                soft_hop(delta),
            ] {
                assert!((0.0..=1.0).contains(&value));
            }
        }
    }

    #[test]
    fn animation_keys_are_stable_and_epoch_scoped() {
        assert_eq!(animation_key(7, 2, 1), animation_key(7, 2, 1));
        assert_ne!(animation_key(7, 2, 1), animation_key(8, 2, 1));
        assert_ne!(animation_key(7, 2, 1), animation_key(7, 3, 1));
        assert_ne!(animation_key(7, 2, 1), animation_key(7, 2, 2));
    }
}
