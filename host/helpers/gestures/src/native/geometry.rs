use std::cmp::Ordering;
use std::f32::consts::{FRAC_PI_2, PI};

use crate::observation::{FrameView, Landmark, HAND_LANDMARK_COUNT};

const DETECTOR_SIZE: f32 = 192.0;
const SCORE_THRESHOLD: f32 = 0.5;
const NMS_THRESHOLD: f32 = 0.3;
const TRACKING_THRESHOLD: f32 = 0.5;
const DUPLICATE_LANDMARK_DISTANCE_RATIO: f32 = 0.25;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(super) struct Point {
    pub(super) x: f32,
    pub(super) y: f32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(super) struct Rect {
    pub(super) center: Point,
    pub(super) width: f32,
    pub(super) height: f32,
    pub(super) rotation: f32,
}

#[derive(Clone, Debug)]
struct Detection {
    score: f32,
    xmin: f32,
    ymin: f32,
    xmax: f32,
    ymax: f32,
    keypoints: [Point; 7],
}

impl Rect {
    pub(super) fn padded_full_frame(width: u32, height: u32) -> Self {
        let longest = width.max(height) as f32;
        Self {
            center: Point { x: 0.5, y: 0.5 },
            width: longest / width as f32,
            height: longest / height as f32,
            rotation: 0.0,
        }
    }

    fn bounds(self) -> (f32, f32, f32, f32) {
        (
            self.center.x - self.width * 0.5,
            self.center.y - self.height * 0.5,
            self.center.x + self.width * 0.5,
            self.center.y + self.height * 0.5,
        )
    }
}

pub(super) fn sample_rgb(frame: &FrameView, rect: Rect, size: usize) -> Vec<f32> {
    let mut output = vec![0.0; size * size * 3];
    let (x_axis, y_axis) = rect_axes(rect, frame.width, frame.height);
    for output_y in 0..size {
        let local_y = (output_y as f32 + 0.5) / size as f32 - 0.5;
        for output_x in 0..size {
            let local_x = (output_x as f32 + 0.5) / size as f32 - 0.5;
            let source_x = rect.center.x + local_x * x_axis.x + local_y * y_axis.x;
            let source_y = rect.center.y + local_x * x_axis.y + local_y * y_axis.y;
            let pixel_x = source_x * frame.width as f32 - 0.5;
            let pixel_y = source_y * frame.height as f32 - 0.5;
            let destination = (output_y * size + output_x) * 3;
            for channel in 0..3 {
                output[destination + channel] =
                    bilinear_channel(frame, pixel_x, pixel_y, channel) / 255.0;
            }
        }
    }
    output
}

fn bilinear_channel(frame: &FrameView, x: f32, y: f32, channel: usize) -> f32 {
    let left = x.floor() as i32;
    let top = y.floor() as i32;
    let dx = x - left as f32;
    let dy = y - top as f32;
    let top_value = sample_channel(frame, left, top, channel) * (1.0 - dx)
        + sample_channel(frame, left + 1, top, channel) * dx;
    let bottom_value = sample_channel(frame, left, top + 1, channel) * (1.0 - dx)
        + sample_channel(frame, left + 1, top + 1, channel) * dx;
    top_value * (1.0 - dy) + bottom_value * dy
}

fn sample_channel(frame: &FrameView, x: i32, y: i32, channel: usize) -> f32 {
    if x < 0 || y < 0 || x >= frame.width as i32 || y >= frame.height as i32 {
        return 0.0;
    }
    let index = (y as usize * frame.width as usize + x as usize) * 3 + channel;
    frame.rgb[index] as f32
}

pub(super) fn decode_hand_rects(raw_boxes: &[f32], raw_scores: &[f32]) -> Vec<Rect> {
    let anchors = palm_anchors();
    if raw_boxes.len() != anchors.len() * 18 || raw_scores.len() != anchors.len() {
        return Vec::new();
    }
    let mut detections = Vec::new();
    for (index, anchor) in anchors.iter().enumerate() {
        let score = sigmoid(raw_scores[index].clamp(-100.0, 100.0));
        if score < SCORE_THRESHOLD {
            continue;
        }
        let values = &raw_boxes[index * 18..(index + 1) * 18];
        let center_x = values[0] / DETECTOR_SIZE + anchor.x;
        let center_y = values[1] / DETECTOR_SIZE + anchor.y;
        let width = values[2] / DETECTOR_SIZE;
        let height = values[3] / DETECTOR_SIZE;
        if !width.is_finite() || !height.is_finite() || width < 0.0 || height < 0.0 {
            continue;
        }
        let mut keypoints = [Point::default(); 7];
        for (keypoint, output) in keypoints.iter_mut().enumerate() {
            output.x = values[4 + keypoint * 2] / DETECTOR_SIZE + anchor.x;
            output.y = values[5 + keypoint * 2] / DETECTOR_SIZE + anchor.y;
        }
        detections.push(Detection {
            score,
            xmin: center_x - width * 0.5,
            ymin: center_y - height * 0.5,
            xmax: center_x + width * 0.5,
            ymax: center_y + height * 0.5,
            keypoints,
        });
    }
    weighted_nms(detections)
        .into_iter()
        .map(detection_to_rect)
        .collect()
}

fn palm_anchors() -> Vec<Point> {
    let mut anchors = Vec::with_capacity(2016);
    for (stride, anchors_per_cell) in [(8usize, 2usize), (16, 6)] {
        let cells = 192 / stride;
        for y in 0..cells {
            for x in 0..cells {
                let anchor = Point {
                    x: (x as f32 + 0.5) / cells as f32,
                    y: (y as f32 + 0.5) / cells as f32,
                };
                anchors.extend(std::iter::repeat_n(anchor, anchors_per_cell));
            }
        }
    }
    anchors
}

fn weighted_nms(mut detections: Vec<Detection>) -> Vec<Detection> {
    detections.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(Ordering::Equal)
    });
    let mut output = Vec::new();
    while let Some(seed) = detections.first().cloned() {
        let mut candidates = Vec::new();
        let mut remaining = Vec::new();
        for detection in detections {
            if detection_iou(&seed, &detection) > NMS_THRESHOLD {
                candidates.push(detection);
            } else {
                remaining.push(detection);
            }
        }
        if candidates.is_empty() {
            break;
        }
        let total_score = candidates
            .iter()
            .map(|candidate| candidate.score)
            .sum::<f32>();
        let mut weighted = seed;
        weighted.xmin = weighted_value(&candidates, total_score, |value| value.xmin);
        weighted.ymin = weighted_value(&candidates, total_score, |value| value.ymin);
        weighted.xmax = weighted_value(&candidates, total_score, |value| value.xmax);
        weighted.ymax = weighted_value(&candidates, total_score, |value| value.ymax);
        for index in 0..weighted.keypoints.len() {
            weighted.keypoints[index].x =
                weighted_value(&candidates, total_score, |value| value.keypoints[index].x);
            weighted.keypoints[index].y =
                weighted_value(&candidates, total_score, |value| value.keypoints[index].y);
        }
        output.push(weighted);
        detections = remaining;
    }
    output
}

fn weighted_value(
    detections: &[Detection],
    total_score: f32,
    value: impl Fn(&Detection) -> f32,
) -> f32 {
    detections
        .iter()
        .map(|detection| value(detection) * detection.score)
        .sum::<f32>()
        / total_score
}

fn detection_iou(left: &Detection, right: &Detection) -> f32 {
    bounds_iou(
        (left.xmin, left.ymin, left.xmax, left.ymax),
        (right.xmin, right.ymin, right.xmax, right.ymax),
    )
}

fn detection_to_rect(detection: Detection) -> Rect {
    let width = detection.xmax - detection.xmin;
    let height = detection.ymax - detection.ymin;
    let wrist = detection.keypoints[0];
    let middle_finger = detection.keypoints[2];
    let rotation =
        normalize_radians(FRAC_PI_2 + (middle_finger.y - wrist.y).atan2(middle_finger.x - wrist.x));
    transform_rect(
        Rect {
            center: Point {
                x: (detection.xmin + detection.xmax) * 0.5,
                y: (detection.ymin + detection.ymax) * 0.5,
            },
            width,
            height,
            rotation,
        },
        192,
        192,
        2.6,
        -0.5,
    )
}

pub(super) fn map_rect_from_crop(
    rect: Rect,
    crop: Rect,
    frame_width: u32,
    frame_height: u32,
) -> Rect {
    let center = project_point(crop, rect.center, frame_width, frame_height);
    let crop_width_pixels = crop.width * frame_width as f32;
    let crop_height_pixels = crop.height * frame_height as f32;
    Rect {
        center,
        width: rect.width * crop_width_pixels / frame_width as f32,
        height: rect.height * crop_height_pixels / frame_height as f32,
        rotation: normalize_radians(rect.rotation + crop.rotation),
    }
}

pub(super) fn project_landmarks(
    crop_landmarks: &[Landmark; HAND_LANDMARK_COUNT],
    crop: Rect,
    image_width: u32,
    image_height: u32,
) -> [Landmark; HAND_LANDMARK_COUNT] {
    let mut projected = [Landmark::default(); HAND_LANDMARK_COUNT];
    for (input, output) in crop_landmarks.iter().zip(projected.iter_mut()) {
        let point = project_point(
            crop,
            Point {
                x: input.x,
                y: input.y,
            },
            image_width,
            image_height,
        );
        *output = Landmark {
            x: point.x,
            y: point.y,
            z: input.z * crop.width,
        };
    }
    projected
}

pub(super) fn rotate_world_landmarks(
    landmarks: &[Landmark; HAND_LANDMARK_COUNT],
    rotation: f32,
) -> [Landmark; HAND_LANDMARK_COUNT] {
    let cos = rotation.cos();
    let sin = rotation.sin();
    let mut projected = *landmarks;
    for landmark in &mut projected {
        let x = landmark.x;
        let y = landmark.y;
        landmark.x = cos * x - sin * y;
        landmark.y = sin * x + cos * y;
    }
    projected
}

fn project_point(rect: Rect, point: Point, image_width: u32, image_height: u32) -> Point {
    let local_x = point.x - 0.5;
    let local_y = point.y - 0.5;
    let (x_axis, y_axis) = rect_axes(rect, image_width, image_height);
    Point {
        x: rect.center.x + local_x * x_axis.x + local_y * y_axis.x,
        y: rect.center.y + local_x * x_axis.y + local_y * y_axis.y,
    }
}

fn rect_axes(rect: Rect, image_width: u32, image_height: u32) -> (Point, Point) {
    let cos = rect.rotation.cos();
    let sin = rect.rotation.sin();
    let aspect = image_width as f32 / image_height as f32;
    (
        Point {
            x: cos * rect.width,
            y: sin * rect.width * aspect,
        },
        Point {
            x: -sin * rect.height / aspect,
            y: cos * rect.height,
        },
    )
}

pub(super) fn next_hand_rect(
    landmarks: &[Landmark; HAND_LANDMARK_COUNT],
    image_width: u32,
    image_height: u32,
) -> Option<Rect> {
    const PARTIAL: [usize; 12] = [0, 1, 2, 3, 5, 6, 9, 10, 13, 14, 17, 18];
    let points = PARTIAL.map(|index| landmarks[index]);
    let wrist = points[0];
    let middle = points[6];
    let index_and_ring = Landmark {
        x: (points[4].x + points[8].x) * 0.5,
        y: (points[4].y + points[8].y) * 0.5,
        z: 0.0,
    };
    let finger_center = Landmark {
        x: (index_and_ring.x + middle.x) * 0.5,
        y: (index_and_ring.y + middle.y) * 0.5,
        z: 0.0,
    };
    let dx = (finger_center.x - wrist.x) * image_width as f32;
    let dy = (finger_center.y - wrist.y) * image_height as f32;
    let rotation = normalize_radians(FRAC_PI_2 + dy.atan2(dx));

    let (axis_min_x, axis_max_x, axis_min_y, axis_max_y) = landmark_bounds(&points)?;
    let axis_center_x = (axis_min_x + axis_max_x) * 0.5;
    let axis_center_y = (axis_min_y + axis_max_y) * 0.5;
    let reverse = -rotation;
    let reverse_cos = reverse.cos();
    let reverse_sin = reverse.sin();
    let mut min_x = f32::MAX;
    let mut min_y = f32::MAX;
    let mut max_x = f32::MIN_POSITIVE;
    let mut max_y = f32::MIN_POSITIVE;
    for landmark in points {
        let x = (landmark.x - axis_center_x) * image_width as f32;
        let y = (landmark.y - axis_center_y) * image_height as f32;
        let projected_x = x * reverse_cos - y * reverse_sin;
        let projected_y = x * reverse_sin + y * reverse_cos;
        min_x = min_x.min(projected_x);
        max_x = max_x.max(projected_x);
        min_y = min_y.min(projected_y);
        max_y = max_y.max(projected_y);
    }
    let projected_center_x = (min_x + max_x) * 0.5;
    let projected_center_y = (min_y + max_y) * 0.5;
    let cos = rotation.cos();
    let sin = rotation.sin();
    let center_x =
        projected_center_x * cos - projected_center_y * sin + image_width as f32 * axis_center_x;
    let center_y =
        projected_center_x * sin + projected_center_y * cos + image_height as f32 * axis_center_y;
    Some(transform_rect(
        Rect {
            center: Point {
                x: center_x / image_width as f32,
                y: center_y / image_height as f32,
            },
            width: (max_x - min_x) / image_width as f32,
            height: (max_y - min_y) / image_height as f32,
            rotation,
        },
        image_width,
        image_height,
        2.0,
        -0.1,
    ))
}

pub(super) fn same_projected_hand(
    left: &[Landmark; HAND_LANDMARK_COUNT],
    right: &[Landmark; HAND_LANDMARK_COUNT],
) -> bool {
    let Some(scale) = hand_extent(left)
        .zip(hand_extent(right))
        .map(|(left, right)| left.min(right))
    else {
        return false;
    };
    let mean_squared_distance = left
        .iter()
        .zip(right)
        .map(|(left, right)| {
            let dx = left.x - right.x;
            let dy = left.y - right.y;
            dx * dx + dy * dy
        })
        .sum::<f32>()
        / HAND_LANDMARK_COUNT as f32;
    mean_squared_distance.is_finite()
        && mean_squared_distance.sqrt() <= scale * DUPLICATE_LANDMARK_DISTANCE_RATIO
}

fn hand_extent(landmarks: &[Landmark; HAND_LANDMARK_COUNT]) -> Option<f32> {
    let mut min_x = f32::INFINITY;
    let mut min_y = f32::INFINITY;
    let mut max_x = f32::NEG_INFINITY;
    let mut max_y = f32::NEG_INFINITY;
    for landmark in landmarks {
        if !landmark.x.is_finite() || !landmark.y.is_finite() {
            return None;
        }
        min_x = min_x.min(landmark.x);
        min_y = min_y.min(landmark.y);
        max_x = max_x.max(landmark.x);
        max_y = max_y.max(landmark.y);
    }
    let extent = (max_x - min_x).hypot(max_y - min_y);
    (extent > f32::EPSILON && extent.is_finite()).then_some(extent)
}

fn landmark_bounds(landmarks: &[Landmark]) -> Option<(f32, f32, f32, f32)> {
    let mut min_x = f32::MAX;
    let mut min_y = f32::MAX;
    let mut max_x = f32::MIN_POSITIVE;
    let mut max_y = f32::MIN_POSITIVE;
    for landmark in landmarks {
        if !landmark.x.is_finite() || !landmark.y.is_finite() {
            return None;
        }
        min_x = min_x.min(landmark.x);
        max_x = max_x.max(landmark.x);
        min_y = min_y.min(landmark.y);
        max_y = max_y.max(landmark.y);
    }
    Some((min_x, max_x, min_y, max_y))
}

fn transform_rect(
    mut rect: Rect,
    image_width: u32,
    image_height: u32,
    scale: f32,
    shift_y: f32,
) -> Rect {
    let width_pixels = rect.width * image_width as f32;
    let height_pixels = rect.height * image_height as f32;
    let sin = rect.rotation.sin();
    let cos = rect.rotation.cos();
    rect.center.x += (-height_pixels * shift_y * sin) / image_width as f32;
    rect.center.y += (height_pixels * shift_y * cos) / image_height as f32;
    let longest = width_pixels.max(height_pixels);
    rect.width = longest / image_width as f32 * scale;
    rect.height = longest / image_height as f32 * scale;
    rect
}

pub(super) fn overlaps_tracked(rect: Rect, tracked: &[Rect]) -> bool {
    tracked
        .iter()
        .any(|existing| bounds_iou(rect.bounds(), existing.bounds()) > TRACKING_THRESHOLD)
}

fn bounds_iou(left: (f32, f32, f32, f32), right: (f32, f32, f32, f32)) -> f32 {
    let intersection_width = (left.2.min(right.2) - left.0.max(right.0)).max(0.0);
    let intersection_height = (left.3.min(right.3) - left.1.max(right.1)).max(0.0);
    let intersection = intersection_width * intersection_height;
    let left_area = (left.2 - left.0).max(0.0) * (left.3 - left.1).max(0.0);
    let right_area = (right.2 - right.0).max(0.0) * (right.3 - right.1).max(0.0);
    let union = left_area + right_area - intersection;
    if union > 0.0 {
        intersection / union
    } else {
        0.0
    }
}

fn sigmoid(value: f32) -> f32 {
    1.0 / (1.0 + (-value).exp())
}

fn normalize_radians(angle: f32) -> f32 {
    angle - 2.0 * PI * ((angle + PI) / (2.0 * PI)).floor()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Instant;

    use super::*;

    #[test]
    fn palm_anchor_layout_matches_the_model() {
        let anchors = palm_anchors();
        assert_eq!(anchors.len(), 2016);
        assert_eq!(
            anchors[0],
            Point {
                x: 1.0 / 48.0,
                y: 1.0 / 48.0
            }
        );
        assert_eq!(anchors[1], anchors[0]);
        assert_eq!(
            anchors[1152],
            Point {
                x: 1.0 / 24.0,
                y: 1.0 / 24.0
            }
        );
    }

    #[test]
    fn full_frame_sampling_letterboxes_without_stretching() {
        let frame = FrameView {
            sequence: 1,
            captured_at: Instant::now(),
            width: 2,
            height: 1,
            rgb: Arc::from([255, 0, 0, 0, 255, 0]),
        };
        let sampled = sample_rgb(&frame, Rect::padded_full_frame(2, 1), 4);
        assert!(sampled[0] < sampled[12]);
        assert!(sampled[12] > 0.5);
        assert!(sampled[36] < sampled[24]);
    }

    #[test]
    fn weighted_nms_preserves_the_highest_score_and_averages_geometry() {
        let detection = |score, xmin| Detection {
            score,
            xmin,
            ymin: 0.0,
            xmax: xmin + 1.0,
            ymax: 1.0,
            keypoints: [Point { x: xmin, y: 0.5 }; 7],
        };
        let output = weighted_nms(vec![detection(0.8, 0.0), detection(0.4, 0.2)]);
        assert_eq!(output.len(), 1);
        assert!((output[0].score - 0.8).abs() < f32::EPSILON);
        assert!((output[0].xmin - (0.4 * 0.2 / 1.2)).abs() < 1e-6);
    }

    #[test]
    fn decoder_retains_candidates_until_track_association() {
        let anchors = palm_anchors();
        let mut boxes = vec![0.0; anchors.len() * 18];
        let mut scores = vec![-100.0; anchors.len()];
        for (index, target_x) in [(0, 0.1_f32), (900, 0.5), (1_800, 0.9)] {
            scores[index] = 10.0;
            let values = &mut boxes[index * 18..(index + 1) * 18];
            values[0] = (target_x - anchors[index].x) * DETECTOR_SIZE;
            values[1] = (0.5 - anchors[index].y) * DETECTOR_SIZE;
            values[2] = 0.05 * DETECTOR_SIZE;
            values[3] = 0.05 * DETECTOR_SIZE;
            for keypoint in 0..7 {
                values[4 + keypoint * 2] = values[0];
                values[5 + keypoint * 2] = values[1];
            }
        }

        assert_eq!(decode_hand_rects(&boxes, &scores).len(), 3);
    }

    #[test]
    fn projected_landmarks_deduplicate_one_physical_hand() {
        let mut original = [Landmark::default(); HAND_LANDMARK_COUNT];
        for (index, landmark) in original.iter_mut().enumerate() {
            landmark.x = 0.2 + (index % 5) as f32 * 0.03;
            landmark.y = 0.3 + (index / 5) as f32 * 0.04;
        }
        let mut duplicate = original;
        for landmark in &mut duplicate {
            landmark.x += 0.005;
            landmark.y -= 0.005;
        }
        let mut other = original;
        for landmark in &mut other {
            landmark.x += 0.3;
        }

        assert!(same_projected_hand(&original, &duplicate));
        assert!(!same_projected_hand(&original, &other));
    }

    #[test]
    fn projected_crop_center_stays_at_rect_center() {
        let rect = Rect {
            center: Point { x: 0.2, y: 0.7 },
            width: 0.4,
            height: 0.3,
            rotation: 0.8,
        };
        assert_eq!(
            project_point(rect, Point { x: 0.5, y: 0.5 }, 16, 9),
            rect.center
        );
    }

    #[test]
    fn rotated_projection_uses_image_space_aspect_ratio() {
        let rect = Rect {
            center: Point { x: 0.5, y: 0.5 },
            width: 0.5,
            height: 1.0,
            rotation: FRAC_PI_2,
        };
        let projected = project_point(rect, Point { x: 1.0, y: 0.5 }, 200, 100);

        assert!((projected.x - 0.5).abs() < 1e-6);
        assert!((projected.y - 1.0).abs() < 1e-6);
    }

    #[test]
    fn tracked_overlap_ignores_rotation_like_the_reference_pipeline() {
        let base = Rect {
            center: Point { x: 0.5, y: 0.5 },
            width: 0.4,
            height: 0.4,
            rotation: 0.0,
        };
        let rotated = Rect {
            rotation: 1.2,
            ..base
        };
        assert!(overlaps_tracked(rotated, &[base]));
    }
}
