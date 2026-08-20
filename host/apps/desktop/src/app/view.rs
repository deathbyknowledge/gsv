use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui::prelude::FluentBuilder as _;
use gpui::{
    div, ease_out_quint, point, px, relative, Animation, AnimationExt as _, AnyElement, Context,
    Focusable, FontWeight, InteractiveElement as _, IntoElement, MouseButton, ParentElement as _,
    Render, ScrollDelta, ScrollWheelEvent, SharedString, StatefulInteractiveElement, Styled,
    TouchPhase, Window,
};
use gpui_component::input::Input;

use crate::client::ApprovalDecision;
use crate::content::MediaAttachment;
use crate::interaction::CanvasLayer;
use crate::model::{
    approval_scope_description, ActivityCategory, ActivitySummaryEntry, ConnectionState,
    LiveActivityEntry, MomentRole, MomentState, PendingApproval, SurfaceMode,
};
use crate::prepared::PreparedContent;
use crate::theme;
use crate::typography::{fit_type_layout, TypeLayout};

use super::media::release_assets;
use super::presence::{
    PresenceLine, PresenceMotion, MAX_VISIBLE_ACTIVITY_LINES, PRESENCE_LANE_HEIGHT,
    PRESENCE_LANE_TOP,
};
use super::rich::{media_descriptors, render_document, RichRenderContext};
use super::selection::{SelectableText, SelectionSurface, SelectionTopology, TextSelection};
use super::{type_content_hash, AddAttachment, CachedTypeLayout, GsvApp, RichPresentationPhase};

fn format_compact_bytes(bytes: u64) -> String {
    if bytes >= 1024 * 1024 {
        format!("{:.1} MiB", bytes as f64 / (1024.0 * 1024.0))
    } else if bytes >= 1024 {
        format!("{:.1} KiB", bytes as f64 / 1024.0)
    } else {
        format!("{bytes} B")
    }
}

#[derive(Clone, Copy)]
struct CanvasGeometry {
    left: f32,
    right: f32,
    top: f32,
    bottom: f32,
    available_height: f32,
}

fn render_activity_summary(
    entries: &[ActivitySummaryEntry],
    selection: &TextSelection,
) -> AnyElement {
    let records = entries
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            div()
                .w_full()
                .text_size(px(13.0))
                .line_height(relative(1.35))
                .text_color(theme::color(theme::ACCENT))
                .child(
                    SelectableText::new(
                        format!("activity-record-{index}"),
                        selection.clone(),
                        ACTIVITY_SELECTION_ORDER + 1 + index as u32,
                        activity_summary_line(entry),
                    )
                    .separator_before("\n"),
                )
        })
        .collect::<Vec<_>>();

    div()
        .w_full()
        .pt(px(8.0))
        .flex()
        .flex_col()
        .gap(px(5.0))
        .font_family(theme::MONO_FONT)
        .child(
            div()
                .mb(px(3.0))
                .text_size(px(9.0))
                .text_color(theme::color(theme::TEXT_FAINT))
                .child(
                    SelectableText::new(
                        "activity-record-label",
                        selection.clone(),
                        ACTIVITY_SELECTION_ORDER,
                        "WORK COMPLETED",
                    )
                    .separator_before("\n\n"),
                ),
        )
        .children(records)
        .into_any_element()
}

fn render_history_edge_feedback(
    intent: super::HistoryEdgeIntent,
    geometry: CanvasGeometry,
) -> AnyElement {
    let progress = intent.progress.clamp(0.0, 1.0);
    let label = if intent.direction < 0 {
        "↑  KEEP SCROLLING FOR PREVIOUS"
    } else {
        "KEEP SCROLLING FOR NEXT  ↓"
    };
    let feedback = div()
        .absolute()
        .left(px(geometry.left))
        .right(px(geometry.right))
        .flex()
        .flex_col()
        .items_center()
        .gap(px(5.0))
        .font_family(theme::MONO_FONT)
        .text_size(px(10.0))
        .text_color(theme::color(theme::LIVE))
        .opacity(0.42 + progress * 0.58)
        .child(label)
        .child(
            div()
                .w(px(54.0))
                .h(px(2.0))
                .rounded_full()
                .bg(theme::color(theme::TEXT_FAINT))
                .child(
                    div()
                        .w(px(54.0 * progress))
                        .h_full()
                        .rounded_full()
                        .bg(theme::color(theme::LIVE)),
                ),
        );
    if intent.direction < 0 {
        feedback
            .top(px(PRESENCE_LANE_TOP + PRESENCE_LANE_HEIGHT + 7.0))
            .into_any_element()
    } else {
        feedback.bottom(px(42.0)).into_any_element()
    }
}

struct TypeFit<'a> {
    key: &'a str,
    text: SharedString,
    revision: u64,
    available_width: f32,
    available_height: f32,
    maximum_size: Option<f32>,
    weight: FontWeight,
}

struct MessageCanvas {
    message: SharedString,
    approval: Option<PendingApproval>,
    rich_content: Option<PreparedContent>,
    append_plain_text: bool,
    activity_summary: Vec<ActivitySummaryEntry>,
    transition_costly: bool,
    rich_presentation: RichPresentationEffect,
    layout: TypeLayout,
    weight: FontWeight,
    color: gpui::Hsla,
    geometry: CanvasGeometry,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RichPresentationEffect {
    None,
    FadePlain(u64),
    HoldRich,
    FadeRich(u64),
}

const HISTORY_SCROLL_THRESHOLD: f32 = 144.0;
const HISTORY_SCROLL_LINE_HEIGHT: f32 = 16.0;
const HISTORY_SCROLL_IDLE: Duration = Duration::from_millis(180);
const GESTURE_SCROLL_LINES_PER_PALM_SECOND: f32 = 30.0;
const TIMELINE_MARKER_WIDTH: f32 = 4.0;
const TIMELINE_MARKER_HEIGHT: f32 = 8.0;
const TYPE_LAYOUT_CACHE_LIMIT: usize = crate::history::MAX_FETCHED_HISTORY_MESSAGES + 8;
const TYPE_LAYOUT_POLICY_REVISION: u8 = 2;
const ACTIVITY_SELECTION_ORDER: u32 = 1_000_000;

fn animate_message(reduced_motion: bool, transition_costly: bool) -> bool {
    !reduced_motion && !transition_costly
}

fn stable_transition_cost(
    remembered: &mut Option<(u64, bool)>,
    epoch: u64,
    candidate: bool,
) -> bool {
    if let Some((remembered_epoch, costly)) = *remembered {
        if remembered_epoch == epoch {
            return costly;
        }
    }
    *remembered = Some((epoch, candidate));
    candidate
}

fn type_fit_hash(revision: u64, available_width: f32, available_height: f32) -> u64 {
    type_content_hash(&(
        TYPE_LAYOUT_POLICY_REVISION,
        theme::PROSE_FONT,
        revision,
        available_width.to_bits(),
        available_height.to_bits(),
    ))
}

fn timeline_marker_geometry(_: bool) -> (f32, f32) {
    (TIMELINE_MARKER_WIDTH, TIMELINE_MARKER_HEIGHT)
}

fn normalized_vertical_delta(delta: ScrollDelta) -> Option<f32> {
    let delta = match delta {
        ScrollDelta::Pixels(delta) => point(f32::from(delta.x), f32::from(delta.y)),
        ScrollDelta::Lines(delta) => point(
            delta.x * HISTORY_SCROLL_LINE_HEIGHT,
            delta.y * HISTORY_SCROLL_LINE_HEIGHT,
        ),
    };
    (delta.y != 0.0 && delta.y.abs() > delta.x.abs()).then_some(delta.y)
}

fn prepare_history_scroll_gesture(
    accumulator: &mut f32,
    last_event: &mut Option<Instant>,
    now: Instant,
) -> bool {
    if last_event.is_none_or(|previous| now.duration_since(previous) > HISTORY_SCROLL_IDLE) {
        *accumulator = 0.0;
    }
    *last_event = Some(now);

    if accumulator.is_infinite() {
        return false;
    }
    true
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum CanvasScrollAction {
    ScrollTo(f32),
    Resist { direction: i8, progress: f32 },
    Blocked,
    Navigate(i8),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ConversationScrollInput {
    Wheel,
    ContinuousGesture,
}

fn canvas_scroll_action(
    accumulator: &mut f32,
    offset: f32,
    maximum: f32,
    vertical: f32,
    can_navigate: bool,
    input: ConversationScrollInput,
) -> CanvasScrollAction {
    let target = (offset + vertical).clamp(-maximum, 0.0);
    let can_scroll = (vertical > 0.0 && offset < 0.0) || (vertical < 0.0 && offset > -maximum);
    if can_scroll {
        *accumulator = 0.0;
        return CanvasScrollAction::ScrollTo(target);
    }

    if !can_navigate {
        *accumulator = 0.0;
        return CanvasScrollAction::Blocked;
    }

    let direction = if vertical > 0.0 { -1 } else { 1 };
    if maximum <= 0.5 && input == ConversationScrollInput::Wheel {
        *accumulator = 0.0;
        return CanvasScrollAction::Navigate(direction);
    }

    if *accumulator != 0.0 && accumulator.signum() != vertical.signum() {
        *accumulator = 0.0;
    }
    *accumulator += vertical;
    if accumulator.abs() < HISTORY_SCROLL_THRESHOLD {
        CanvasScrollAction::Resist {
            direction,
            progress: (accumulator.abs() / HISTORY_SCROLL_THRESHOLD).clamp(0.0, 1.0),
        }
    } else {
        CanvasScrollAction::Navigate(direction)
    }
}

fn latch_history_scroll(accumulator: &mut f32, vertical: f32) {
    *accumulator = vertical.signum() * f32::INFINITY;
}

fn message_measurement_text(message: &SharedString, media: &[MediaAttachment]) -> SharedString {
    if !message.is_empty() {
        return message.clone();
    }
    media
        .iter()
        .find_map(|attachment| {
            attachment
                .description
                .as_deref()
                .or(attachment.filename.as_deref())
        })
        .map_or_else(|| "Media".into(), |text| text.to_string().into())
}

fn live_activity_label(entry: LiveActivityEntry) -> String {
    match (entry.category, entry.count) {
        (ActivityCategory::SearchingFiles, 1) => "Running a file search…".to_string(),
        (ActivityCategory::SearchingFiles, count) => {
            format!("Running {count} file searches…")
        }
        (ActivityCategory::ReadingFiles, 1) => "Reading a file…".to_string(),
        (ActivityCategory::ReadingFiles, count) => format!("Running {count} read operations…"),
        (ActivityCategory::WritingFiles, 1) => "Writing a file…".to_string(),
        (ActivityCategory::WritingFiles, count) => format!("Running {count} write operations…"),
        (ActivityCategory::EditingFiles, 1) => "Editing a file…".to_string(),
        (ActivityCategory::EditingFiles, count) => format!("Running {count} edit operations…"),
        (ActivityCategory::DeletingFiles, 1) => "Deleting a file…".to_string(),
        (ActivityCategory::DeletingFiles, count) => {
            format!("Running {count} delete operations…")
        }
        (ActivityCategory::RunningCommands, 1) => "Running a command…".to_string(),
        (ActivityCategory::RunningCommands, count) => format!("Running {count} commands…"),
        (ActivityCategory::RunningCode, 1) => "Running a code task…".to_string(),
        (ActivityCategory::RunningCode, count) => format!("Running {count} code tasks…"),
    }
}

fn live_activity_motion(category: ActivityCategory) -> PresenceMotion {
    match category {
        ActivityCategory::SearchingFiles => PresenceMotion::Search,
        ActivityCategory::ReadingFiles => PresenceMotion::Read,
        ActivityCategory::WritingFiles
        | ActivityCategory::EditingFiles
        | ActivityCategory::DeletingFiles => PresenceMotion::Mutate,
        ActivityCategory::RunningCommands | ActivityCategory::RunningCode => {
            PresenceMotion::Execute
        }
    }
}

fn grouped_live_activity(entries: &[LiveActivityEntry]) -> Vec<PresenceLine> {
    let mut lines = entries
        .iter()
        .take(MAX_VISIBLE_ACTIVITY_LINES)
        .map(|entry| PresenceLine {
            label: live_activity_label(*entry),
            motion: live_activity_motion(entry.category),
        })
        .collect::<Vec<_>>();
    let hidden = entries.len().saturating_sub(MAX_VISIBLE_ACTIVITY_LINES);
    if hidden > 0 {
        lines.push(PresenceLine {
            label: format!("+ {hidden} more"),
            motion: PresenceMotion::None,
        });
    }
    lines
}

fn legacy_activity_label(activity: &str) -> String {
    if let Some(attempt) = activity.strip_prefix("RECONNECTING · ") {
        return format!("Reconnecting… attempt {attempt}");
    }
    match activity {
        "CONNECTING" => "Connecting…",
        "RECONNECTING" => "Reconnecting…",
        "THINKING" => "Thinking…",
        "QUEUED" => "Waiting to begin…",
        "STOPPING" => "Stopping…",
        "APPLYING" => "Applying…",
        "SENDING" => "Sending…",
        "SENDING PREVIOUS THOUGHT" => "Sending your previous thought…",
        "VERIFYING DELIVERY" => "Checking delivery…",
        "TRYING ANOTHER PATH" => "Trying another approach…",
        "TRYING AGAIN" => "Trying again…",
        "OPENING A NEW CONVERSATION" => "Opening a new conversation…",
        "NOT APPLIED · TRY AGAIN" => "Not applied. Try again.",
        "TYPE ALLOW ONCE, ALWAYS ALLOW, OR DENY" => "Type allow once, always allow, or deny",
        _ => activity,
    }
    .to_string()
}

fn legacy_presence_line(activity: &str) -> PresenceLine {
    let motion = match activity {
        "THINKING" | "CONNECTING" | "RECONNECTING" => PresenceMotion::Breathe,
        "APPLYING" | "SENDING" | "SENDING PREVIOUS THOUGHT" => PresenceMotion::Mutate,
        "VERIFYING DELIVERY" | "TRYING ANOTHER PATH" | "TRYING AGAIN" => PresenceMotion::Search,
        _ => PresenceMotion::None,
    };
    PresenceLine {
        label: legacy_activity_label(activity),
        motion,
    }
}

fn presence_lines(
    live_activity: &[LiveActivityEntry],
    legacy_activity: Option<&str>,
    uncertain: bool,
    approval: bool,
    voice_notice: Option<&str>,
    voice_dwell_progress: Option<u16>,
) -> Vec<PresenceLine> {
    if approval {
        return legacy_activity
            .filter(|activity| {
                matches!(
                    *activity,
                    "APPLYING"
                        | "NOT APPLIED · TRY AGAIN"
                        | "TYPE ALLOW ONCE, ALWAYS ALLOW, OR DENY"
                )
            })
            .map(legacy_presence_line)
            .into_iter()
            .collect();
    }
    let mut lines = if !live_activity.is_empty() {
        grouped_live_activity(live_activity)
    } else if let Some(activity) = legacy_activity {
        vec![legacy_presence_line(activity)]
    } else {
        uncertain
            .then(|| PresenceLine {
                label: "Delivery not confirmed… checking history".to_string(),
                motion: PresenceMotion::Search,
            })
            .into_iter()
            .collect()
    };
    if let Some(notice) = voice_notice {
        let motion = if let Some(progress_permille) = voice_dwell_progress {
            PresenceMotion::Dwell(progress_permille.min(1_000))
        } else if notice.contains("LISTENING") {
            PresenceMotion::Breathe
        } else if notice.contains("DOWNLOADING")
            || notice.contains("VERIFYING")
            || notice.contains("PREPARING")
        {
            PresenceMotion::Search
        } else if notice.contains("FINISHING") {
            PresenceMotion::Mutate
        } else {
            PresenceMotion::None
        };
        lines.insert(
            0,
            PresenceLine {
                label: notice.to_string(),
                motion,
            },
        );
    }
    lines
}

fn activity_summary_line(entry: &ActivitySummaryEntry) -> String {
    let action = match entry.category {
        ActivityCategory::SearchingFiles => "Searched files",
        ActivityCategory::ReadingFiles => "Read files",
        ActivityCategory::WritingFiles => "Wrote files",
        ActivityCategory::EditingFiles => "Edited files",
        ActivityCategory::DeletingFiles => "Deleted files",
        ActivityCategory::RunningCommands => {
            return match entry.count {
                1 => "Ran 1 command".to_string(),
                count => format!("Ran {count} commands"),
            };
        }
        ActivityCategory::RunningCode => "Ran code",
    };
    match entry.count {
        1 => format!("{action} once"),
        count => format!("{action} {count} times"),
    }
}

fn activity_summary_revision(entries: &[ActivitySummaryEntry]) -> u64 {
    let summary = entries
        .iter()
        .map(activity_summary_line)
        .collect::<Vec<_>>()
        .join("\n");
    type_content_hash(&summary)
}

fn message_selection_topology(rich_content: bool, append_plain_text: bool) -> SelectionTopology {
    match (rich_content, append_plain_text) {
        (false, _) => SelectionTopology::PlainMessage,
        (true, false) => SelectionTopology::RichDocument,
        (true, true) => SelectionTopology::PlainPrefixWithRichDocument,
    }
}

fn message_selection_key(moment_id: &str, activity_summary: &[ActivitySummaryEntry]) -> String {
    // A stream revision replaces the same logical document. Keep selection positions alive while
    // its raw provider snapshot and prepared Markdown revision advance; topology changes still
    // invalidate positions in `TextSelection::prepare`.
    format!(
        "conversation:{moment_id}:{}",
        activity_summary_revision(activity_summary)
    )
}

fn streaming_scroll_anchor(maximum: f32, offset: f32) -> super::MessageScrollAnchor {
    let maximum = maximum.max(0.0);
    let offset = offset.clamp(-maximum, 0.0);
    if maximum <= 0.5 || offset >= -0.5 {
        super::MessageScrollAnchor::Top
    } else if offset <= -maximum + 0.5 {
        super::MessageScrollAnchor::Bottom
    } else {
        super::MessageScrollAnchor::Absolute(offset)
    }
}

fn scroll_anchor_offset(anchor: super::MessageScrollAnchor, maximum: f32) -> f32 {
    let maximum = maximum.max(0.0);
    match anchor {
        super::MessageScrollAnchor::Top => 0.0,
        super::MessageScrollAnchor::Bottom => -maximum,
        super::MessageScrollAnchor::Ratio(ratio) => -maximum * ratio.clamp(0.0, 1.0),
        super::MessageScrollAnchor::Absolute(offset) => offset.clamp(-maximum, 0.0),
    }
}

fn markdown_media_is_authoritative(
    state: MomentState,
    expected: Option<crate::prepared::ContentRevision>,
    rendered: &PreparedContent,
) -> bool {
    state == MomentState::Complete && expected == Some(rendered.revision())
}

impl GsvApp {
    fn capture_message_scroll_anchor(&self) -> super::MessageScrollAnchor {
        let maximum = f32::from(self.message_scroll.max_offset().height).max(0.0);
        let offset = f32::from(self.message_scroll.offset().y).clamp(-maximum, 0.0);
        if maximum <= 0.5 || offset >= -0.5 {
            super::MessageScrollAnchor::Top
        } else if offset <= -maximum + 0.5 {
            super::MessageScrollAnchor::Bottom
        } else {
            super::MessageScrollAnchor::Ratio((-offset / maximum).clamp(0.0, 1.0))
        }
    }

    fn apply_message_scroll_anchor(&mut self, anchor: super::MessageScrollAnchor) {
        let maximum = f32::from(self.message_scroll.max_offset().height).max(0.0);
        let offset = scroll_anchor_offset(anchor, maximum);
        self.message_scroll.set_offset(point(px(0.0), px(offset)));
    }

    fn capture_streaming_scroll_anchor(&self) -> super::MessageScrollAnchor {
        let maximum = f32::from(self.message_scroll.max_offset().height).max(0.0);
        let offset = f32::from(self.message_scroll.offset().y).clamp(-maximum, 0.0);
        streaming_scroll_anchor(maximum, offset)
    }

    fn resolve_rich_presentation(
        &mut self,
        moment_id: &str,
        revision: u64,
        rich_ready: bool,
        already_visible: bool,
        cx: &mut Context<Self>,
    ) -> RichPresentationEffect {
        if !rich_ready {
            if self.rich_presentation.as_ref().is_some_and(|presentation| {
                presentation.moment_id != moment_id || presentation.revision != revision
            }) {
                self.rich_presentation = None;
            }
            return RichPresentationEffect::None;
        }

        let matches = self.rich_presentation.as_ref().is_some_and(|presentation| {
            presentation.moment_id == moment_id && presentation.revision == revision
        });
        if !matches {
            let epoch = self.next_rich_presentation_epoch;
            self.next_rich_presentation_epoch =
                self.next_rich_presentation_epoch.wrapping_add(2).max(2);
            let updating_visible_rich = self
                .rich_presentation
                .as_ref()
                .is_some_and(|presentation| presentation.moment_id == moment_id);
            let phase = if updating_visible_rich {
                RichPresentationPhase::UpdatingRichLayout {
                    anchor: self.capture_streaming_scroll_anchor(),
                }
            } else if already_visible && !self.reduced_motion {
                RichPresentationPhase::FadingPlain
            } else {
                RichPresentationPhase::Steady
            };
            let outgoing_content = self
                .pending_rich_fallback
                .take()
                .filter(|fallback| {
                    phase == RichPresentationPhase::FadingPlain && fallback.moment_id == moment_id
                })
                .map(|fallback| fallback.content);
            self.rich_presentation = Some(super::RichPresentation {
                moment_id: moment_id.to_string(),
                revision,
                epoch,
                phase,
                outgoing_content,
            });
            if phase == RichPresentationPhase::FadingPlain {
                let timer = cx.background_executor().timer(Duration::from_millis(70));
                cx.spawn(async move |this, cx| {
                    timer.await;
                    let _ = this.update(cx, |this, cx| {
                        let should_advance =
                            this.rich_presentation.as_ref().is_some_and(|presentation| {
                                presentation.epoch == epoch
                                    && presentation.revision == revision
                                    && presentation.phase == RichPresentationPhase::FadingPlain
                            });
                        if should_advance {
                            // Capture at the renderer handoff, after any wheel input that
                            // arrived during the outgoing dissolve.
                            let anchor = this.capture_message_scroll_anchor();
                            let presentation = this
                                .rich_presentation
                                .as_mut()
                                .expect("matching rich presentation still exists");
                            presentation.phase =
                                RichPresentationPhase::AwaitingRichLayout { anchor };
                            cx.notify();
                        }
                    });
                })
                .detach();
            }
        }

        let (epoch, phase) = self
            .rich_presentation
            .as_ref()
            .map(|presentation| (presentation.epoch, presentation.phase))
            .expect("rich presentation exists for ready content");
        match phase {
            RichPresentationPhase::Steady => RichPresentationEffect::None,
            RichPresentationPhase::FadingPlain => RichPresentationEffect::FadePlain(epoch),
            RichPresentationPhase::AwaitingRichLayout { anchor } => {
                if self.rich_layout_wait_scheduled != Some(epoch) {
                    self.rich_layout_wait_scheduled = Some(epoch);
                    let timer = cx.background_executor().timer(Duration::from_millis(16));
                    cx.spawn(async move |this, cx| {
                        timer.await;
                        let _ = this.update(cx, |this, cx| {
                            if this.rich_layout_wait_scheduled == Some(epoch) {
                                this.rich_layout_wait_scheduled = None;
                            }
                            let should_apply =
                                this.rich_presentation.as_ref().is_some_and(|presentation| {
                                    presentation.epoch == epoch
                                        && presentation.revision == revision
                                        && presentation.phase
                                            == RichPresentationPhase::AwaitingRichLayout { anchor }
                                });
                            if should_apply {
                                this.apply_message_scroll_anchor(anchor);
                                if let Some(presentation) = this.rich_presentation.as_mut() {
                                    presentation.phase = RichPresentationPhase::FadingRich;
                                }
                                cx.notify();
                            }
                        });
                    })
                    .detach();
                }
                RichPresentationEffect::HoldRich
            }
            RichPresentationPhase::FadingRich => {
                if self.rich_steady_wait_scheduled != Some(epoch) {
                    self.rich_steady_wait_scheduled = Some(epoch);
                    let timer = cx.background_executor().timer(Duration::from_millis(110));
                    cx.spawn(async move |this, cx| {
                        timer.await;
                        let _ = this.update(cx, |this, _| {
                            if this.rich_steady_wait_scheduled == Some(epoch) {
                                this.rich_steady_wait_scheduled = None;
                            }
                            if let Some(presentation) =
                                this.rich_presentation.as_mut().filter(|presentation| {
                                    presentation.epoch == epoch
                                        && presentation.revision == revision
                                        && presentation.phase == RichPresentationPhase::FadingRich
                                })
                            {
                                presentation.phase = RichPresentationPhase::Steady;
                                presentation.outgoing_content = None;
                            }
                        });
                    })
                    .detach();
                }
                RichPresentationEffect::FadeRich(epoch.wrapping_add(1))
            }
            RichPresentationPhase::UpdatingRichLayout { anchor } => {
                if self.rich_layout_wait_scheduled != Some(epoch) {
                    self.rich_layout_wait_scheduled = Some(epoch);
                    let timer = cx.background_executor().timer(Duration::from_millis(16));
                    cx.spawn(async move |this, cx| {
                        timer.await;
                        let _ = this.update(cx, |this, cx| {
                            if this.rich_layout_wait_scheduled == Some(epoch) {
                                this.rich_layout_wait_scheduled = None;
                            }
                            let should_apply =
                                this.rich_presentation.as_ref().is_some_and(|presentation| {
                                    presentation.epoch == epoch
                                        && presentation.revision == revision
                                        && presentation.phase
                                            == RichPresentationPhase::UpdatingRichLayout { anchor }
                                });
                            if should_apply {
                                this.apply_message_scroll_anchor(anchor);
                                if let Some(presentation) = this.rich_presentation.as_mut() {
                                    presentation.phase = RichPresentationPhase::Steady;
                                }
                                cx.notify();
                            }
                        });
                    })
                    .detach();
                }
                RichPresentationEffect::None
            }
        }
    }

    fn fit_cached_type_layout(&mut self, window: &Window, request: TypeFit<'_>) -> TypeLayout {
        let TypeFit {
            key,
            text,
            revision,
            available_width,
            available_height,
            maximum_size,
            weight,
        } = request;
        let content_hash = type_fit_hash(revision, available_width, available_height);
        self.type_layout_clock = self.type_layout_clock.wrapping_add(1);
        if let Some(cached) = self
            .type_layouts
            .get_mut(key)
            .filter(|cached| cached.matches(content_hash, maximum_size, weight))
        {
            cached.last_used = self.type_layout_clock;
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
            if let Some(oldest) = self
                .type_layouts
                .iter()
                .min_by_key(|(_, cached)| cached.last_used)
                .map(|(key, _)| key.clone())
            {
                self.type_layouts.remove(&oldest);
            }
        }
        self.type_layouts.insert(
            key.to_string(),
            CachedTypeLayout {
                content_hash,
                maximum_size: maximum_size.map(f32::to_bits),
                weight: weight.0.to_bits(),
                last_used: self.type_layout_clock,
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
                let (marker_width, marker_height) = timeline_marker_geometry(is_selected);
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
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.select_moment(index, window, cx);
                    }))
                    .child(
                        div()
                            .w(px(marker_width))
                            .h(px(marker_height))
                            .rounded_full()
                            .bg(marker_color)
                            .opacity(if is_selected { 1.0 } else { 0.68 })
                            .when(is_selected, |this| this.shadow_sm()),
                    )
                    .into_any_element()
            })
            .collect::<Vec<_>>();

        if !self.interaction.conversation_draft().is_empty() {
            let held = self.interaction.held_draft();
            let (marker_width, marker_height) = timeline_marker_geometry(draft_visible);
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
                            .w(px(marker_width))
                            .h(px(marker_height))
                            .rounded_full()
                            .opacity(if draft_visible { 1.0 } else { 0.68 })
                            .when(!held, |this| this.bg(theme::color(theme::ACCENT)))
                            .when(held, |this| {
                                this.border_1()
                                    .border_color(theme::color(theme::TEXT_QUIET))
                            })
                            .when(draft_visible, |this| this.shadow_sm()),
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
                    .w_full()
                    .h_full()
                    .py(px(70.0))
                    .flex()
                    .flex_col()
                    .items_center()
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
                    .on_scroll_wheel(cx.listener(Self::scroll_timeline))
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
        let live_activity_entries = if self.interaction.is_approval() {
            Vec::new()
        } else {
            self.conversation.live_activity_entries()
        };
        let left_padding = (viewport_width * 0.065).clamp(108.0, 142.0);
        let right_padding = (viewport_width * 0.065).clamp(46.0, 142.0);
        let vertical_padding = (viewport_height * 0.105).clamp(50.0, 108.0);
        let top_padding = vertical_padding.max(PRESENCE_LANE_TOP + PRESENCE_LANE_HEIGHT + 24.0);
        let available_width = (viewport_width - left_padding - right_padding).max(1.0);
        let available_height = (viewport_height - top_padding - vertical_padding - 72.0).max(1.0);
        let geometry = CanvasGeometry {
            left: left_padding,
            right: right_padding,
            top: top_padding,
            bottom: vertical_padding,
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
        let activity_summary = current
            .map(|moment| self.conversation.activity_summary_for(moment).to_vec())
            .unwrap_or_default();
        let local_preparation_candidate = current.and_then(|moment| moment.preparation_candidate());
        let (display_text, media, moment_id, run_id, role, state, message_revision) = match current
        {
            Some(moment) => (
                moment.text.clone(),
                moment.media.clone(),
                moment.id.clone(),
                moment.run_id.clone(),
                moment.role,
                moment.state,
                moment.content_revision,
            ),
            None if self.conversation.connection == ConnectionState::Connecting => (
                Arc::from("Reaching your GSV…"),
                Arc::new(Vec::new()),
                "system:connecting".to_string(),
                None,
                MomentRole::System,
                MomentState::Complete,
                1,
            ),
            None => (
                Arc::from("Begin anywhere."),
                Arc::new(Vec::new()),
                "system:begin".to_string(),
                None,
                MomentRole::Intelligence,
                MomentState::Complete,
                2,
            ),
        };
        let display_message = SharedString::new(display_text.clone());
        let preparation_candidate = self
            .history_preparations
            .get(&moment_id)
            .cloned()
            .or(local_preparation_candidate);
        let message_revision = preparation_candidate
            .as_ref()
            .map_or(message_revision, |candidate| candidate.revision.get());
        let authoritative_markdown_revision = preparation_candidate
            .as_ref()
            .map(|candidate| candidate.revision);
        let prepared_content = if let Some(candidate) = preparation_candidate.as_ref() {
            self.prepared_content.resolve_history(candidate)
        } else if state == MomentState::Streaming && role == MomentRole::Intelligence {
            self.prepared_content.resolve_streaming(
                &moment_id,
                message_revision,
                display_text,
                media.clone(),
            )
        } else {
            self.prepared_content.resolve_or_request(
                &moment_id,
                role,
                state,
                display_message.as_ref(),
                media.as_slice(),
            )
        };
        let content_pending = self.prepared_content.is_pending(&moment_id);
        let already_visible = self.message_scroll_moment.as_deref() == Some(moment_id.as_str());
        let prepared_is_rich = prepared_content
            .as_ref()
            .is_some_and(PreparedContent::is_rich);
        let rich_ready = prepared_is_rich;
        // Pending work renders the last exact prepared snapshot. Its revision, rather than the
        // newer raw provider revision, owns the presentation until the exact new result arrives.
        let presentation_revision = prepared_content
            .as_ref()
            .map_or(message_revision, |content| content.revision().get());
        let rich_presentation = self.resolve_rich_presentation(
            &moment_id,
            presentation_revision,
            rich_ready,
            already_visible,
            cx,
        );
        let outgoing_content = matches!(rich_presentation, RichPresentationEffect::FadePlain(_))
            .then(|| {
                self.rich_presentation
                    .as_ref()
                    .and_then(|presentation| presentation.outgoing_content.clone())
            })
            .flatten();
        let showing_outgoing_fallback = outgoing_content.is_some();
        let show_rich = showing_outgoing_fallback
            || (rich_ready && !matches!(rich_presentation, RichPresentationEffect::FadePlain(_)));
        let rendered_content = if showing_outgoing_fallback {
            outgoing_content
        } else {
            show_rich.then_some(prepared_content.clone()).flatten()
        };
        let rendered_append_plain_text = showing_outgoing_fallback;
        let selection_topology = message_selection_topology(show_rich, rendered_append_plain_text);
        if self.message_scroll_moment.as_deref() != Some(moment_id.as_str()) {
            self.message_scroll.set_offset(point(px(0.0), px(0.0)));
            self.message_scroll_moment = Some(moment_id.clone());
            if !self.history_scroll_accumulator.is_infinite() {
                self.history_scroll_accumulator = 0.0;
                self.history_scroll_last_event = None;
            }
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
        let measurement_text = message_measurement_text(&display_message, media.as_slice());
        let layout_revision = if state == MomentState::Streaming {
            prepared_content
                .as_ref()
                .map_or(0, |content| content.revision().get())
        } else {
            message_revision
        };
        let message_layout = self.fit_cached_type_layout(
            window,
            TypeFit {
                key: &moment_type_key,
                text: measurement_text,
                revision: layout_revision,
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
        let transition_costly_candidate = message_layout.scrolls
            || !media.is_empty()
            || content_pending
            || prepared_content.as_ref().is_some_and(|content| {
                !content.media().is_empty()
                    || content.document().blocks.len() > 4
                    || content.inline_text().len() > 6
            })
            || (prepared_content.is_none()
                && role == MomentRole::Intelligence
                && state == MomentState::Complete
                && (!media.is_empty() || display_message.len() > 640));
        let transition_costly = stable_transition_cost(
            &mut self.message_transition_cost,
            self.transition_epoch,
            transition_costly_candidate,
        );

        let mode_label = if self.conversation.mode == SurfaceMode::Conversation {
            "TERMINAL"
        } else {
            "CONVERSATION"
        };
        let draft = self.interaction.visible_draft().map(str::to_string);
        let draft_visible = draft.is_some();
        if draft_visible {
            self.text_selection.clear();
        } else {
            self.text_selection.prepare(
                message_selection_key(&moment_id, &activity_summary),
                selection_topology,
            );
        }
        let released = if draft_visible {
            self.media_cache.sync([], &self.commands)
        } else {
            self.media_cache.sync(
                rendered_content
                    .as_ref()
                    .map(|content| {
                        media_descriptors(
                            content,
                            markdown_media_is_authoritative(
                                state,
                                authoritative_markdown_revision,
                                content,
                            ),
                        )
                    })
                    .unwrap_or_default(),
                &self.commands,
            )
        };
        self.cancel_stale_media_preparations();
        release_assets(released, cx);
        let voice_dwell_progress = self
            .visible_voice_gesture_progress()
            .map(|progress| progress.progress_permille());
        let activity = presence_lines(
            &live_activity_entries,
            self.conversation.activity.as_deref(),
            !draft_visible && state == MomentState::Uncertain,
            self.interaction.is_approval(),
            self.voice_notice.as_deref(),
            voice_dwell_progress,
        );
        let show_stop_hint = self.conversation.active_run_id.is_some() && !activity.is_empty();
        // GPUI animation frames dirty ancestor views. Keep the distinctive indicator shape but
        // suppress its motion when the selected canvas is expensive to rebuild; this prevents a
        // status flourish from repeatedly walking a large rich document on the foreground thread.
        let suppress_presence_motion = self.reduced_motion
            || transition_costly_candidate
            || rich_presentation != RichPresentationEffect::None;
        self.presence_lane.update(cx, |lane, lane_cx| {
            lane.set_state(
                activity.clone(),
                show_stop_hint,
                suppress_presence_motion,
                lane_cx,
            );
        });
        let show_hint = !self.interaction.has_interacted()
            && activity.is_empty()
            && !self.interaction.is_approval();

        let canvas = if let Some(draft) = draft {
            let draft_layout = self.fit_cached_type_layout(
                window,
                TypeFit {
                    key: "draft",
                    text: draft.clone().into(),
                    revision: type_content_hash(&draft),
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
                cx,
            )
        } else {
            self.render_message_canvas(
                MessageCanvas {
                    message: display_message,
                    approval: self.conversation.pending_approval.clone(),
                    rich_content: rendered_content,
                    append_plain_text: rendered_append_plain_text,
                    activity_summary,
                    transition_costly,
                    rich_presentation,
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
                    text: sink_value.clone().into(),
                    revision: type_content_hash(&sink_value),
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
            .child(self.presence_lane.clone())
            .when_some(self.history_edge_intent, |this, intent| {
                this.child(render_history_edge_feedback(intent, geometry))
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
            .pt(px(geometry.top))
            .pb(px(geometry.bottom))
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

    fn render_approval_controls(
        &self,
        approval: PendingApproval,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let scope = approval_scope_description(&approval);
        let submitting = self.interaction.is_approval_submitting();
        let once_request_id = approval.request_id.clone();
        let always_request_id = approval.request_id.clone();
        let deny_request_id = approval.request_id;
        let choice = |id: &'static str, label: &'static str| {
            div()
                .id(id)
                .cursor_pointer()
                .px(px(8.0))
                .py(px(8.0))
                .text_size(px(15.0))
                .text_color(theme::color(theme::ACCENT))
                .hover(|this| this.text_color(theme::color(theme::TEXT)))
                .child(label)
        };

        div()
            .w_full()
            .pt(px(26.0))
            .flex()
            .flex_col()
            .gap(px(10.0))
            .font_family(theme::MONO_FONT)
            .when(submitting, |this| this.opacity(0.42))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_x(px(24.0))
                    .gap_y(px(8.0))
                    .child(choice("approval-once", "ALLOW ONCE").on_click(cx.listener(
                        move |this, _, window, cx| {
                            this.apply_approval_decision(
                                once_request_id.clone(),
                                "allow once".to_string(),
                                ApprovalDecision::Approve { remember: false },
                                window,
                                cx,
                            );
                        },
                    )))
                    .child(
                        choice("approval-always", "ALWAYS ALLOW").on_click(cx.listener(
                            move |this, _, window, cx| {
                                this.apply_approval_decision(
                                    always_request_id.clone(),
                                    "always allow".to_string(),
                                    ApprovalDecision::Approve { remember: true },
                                    window,
                                    cx,
                                );
                            },
                        )),
                    )
                    .child(choice("approval-deny", "DENY").on_click(cx.listener(
                        move |this, _, window, cx| {
                            this.apply_approval_decision(
                                deny_request_id.clone(),
                                "deny".to_string(),
                                ApprovalDecision::Deny,
                                window,
                                cx,
                            );
                        },
                    ))),
            )
            .child(
                div()
                    .text_size(px(12.0))
                    .line_height(relative(1.35))
                    .text_color(theme::color(theme::TEXT_FAINT))
                    .child(scope),
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
            approval,
            rich_content,
            append_plain_text,
            activity_summary,
            transition_costly,
            rich_presentation,
            layout,
            weight,
            color,
            geometry,
        } = request;
        let content = if let Some(content) = rich_content {
            div()
                .w_full()
                .flex()
                .flex_col()
                .gap(px((layout.size * 0.52).clamp(13.0, 28.0)))
                .when(append_plain_text && !message.is_empty(), |this| {
                    this.child(div().w_full().child(SelectableText::new(
                        "message-plain-prefix",
                        self.text_selection.clone(),
                        0,
                        message.clone(),
                    )))
                })
                .child(render_document(
                    content,
                    &self.text_selection,
                    self.message_scroll_moment.as_deref().unwrap_or("message"),
                    RichRenderContext::new(
                        &self.media_cache,
                        &self.commands,
                        layout.size,
                        color,
                        geometry.available_height,
                    ),
                ))
                .when(!activity_summary.is_empty(), |this| {
                    this.child(render_activity_summary(
                        &activity_summary,
                        &self.text_selection,
                    ))
                })
                .into_any_element()
        } else if !activity_summary.is_empty() {
            div()
                .w_full()
                .flex()
                .flex_col()
                .gap(px((layout.size * 0.52).clamp(18.0, 32.0)))
                .when(!message.is_empty(), |this| {
                    this.child(SelectableText::new(
                        "message-plain",
                        self.text_selection.clone(),
                        0,
                        message.clone(),
                    ))
                })
                .child(render_activity_summary(
                    &activity_summary,
                    &self.text_selection,
                ))
                .into_any_element()
        } else {
            SelectableText::new("message-plain", self.text_selection.clone(), 0, message)
                .into_any_element()
        };
        let message = div()
            .relative()
            .w_full()
            .min_h(px(geometry.available_height))
            .max_w(px(layout.width))
            .flex_shrink_0()
            .flex()
            .flex_col()
            .justify_center()
            .font_family(theme::PROSE_FONT)
            .font_weight(weight)
            .text_size(px(layout.size))
            .line_height(relative(layout.line_height))
            .text_color(color)
            .child(content)
            .when_some(approval, |this, approval| {
                this.child(self.render_approval_controls(approval, cx))
            });
        let direction = self.transition_direction;
        let message = if animate_message(self.reduced_motion, transition_costly) {
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
        } else {
            message.into_any_element()
        };
        let rich_epoch = match rich_presentation {
            RichPresentationEffect::None => None,
            RichPresentationEffect::HoldRich => None,
            RichPresentationEffect::FadePlain(epoch) | RichPresentationEffect::FadeRich(epoch) => {
                Some(epoch)
            }
        };
        let message = if rich_presentation == RichPresentationEffect::HoldRich {
            div()
                .w_full()
                .flex()
                .justify_center()
                .opacity(0.7)
                .child(message)
                .into_any_element()
        } else if let Some(epoch) = rich_epoch.filter(|_| !self.reduced_motion) {
            let (start, span) = match rich_presentation {
                RichPresentationEffect::FadePlain(_) => (1.0, -0.3),
                RichPresentationEffect::FadeRich(_) => (0.7, 0.3),
                RichPresentationEffect::None | RichPresentationEffect::HoldRich => unreachable!(),
            };
            div()
                .w_full()
                .flex()
                .justify_center()
                .child(message)
                .with_animation(
                    ("rich-ready", epoch),
                    Animation::new(Duration::from_millis(110)).with_easing(ease_out_quint()),
                    move |this, delta| this.opacity(start + delta * span),
                )
                .into_any_element()
        } else {
            message
        };

        let surface = div()
            .id(("message-scroll", self.transition_epoch))
            .absolute()
            .inset_0()
            .pl(px(geometry.left))
            .pr(px(geometry.right))
            .pt(px(geometry.top))
            .pb(px(geometry.bottom + 58.0))
            .flex()
            .justify_center()
            .items_start()
            .overflow_hidden()
            .track_scroll(&self.message_scroll)
            .child(
                div()
                    .absolute()
                    .size(px(1.0))
                    .top(px(geometry.available_height.max(layout.content_height))),
            )
            .occlude()
            .on_scroll_wheel(cx.listener(Self::scroll_moments))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, window, cx| {
                    this.input.focus_handle(cx).focus(window);
                }),
            )
            .child(message);
        SelectionSurface::new(
            ("message-selection", self.transition_epoch),
            self.text_selection.clone(),
            surface,
        )
        .into_any_element()
    }

    fn clear_history_edge_feedback(&mut self) -> bool {
        let changed = self.history_edge_intent.take().is_some();
        self.history_edge_feedback_epoch = self.history_edge_feedback_epoch.wrapping_add(1);
        changed
    }

    fn show_history_edge_feedback(&mut self, direction: i8, progress: f32, cx: &mut Context<Self>) {
        self.history_edge_intent = Some(super::HistoryEdgeIntent {
            direction,
            progress,
        });
        self.history_edge_feedback_epoch = self.history_edge_feedback_epoch.wrapping_add(1);
        let epoch = self.history_edge_feedback_epoch;
        let timer = cx.background_executor().timer(HISTORY_SCROLL_IDLE);
        cx.spawn(async move |this, cx| {
            timer.await;
            let _ = this.update(cx, |this, cx| {
                if this.history_edge_feedback_epoch == epoch {
                    this.history_edge_intent = None;
                    this.history_scroll_accumulator = 0.0;
                    this.history_scroll_last_event = None;
                    cx.notify();
                }
            });
        })
        .detach();
        cx.notify();
    }

    fn scroll_moments(
        &mut self,
        event: &ScrollWheelEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if matches!(event.touch_phase, TouchPhase::Ended) {
            self.finish_conversation_scroll(cx);
            cx.stop_propagation();
            return;
        }
        let Some(vertical) = normalized_vertical_delta(event.delta) else {
            return;
        };
        cx.stop_propagation();
        self.apply_conversation_scroll(
            vertical,
            Instant::now(),
            ConversationScrollInput::Wheel,
            window,
            cx,
        );
    }

    pub(super) fn scroll_conversation_by_gesture_velocity(
        &mut self,
        offset_palms: f32,
        elapsed: Duration,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !offset_palms.is_finite()
            || offset_palms == 0.0
            || elapsed.is_zero()
            || self.login.is_some()
            || self.microphone_chooser.is_some()
            || self.gesture_guide_open
            || self.conversation.mode != SurfaceMode::Conversation
            || self.interaction.is_approval()
        {
            return;
        }
        let vertical = offset_palms
            * HISTORY_SCROLL_LINE_HEIGHT
            * GESTURE_SCROLL_LINES_PER_PALM_SECOND
            * elapsed.as_secs_f32();
        self.apply_conversation_scroll(
            vertical,
            Instant::now(),
            ConversationScrollInput::ContinuousGesture,
            window,
            cx,
        );
    }

    pub(super) fn finish_gesture_scroll(&mut self, cx: &mut Context<Self>) {
        self.finish_conversation_scroll(cx);
    }

    fn finish_conversation_scroll(&mut self, cx: &mut Context<Self>) {
        self.history_scroll_accumulator = 0.0;
        self.history_scroll_last_event = None;
        if self.clear_history_edge_feedback() {
            cx.notify();
        }
    }

    fn apply_conversation_scroll(
        &mut self,
        vertical: f32,
        now: Instant,
        input: ConversationScrollInput,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let selection_cleared = self.text_selection.clear();
        if !prepare_history_scroll_gesture(
            &mut self.history_scroll_accumulator,
            &mut self.history_scroll_last_event,
            now,
        ) {
            if selection_cleared {
                cx.notify();
            }
            return;
        }

        let maximum = f32::from(self.message_scroll.max_offset().height);
        let offset = f32::from(self.message_scroll.offset().y).clamp(-maximum, 0.0);
        let direction = if vertical > 0.0 { -1 } else { 1 };
        let can_navigate = if direction < 0 {
            self.conversation.selected > 0
        } else {
            self.conversation.selected + 1 < self.conversation.moments.len()
        };
        match canvas_scroll_action(
            &mut self.history_scroll_accumulator,
            offset,
            maximum,
            vertical,
            can_navigate,
            input,
        ) {
            CanvasScrollAction::ScrollTo(target) => {
                self.clear_history_edge_feedback();
                self.message_scroll.set_offset(point(px(0.0), px(target)));
                cx.notify();
            }
            CanvasScrollAction::Resist {
                direction,
                progress,
            } => {
                self.show_history_edge_feedback(direction, progress, cx);
            }
            CanvasScrollAction::Blocked => {
                let feedback_cleared = self.clear_history_edge_feedback();
                if selection_cleared || feedback_cleared {
                    cx.notify();
                }
            }
            CanvasScrollAction::Navigate(direction) => {
                self.clear_history_edge_feedback();
                self.move_moment(direction, window, cx);
                if input == ConversationScrollInput::Wheel {
                    latch_history_scroll(&mut self.history_scroll_accumulator, vertical);
                } else {
                    self.history_scroll_accumulator = 0.0;
                }
                self.history_scroll_last_event = Some(now);
                if selection_cleared {
                    cx.notify();
                }
            }
        }
    }

    fn scroll_timeline(
        &mut self,
        event: &ScrollWheelEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        cx.stop_propagation();
        if matches!(event.touch_phase, TouchPhase::Ended) {
            self.timeline_scroll_accumulator = 0.0;
            self.timeline_scroll_last_event = None;
            return;
        }
        let Some(vertical) = normalized_vertical_delta(event.delta) else {
            return;
        };
        let now = Instant::now();
        if self
            .timeline_scroll_last_event
            .is_none_or(|previous| now.duration_since(previous) > HISTORY_SCROLL_IDLE)
            || (self.timeline_scroll_accumulator != 0.0
                && self.timeline_scroll_accumulator.signum() != vertical.signum())
        {
            self.timeline_scroll_accumulator = 0.0;
        }
        self.timeline_scroll_last_event = Some(now);
        self.timeline_scroll_accumulator += vertical;
        let steps = (self.timeline_scroll_accumulator.abs() / 48.0).floor() as usize;
        if steps == 0 {
            return;
        }
        let direction = if self.timeline_scroll_accumulator > 0.0 {
            -1
        } else {
            1
        };
        self.timeline_scroll_accumulator = self.timeline_scroll_accumulator.signum()
            * (self.timeline_scroll_accumulator.abs() - steps as f32 * 48.0);
        for _ in 0..steps.min(self.conversation.moments.len()) {
            self.move_moment(direction, window, cx);
        }
    }

    fn clear_selection_on_scroll(
        &mut self,
        _: &ScrollWheelEvent,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.text_selection.clear() {
            cx.notify();
        }
    }

    fn render_draft_canvas(
        &mut self,
        layout: TypeLayout,
        geometry: CanvasGeometry,
        approval: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let is_long = layout.scrolls;
        let attachment_rows = self
            .draft_attachments
            .iter()
            .map(|attachment| {
                let attachment_id = attachment.id;
                let label = format!(
                    "{}  ·  {}  ·  REMOVE",
                    attachment.filename,
                    format_compact_bytes(attachment.size)
                );
                div()
                    .id(("draft-attachment", attachment_id))
                    .cursor_pointer()
                    .px(px(12.0))
                    .py(px(7.0))
                    .bg(theme::color(theme::SELECTION).opacity(0.46))
                    .font_family(theme::MONO_FONT)
                    .text_size(px(10.0))
                    .text_color(theme::color(theme::TEXT_QUIET))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        cx.stop_propagation();
                        this.remove_draft_attachment(attachment_id, window, cx);
                    }))
                    .child(label)
            })
            .collect::<Vec<_>>();
        let add_attachment = (!approval).then(|| {
            div()
                .id("draft-add-attachment")
                .cursor_pointer()
                .font_family(theme::MONO_FONT)
                .text_size(px(9.0))
                .text_color(theme::color(theme::TEXT_FAINT))
                .on_click(cx.listener(|this, _, window, cx| {
                    cx.stop_propagation();
                    this.choose_attachments(&AddAttachment, window, cx);
                }))
                .child("ADD FILES  ·  ⌘⇧A")
        });
        div()
            .id(("draft-scroll", self.transition_epoch))
            .absolute()
            .inset_0()
            .pl(px(geometry.left))
            .pr(px(geometry.right))
            .pt(px(geometry.top))
            .pb(px(geometry.bottom + 24.0))
            .flex()
            .justify_center()
            .when(is_long, |this| this.items_start())
            .when(!is_long, |this| this.items_center())
            .overflow_hidden()
            .child(
                div()
                    .w_full()
                    .max_w(px(layout.width))
                    .flex()
                    .flex_col()
                    .gap(px(18.0))
                    .child(
                        Input::new(&self.input)
                            .appearance(false)
                            .bordered(false)
                            .focus_bordered(false)
                            .w_full()
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
                    .when(!attachment_rows.is_empty(), |this| {
                        this.child(
                            div()
                                .w_full()
                                .flex()
                                .flex_wrap()
                                .gap(px(8.0))
                                .children(attachment_rows),
                        )
                    })
                    .when_some(add_attachment, |this, add_attachment| {
                        this.child(add_attachment)
                    }),
            )
            .into_any_element()
    }

    fn render_microphone_chooser(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(chooser) = &self.microphone_chooser else {
            return div().into_any_element();
        };
        let mut choices = Vec::with_capacity(chooser.devices.len() + 1);
        choices.push("SYSTEM DEFAULT".to_string());
        choices.extend(chooser.devices.iter().enumerate().map(|(index, device)| {
            let duplicate_count = chooser
                .devices
                .iter()
                .filter(|candidate| candidate.name == device.name)
                .count();
            let duplicate_ordinal = chooser.devices[..=index]
                .iter()
                .filter(|candidate| candidate.name == device.name)
                .count();
            let mut label = if duplicate_count > 1 {
                format!("{} · {duplicate_ordinal}", device.name)
            } else {
                device.name.clone()
            };
            if device.is_default {
                label.push_str(" · CURRENT SYSTEM INPUT");
            }
            label
        }));
        let rows = choices
            .into_iter()
            .enumerate()
            .map(|(index, label)| {
                let highlighted = chooser.highlighted == index;
                div()
                    .id(("microphone-choice", index))
                    .w_full()
                    .py(px(7.0))
                    .cursor_pointer()
                    .font_family(theme::MONO_FONT)
                    .text_size(px(13.0))
                    .text_color(theme::color(if highlighted {
                        theme::ACCENT
                    } else {
                        theme::TEXT_QUIET
                    }))
                    .hover(|this| this.text_color(theme::color(theme::TEXT)))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.select_microphone_at(index, window, cx);
                    }))
                    .child(format!("{} {label}", if highlighted { "›" } else { " " }))
            })
            .collect::<Vec<_>>();
        let status = if chooser.loading {
            Some("LISTENING FOR MICROPHONES".to_string())
        } else {
            chooser.notice.clone()
        };

        div()
            .id("microphone-surface")
            .key_context("MicrophoneChooser")
            .track_focus(&self.microphone_focus)
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_center()
            .occlude()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, window, _| {
                    this.microphone_focus.focus(window);
                }),
            )
            .child(
                div()
                    .w_full()
                    .max_w(px(820.0))
                    .px(px(42.0))
                    .flex()
                    .flex_col()
                    .gap(px(18.0))
                    .child(
                        div()
                            .font_family(theme::MONO_FONT)
                            .text_size(px(10.0))
                            .text_color(theme::color(theme::TEXT_FAINT))
                            .child("VOICE INPUT"),
                    )
                    .child(
                        div()
                            .font_family(theme::PROSE_FONT)
                            .font_weight(FontWeight::NORMAL)
                            .text_size(px(25.0))
                            .text_color(theme::color(theme::TEXT_QUIET))
                            .child("Which microphone should hear you?"),
                    )
                    .when(!chooser.loading, |this| {
                        this.child(div().mt(px(7.0)).flex().flex_col().children(rows))
                    })
                    .when_some(status, |this, status| {
                        this.child(
                            div()
                                .mt(px(5.0))
                                .font_family(theme::MONO_FONT)
                                .text_size(px(10.0))
                                .line_height(relative(1.45))
                                .text_color(theme::color(theme::TEXT_FAINT))
                                .child(status),
                        )
                    }),
            )
            .child(
                div()
                    .absolute()
                    .bottom(px(31.0))
                    .left_0()
                    .right_0()
                    .text_center()
                    .font_family(theme::MONO_FONT)
                    .text_size(px(9.0))
                    .text_color(theme::color(theme::TEXT_FAINT))
                    .child("↑ ↓ CHOOSE · ENTER SAVES · ESC RETURNS"),
            )
            .into_any_element()
    }

    fn render_terminal(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let released = self.media_cache.sync([], &self.commands);
        self.cancel_stale_media_preparations();
        release_assets(released, cx);
        let terminal_revision = self
            .terminal
            .iter()
            .map(|exchange| {
                format!(
                    "{}\0{}\0{:?}\0{}\n",
                    exchange.command, exchange.output, exchange.exit_code, exchange.pending
                )
            })
            .collect::<String>();
        self.text_selection.prepare(
            format!("terminal:{}", type_content_hash(&terminal_revision)),
            SelectionTopology::TerminalTranscript,
        );
        let visible_exchange_count = self.terminal.len().min(24);
        let transcript = self
            .terminal
            .iter()
            .rev()
            .take(24)
            .enumerate()
            .map(|(index, exchange)| {
                let command = exchange.command.clone();
                let output = exchange.output.clone();
                let pending = exchange.pending;
                let order = ((visible_exchange_count - index) * 4) as u32;
                let exit_color = if exchange.exit_code.is_some_and(|code| code != 0) {
                    theme::color(theme::ERROR)
                } else {
                    theme::color(theme::TEXT_FAINT)
                };
                div()
                    .flex()
                    .flex_col()
                    .gap(px(9.0))
                    .child(div().text_color(theme::color(theme::ACCENT)).child(
                        SelectableText::new(
                            format!("terminal-command-{index}"),
                            self.text_selection.clone(),
                            order,
                            format!("› {command}"),
                        ),
                    ))
                    .when(!output.is_empty(), |this| {
                        this.child(
                            div().text_color(theme::color(theme::TEXT_QUIET)).child(
                                SelectableText::new(
                                    format!("terminal-output-{index}"),
                                    self.text_selection.clone(),
                                    order + 1,
                                    output,
                                )
                                .separator_before("\n"),
                            ),
                        )
                    })
                    .when_some(exchange.exit_code, |this, code| {
                        this.child(
                            div().text_size(px(9.0)).text_color(exit_color).child(
                                SelectableText::new(
                                    format!("terminal-exit-{index}"),
                                    self.text_selection.clone(),
                                    order + 2,
                                    format!("EXIT {code}"),
                                )
                                .separator_before("\n"),
                            ),
                        )
                    })
                    .when(pending, |this| {
                        this.child(
                            div()
                                .text_size(px(9.0))
                                .text_color(theme::color(theme::LIVE))
                                .child(
                                    SelectableText::new(
                                        format!("terminal-running-{index}"),
                                        self.text_selection.clone(),
                                        order + 3,
                                        "RUNNING",
                                    )
                                    .separator_before("\n"),
                                ),
                        )
                    })
            })
            .collect::<Vec<_>>();

        let surface = div()
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
                            .on_scroll_wheel(cx.listener(Self::clear_selection_on_scroll))
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
            );
        SelectionSurface::new("terminal-selection", self.text_selection.clone(), surface)
            .into_any_element()
    }
}

impl Render for GsvApp {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let login_visible = self.login.is_some();
        let microphone_visible = !login_visible && self.microphone_chooser.is_some();
        div()
            .id("gsv-desktop")
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
            .on_action(cx.listener(Self::toggle_dictation_action))
            .on_action(cx.listener(Self::toggle_gesture_guide_action))
            .on_action(cx.listener(Self::choose_microphone_action))
            .on_action(cx.listener(Self::previous_microphone))
            .on_action(cx.listener(Self::next_microphone))
            .on_action(cx.listener(Self::select_microphone_action))
            .on_action(cx.listener(Self::choose_attachments))
            .capture_action(cx.listener(Self::copy_selection))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, window, cx| {
                    this.focus_active_input(window, cx);
                }),
            )
            .when(login_visible, |this| {
                this.child(self.render_login(window, cx))
            })
            .when(microphone_visible, |this| {
                this.child(self.render_microphone_chooser(cx))
            })
            .when(
                !login_visible
                    && !microphone_visible
                    && self.conversation.mode == SurfaceMode::Conversation,
                |this| {
                    this.child(self.render_conversation(window, cx))
                        .child(self.render_timeline(window, cx))
                },
            )
            .when(
                !login_visible
                    && !microphone_visible
                    && self.conversation.mode == SurfaceMode::Terminal,
                |this| this.child(self.render_terminal(cx)),
            )
            .when(
                !login_visible && !microphone_visible && self.gesture_guide_available(),
                |this| this.child(self.render_gesture_guide_toggle(cx)),
            )
            .when(self.gesture_guide_open, |this| {
                this.child(self.render_gesture_guide(cx))
            })
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::rc::Rc;

    use gesture_protocol::{LifecycleState, ScrollState};
    use gpui::{
        point, AppContext as _, Modifiers, ScrollDelta, ScrollWheelEvent, TestAppContext,
        VisualTestContext, WindowOptions,
    };
    use gpui_component::Root;

    use super::*;
    use crate::app::gesture::GESTURE_SCROLL_FRAME_INTERVAL;
    use crate::vision_debug::VisionEvent;

    #[test]
    fn expensive_message_layouts_do_not_repeat_during_a_transition() {
        assert!(animate_message(false, false));
        assert!(!animate_message(false, true));
        assert!(!animate_message(true, false));

        let mut remembered = None;
        assert!(!stable_transition_cost(&mut remembered, 7, false));
        assert!(!stable_transition_cost(&mut remembered, 7, true));
        assert!(stable_transition_cost(&mut remembered, 8, true));
    }

    #[test]
    fn message_selection_topology_tracks_async_renderer_upgrades() {
        assert_eq!(
            message_selection_topology(false, false),
            SelectionTopology::PlainMessage
        );
        assert_eq!(
            message_selection_topology(true, false),
            SelectionTopology::RichDocument
        );
        assert_eq!(
            message_selection_topology(true, true),
            SelectionTopology::PlainPrefixWithRichDocument
        );

        let first_revision = message_selection_key("assistant:stream", &[]);
        let corrected_revision = message_selection_key("assistant:stream", &[]);
        assert_eq!(first_revision, corrected_revision);
    }

    #[test]
    fn streaming_growth_preserves_middle_offset_and_bottom_following() {
        let middle = streaming_scroll_anchor(100.0, -40.0);
        assert_eq!(middle, super::super::MessageScrollAnchor::Absolute(-40.0));
        assert_eq!(scroll_anchor_offset(middle, 240.0), -40.0);

        let bottom = streaming_scroll_anchor(100.0, -100.0);
        assert_eq!(bottom, super::super::MessageScrollAnchor::Bottom);
        assert_eq!(scroll_anchor_offset(bottom, 240.0), -240.0);
    }

    #[test]
    fn completed_state_does_not_authorize_an_old_streaming_media_snapshot() {
        let old = crate::prepared::prepare_completed_assistant(
            "![old](https://example.com/old.png)".to_string(),
            Vec::new(),
        );
        let final_revision = crate::prepared::content_revision("final correction", &[]);

        assert!(!markdown_media_is_authoritative(
            MomentState::Complete,
            Some(final_revision),
            &old,
        ));
        assert!(media_descriptors(&old, false).is_empty());
    }

    #[test]
    fn activity_language_is_sanitized_and_human_readable() {
        use crate::model::ActivityUnit;

        assert_eq!(
            live_activity_label(LiveActivityEntry {
                category: ActivityCategory::RunningCommands,
                count: 1,
            }),
            "Running a command…"
        );
        assert_eq!(
            live_activity_label(LiveActivityEntry {
                category: ActivityCategory::RunningCommands,
                count: 3,
            }),
            "Running 3 commands…"
        );
        assert_eq!(
            live_activity_label(LiveActivityEntry {
                category: ActivityCategory::ReadingFiles,
                count: 3,
            }),
            "Running 3 read operations…"
        );
        assert_eq!(
            legacy_activity_label("RECONNECTING · 3"),
            "Reconnecting… attempt 3"
        );
        assert_eq!(
            activity_summary_line(&ActivitySummaryEntry {
                category: ActivityCategory::ReadingFiles,
                count: 13,
                unit: ActivityUnit::Reads,
            }),
            "Read files 13 times"
        );
        assert_eq!(
            activity_summary_line(&ActivitySummaryEntry {
                category: ActivityCategory::RunningCode,
                count: 1,
                unit: ActivityUnit::Runs,
            }),
            "Ran code once"
        );
        assert_eq!(
            activity_summary_line(&ActivitySummaryEntry {
                category: ActivityCategory::RunningCommands,
                count: 17,
                unit: ActivityUnit::Commands,
            }),
            "Ran 17 commands"
        );
    }

    #[test]
    fn wheel_deltas_normalize_mouse_lines_and_touchpad_pixels() {
        assert_eq!(
            normalized_vertical_delta(ScrollDelta::Lines(point(0.0, 3.0))),
            Some(48.0)
        );
        assert_eq!(
            normalized_vertical_delta(ScrollDelta::Pixels(point(px(0.0), px(-48.0)))),
            Some(-48.0)
        );
        assert_eq!(
            normalized_vertical_delta(ScrollDelta::Lines(point(4.0, 3.0))),
            None
        );
    }

    #[test]
    fn canvas_requires_fresh_overscroll_after_reaching_the_boundary() {
        let mut accumulator = 0.0;
        assert_eq!(
            canvas_scroll_action(
                &mut accumulator,
                -40.0,
                100.0,
                -120.0,
                true,
                ConversationScrollInput::Wheel,
            ),
            CanvasScrollAction::ScrollTo(-100.0)
        );
        assert_eq!(accumulator, 0.0);

        assert_eq!(
            canvas_scroll_action(
                &mut accumulator,
                -100.0,
                100.0,
                -48.0,
                true,
                ConversationScrollInput::Wheel,
            ),
            CanvasScrollAction::Resist {
                direction: 1,
                progress: 1.0 / 3.0,
            }
        );
        assert_eq!(
            canvas_scroll_action(
                &mut accumulator,
                -100.0,
                100.0,
                -48.0,
                true,
                ConversationScrollInput::Wheel,
            ),
            CanvasScrollAction::Resist {
                direction: 1,
                progress: 2.0 / 3.0,
            }
        );
        assert_eq!(
            canvas_scroll_action(
                &mut accumulator,
                -100.0,
                100.0,
                -48.0,
                true,
                ConversationScrollInput::Wheel,
            ),
            CanvasScrollAction::Navigate(1)
        );
    }

    #[test]
    fn short_canvas_navigates_immediately_and_latches_until_idle() {
        let start = Instant::now();
        let mut accumulator = 0.0;
        let mut last_event = Some(start);
        assert_eq!(
            canvas_scroll_action(
                &mut accumulator,
                0.0,
                0.0,
                -30.0,
                true,
                ConversationScrollInput::Wheel,
            ),
            CanvasScrollAction::Navigate(1)
        );

        latch_history_scroll(&mut accumulator, -48.0);

        assert!(!prepare_history_scroll_gesture(
            &mut accumulator,
            &mut last_event,
            start + Duration::from_millis(20),
        ));
        assert!(!prepare_history_scroll_gesture(
            &mut accumulator,
            &mut last_event,
            start + Duration::from_millis(40),
        ));

        assert!(prepare_history_scroll_gesture(
            &mut accumulator,
            &mut last_event,
            start + HISTORY_SCROLL_IDLE + Duration::from_millis(50),
        ));
        assert_eq!(accumulator, 0.0);
    }

    #[test]
    fn continuous_gesture_accumulates_distance_before_crossing_short_moments() {
        let mut accumulator = 0.0;
        for progress in [1.0 / 3.0, 2.0 / 3.0] {
            assert_eq!(
                canvas_scroll_action(
                    &mut accumulator,
                    0.0,
                    0.0,
                    -48.0,
                    true,
                    ConversationScrollInput::ContinuousGesture,
                ),
                CanvasScrollAction::Resist {
                    direction: 1,
                    progress,
                }
            );
        }
        assert_eq!(
            canvas_scroll_action(
                &mut accumulator,
                0.0,
                0.0,
                -48.0,
                true,
                ConversationScrollInput::ContinuousGesture,
            ),
            CanvasScrollAction::Navigate(1)
        );
    }

    #[test]
    fn boundary_resistance_reverses_and_missing_neighbor_is_blocked() {
        let mut accumulator = 80.0;
        assert_eq!(
            canvas_scroll_action(
                &mut accumulator,
                -100.0,
                100.0,
                -30.0,
                true,
                ConversationScrollInput::Wheel,
            ),
            CanvasScrollAction::Resist {
                direction: 1,
                progress: 30.0 / HISTORY_SCROLL_THRESHOLD,
            }
        );
        assert_eq!(accumulator, -30.0);
        assert_eq!(
            canvas_scroll_action(
                &mut accumulator,
                -100.0,
                100.0,
                -48.0,
                false,
                ConversationScrollInput::Wheel,
            ),
            CanvasScrollAction::Blocked
        );
        assert_eq!(accumulator, 0.0);
    }

    #[test]
    fn timeline_markers_keep_uniform_geometry_when_selected() {
        assert_eq!(timeline_marker_geometry(false), (4.0, 8.0));
        assert_eq!(
            timeline_marker_geometry(false),
            timeline_marker_geometry(true)
        );
    }

    #[test]
    fn parallel_activity_is_grouped_and_capped_without_details() {
        let lines = grouped_live_activity(&[
            LiveActivityEntry {
                category: ActivityCategory::SearchingFiles,
                count: 2,
            },
            LiveActivityEntry {
                category: ActivityCategory::ReadingFiles,
                count: 4,
            },
            LiveActivityEntry {
                category: ActivityCategory::WritingFiles,
                count: 1,
            },
            LiveActivityEntry {
                category: ActivityCategory::RunningCommands,
                count: 3,
            },
            LiveActivityEntry {
                category: ActivityCategory::RunningCode,
                count: 1,
            },
        ]);

        assert_eq!(lines.len(), 4);
        assert_eq!(lines[0].label, "Running 2 file searches…");
        assert_eq!(lines[0].motion, PresenceMotion::Search);
        assert_eq!(lines[1].label, "Running 4 read operations…");
        assert_eq!(lines[1].motion, PresenceMotion::Read);
        assert_eq!(lines[2].motion, PresenceMotion::Mutate);
        assert_eq!(lines[3].label, "+ 2 more");
        assert_eq!(lines[3].motion, PresenceMotion::None);
    }

    #[test]
    fn approval_replaces_live_presence() {
        let live = [LiveActivityEntry {
            category: ActivityCategory::RunningCommands,
            count: 2,
        }];
        assert!(presence_lines(
            &live,
            Some("THINKING"),
            true,
            true,
            Some("LISTENING"),
            Some(500),
        )
        .is_empty());
        assert_eq!(
            presence_lines(&live, Some("THINKING"), true, false, None, None)[0].label,
            "Running 2 commands…"
        );
        assert_eq!(
            presence_lines(&live, Some("APPLYING"), false, true, None, None)[0].label,
            "Applying…"
        );
        assert_eq!(
            presence_lines(
                &live,
                Some("NOT APPLIED · TRY AGAIN"),
                false,
                true,
                None,
                None,
            )[0]
            .label,
            "Not applied. Try again."
        );
    }

    #[test]
    fn voice_notice_leads_normal_presence_without_exposing_implementation() {
        let live = [LiveActivityEntry {
            category: ActivityCategory::RunningCode,
            count: 1,
        }];
        let lines = presence_lines(&live, None, false, false, Some("LISTENING"), None);

        assert_eq!(lines[0].label, "LISTENING");
        assert_eq!(lines[0].motion, PresenceMotion::Breathe);
        assert_eq!(lines[1].label, "Running a code task…");

        let downloading = presence_lines(
            &[],
            None,
            false,
            false,
            Some("DOWNLOADING VOICE INPUT · 42%"),
            None,
        );
        assert_eq!(downloading[0].motion, PresenceMotion::Search);
        let finishing =
            presence_lines(&[], None, false, false, Some("FINISHING VOICE INPUT"), None);
        assert_eq!(finishing[0].motion, PresenceMotion::Mutate);

        let gesture_dwell = presence_lines(
            &[],
            None,
            false,
            false,
            Some("LISTENING · PREPARING TO SEND"),
            Some(725),
        );
        assert_eq!(gesture_dwell[0].motion, PresenceMotion::Dwell(725));
    }

    #[test]
    fn type_fit_cache_hash_covers_revision_and_geometry() {
        let baseline = type_fit_hash(7, 800.0, 500.0);
        assert_eq!(baseline, type_fit_hash(7, 800.0, 500.0));
        assert_ne!(baseline, type_fit_hash(7, 801.0, 500.0));
        assert_ne!(baseline, type_fit_hash(7, 800.0, 501.0));
        assert_ne!(baseline, type_fit_hash(8, 800.0, 500.0));
    }

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
    fn short_canvas_wheel_moves_immediately_and_latches_the_gesture(cx: &mut TestAppContext) {
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
            app.update(cx, |app, _| {
                // VisualTestContext may spend wall-clock time painting this first transition.
                // Pin the synthetic gesture clock after the event so the rest of this test is
                // independent of parallel-suite scheduling.
                app.history_scroll_last_event = Some(Instant::now());
            });
            let app = app.read(cx);
            assert_eq!(app.conversation.selected, 1);
            assert_eq!(app.audio.request_count(crate::audio::KeySound::Navigate), 1);
        });

        for _ in 0..5 {
            cx.cx.update(|cx| {
                app.update(cx, |app, _| {
                    app.history_scroll_accumulator = f32::INFINITY;
                    app.history_scroll_last_event = Some(Instant::now());
                });
            });
            cx.simulate_event(ScrollWheelEvent {
                position,
                delta: ScrollDelta::Pixels(point(px(0.0), px(64.0))),
                ..Default::default()
            });
        }
        cx.cx.update(|cx| {
            let app = app.read(cx);
            assert_eq!(app.conversation.selected, 1);
            assert_eq!(app.audio.request_count(crate::audio::KeySound::Navigate), 1);
        });

        cx.cx.update(|cx| {
            app.update(cx, |app, _| {
                app.history_scroll_accumulator = f32::INFINITY;
                app.history_scroll_last_event = Some(Instant::now());
            });
        });
        cx.simulate_event(ScrollWheelEvent {
            position,
            delta: ScrollDelta::Lines(point(0.0, -3.0)),
            ..Default::default()
        });
        cx.cx.update(|cx| {
            let app = app.read(cx);
            assert_eq!(app.conversation.selected, 1);
            assert_eq!(app.audio.request_count(crate::audio::KeySound::Navigate), 1);
        });

        cx.simulate_event(ScrollWheelEvent {
            position,
            touch_phase: TouchPhase::Ended,
            ..Default::default()
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
    }

    #[gpui::test]
    fn timeline_wheel_owns_navigation_without_scrolling_the_rail(cx: &mut TestAppContext) {
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
        let viewport = cx.update(|window, _| window.viewport_size());
        let message_offset_before = cx.cx.update(|cx| app.read(cx).message_scroll.offset());
        let rail_offset_before = cx.cx.update(|cx| app.read(cx).timeline_scroll.offset());

        cx.simulate_event(ScrollWheelEvent {
            position: point(px(40.0), px(f32::from(viewport.height) / 2.0)),
            delta: ScrollDelta::Lines(point(0.0, 3.0)),
            ..Default::default()
        });
        cx.run_until_parked();
        cx.cx.update(|cx| {
            let app = app.read(cx);
            assert_eq!(app.conversation.selected, 1);
            assert_eq!(app.message_scroll.offset(), message_offset_before);
            assert_eq!(app.timeline_scroll.offset(), rail_offset_before);
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
                app.conversation.moments[1] = crate::model::Moment::new(
                    "demo-2",
                    MomentRole::User,
                    "A long message. ".repeat(2_000),
                );
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
            assert_eq!(app.conversation.selected, 1);
            assert_eq!(app.audio.request_count(crate::audio::KeySound::Navigate), 0);
            assert_eq!(
                app.history_edge_intent.map(|intent| intent.direction),
                Some(1)
            );
            assert_eq!(
                app.history_edge_intent.map(|intent| intent.progress),
                Some(1.0 / 3.0)
            );
        });
        cx.simulate_event(ScrollWheelEvent {
            position,
            delta: ScrollDelta::Lines(point(0.0, -3.0)),
            ..Default::default()
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
            assert!(app.history_edge_intent.is_none());
        });
    }

    #[gpui::test]
    fn gesture_scroll_moves_the_long_message_canvas_without_a_pointer_event(
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
                app.conversation.moments[1] = crate::model::Moment::new(
                    "demo-2",
                    MomentRole::User,
                    "A long message. ".repeat(2_000),
                );
                app.conversation.select(1);
                app.vision_lifecycle = Some(LifecycleState::Ready);
                app.vision_armed = true;
                cx.notify();
            });
        });
        cx.run_until_parked();
        cx.cx.update(|cx| {
            let app = app.read(cx);
            assert!(app.message_scroll.max_offset().height > px(144.0));
            assert_eq!(app.message_scroll.offset().y, px(0.0));
        });

        cx.update(|window, cx| {
            app.update(cx, |app, cx| {
                let received_at = cx.background_executor().now();
                app.handle_vision_event(
                    VisionEvent::Scroll {
                        sequence: 1,
                        received_at,
                        state: ScrollState::Active {
                            instance_id: 7,
                            offset_millipalms: -1_000,
                        },
                    },
                    window,
                    cx,
                );
            });
        });
        cx.run_until_parked();
        cx.executor().advance_clock(GESTURE_SCROLL_FRAME_INTERVAL);
        cx.run_until_parked();
        let first_offset = cx.cx.update(|cx| app.read(cx).message_scroll.offset().y);
        assert!(first_offset < px(0.0));

        cx.executor().advance_clock(GESTURE_SCROLL_FRAME_INTERVAL);
        cx.run_until_parked();
        let second_offset = cx.cx.update(|cx| app.read(cx).message_scroll.offset().y);
        assert!(second_offset < first_offset);

        cx.update(|window, cx| {
            app.update(cx, |app, cx| {
                app.handle_vision_event(
                    VisionEvent::Scroll {
                        sequence: 2,
                        received_at: cx.background_executor().now(),
                        state: ScrollState::Idle,
                    },
                    window,
                    cx,
                );
            });
        });
        let stopped_offset = cx.cx.update(|cx| app.read(cx).message_scroll.offset().y);
        cx.executor().advance_clock(Duration::from_millis(64));
        cx.run_until_parked();
        cx.cx.update(|cx| {
            let app = app.read(cx);
            assert_eq!(app.conversation.selected, 1);
            assert_eq!(app.message_scroll.offset().y, stopped_offset);
            assert_eq!(app.history_scroll_accumulator, 0.0);
            assert!(app.history_scroll_last_event.is_none());
        });
    }

    #[gpui::test]
    fn stream_size_shrinks_with_prepared_growth_and_never_regrows_within_the_run(
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
        let cx = VisualTestContext::from_window(window.into(), cx);
        cx.run_until_parked();

        let app = app.borrow().clone().expect("app entity should be retained");
        cx.cx.update(|cx| {
            app.update(cx, |app, cx| {
                app.conversation.start_run("run-1");
                app.conversation
                    .stream_text(Some("run-1"), "A measured response.");
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
                app.conversation
                    .stream_text(Some("run-1"), &" More measured detail.".repeat(160));
                cx.notify();
            });
        });
        cx.executor().advance_clock(Duration::from_millis(40));
        cx.run_until_parked();
        let grown_size = cx.cx.update(|cx| {
            let app = app.read(cx);
            let mut sizes = app.stream_type_sizes.values().copied();
            let size = sizes.next().expect("grown stream size should be cached");
            assert!(sizes.all(|other| other == size));
            assert!(
                size < live_size,
                "accepted prepared growth should shrink from {live_size} to {size}"
            );
            size
        });

        cx.cx.update(|cx| {
            app.update(cx, |app, cx| {
                app.conversation.replace_run_text_owned(
                    Some("run-1"),
                    "A corrected short response.".to_string(),
                );
                cx.notify();
            });
        });
        cx.executor().advance_clock(Duration::from_millis(40));
        cx.run_until_parked();
        cx.cx.update(|cx| {
            assert!(app
                .read(cx)
                .stream_type_sizes
                .values()
                .all(|size| *size == grown_size));
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
            assert_eq!(app.stream_type_sizes.values().next(), Some(&grown_size));
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
            app.type_layouts
                .iter()
                .map(|(key, value)| {
                    (
                        key.clone(),
                        (
                            value.content_hash,
                            value.maximum_size,
                            value.weight,
                            value.layout,
                        ),
                    )
                })
                .collect::<std::collections::HashMap<_, _>>()
        });

        cx.cx.update(|cx| app.update(cx, |_, cx| cx.notify()));
        cx.run_until_parked();
        cx.cx.update(|cx| {
            let app = app.read(cx);
            let current = app
                .type_layouts
                .iter()
                .map(|(key, value)| {
                    (
                        key.clone(),
                        (
                            value.content_hash,
                            value.maximum_size,
                            value.weight,
                            value.layout,
                        ),
                    )
                })
                .collect::<std::collections::HashMap<_, _>>();
            assert_eq!(current, cached);
        });
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
                app.conversation.moments[2] = crate::model::Moment::new(
                    "demo-3",
                    MomentRole::Intelligence,
                    "# Result\n\n![map](https://example.com/map.png)",
                );
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
            assert!(app.prepared_content.is_ready("demo-3"));
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
