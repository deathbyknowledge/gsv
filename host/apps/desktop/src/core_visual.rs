use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui::{
    div, img, Context, IntoElement, ObjectFit, ParentElement as _, Render, RenderImage,
    Styled as _, StyledImage as _, Task, Window,
};
use image::{Frame, RgbaImage};
use smallvec::SmallVec;
use visual_engine::{VisualEngine, VisualEngineConfig, VisualEvent, VisualFrame, VisualPreset};

use crate::model::ActivityCategory;

const MINIMUM_ACTIVITY_VISIBILITY: Duration = Duration::from_millis(1_800);
const MAX_PENDING_ACTIVITIES: usize = 2;
const CORE_RENDER_EXTENTS: [u32; 3] = [512, 768, 1_024];
pub(crate) const MAX_CORE_DIAMETER: f32 = 760.0;

#[derive(Debug)]
struct ActivityPresentation {
    generation: u64,
    observed: Option<VisualPreset>,
    visible: Option<VisualPreset>,
    visible_since: Option<Instant>,
    pending: VecDeque<VisualPreset>,
}

impl ActivityPresentation {
    fn new() -> Self {
        Self {
            generation: 0,
            observed: None,
            visible: None,
            visible_since: None,
            pending: VecDeque::new(),
        }
    }

    fn update(&mut self, generation: u64, incoming: Option<VisualPreset>, now: Instant) -> bool {
        let mut changed = false;
        if generation != self.generation {
            self.clear();
            self.generation = generation;
            changed = true;
        }

        let activity_changed = incoming != self.observed;
        if activity_changed {
            self.observed = incoming;
            changed = true;
        }
        if let Some(activity) = incoming.filter(|_| activity_changed || self.visible.is_none()) {
            changed |= self.present_or_queue(activity, now);
        }
        changed
    }

    fn advance(&mut self, now: Instant) -> bool {
        let next = self.pending.pop_front().or(self.observed);
        if next == self.visible && next.is_none() {
            return false;
        }
        self.visible = next;
        self.visible_since = next.map(|_| now);
        true
    }

    fn next_delay(&self, now: Instant) -> Option<Duration> {
        let visible_since = self.visible_since?;
        if self.pending.is_empty() && self.observed == self.visible {
            return None;
        }
        Some(
            visible_since
                .checked_add(MINIMUM_ACTIVITY_VISIBILITY)
                .and_then(|deadline| deadline.checked_duration_since(now))
                .unwrap_or(Duration::ZERO),
        )
    }

    fn present_or_queue(&mut self, activity: VisualPreset, now: Instant) -> bool {
        if self.visible.is_none() {
            self.visible = Some(activity);
            self.visible_since = Some(now);
            return true;
        }
        if self.visible == Some(activity) && self.pending.is_empty() {
            self.visible_since = Some(now);
            return true;
        }
        if self.pending.back() == Some(&activity) {
            return false;
        }
        if self.pending.len() >= MAX_PENDING_ACTIVITIES {
            self.pending.pop_front();
        }
        self.pending.push_back(activity);
        true
    }

    fn clear(&mut self) {
        self.observed = None;
        self.visible = None;
        self.visible_since = None;
        self.pending.clear();
    }
}

pub(crate) struct CoreVisual {
    event_task: Option<Task<()>>,
    engine: Option<VisualEngine>,
    image: Option<Arc<RenderImage>>,
    presentation: ActivityPresentation,
    base_preset: VisualPreset,
    applied_preset: VisualPreset,
    render_extent: u32,
    enabled: bool,
    advance_epoch: u64,
    advance_task: Option<Task<()>>,
}

impl CoreVisual {
    pub(crate) fn new(window: &mut Window, cx: &mut Context<Self>, reduced_motion: bool) -> Self {
        let render_extent = core_render_extent(MAX_CORE_DIAMETER, window.scale_factor());
        let config = VisualEngineConfig {
            width: render_extent,
            height: render_extent,
            frames_per_second: if reduced_motion { 12 } else { 30 },
            idle_frames_per_second: if reduced_motion { 8 } else { 18 },
            initial_preset: VisualPreset::Listening,
            initially_active: false,
        };
        let mut engine = match VisualEngine::start(config) {
            Ok(engine) => engine,
            Err(error) => {
                eprintln!("GSV Core visual is unavailable: {error}");
                return Self::unavailable();
            }
        };
        let mut events = match engine.take_events() {
            Ok(events) => events,
            Err(error) => {
                eprintln!("GSV Core visual is unavailable: {error}");
                return Self::unavailable();
            }
        };
        let event_task = cx.spawn_in(window, async move |this, cx| {
            while let Some(event) = events.recv().await {
                if this
                    .update_in(cx, |this, window, cx| {
                        this.handle_event(event, window, cx);
                    })
                    .is_err()
                {
                    break;
                }
            }
        });

        Self {
            event_task: Some(event_task),
            engine: Some(engine),
            image: None,
            presentation: ActivityPresentation::new(),
            base_preset: VisualPreset::Listening,
            applied_preset: VisualPreset::Listening,
            render_extent,
            enabled: false,
            advance_epoch: 0,
            advance_task: None,
        }
    }

    pub(crate) fn set_process_state(
        &mut self,
        generation: u64,
        active: bool,
        activity: Option<ActivityCategory>,
        enabled: bool,
        cx: &mut Context<Self>,
    ) {
        let now = Instant::now();
        let presentation_changed =
            self.presentation
                .update(generation, activity.map(activity_preset), now);
        let base_preset = if active {
            VisualPreset::Thinking
        } else {
            VisualPreset::Listening
        };
        let base_changed = self.base_preset != base_preset;
        self.base_preset = base_preset;
        let enabled_changed = self.enabled != enabled;
        self.enabled = enabled;

        if presentation_changed || base_changed || enabled_changed {
            self.apply_renderer_state();
        }
        if presentation_changed {
            self.schedule_advance(now, cx);
        }
        if presentation_changed || base_changed || enabled_changed {
            cx.notify();
        }
    }

    pub(crate) fn set_display_size(&mut self, logical_extent: f32, scale_factor: f32) {
        let render_extent = core_render_extent(logical_extent, scale_factor);
        if self.render_extent == render_extent {
            return;
        }
        self.render_extent = render_extent;
        let Some(engine) = &self.engine else {
            return;
        };
        if let Err(error) = engine.set_resolution(render_extent, render_extent) {
            eprintln!("GSV Core visual could not change resolution: {error}");
        }
    }

    pub(crate) fn pulse_keyboard(&self, strength: f32) {
        let Some(engine) = &self.engine else {
            return;
        };
        if let Err(error) = engine.pulse_keyboard(strength) {
            eprintln!("GSV Core visual could not react to keyboard input: {error}");
        }
    }

    pub(crate) fn set_microphone_level(&self, level: f32) {
        let Some(engine) = &self.engine else {
            return;
        };
        if let Err(error) = engine.set_microphone_level(level) {
            eprintln!("GSV Core visual could not react to microphone input: {error}");
        }
    }

    pub(crate) fn reset(&mut self, generation: u64, cx: &mut Context<Self>) {
        self.presentation.clear();
        self.presentation.generation = generation;
        self.base_preset = VisualPreset::Listening;
        self.enabled = false;
        self.advance_epoch = self.advance_epoch.wrapping_add(1);
        self.advance_task = None;
        self.apply_renderer_state();
        cx.notify();
    }

    pub(crate) fn set_enabled(&mut self, enabled: bool, cx: &mut Context<Self>) {
        if self.enabled == enabled {
            return;
        }
        self.enabled = enabled;
        self.apply_renderer_state();
        cx.notify();
    }

    fn unavailable() -> Self {
        Self {
            event_task: None,
            engine: None,
            image: None,
            presentation: ActivityPresentation::new(),
            base_preset: VisualPreset::Listening,
            applied_preset: VisualPreset::Listening,
            render_extent: 0,
            enabled: false,
            advance_epoch: 0,
            advance_task: None,
        }
    }

    fn handle_event(&mut self, event: VisualEvent, window: &mut Window, cx: &mut Context<Self>) {
        match event {
            VisualEvent::Frame(frame) => self.install_frame(frame, window, cx),
            VisualEvent::Failed(message) => {
                eprintln!("GSV Core visual stopped: {message}");
                self.engine.take();
            }
        }
    }

    fn install_frame(&mut self, frame: VisualFrame, window: &mut Window, cx: &mut Context<Self>) {
        let Some(buffer) = RgbaImage::from_raw(frame.width, frame.height, frame.bgra) else {
            return;
        };
        let image = Arc::new(RenderImage::new(SmallVec::from_elem(Frame::new(buffer), 1)));
        if let Some(previous) = self.image.replace(image) {
            cx.drop_image(previous, Some(window));
        }
        cx.notify();
    }

    fn apply_renderer_state(&mut self) {
        let target = self.presentation.visible.unwrap_or(self.base_preset);
        let Some(engine) = &self.engine else {
            return;
        };
        if target != self.applied_preset {
            if let Err(error) = engine.set_preset(target) {
                eprintln!("GSV Core visual could not change state: {error}");
            } else {
                self.applied_preset = target;
            }
        }
        if let Err(error) = engine.set_active(self.enabled) {
            eprintln!("GSV Core visual could not change cadence: {error}");
        }
    }

    fn schedule_advance(&mut self, now: Instant, cx: &mut Context<Self>) {
        self.advance_epoch = self.advance_epoch.wrapping_add(1);
        self.advance_task = None;
        let epoch = self.advance_epoch;
        let Some(delay) = self.presentation.next_delay(now) else {
            return;
        };
        let timer = cx.background_executor().timer(delay);
        self.advance_task = Some(cx.spawn(async move |this, cx| {
            timer.await;
            let _ = this.update(cx, |this, cx| {
                if this.advance_epoch != epoch {
                    return;
                }
                let now = Instant::now();
                if this.presentation.advance(now) {
                    this.apply_renderer_state();
                    this.schedule_advance(now, cx);
                    cx.notify();
                }
            });
        }));
    }
}

impl Render for CoreVisual {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let mut stage = div().size_full().flex().items_center().justify_center();
        if let Some(image) = self.image.clone() {
            stage = stage.child(img(image).size_full().object_fit(ObjectFit::Contain));
        }
        stage
    }
}

impl Drop for CoreVisual {
    fn drop(&mut self) {
        self.event_task.take();
        self.engine.take();
    }
}

fn activity_preset(activity: ActivityCategory) -> VisualPreset {
    match activity {
        ActivityCategory::SearchingFiles => VisualPreset::Searching,
        ActivityCategory::ReadingFiles => VisualPreset::Reading,
        ActivityCategory::WritingFiles | ActivityCategory::EditingFiles => VisualPreset::Writing,
        ActivityCategory::DeletingFiles => VisualPreset::DeletingShredder,
        ActivityCategory::RunningCommands | ActivityCategory::RunningCode => {
            VisualPreset::Executing
        }
    }
}

fn core_render_extent(logical_extent: f32, scale_factor: f32) -> u32 {
    debug_assert!(logical_extent.is_finite() && logical_extent > 0.0);
    debug_assert!(scale_factor.is_finite() && scale_factor > 0.0);
    let required_extent = (logical_extent * scale_factor).ceil() as u32;
    CORE_RENDER_EXTENTS
        .into_iter()
        .find(|extent| *extent >= required_extent)
        .unwrap_or(CORE_RENDER_EXTENTS[CORE_RENDER_EXTENTS.len() - 1])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_extent_tracks_physical_presentation_size_with_a_quality_cap() {
        assert_eq!(core_render_extent(340.0, 1.0), 512);
        assert_eq!(core_render_extent(MAX_CORE_DIAMETER, 1.0), 768);
        assert_eq!(core_render_extent(MAX_CORE_DIAMETER, 1.25), 1_024);
        assert_eq!(core_render_extent(MAX_CORE_DIAMETER, 2.0), 1_024);
    }

    #[test]
    fn holds_a_completed_activity_for_the_minimum_visible_time() {
        let started = Instant::now();
        let mut presentation = ActivityPresentation::new();
        assert!(presentation.update(1, Some(VisualPreset::Reading), started));
        assert!(presentation.update(1, None, started + Duration::from_millis(100)));
        assert_eq!(presentation.visible, Some(VisualPreset::Reading));
        assert_eq!(
            presentation.next_delay(started + Duration::from_millis(100)),
            Some(Duration::from_millis(1_700))
        );

        assert!(presentation.advance(started + MINIMUM_ACTIVITY_VISIBILITY));
        assert_eq!(presentation.visible, None);
    }

    #[test]
    fn queues_rapid_activities_in_observed_order_with_a_bounded_backlog() {
        let started = Instant::now();
        let mut presentation = ActivityPresentation::new();
        presentation.update(1, Some(VisualPreset::Reading), started);
        presentation.update(1, None, started + Duration::from_millis(10));
        presentation.update(
            1,
            Some(VisualPreset::Searching),
            started + Duration::from_millis(20),
        );
        presentation.update(1, None, started + Duration::from_millis(30));
        presentation.update(
            1,
            Some(VisualPreset::Writing),
            started + Duration::from_millis(40),
        );
        presentation.update(1, None, started + Duration::from_millis(50));

        presentation.advance(started + MINIMUM_ACTIVITY_VISIBILITY);
        assert_eq!(presentation.visible, Some(VisualPreset::Searching));
        presentation.advance(started + MINIMUM_ACTIVITY_VISIBILITY * 2);
        assert_eq!(presentation.visible, Some(VisualPreset::Writing));
        presentation.advance(started + MINIMUM_ACTIVITY_VISIBILITY * 3);
        assert_eq!(presentation.visible, None);
    }

    #[test]
    fn a_new_generation_discards_old_afterimages() {
        let started = Instant::now();
        let mut presentation = ActivityPresentation::new();
        presentation.update(1, Some(VisualPreset::Reading), started);
        presentation.update(
            1,
            Some(VisualPreset::Searching),
            started + Duration::from_millis(20),
        );

        presentation.update(2, None, started + Duration::from_millis(40));

        assert_eq!(presentation.visible, None);
        assert!(presentation.pending.is_empty());
        assert_eq!(presentation.next_delay(started), None);
    }
}
