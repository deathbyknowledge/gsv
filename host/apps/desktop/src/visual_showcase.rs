use std::sync::Arc;

use gpui::prelude::FluentBuilder as _;
use gpui::{
    actions, div, img, linear_color_stop, linear_gradient, px, relative, rgb, App, Context,
    FocusHandle, Focusable, InteractiveElement as _, IntoElement, KeyBinding, MouseButton,
    MouseDownEvent, MouseMoveEvent, MouseUpEvent, ObjectFit, ParentElement as _, Point, Render,
    RenderImage, StatefulInteractiveElement as _, Styled, StyledImage as _, Task, Window,
};
use image::{Frame, RgbaImage};
use smallvec::SmallVec;
use visual_engine::{VisualEngine, VisualEngineConfig, VisualEvent, VisualFrame, VisualPreset};

use crate::theme;

actions!(visual_showcase, [PreviousVisual, NextVisual, ResetShipView]);

pub(crate) fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("left", PreviousVisual, None),
        KeyBinding::new("right", NextVisual, None),
        KeyBinding::new("space", NextVisual, None),
        KeyBinding::new("r", ResetShipView, None),
    ]);
}

pub(crate) struct VisualShowcase {
    event_task: Option<Task<()>>,
    engine: Option<VisualEngine>,
    image: Option<Arc<RenderImage>>,
    preset: VisualPreset,
    status: String,
    sequence: u64,
    render_millis: f32,
    frame_width: u32,
    frame_height: u32,
    focus_handle: FocusHandle,
    drag_anchor: Option<Point<gpui::Pixels>>,
    ship_orbit: f32,
    ship_elevation: f32,
}

impl VisualShowcase {
    pub(crate) fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus_handle = cx.focus_handle();
        focus_handle.focus(window);
        let mut engine = match VisualEngine::start(VisualEngineConfig::default()) {
            Ok(engine) => engine,
            Err(error) => {
                return Self {
                    event_task: None,
                    engine: None,
                    image: None,
                    preset: VisualPreset::Listening,
                    status: error.to_string(),
                    sequence: 0,
                    render_millis: 0.0,
                    frame_width: 0,
                    frame_height: 0,
                    focus_handle,
                    drag_anchor: None,
                    ship_orbit: 0.0,
                    ship_elevation: 0.0,
                };
            }
        };
        let mut events = match engine.take_events() {
            Ok(events) => events,
            Err(error) => {
                return Self {
                    event_task: None,
                    engine: Some(engine),
                    image: None,
                    preset: VisualPreset::Listening,
                    status: error.to_string(),
                    sequence: 0,
                    render_millis: 0.0,
                    frame_width: 0,
                    frame_height: 0,
                    focus_handle,
                    drag_anchor: None,
                    ship_orbit: 0.0,
                    ship_elevation: 0.0,
                };
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
            preset: VisualPreset::Listening,
            status: "INITIALIZING GPU".into(),
            sequence: 0,
            render_millis: 0.0,
            frame_width: 0,
            frame_height: 0,
            focus_handle,
            drag_anchor: None,
            ship_orbit: 0.0,
            ship_elevation: 0.0,
        }
    }

    fn handle_event(&mut self, event: VisualEvent, window: &mut Window, cx: &mut Context<Self>) {
        match event {
            VisualEvent::Frame(frame) => self.install_frame(frame, window, cx),
            VisualEvent::Failed(message) => {
                self.status = message;
                cx.notify();
            }
        }
    }

    fn install_frame(&mut self, frame: VisualFrame, window: &mut Window, cx: &mut Context<Self>) {
        let Some(buffer) = RgbaImage::from_raw(frame.width, frame.height, frame.bgra) else {
            self.status = "GPU RETURNED AN INVALID FRAME".into();
            cx.notify();
            return;
        };
        let image = Arc::new(RenderImage::new(SmallVec::from_elem(Frame::new(buffer), 1)));
        if let Some(previous) = self.image.replace(image) {
            cx.drop_image(previous, Some(window));
        }
        self.sequence = frame.sequence;
        self.frame_width = frame.width;
        self.frame_height = frame.height;
        let frame_millis = frame.render_time.as_secs_f32() * 1_000.0;
        self.render_millis = if self.render_millis == 0.0 {
            frame_millis
        } else {
            self.render_millis * 0.92 + frame_millis * 0.08
        };
        self.status = "SHARED AGSL // RUST GPU".into();
        cx.notify();
    }

    fn previous_visual(&mut self, _: &PreviousVisual, _: &mut Window, cx: &mut Context<Self>) {
        let current = VisualPreset::ALL
            .iter()
            .position(|preset| *preset == self.preset)
            .unwrap_or(0);
        let previous = (current + VisualPreset::ALL.len() - 1) % VisualPreset::ALL.len();
        self.select_preset(VisualPreset::ALL[previous], cx);
    }

    fn next_visual(&mut self, _: &NextVisual, _: &mut Window, cx: &mut Context<Self>) {
        let current = VisualPreset::ALL
            .iter()
            .position(|preset| *preset == self.preset)
            .unwrap_or(0);
        self.select_preset(
            VisualPreset::ALL[(current + 1) % VisualPreset::ALL.len()],
            cx,
        );
    }

    fn reset_ship_view(&mut self, _: &ResetShipView, _: &mut Window, cx: &mut Context<Self>) {
        self.ship_orbit = 0.0;
        self.ship_elevation = 0.0;
        if let Some(engine) = &self.engine {
            if let Err(error) = engine.set_ship_view(0.0, 0.0) {
                self.status = error.to_string();
            }
        }
        cx.notify();
    }

    fn select_preset(&mut self, preset: VisualPreset, cx: &mut Context<Self>) {
        self.preset = preset;
        if let Some(engine) = &self.engine {
            if let Err(error) = engine.set_preset(preset) {
                self.status = error.to_string();
            }
        }
        cx.notify();
    }

    fn on_mouse_down(&mut self, event: &MouseDownEvent, _: &mut Window, _: &mut Context<Self>) {
        if self.is_ship() {
            self.drag_anchor = Some(event.position);
        }
    }

    fn on_mouse_up(&mut self, _: &MouseUpEvent, _: &mut Window, _: &mut Context<Self>) {
        self.drag_anchor = None;
    }

    fn on_mouse_move(&mut self, event: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        let Some(anchor) = self.drag_anchor.replace(event.position) else {
            return;
        };
        if !event.dragging() || !self.is_ship() {
            self.drag_anchor = None;
            return;
        }
        let delta = event.position - anchor;
        self.ship_orbit += f32::from(delta.x) * 0.008;
        self.ship_elevation = (self.ship_elevation + f32::from(delta.y) * 0.006).clamp(-0.72, 0.72);
        if let Some(engine) = &self.engine {
            if let Err(error) = engine.set_ship_view(self.ship_orbit, self.ship_elevation) {
                self.status = error.to_string();
            }
        }
        cx.notify();
    }

    fn is_ship(&self) -> bool {
        matches!(
            self.preset,
            VisualPreset::ShipHologram | VisualPreset::ShipPhysical | VisualPreset::ShipArmed
        )
    }

    fn star(index: usize, phase: f32) -> impl IntoElement {
        let x = ((index * 73 + 11) % 101) as f32 / 101.0;
        let y = ((index * 47 + 19) % 97) as f32 / 97.0;
        let bright = index.is_multiple_of(17);
        let radius = if bright {
            1.8
        } else if index.is_multiple_of(5) {
            1.25
        } else {
            0.72
        };
        let twinkle = 0.42 + 0.58 * (phase * 0.8 + index as f32 * 1.73).sin().abs();
        let opacity = (if bright { 0.58 } else { 0.24 }) * twinkle;
        div()
            .absolute()
            .left(relative(x))
            .top(relative(y))
            .size(px(radius))
            .rounded_full()
            .bg(if index.is_multiple_of(6) {
                rgb(theme::ACCENT)
            } else {
                rgb(0xdedcff)
            })
            .opacity(opacity)
    }

    fn state_control(&self, preset: VisualPreset, cx: &mut Context<Self>) -> impl IntoElement {
        let selected = preset == self.preset;
        div()
            .id(preset.label())
            .px(px(12.0))
            .py(px(7.0))
            .border_b_1()
            .border_color(if selected {
                rgb(theme::ACCENT)
            } else {
                rgb(theme::TEXT_FAINT)
            })
            .font_family(theme::MONO_FONT)
            .text_size(px(10.0))
            .text_color(if selected {
                rgb(theme::TEXT)
            } else {
                rgb(theme::TEXT_QUIET)
            })
            .cursor_pointer()
            .hover(|style| style.text_color(rgb(theme::ACCENT)))
            .on_click(cx.listener(move |this, _, _, cx| {
                this.select_preset(preset, cx);
            }))
            .child(preset.label())
    }
}

impl Render for VisualShowcase {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let phase = self.sequence as f32 / 30.0;
        let image = self.image.clone();
        let drag_hint = self
            .is_ship()
            .then_some("DRAG TO ORBIT // VERTICAL DRAG TO ELEVATE");
        let metrics = if self.sequence == 0 {
            self.status.clone()
        } else {
            format!(
                "{} // {:04.1} MS // {}×{}",
                self.status, self.render_millis, self.frame_width, self.frame_height
            )
        };

        div()
            .relative()
            .track_focus(&self.focus_handle)
            .on_action(cx.listener(Self::previous_visual))
            .on_action(cx.listener(Self::next_visual))
            .on_action(cx.listener(Self::reset_ship_view))
            .size_full()
            .overflow_hidden()
            .bg(linear_gradient(
                180.0,
                linear_color_stop(rgb(0x050414), 0.0),
                linear_color_stop(rgb(0x0a0822), 1.0),
            ))
            .text_color(rgb(theme::TEXT))
            .children((0..146).map(|index| Self::star(index, phase)))
            .child(
                div()
                    .absolute()
                    .top(px(28.0))
                    .left(px(32.0))
                    .font_family(theme::MONO_FONT)
                    .text_size(px(11.0))
                    .text_color(rgb(theme::TEXT_QUIET))
                    .child("GSV // VISUAL CORE"),
            )
            .child(
                div()
                    .absolute()
                    .top(px(28.0))
                    .right(px(32.0))
                    .font_family(theme::MONO_FONT)
                    .text_size(px(10.0))
                    .text_color(rgb(theme::ACCENT))
                    .child(self.preset.label()),
            )
            .child(
                div()
                    .id("visual-stage")
                    .absolute()
                    .top(px(64.0))
                    .bottom(px(104.0))
                    .left(px(42.0))
                    .right(px(42.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
                    .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
                    .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
                    .on_mouse_move(cx.listener(Self::on_mouse_move))
                    .when_some(image, |stage, image| {
                        stage.child(
                            img(image)
                                .id("procedural-visual-frame")
                                .size_full()
                                .object_fit(ObjectFit::Contain),
                        )
                    })
                    .when(self.image.is_none(), |stage| {
                        stage.child(
                            div()
                                .font_family(theme::MONO_FONT)
                                .text_size(px(10.0))
                                .text_color(rgb(theme::TEXT_QUIET))
                                .child(self.status.clone()),
                        )
                    })
                    .when_some(drag_hint, |stage, hint| {
                        stage.child(
                            div()
                                .absolute()
                                .bottom(px(4.0))
                                .font_family(theme::MONO_FONT)
                                .text_size(px(8.0))
                                .text_color(rgb(theme::TEXT_FAINT))
                                .child(hint),
                        )
                    }),
            )
            .child(
                div()
                    .absolute()
                    .bottom(px(25.0))
                    .left(px(32.0))
                    .right(px(32.0))
                    .flex()
                    .items_end()
                    .justify_between()
                    .child(
                        div().flex().gap(px(8.0)).children(
                            VisualPreset::ALL
                                .into_iter()
                                .map(|preset| self.state_control(preset, cx)),
                        ),
                    )
                    .child(
                        div()
                            .pb(px(7.0))
                            .font_family(theme::MONO_FONT)
                            .text_size(px(8.0))
                            .text_color(rgb(theme::TEXT_FAINT))
                            .child(metrics),
                    ),
            )
    }
}

impl Focusable for VisualShowcase {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Drop for VisualShowcase {
    fn drop(&mut self) {
        self.event_task.take();
        self.engine.take();
    }
}
