use std::time::Duration;

use font8x8::{UnicodeFonts, BASIC_FONTS};
use gesture_protocol::{ControlStatus, GestureCandidate, GestureProgress};

use crate::control::{ControlChord, ControlDiagnostic};
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
const PROGRESS_TRACK_COLOR: u32 = 0x3E_47_55;
const PROGRESS_RADIUS: isize = 24;
const PROGRESS_MARGIN: usize = 12;

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
    pub diagnostic: ControlPresentationDiagnostic,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ControlPresentationDiagnostic {
    Controller(ControlDiagnostic),
    AwaitingFreshObservation,
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
    draw_gesture_progress(pixels, width, height, status_progress(control.status));
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
    let label = hand_label(hand);
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

fn hand_label(hand: &HandObservation) -> String {
    format!(
        "{} {:.1}%  {} {:.1}%",
        handedness_name(hand.handedness),
        percent(hand.handedness_score),
        hand.pose.label(),
        percent(hand.pose_score),
    )
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
        first.pose.label(),
        handedness_name(second.handedness),
        second.pose.label(),
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
    let (control_status, control_color) = control_status_text(control.status);
    let (control_diagnostic, diagnostic_color) =
        control_diagnostic_text(control.status, control.diagnostic);

    let panel_width = [
        camera_status.len(),
        rates.len(),
        timings.len(),
        sequences.len(),
        control_status.len(),
        control_diagnostic.len(),
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
        (panel_width, 63),
        PANEL_COLOR,
    );
    draw_text(pixels, width, height, 4, 3, camera_status, status_color);
    draw_text(pixels, width, height, 4, 13, &rates, TEXT_COLOR);
    draw_text(pixels, width, height, 4, 23, &timings, MUTED_TEXT_COLOR);
    draw_text(pixels, width, height, 4, 33, &sequences, MUTED_TEXT_COLOR);
    draw_text(pixels, width, height, 4, 43, control_status, control_color);
    draw_text(
        pixels,
        width,
        height,
        4,
        53,
        &control_diagnostic,
        diagnostic_color,
    );
}

fn control_status_text(status: ControlStatus) -> (&'static str, u32) {
    match status {
        ControlStatus::Disabled => ("GESTURES DISABLED", WARNING_COLOR),
        ControlStatus::Standby { .. } => (
            "GESTURES STANDBY - TWO OPEN PALMS START TRANSCRIPTION",
            PAIR_COLOR,
        ),
        ControlStatus::Active { muted: false, .. } => (
            "TRANSCRIBING - VICTORY STOP / THUMB UP SEND / DOWN MUTE",
            PAIR_COLOR,
        ),
        ControlStatus::Active { muted: true, .. } => (
            "TRANSCRIBING + MUTED - POINTING UP UNMUTE / VICTORY STOP",
            RIGHT_COLOR,
        ),
    }
}

fn control_diagnostic_text(
    status: ControlStatus,
    diagnostic: ControlPresentationDiagnostic,
) -> (String, u32) {
    if status == ControlStatus::Disabled {
        return ("CONTROL INACTIVE".to_string(), MUTED_TEXT_COLOR);
    }

    let ControlPresentationDiagnostic::Controller(diagnostic) = diagnostic else {
        return (
            "CONTROL WAITING FOR FRESH OBSERVATION".to_string(),
            WARNING_COLOR,
        );
    };
    match diagnostic {
        ControlDiagnostic::AwaitingPose => {
            ("CONTROL WAITING FOR POSE".to_string(), MUTED_TEXT_COLOR)
        }
        ControlDiagnostic::NeedTwoHands { detected } => (
            format!("CONTROL NEEDS 2 HANDS - DETECTED {}", detected.min(2)),
            WARNING_COLOR,
        ),
        ControlDiagnostic::UnsupportedPose => (
            "CONTROL UNSUPPORTED TWO-HAND POSE".to_string(),
            WARNING_COLOR,
        ),
        ControlDiagnostic::UnexpectedPose { chord } => (
            format!("CONTROL {} NOT VALID IN THIS STATE", chord_text(chord)),
            WARNING_COLOR,
        ),
        ControlDiagnostic::AlreadySatisfied { chord } => (
            format!("CONTROL {} ALREADY SATISFIED", chord_text(chord)),
            MUTED_TEXT_COLOR,
        ),
        ControlDiagnostic::AwaitingAuthority { chord } => (
            format!("CONTROL {} WAITING FOR APP", chord_text(chord)),
            WARNING_COLOR,
        ),
        ControlDiagnostic::AwaitingRelease { chord } => (
            format!("CONTROL RELEASE {} POSE TO REARM", chord_text(chord)),
            WARNING_COLOR,
        ),
        ControlDiagnostic::InvalidScore => {
            ("CONTROL INVALID CONFIDENCE".to_string(), WARNING_COLOR)
        }
        ControlDiagnostic::InvalidOrder => {
            ("CONTROL FRAME ORDER REJECTED".to_string(), WARNING_COLOR)
        }
        ControlDiagnostic::FrameTooOld { age_ms } => {
            (format!("CONTROL FRAME TOO OLD {age_ms}MS"), WARNING_COLOR)
        }
        ControlDiagnostic::SampleGap { gap_ms } => (
            format!("CONTROL SAMPLE GAP {gap_ms}MS - RESTARTING"),
            WARNING_COLOR,
        ),
        ControlDiagnostic::EvidenceGap { gap_ms } => (
            format!("CONTROL EVIDENCE GAP {gap_ms}MS - RESTARTING"),
            WARNING_COLOR,
        ),
        ControlDiagnostic::LowConfidence {
            chord,
            observed_percent,
            required_percent,
        } => (
            format!(
                "CONTROL {} {}% - NEED {}%",
                chord_text(chord),
                observed_percent.min(100),
                required_percent.min(100),
            ),
            WARNING_COLOR,
        ),
        ControlDiagnostic::Stabilizing {
            chord,
            confidence_percent,
            progress_percent,
        } => (
            format!(
                "CONTROL {} {}% - EVIDENCE {}%",
                chord_text(chord),
                confidence_percent.min(100),
                progress_percent.min(100),
            ),
            PAIR_COLOR,
        ),
        ControlDiagnostic::Cooldown { remaining_ms } => {
            (format!("CONTROL COOLDOWN {remaining_ms}MS"), WARNING_COLOR)
        }
        ControlDiagnostic::Accepted { chord } => (
            format!("CONTROL {} ACCEPTED", chord_text(chord)),
            PAIR_COLOR,
        ),
    }
}

fn chord_text(chord: ControlChord) -> &'static str {
    match chord {
        ControlChord::StartTranscription => "START",
        ControlChord::StopTranscription => "STOP",
        ControlChord::Send => "SEND",
        ControlChord::Mute => "MUTE",
        ControlChord::Unmute => "UNMUTE",
    }
}

fn status_progress(status: ControlStatus) -> Option<GestureProgress> {
    match status {
        ControlStatus::Disabled => None,
        ControlStatus::Standby { progress } | ControlStatus::Active { progress, .. } => progress,
    }
}

fn draw_gesture_progress(
    pixels: &mut [u32],
    width: usize,
    height: usize,
    progress: Option<GestureProgress>,
) {
    let Some(progress) = progress else {
        return;
    };
    let Ok(radius) = usize::try_from(PROGRESS_RADIUS) else {
        return;
    };
    let diameter = radius.saturating_mul(2).saturating_add(1);
    let indicator_height = diameter.saturating_add(14);
    if width < diameter.saturating_add(PROGRESS_MARGIN.saturating_mul(2))
        || height < indicator_height.saturating_add(PROGRESS_MARGIN)
    {
        return;
    }

    let (_, color) = candidate_style(progress.candidate());
    let center = (
        width.saturating_sub(PROGRESS_MARGIN).saturating_sub(radius),
        PROGRESS_MARGIN.saturating_add(radius),
    );
    draw_clockwise_disk(
        pixels,
        width,
        height,
        ClockwiseDisk {
            center,
            radius: PROGRESS_RADIUS,
            progress_permille: progress.progress_permille(),
            progress_color: color,
            track_color: PROGRESS_TRACK_COLOR,
        },
    );

    let label = progress_label(progress);
    let label_width = text_width(&label).saturating_add(4).min(width);
    let label_x = width
        .saturating_sub(PROGRESS_MARGIN)
        .saturating_sub(label_width);
    let label_y = center
        .1
        .saturating_add(radius)
        .saturating_add(4)
        .min(height.saturating_sub(10));
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

fn candidate_style(candidate: GestureCandidate) -> (&'static str, u32) {
    match candidate {
        GestureCandidate::StartTranscription => ("START", PAIR_COLOR),
        GestureCandidate::StopTranscription => ("STOP", LEFT_COLOR),
        GestureCandidate::Send => ("SEND", WARNING_COLOR),
        GestureCandidate::Mute => ("MUTE", RIGHT_COLOR),
        GestureCandidate::Unmute => ("UNMUTE", PAIR_COLOR),
    }
}

fn progress_label(progress: GestureProgress) -> String {
    let (candidate, _) = candidate_style(progress.candidate());
    let permille = progress.progress_permille();
    format!("EVIDENCE {candidate} {}.{}%", permille / 10, permille % 10,)
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ClockwiseDisk {
    center: (usize, usize),
    radius: isize,
    progress_permille: u16,
    progress_color: u32,
    track_color: u32,
}

fn draw_clockwise_disk(pixels: &mut [u32], width: usize, height: usize, disk: ClockwiseDisk) {
    if disk.radius <= 0 {
        return;
    }
    let radius_squared = disk.radius.saturating_mul(disk.radius);
    let progress_permille = disk.progress_permille.min(1_000);

    for dy in -disk.radius..=disk.radius {
        for dx in -disk.radius..=disk.radius {
            let distance_squared = dx.saturating_mul(dx).saturating_add(dy.saturating_mul(dy));
            if distance_squared > radius_squared {
                continue;
            }
            let active = progress_permille == 1_000
                || progress_permille > 0
                    && ((dx == 0 && dy == 0)
                        || clockwise_position_permille(dx, dy) < progress_permille);
            let Some(x) = disk.center.0.checked_add_signed(dx) else {
                continue;
            };
            let Some(y) = disk.center.1.checked_add_signed(dy) else {
                continue;
            };
            put_pixel(
                pixels,
                width,
                height,
                x,
                y,
                if active {
                    disk.progress_color
                } else {
                    disk.track_color
                },
            );
        }
    }
}

fn clockwise_position_permille(dx: isize, dy: isize) -> u16 {
    let mut angle = (dx as f64).atan2(-(dy as f64));
    if angle < 0.0 {
        angle += std::f64::consts::TAU;
    }
    ((angle / std::f64::consts::TAU * 1_000.0).floor() as u16).min(999)
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
    use crate::observation::{HandObservation, HandPose};

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
    fn clockwise_disk_starts_at_twelve_and_advances_rightward() {
        const SIZE: usize = 25;
        const CENTER: usize = 12;
        const RADIUS: usize = 8;
        const ACTIVE: u32 = 7;
        const TRACK: u32 = 3;
        let pixel = |pixels: &[u32], x, y| pixels[y * SIZE + x];

        let mut quarter = vec![0; SIZE * SIZE];
        draw_clockwise_disk(
            &mut quarter,
            SIZE,
            SIZE,
            ClockwiseDisk {
                center: (CENTER, CENTER),
                radius: RADIUS as isize,
                progress_permille: 250,
                progress_color: ACTIVE,
                track_color: TRACK,
            },
        );
        assert_eq!(pixel(&quarter, CENTER, CENTER - RADIUS), ACTIVE);
        assert_eq!(pixel(&quarter, CENTER + RADIUS, CENTER), TRACK);
        assert_eq!(pixel(&quarter, CENTER, CENTER + RADIUS), TRACK);
        assert_eq!(pixel(&quarter, CENTER - RADIUS, CENTER), TRACK);
        assert_eq!(pixel(&quarter, CENTER, CENTER), ACTIVE);

        let mut three_quarters = vec![0; SIZE * SIZE];
        draw_clockwise_disk(
            &mut three_quarters,
            SIZE,
            SIZE,
            ClockwiseDisk {
                center: (CENTER, CENTER),
                radius: RADIUS as isize,
                progress_permille: 750,
                progress_color: ACTIVE,
                track_color: TRACK,
            },
        );
        assert_eq!(pixel(&three_quarters, CENTER, CENTER - RADIUS), ACTIVE);
        assert_eq!(pixel(&three_quarters, CENTER + RADIUS, CENTER), ACTIVE);
        assert_eq!(pixel(&three_quarters, CENTER, CENTER + RADIUS), ACTIVE);
        assert_eq!(pixel(&three_quarters, CENTER - RADIUS, CENTER), TRACK);
    }

    #[test]
    fn clockwise_disk_has_exact_empty_and_complete_states() {
        const SIZE: usize = 25;
        let mut empty = vec![0; SIZE * SIZE];
        draw_clockwise_disk(
            &mut empty,
            SIZE,
            SIZE,
            ClockwiseDisk {
                center: (12, 12),
                radius: 8,
                progress_permille: 0,
                progress_color: 7,
                track_color: 3,
            },
        );
        assert!(!empty.contains(&7));
        assert!(empty.contains(&3));

        let mut complete = vec![0; SIZE * SIZE];
        draw_clockwise_disk(
            &mut complete,
            SIZE,
            SIZE,
            ClockwiseDisk {
                center: (12, 12),
                radius: 8,
                progress_permille: 1_000,
                progress_color: 7,
                track_color: 3,
            },
        );
        assert!(complete.contains(&7));
        assert!(!complete.contains(&3));
    }

    #[test]
    fn progress_indicator_disappears_with_the_candidate() {
        const WIDTH: usize = 200;
        const HEIGHT: usize = 100;
        let mut pixels = vec![0; WIDTH * HEIGHT];

        draw_gesture_progress(&mut pixels, WIDTH, HEIGHT, None);

        assert!(pixels.iter().all(|pixel| *pixel == 0));
    }

    #[test]
    fn progress_indicator_uses_normalized_status_progress_clockwise() {
        const WIDTH: usize = 200;
        const HEIGHT: usize = 100;
        let center = (
            WIDTH - PROGRESS_MARGIN - PROGRESS_RADIUS as usize,
            PROGRESS_MARGIN + PROGRESS_RADIUS as usize,
        );
        let mut pixels = vec![0; WIDTH * HEIGHT];
        let progress = GestureProgress::new(GestureCandidate::StartTranscription, 250)
            .expect("bounded progress");

        draw_gesture_progress(&mut pixels, WIDTH, HEIGHT, Some(progress));

        let radius = PROGRESS_RADIUS as usize;
        assert_eq!(pixels[(center.1 - radius) * WIDTH + center.0], PAIR_COLOR);
        assert_eq!(
            pixels[center.1 * WIDTH + center.0 + radius],
            PROGRESS_TRACK_COLOR
        );
    }

    #[test]
    fn progress_candidate_labels_and_colors_are_closed() {
        let cases = [
            (GestureCandidate::StartTranscription, "START", PAIR_COLOR),
            (GestureCandidate::StopTranscription, "STOP", LEFT_COLOR),
            (GestureCandidate::Send, "SEND", WARNING_COLOR),
            (GestureCandidate::Mute, "MUTE", RIGHT_COLOR),
            (GestureCandidate::Unmute, "UNMUTE", PAIR_COLOR),
        ];

        for (candidate, expected_label, expected_color) in cases {
            assert_eq!(candidate_style(candidate), (expected_label, expected_color));
            let progress = GestureProgress::new(candidate, 427).expect("bounded progress");
            assert_eq!(
                progress_label(progress),
                format!("EVIDENCE {expected_label} 42.7%")
            );
        }
    }

    #[test]
    fn progress_indicator_reads_only_the_bounded_status_snapshot() {
        let progress = GestureProgress::new(GestureCandidate::Send, 640).expect("bounded progress");
        assert_eq!(status_progress(ControlStatus::Disabled), None);
        assert_eq!(
            status_progress(ControlStatus::Standby {
                progress: Some(progress),
            }),
            Some(progress)
        );
        assert_eq!(
            status_progress(ControlStatus::Active {
                voice_request_id: 99,
                muted: false,
                progress: None,
            }),
            None
        );
        assert_eq!(
            status_progress(ControlStatus::Active {
                voice_request_id: 99,
                muted: false,
                progress: Some(progress),
            }),
            Some(progress)
        );
    }

    #[test]
    fn two_hands_draw_a_pair_relationship_between_palms() {
        let hand = |handedness, x, pose| HandObservation {
            handedness,
            handedness_score: 0.9,
            pose,
            pose_score: 0.8,
            landmarks: [Landmark { x, y: 0.7, z: 0.0 }; 21],
        };
        let observed_at = Instant::now();
        let observation = Observation {
            frame_sequence: 4,
            observed_at,
            hands: vec![
                hand(Handedness::Left, 0.25, HandPose::Anchor),
                hand(Handedness::Right, 0.75, HandPose::SoftFist),
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
                    muted: false,
                    progress: None,
                },
                diagnostic: ControlPresentationDiagnostic::Controller(
                    ControlDiagnostic::Stabilizing {
                        chord: ControlChord::Mute,
                        confidence_percent: 82,
                        progress_percent: 40,
                    },
                ),
            },
            &perf,
            false,
        );

        assert_eq!(pixels[70 * 101 + 50], PAIR_COLOR);
    }

    #[test]
    fn semantic_overlay_uses_transcription_lifetime_vocabulary_without_request_identity() {
        let statuses = [
            (ControlStatus::Disabled, "GESTURES DISABLED"),
            (
                ControlStatus::Standby { progress: None },
                "GESTURES STANDBY",
            ),
            (
                ControlStatus::Active {
                    voice_request_id: 8,
                    muted: false,
                    progress: None,
                },
                "TRANSCRIBING",
            ),
            (
                ControlStatus::Active {
                    voice_request_id: 9,
                    muted: true,
                    progress: None,
                },
                "TRANSCRIBING + MUTED",
            ),
        ];

        for (status, expected_prefix) in statuses {
            let (text, _) = control_status_text(status);
            assert!(text.starts_with(expected_prefix));
            assert!(!text.contains('7'));
            assert!(!text.contains('8'));
            assert!(!text.contains('9'));
            assert!(!text.contains("READY"));
            assert!(!text.contains("HOLD"));
        }
    }

    #[test]
    fn hand_label_keeps_confidence_boundary_visible() {
        let hand = HandObservation {
            handedness: Handedness::Left,
            handedness_score: 0.912,
            pose: HandPose::Anchor,
            pose_score: 0.795,
            landmarks: [Landmark::default(); 21],
        };

        assert_eq!(hand_label(&hand), "L 91.2%  Anchor 79.5%");
    }

    #[test]
    fn controller_diagnostics_use_fixed_local_vocabulary() {
        let active = ControlStatus::Active {
            voice_request_id: 987_654_321,
            muted: false,
            progress: None,
        };
        let cases = [
            (ControlDiagnostic::AwaitingPose, "CONTROL WAITING FOR POSE"),
            (
                ControlDiagnostic::NeedTwoHands { detected: 1 },
                "CONTROL NEEDS 2 HANDS - DETECTED 1",
            ),
            (
                ControlDiagnostic::UnsupportedPose,
                "CONTROL UNSUPPORTED TWO-HAND POSE",
            ),
            (
                ControlDiagnostic::UnexpectedPose {
                    chord: ControlChord::Mute,
                },
                "CONTROL MUTE NOT VALID IN THIS STATE",
            ),
            (
                ControlDiagnostic::AlreadySatisfied {
                    chord: ControlChord::StartTranscription,
                },
                "CONTROL START ALREADY SATISFIED",
            ),
            (
                ControlDiagnostic::AwaitingAuthority {
                    chord: ControlChord::StopTranscription,
                },
                "CONTROL STOP WAITING FOR APP",
            ),
            (
                ControlDiagnostic::AwaitingRelease {
                    chord: ControlChord::StartTranscription,
                },
                "CONTROL RELEASE START POSE TO REARM",
            ),
            (
                ControlDiagnostic::InvalidScore,
                "CONTROL INVALID CONFIDENCE",
            ),
            (
                ControlDiagnostic::InvalidOrder,
                "CONTROL FRAME ORDER REJECTED",
            ),
            (
                ControlDiagnostic::FrameTooOld { age_ms: 251 },
                "CONTROL FRAME TOO OLD 251MS",
            ),
            (
                ControlDiagnostic::SampleGap { gap_ms: 251 },
                "CONTROL SAMPLE GAP 251MS - RESTARTING",
            ),
            (
                ControlDiagnostic::EvidenceGap { gap_ms: 181 },
                "CONTROL EVIDENCE GAP 181MS - RESTARTING",
            ),
            (
                ControlDiagnostic::LowConfidence {
                    chord: ControlChord::StartTranscription,
                    observed_percent: 49,
                    required_percent: 50,
                },
                "CONTROL START 49% - NEED 50%",
            ),
            (
                ControlDiagnostic::Stabilizing {
                    chord: ControlChord::Send,
                    confidence_percent: 84,
                    progress_percent: 57,
                },
                "CONTROL SEND 84% - EVIDENCE 57%",
            ),
            (
                ControlDiagnostic::Cooldown { remaining_ms: 412 },
                "CONTROL COOLDOWN 412MS",
            ),
            (
                ControlDiagnostic::Accepted {
                    chord: ControlChord::Unmute,
                },
                "CONTROL UNMUTE ACCEPTED",
            ),
        ];

        for (diagnostic, expected) in cases {
            let (text, _) = control_diagnostic_text(
                active,
                ControlPresentationDiagnostic::Controller(diagnostic),
            );
            assert_eq!(text, expected);
            assert!(!text.contains("987654321"));
        }

        assert_eq!(
            control_diagnostic_text(
                ControlStatus::Disabled,
                ControlPresentationDiagnostic::Controller(ControlDiagnostic::InvalidScore),
            )
            .0,
            "CONTROL INACTIVE"
        );
        assert_eq!(
            control_diagnostic_text(
                active,
                ControlPresentationDiagnostic::Controller(ControlDiagnostic::LowConfidence {
                    chord: ControlChord::StartTranscription,
                    observed_percent: u8::MAX,
                    required_percent: u8::MAX,
                }),
            )
            .0,
            "CONTROL START 100% - NEED 100%"
        );
        assert_eq!(
            control_diagnostic_text(
                active,
                ControlPresentationDiagnostic::AwaitingFreshObservation,
            )
            .0,
            "CONTROL WAITING FOR FRESH OBSERVATION"
        );
    }
}
