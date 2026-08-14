use std::time::Duration;

use font8x8::{UnicodeFonts, BASIC_FONTS};
use gsv_vision_control::{ControlStatus, GestureState};

use crate::observation::{HandObservation, Handedness, Landmark, Observation};

pub const HAND_CONNECTIONS: [(usize, usize); 21] = [
    (0, 1),
    (1, 2),
    (2, 3),
    (3, 4),
    (0, 5),
    (5, 6),
    (6, 7),
    (7, 8),
    (5, 9),
    (9, 10),
    (10, 11),
    (11, 12),
    (9, 13),
    (13, 14),
    (14, 15),
    (15, 16),
    (13, 17),
    (17, 18),
    (18, 19),
    (19, 20),
    (17, 0),
];

const LEFT_COLOR: u32 = 0x45_D8_EB;
const RIGHT_COLOR: u32 = 0xFF_78_B4;
const UNKNOWN_COLOR: u32 = 0xFF_D1_66;
const JOINT_COLOR: u32 = 0xF4_F7_FB;
const PAIR_COLOR: u32 = 0xA7_F3_D0;
const TEXT_COLOR: u32 = 0xF4_F7_FB;
const MUTED_TEXT_COLOR: u32 = 0xAF_B8_C6;
const PANEL_COLOR: u32 = 0x10_13_18;
const WARNING_COLOR: u32 = 0xFF_B4_54;

#[derive(Clone, Debug)]
pub struct PerfText {
    pub camera_running: bool,
    pub camera_frames_per_second: f32,
    pub observation_frames_per_second: f32,
    pub render_frames_per_second: f32,
    pub inference_time: Option<Duration>,
    pub frame_age: Duration,
    pub observation_latency: Option<Duration>,
    pub frame_sequence: u64,
    pub observation_sequence: Option<u64>,
    pub skipped_frames: u64,
    pub slot_replacements: u64,
    pub capture_errors: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ControlOverlay {
    pub status: ControlStatus,
    pub app_held: bool,
}

pub fn draw_overlay(
    pixels: &mut [u32],
    width: usize,
    height: usize,
    observation: Option<&Observation>,
    control: ControlOverlay,
    perf: &PerfText,
    mirror: bool,
) {
    if width == 0 || height == 0 || pixels.len() < width.saturating_mul(height) {
        return;
    }

    if let Some(observation) = observation {
        for hand in &observation.hands {
            draw_hand(pixels, width, height, hand, mirror);
        }
        if observation.hands.len() == 2 {
            draw_pair(
                pixels,
                width,
                height,
                &observation.hands[0],
                &observation.hands[1],
                mirror,
            );
        }
    }

    draw_perf(pixels, width, height, control, perf);
}

fn draw_hand(
    pixels: &mut [u32],
    width: usize,
    height: usize,
    hand: &HandObservation,
    mirror: bool,
) {
    let color = handedness_color(hand.handedness);
    let points = hand
        .landmarks
        .iter()
        .map(|landmark| project_landmark(*landmark, width, height, mirror))
        .collect::<Vec<_>>();

    for (start, end) in HAND_CONNECTIONS {
        if let (Some(start), Some(end)) = (points[start], points[end]) {
            draw_line(pixels, width, height, start, end, color);
        }
    }
    for point in points.iter().flatten() {
        draw_disc(pixels, width, height, *point, 3, JOINT_COLOR);
        draw_disc(pixels, width, height, *point, 1, color);
    }

    let Some((label_x, label_y)) = label_anchor(&points, width, height) else {
        return;
    };
    let label = format!(
        "{} {:.0}%  {} {:.0}%",
        handedness_name(hand.handedness),
        percent(hand.handedness_score),
        display_gesture(&hand.gesture),
        percent(hand.gesture_score),
    );
    draw_text_box(
        pixels,
        width,
        height,
        (label_x, label_y),
        &label,
        color,
        PANEL_COLOR,
    );
}

fn draw_pair(
    pixels: &mut [u32],
    width: usize,
    height: usize,
    first: &HandObservation,
    second: &HandObservation,
    mirror: bool,
) {
    let Some(first_center) = palm_center(first, width, height, mirror) else {
        return;
    };
    let Some(second_center) = palm_center(second, width, height, mirror) else {
        return;
    };
    draw_line(
        pixels,
        width,
        height,
        first_center,
        second_center,
        PAIR_COLOR,
    );

    let dx = first_center.0.abs_diff(second_center.0) as f32;
    let dy = first_center.1.abs_diff(second_center.1) as f32;
    let scale = width.min(height).max(1) as f32;
    let distance = dx.hypot(dy) / scale;
    let pair = format!(
        "PAIR {}:{}  <>  {}:{}  D={distance:.2}",
        handedness_name(first.handedness),
        display_gesture(&first.gesture),
        handedness_name(second.handedness),
        display_gesture(&second.gesture),
    );
    let midpoint = (
        first_center.0.saturating_add(second_center.0) / 2,
        first_center.1.saturating_add(second_center.1) / 2,
    );
    let text_width = text_width(&pair);
    let x = midpoint.0.saturating_sub(text_width / 2);
    let y = midpoint.1.saturating_add(7).min(height.saturating_sub(10));
    draw_text_box(
        pixels,
        width,
        height,
        (x, y),
        &pair,
        PAIR_COLOR,
        PANEL_COLOR,
    );
}

fn draw_perf(
    pixels: &mut [u32],
    width: usize,
    height: usize,
    control: ControlOverlay,
    perf: &PerfText,
) {
    let camera_status = if perf.camera_running {
        "CAMERA RUNNING"
    } else {
        "CAMERA STOPPED"
    };
    let status_color = if perf.camera_running {
        PAIR_COLOR
    } else {
        WARNING_COLOR
    };
    let rates = format!(
        "CAM {:>4.1}  OBS {:>4.1}  DRAW {:>4.1} FPS",
        finite_or_zero(perf.camera_frames_per_second),
        finite_or_zero(perf.observation_frames_per_second),
        finite_or_zero(perf.render_frames_per_second),
    );
    let timings = format!(
        "INFER {:>6}  AGE {:>6}  LAT {:>6}",
        duration_text(perf.inference_time),
        duration_text(Some(perf.frame_age)),
        duration_text(perf.observation_latency),
    );
    let sequences = format!(
        "FRAME {}  OBS {}  SKIP {}  SLOT {}  ERR {}",
        perf.frame_sequence,
        perf.observation_sequence
            .map_or_else(|| "-".to_string(), |sequence| sequence.to_string()),
        perf.skipped_frames,
        perf.slot_replacements,
        perf.capture_errors,
    );
    let (control_status, control_color) = control_status_text(control.status, control.app_held);

    let panel_width = [
        camera_status.len(),
        rates.len(),
        timings.len(),
        sequences.len(),
        control_status.len(),
    ]
    .into_iter()
    .max()
    .unwrap_or_default()
    .saturating_mul(9)
    .saturating_add(8)
    .min(width);
    fill_rect(
        pixels,
        width,
        height,
        (0, 0),
        (panel_width, 53),
        PANEL_COLOR,
    );
    draw_text(pixels, width, height, 4, 3, camera_status, status_color);
    draw_text(pixels, width, height, 4, 13, &rates, TEXT_COLOR);
    draw_text(pixels, width, height, 4, 23, &timings, MUTED_TEXT_COLOR);
    draw_text(pixels, width, height, 4, 33, &sequences, MUTED_TEXT_COLOR);
    draw_text(pixels, width, height, 4, 43, control_status, control_color);
}

fn control_status_text(status: ControlStatus, app_held: bool) -> (&'static str, u32) {
    match (status, app_held) {
        (
            ControlStatus::Active {
                state: GestureState::Holding,
                ..
            },
            false,
        ) => (
            "GESTURES HOLD REQUESTED - SHOW TWO OPEN PALMS TO SYNC",
            WARNING_COLOR,
        ),
        (
            ControlStatus::Active {
                state: GestureState::NeedsReady | GestureState::Ready,
                ..
            },
            true,
        ) => ("GESTURES APP HOLDING - RELEASE REQUESTED", WARNING_COLOR),
        (ControlStatus::Disabled, _) => ("GESTURES DISABLED - START VOICE INPUT", WARNING_COLOR),
        (
            ControlStatus::Active {
                state: GestureState::NeedsReady,
                ..
            },
            false,
        ) => ("GESTURES NEED READY - SHOW TWO OPEN PALMS", WARNING_COLOR),
        (
            ControlStatus::Active {
                state: GestureState::Ready,
                ..
            },
            false,
        ) => (
            "GESTURES READY - PALM+FIST HOLD / PALM+THUMB SEND",
            PAIR_COLOR,
        ),
        (
            ControlStatus::Active {
                state: GestureState::Holding,
                ..
            },
            true,
        ) => (
            "GESTURES HOLDING - SHOW TWO OPEN PALMS TO RELEASE",
            RIGHT_COLOR,
        ),
    }
}

fn duration_text(duration: Option<Duration>) -> String {
    duration.map_or_else(
        || "--.-MS".to_string(),
        |duration| format!("{:>4.1}MS", duration.as_secs_f64() * 1_000.0),
    )
}

fn finite_or_zero(value: f32) -> f32 {
    if value.is_finite() {
        value.max(0.0)
    } else {
        0.0
    }
}

fn percent(score: f32) -> f32 {
    if score.is_finite() {
        score.clamp(0.0, 1.0) * 100.0
    } else {
        0.0
    }
}

fn display_gesture(gesture: &str) -> &str {
    if gesture.is_empty() {
        "None"
    } else {
        gesture
    }
}

fn handedness_name(handedness: Handedness) -> &'static str {
    match handedness {
        Handedness::Left => "L",
        Handedness::Right => "R",
        Handedness::Unknown => "?",
    }
}

fn handedness_color(handedness: Handedness) -> u32 {
    match handedness {
        Handedness::Left => LEFT_COLOR,
        Handedness::Right => RIGHT_COLOR,
        Handedness::Unknown => UNKNOWN_COLOR,
    }
}

fn palm_center(
    hand: &HandObservation,
    width: usize,
    height: usize,
    mirror: bool,
) -> Option<(usize, usize)> {
    const PALM: [usize; 5] = [0, 5, 9, 13, 17];
    let mut x = 0_usize;
    let mut y = 0_usize;
    let mut count = 0_usize;
    for index in PALM {
        if let Some(point) = project_landmark(hand.landmarks[index], width, height, mirror) {
            x = x.saturating_add(point.0);
            y = y.saturating_add(point.1);
            count += 1;
        }
    }
    (count > 0).then_some((x / count.max(1), y / count.max(1)))
}

fn project_landmark(
    landmark: Landmark,
    width: usize,
    height: usize,
    mirror: bool,
) -> Option<(usize, usize)> {
    if width == 0 || height == 0 || !landmark.x.is_finite() || !landmark.y.is_finite() {
        return None;
    }
    let x = if mirror { 1.0 - landmark.x } else { landmark.x };
    let x = (x.clamp(0.0, 1.0) * width.saturating_sub(1) as f32).round() as usize;
    let y = (landmark.y.clamp(0.0, 1.0) * height.saturating_sub(1) as f32).round() as usize;
    Some((x, y))
}

fn label_anchor(
    points: &[Option<(usize, usize)>],
    width: usize,
    height: usize,
) -> Option<(usize, usize)> {
    let min_x = points.iter().flatten().map(|point| point.0).min()?;
    let min_y = points.iter().flatten().map(|point| point.1).min()?;
    Some((
        min_x.min(width.saturating_sub(1)),
        min_y.saturating_sub(11).min(height.saturating_sub(10)),
    ))
}

fn draw_text_box(
    pixels: &mut [u32],
    width: usize,
    height: usize,
    origin: (usize, usize),
    text: &str,
    foreground: u32,
    background: u32,
) {
    let (x, y) = origin;
    let box_width = text_width(text).saturating_add(4).min(width);
    let x = x.min(width.saturating_sub(box_width));
    fill_rect(pixels, width, height, (x, y), (box_width, 10), background);
    draw_text(
        pixels,
        width,
        height,
        x.saturating_add(2),
        y.saturating_add(1),
        text,
        foreground,
    );
}

fn text_width(text: &str) -> usize {
    text.chars().count().saturating_mul(9)
}

fn draw_text(
    pixels: &mut [u32],
    width: usize,
    height: usize,
    mut x: usize,
    y: usize,
    text: &str,
    color: u32,
) {
    for character in text.chars() {
        if x >= width {
            break;
        }
        let glyph = BASIC_FONTS
            .get(character)
            .or_else(|| BASIC_FONTS.get('?'))
            .unwrap_or([0; 8]);
        for (row, bits) in glyph.into_iter().enumerate() {
            let pixel_y = y.saturating_add(row);
            if pixel_y >= height {
                break;
            }
            for column in 0..8 {
                if bits & (1 << column) != 0 {
                    put_pixel(
                        pixels,
                        width,
                        height,
                        x.saturating_add(column),
                        pixel_y,
                        color,
                    );
                }
            }
        }
        x = x.saturating_add(9);
    }
}

fn fill_rect(
    pixels: &mut [u32],
    width: usize,
    height: usize,
    origin: (usize, usize),
    size: (usize, usize),
    color: u32,
) {
    let (x, y) = origin;
    let (rectangle_width, rectangle_height) = size;
    let end_x = x.saturating_add(rectangle_width).min(width);
    let end_y = y.saturating_add(rectangle_height).min(height);
    for pixel_y in y.min(height)..end_y {
        let row = pixel_y.saturating_mul(width);
        for pixel_x in x.min(width)..end_x {
            if let Some(pixel) = pixels.get_mut(row.saturating_add(pixel_x)) {
                *pixel = color;
            }
        }
    }
}

fn put_pixel(pixels: &mut [u32], width: usize, height: usize, x: usize, y: usize, color: u32) {
    if x < width && y < height {
        if let Some(pixel) = pixels.get_mut(y.saturating_mul(width).saturating_add(x)) {
            *pixel = color;
        }
    }
}

fn draw_disc(
    pixels: &mut [u32],
    width: usize,
    height: usize,
    center: (usize, usize),
    radius: isize,
    color: u32,
) {
    let radius_squared = radius.saturating_mul(radius);
    for dy in -radius..=radius {
        for dx in -radius..=radius {
            if dx.saturating_mul(dx).saturating_add(dy.saturating_mul(dy)) > radius_squared {
                continue;
            }
            let Some(x) = center.0.checked_add_signed(dx) else {
                continue;
            };
            let Some(y) = center.1.checked_add_signed(dy) else {
                continue;
            };
            put_pixel(pixels, width, height, x, y, color);
        }
    }
}

fn draw_line(
    pixels: &mut [u32],
    width: usize,
    height: usize,
    start: (usize, usize),
    end: (usize, usize),
    color: u32,
) {
    let (mut x0, mut y0) = (start.0 as isize, start.1 as isize);
    let (x1, y1) = (end.0 as isize, end.1 as isize);
    let dx = (x1 - x0).abs();
    let step_x = if x0 < x1 { 1 } else { -1 };
    let dy = -(y1 - y0).abs();
    let step_y = if y0 < y1 { 1 } else { -1 };
    let mut error = dx + dy;

    loop {
        if let (Ok(x), Ok(y)) = (usize::try_from(x0), usize::try_from(y0)) {
            put_pixel(pixels, width, height, x, y, color);
        }
        if x0 == x1 && y0 == y1 {
            break;
        }
        let twice_error = error.saturating_mul(2);
        if twice_error >= dy {
            error += dy;
            x0 += step_x;
        }
        if twice_error <= dx {
            error += dx;
            y0 += step_y;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use super::*;
    use crate::observation::HandObservation;

    #[test]
    fn all_skeleton_connections_use_valid_landmark_indices() {
        assert!(HAND_CONNECTIONS
            .iter()
            .all(|(start, end)| *start < 21 && *end < 21));
    }

    #[test]
    fn mirrored_projection_flips_only_horizontal_position() {
        let landmark = Landmark {
            x: 0.25,
            y: 0.75,
            z: 0.0,
        };
        assert_eq!(project_landmark(landmark, 101, 101, false), Some((25, 75)));
        assert_eq!(project_landmark(landmark, 101, 101, true), Some((75, 75)));
    }

    #[test]
    fn invalid_landmarks_are_not_projected() {
        assert_eq!(
            project_landmark(
                Landmark {
                    x: f32::NAN,
                    y: 0.5,
                    z: 0.0,
                },
                640,
                480,
                true,
            ),
            None
        );
    }

    #[test]
    fn line_rasterization_includes_both_endpoints() {
        let mut pixels = vec![0; 25];
        draw_line(&mut pixels, 5, 5, (0, 0), (4, 4), 7);
        assert_eq!(pixels[0], 7);
        assert_eq!(pixels[24], 7);
    }

    #[test]
    fn two_hands_draw_a_pair_relationship_between_palms() {
        let hand = |handedness, x, gesture: &str| HandObservation {
            handedness,
            handedness_score: 0.9,
            gesture: gesture.to_string(),
            gesture_score: 0.8,
            landmarks: [Landmark { x, y: 0.6, z: 0.0 }; 21],
        };
        let observed_at = Instant::now();
        let observation = Observation {
            frame_sequence: 4,
            observed_at,
            hands: vec![
                hand(Handedness::Left, 0.25, "Closed_Fist"),
                hand(Handedness::Right, 0.75, "Open_Palm"),
            ],
            inference_time: Duration::from_millis(12),
        };
        let perf = PerfText {
            camera_running: true,
            camera_frames_per_second: 15.0,
            observation_frames_per_second: 15.0,
            render_frames_per_second: 30.0,
            inference_time: Some(Duration::from_millis(12)),
            frame_age: Duration::from_millis(20),
            observation_latency: Some(Duration::from_millis(15)),
            frame_sequence: 4,
            observation_sequence: Some(4),
            skipped_frames: 0,
            slot_replacements: 3,
            capture_errors: 0,
        };
        let mut pixels = vec![0; 101 * 101];

        draw_overlay(
            &mut pixels,
            101,
            101,
            Some(&observation),
            ControlOverlay {
                status: ControlStatus::Active {
                    voice_request_id: 8,
                    state: GestureState::Ready,
                },
                app_held: false,
            },
            &perf,
            false,
        );

        assert_eq!(pixels[60 * 101 + 50], PAIR_COLOR);
    }

    #[test]
    fn semantic_overlay_is_fixed_and_does_not_expose_request_identity() {
        let statuses = [
            (ControlStatus::Disabled, false, "GESTURES DISABLED"),
            (
                ControlStatus::Active {
                    voice_request_id: 7,
                    state: GestureState::NeedsReady,
                },
                false,
                "GESTURES NEED READY",
            ),
            (
                ControlStatus::Active {
                    voice_request_id: 8,
                    state: GestureState::Ready,
                },
                false,
                "GESTURES READY",
            ),
            (
                ControlStatus::Active {
                    voice_request_id: 9,
                    state: GestureState::Holding,
                },
                true,
                "GESTURES HOLDING",
            ),
        ];

        for (status, held, expected_prefix) in statuses {
            let (text, _) = control_status_text(status, held);
            assert!(text.starts_with(expected_prefix));
            assert!(!text.contains('7'));
            assert!(!text.contains('8'));
            assert!(!text.contains('9'));
        }
    }

    #[test]
    fn overlay_never_claims_a_helper_only_hold_is_authoritative() {
        let locally_holding = ControlStatus::Active {
            voice_request_id: 17,
            state: GestureState::Holding,
        };
        assert_eq!(
            control_status_text(locally_holding, false).0,
            "GESTURES HOLD REQUESTED - SHOW TWO OPEN PALMS TO SYNC"
        );
        assert_eq!(
            control_status_text(locally_holding, true).0,
            "GESTURES HOLDING - SHOW TWO OPEN PALMS TO RELEASE"
        );

        let locally_released = ControlStatus::Active {
            voice_request_id: 17,
            state: GestureState::Ready,
        };
        assert_eq!(
            control_status_text(locally_released, true).0,
            "GESTURES APP HOLDING - RELEASE REQUESTED"
        );
    }
}
