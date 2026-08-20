//! Native global scroll injection for absolute fist-drag state.
//!
//! The gesture helper never controls the operating system directly. Desktop
//! validates armed authority and freshness, derives bounded relative wheel
//! movement from absolute positions, and owns the platform input backend.

use std::time::{Duration, Instant};

use gesture_protocol::ScrollState;

const MAX_SCROLL_STATE_AGE: Duration = Duration::from_millis(500);
const LINES_PER_PALM: f32 = 6.0;

#[derive(Default)]
pub(crate) struct GestureScroller {
    motion: ScrollMotion,
    backend: NativeScroller,
}

impl GestureScroller {
    pub(crate) fn observe(&mut self, state: ScrollState, received_at: Instant, armed: bool) {
        if !armed || Instant::now().saturating_duration_since(received_at) > MAX_SCROLL_STATE_AGE {
            self.reset();
            return;
        }
        let lines = self.motion.observe(state);
        if lines != 0 {
            self.backend.scroll(lines);
        }
    }

    pub(crate) fn reset(&mut self) {
        self.motion.reset();
    }
}

#[derive(Default)]
struct ScrollMotion {
    instance_id: Option<u64>,
    offset_millipalms: i16,
    remainder: f32,
}

impl ScrollMotion {
    fn observe(&mut self, state: ScrollState) -> i32 {
        let ScrollState::Dragging {
            instance_id,
            offset_millipalms,
        } = state
        else {
            self.reset();
            return 0;
        };

        let previous = if self.instance_id == Some(instance_id) {
            self.offset_millipalms
        } else {
            self.remainder = 0.0;
            0
        };
        self.instance_id = Some(instance_id);
        self.offset_millipalms = offset_millipalms;

        // Camera Y grows downward. Negating the movement makes the page feel
        // grabbed: raising a fist pulls content upward and reveals what follows.
        let palm_delta = (i32::from(offset_millipalms) - i32::from(previous)) as f32 / 1_000.0;
        let requested = self.remainder - palm_delta * LINES_PER_PALM;
        let lines = requested.trunc() as i32;
        self.remainder = requested - lines as f32;
        lines
    }

    fn reset(&mut self) {
        self.instance_id = None;
        self.offset_millipalms = 0;
        self.remainder = 0.0;
    }
}

#[cfg(unix)]
#[derive(Default)]
enum NativeScroller {
    #[default]
    Uninitialized,
    Ready(Box<enigo::Enigo>),
    Unavailable,
}

#[cfg(unix)]
impl NativeScroller {
    fn scroll(&mut self, lines: i32) {
        use enigo::{Axis, Mouse as _};

        if matches!(self, Self::Uninitialized) {
            *self = match connect_native_scroller() {
                Ok(backend) => Self::Ready(Box::new(backend)),
                Err(()) => {
                    eprintln!(
                        "GSV gesture scrolling is unavailable: native input access could not be opened."
                    );
                    Self::Unavailable
                }
            };
        }
        let failed = match self {
            Self::Ready(backend) => backend.scroll(lines, Axis::Vertical).is_err(),
            Self::Uninitialized | Self::Unavailable => false,
        };
        if failed {
            eprintln!("GSV gesture scrolling is unavailable: native input access was interrupted.");
            *self = Self::Unavailable;
        }
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn connect_native_scroller() -> Result<enigo::Enigo, ()> {
    use enigo::{Axis, Mouse as _, Settings};

    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        let settings = Settings {
            linux_delay: 0,
            x11_display: Some(disabled_display_name("x11")),
            ..Settings::default()
        };
        if let Ok(mut backend) = enigo::Enigo::new(&settings) {
            // A compositor may expose only the keyboard half of the protocol.
            // A zero-distance probe proves that this connection can scroll.
            if backend.scroll(0, Axis::Vertical).is_ok() {
                return Ok(backend);
            }
        }
    }

    let settings = Settings {
        linux_delay: 0,
        wayland_display: Some(disabled_display_name("wayland")),
        ..Settings::default()
    };
    enigo::Enigo::new(&settings).map_err(|_| ())
}

#[cfg(target_os = "macos")]
fn connect_native_scroller() -> Result<enigo::Enigo, ()> {
    enigo::Enigo::new(&enigo::Settings::default()).map_err(|_| ())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn disabled_display_name(protocol: &str) -> String {
    format!("gsv-disabled-{protocol}-{}", std::process::id())
}

#[cfg(not(unix))]
#[derive(Default)]
struct NativeScroller;

#[cfg(not(unix))]
impl NativeScroller {
    fn scroll(&mut self, _lines: i32) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absolute_drag_positions_become_incremental_direct_manipulation() {
        let mut motion = ScrollMotion::default();
        assert_eq!(
            motion.observe(ScrollState::Dragging {
                instance_id: 7,
                offset_millipalms: -500,
            }),
            3
        );
        assert_eq!(
            motion.observe(ScrollState::Dragging {
                instance_id: 7,
                offset_millipalms: -750,
            }),
            1
        );
        assert_eq!(
            motion.observe(ScrollState::Dragging {
                instance_id: 7,
                offset_millipalms: -1_000,
            }),
            2
        );
        assert_eq!(motion.observe(ScrollState::Idle), 0);
    }

    #[test]
    fn a_coalesced_new_instance_still_uses_its_known_zero_origin() {
        let mut motion = ScrollMotion::default();
        assert_eq!(
            motion.observe(ScrollState::Dragging {
                instance_id: 11,
                offset_millipalms: 500,
            }),
            -3
        );
        assert_eq!(
            motion.observe(ScrollState::Dragging {
                instance_id: 12,
                offset_millipalms: -500,
            }),
            3
        );
    }

    #[test]
    fn sub_line_motion_accumulates_without_jittering() {
        let mut motion = ScrollMotion::default();
        for offset in [50, 100, 150] {
            assert_eq!(
                motion.observe(ScrollState::Dragging {
                    instance_id: 5,
                    offset_millipalms: offset,
                }),
                0
            );
        }
        assert_eq!(
            motion.observe(ScrollState::Dragging {
                instance_id: 5,
                offset_millipalms: 200,
            }),
            -1
        );
    }
}
