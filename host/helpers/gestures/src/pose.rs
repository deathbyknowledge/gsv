//! Authored, camera-local hand posture recognition.
//!
//! The native landmark model supplies 21 world-space joints. This module turns
//! that private geometry into GSV's small typed posture vocabulary using only
//! palm-normalized distances and joint angles. It owns no temporal action or
//! application semantics.

use crate::observation::{HandPose, Landmark, HAND_LANDMARK_COUNT};

const WRIST: usize = 0;
const THUMB_TIP: usize = 4;
const INDEX_MCP: usize = 5;
const INDEX_PIP: usize = 6;
const INDEX_DIP: usize = 7;
const INDEX_TIP: usize = 8;
const MIDDLE_MCP: usize = 9;
const MIDDLE_PIP: usize = 10;
const MIDDLE_DIP: usize = 11;
const MIDDLE_TIP: usize = 12;
const RING_MCP: usize = 13;
const RING_PIP: usize = 14;
const RING_DIP: usize = 15;
const RING_TIP: usize = 16;
const PINKY_MCP: usize = 17;
const PINKY_PIP: usize = 18;
const PINKY_DIP: usize = 19;
const PINKY_TIP: usize = 20;

const MIN_POSE_SCORE: f32 = 0.46;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PoseRecognition {
    pub pose: HandPose,
    pub score: f32,
}

#[must_use]
pub fn recognize(landmarks: &[Landmark; HAND_LANDMARK_COUNT]) -> PoseRecognition {
    let Some(features) = Features::new(landmarks) else {
        return PoseRecognition {
            pose: HandPose::Unknown,
            score: 0.0,
        };
    };

    let candidates = [
        (HandPose::GatheredPinch, features.gathered_pinch()),
        (HandPose::IndexPinch, features.index_pinch()),
        (HandPose::MiddlePinch, features.middle_pinch()),
        (HandPose::Point, features.point()),
        (HandPose::SoftFist, features.soft_fist()),
        (HandPose::Anchor, features.anchor()),
    ];
    let (pose, score) = candidates
        .into_iter()
        .max_by(|left, right| left.1.total_cmp(&right.1))
        .unwrap_or((HandPose::Unknown, 0.0));
    if score < MIN_POSE_SCORE {
        PoseRecognition {
            pose: HandPose::Unknown,
            score,
        }
    } else {
        PoseRecognition { pose, score }
    }
}

struct Features {
    index_straight: f32,
    middle_straight: f32,
    ring_straight: f32,
    pinky_straight: f32,
    thumb_index: f32,
    thumb_middle: f32,
    thumb_ring: f32,
    thumb_pinky: f32,
    index_middle: f32,
    middle_ring: f32,
    ring_pinky: f32,
}

impl Features {
    fn new(landmarks: &[Landmark; HAND_LANDMARK_COUNT]) -> Option<Self> {
        if landmarks.iter().any(|landmark| {
            !landmark.x.is_finite() || !landmark.y.is_finite() || !landmark.z.is_finite()
        }) {
            return None;
        }
        let palm_width = distance(landmarks[INDEX_MCP], landmarks[PINKY_MCP]);
        let palm_length = distance(landmarks[WRIST], landmarks[MIDDLE_MCP]);
        let scale = palm_width.max(palm_length);
        if !scale.is_finite() || scale <= f32::EPSILON {
            return None;
        }
        Some(Self {
            index_straight: finger_straightness(
                landmarks[INDEX_MCP],
                landmarks[INDEX_PIP],
                landmarks[INDEX_DIP],
                landmarks[INDEX_TIP],
            ),
            middle_straight: finger_straightness(
                landmarks[MIDDLE_MCP],
                landmarks[MIDDLE_PIP],
                landmarks[MIDDLE_DIP],
                landmarks[MIDDLE_TIP],
            ),
            ring_straight: finger_straightness(
                landmarks[RING_MCP],
                landmarks[RING_PIP],
                landmarks[RING_DIP],
                landmarks[RING_TIP],
            ),
            pinky_straight: finger_straightness(
                landmarks[PINKY_MCP],
                landmarks[PINKY_PIP],
                landmarks[PINKY_DIP],
                landmarks[PINKY_TIP],
            ),
            thumb_index: distance(landmarks[THUMB_TIP], landmarks[INDEX_TIP]) / scale,
            thumb_middle: distance(landmarks[THUMB_TIP], landmarks[MIDDLE_TIP]) / scale,
            thumb_ring: distance(landmarks[THUMB_TIP], landmarks[RING_TIP]) / scale,
            thumb_pinky: distance(landmarks[THUMB_TIP], landmarks[PINKY_TIP]) / scale,
            index_middle: distance(landmarks[INDEX_TIP], landmarks[MIDDLE_TIP]) / scale,
            middle_ring: distance(landmarks[MIDDLE_TIP], landmarks[RING_TIP]) / scale,
            ring_pinky: distance(landmarks[RING_TIP], landmarks[PINKY_TIP]) / scale,
        })
    }

    fn gathered_pinch(&self) -> f32 {
        minimum(&[
            low(self.thumb_index, 0.34, 0.18),
            low(self.thumb_middle, 0.38, 0.20),
            low(self.thumb_ring, 0.43, 0.22),
            low(self.thumb_pinky, 0.48, 0.24),
        ])
    }

    fn index_pinch(&self) -> f32 {
        minimum(&[
            low(self.thumb_index, 0.32, 0.18),
            high(self.thumb_middle, 0.31, 0.18),
            high(self.thumb_ring, 0.39, 0.20),
            high(self.thumb_pinky, 0.46, 0.22),
            low(self.middle_straight, 0.78, 0.35),
            low(self.ring_straight, 0.76, 0.35),
            low(self.pinky_straight, 0.74, 0.35),
        ])
    }

    fn middle_pinch(&self) -> f32 {
        minimum(&[
            low(self.thumb_middle, 0.34, 0.18),
            high(self.thumb_index, 0.30, 0.16),
            high(self.thumb_ring, 0.30, 0.18),
            high(self.thumb_pinky, 0.40, 0.20),
            low(self.ring_straight, 0.76, 0.35),
            low(self.pinky_straight, 0.74, 0.35),
        ])
    }

    fn point(&self) -> f32 {
        minimum(&[
            high(self.index_straight, 0.72, 0.24),
            low(self.middle_straight, 0.50, 0.28),
            low(self.ring_straight, 0.48, 0.28),
            low(self.pinky_straight, 0.46, 0.28),
            high(self.thumb_index, 0.35, 0.18),
        ])
    }

    fn soft_fist(&self) -> f32 {
        minimum(&[
            low(self.index_straight, 0.48, 0.30),
            low(self.middle_straight, 0.46, 0.30),
            low(self.ring_straight, 0.44, 0.30),
            low(self.pinky_straight, 0.42, 0.30),
            high(self.thumb_index, 0.24, 0.16),
            high(self.thumb_middle, 0.18, 0.12),
            low(self.thumb_middle, 0.55, 0.22),
            low(self.thumb_ring, 0.65, 0.25),
            low(self.thumb_pinky, 0.78, 0.28),
        ])
    }

    fn anchor(&self) -> f32 {
        minimum(&[
            high(self.index_straight, 0.52, 0.28),
            high(self.middle_straight, 0.52, 0.28),
            high(self.ring_straight, 0.48, 0.28),
            high(self.pinky_straight, 0.44, 0.28),
            low(self.index_middle, 0.72, 0.32),
            low(self.middle_ring, 0.65, 0.30),
            low(self.ring_pinky, 0.60, 0.28),
            high(self.thumb_index, 0.38, 0.20),
        ])
    }
}

fn finger_straightness(mcp: Landmark, pip: Landmark, dip: Landmark, tip: Landmark) -> f32 {
    let proximal = straight_joint(mcp, pip, dip);
    let distal = straight_joint(pip, dip, tip);
    proximal.min(distal)
}

fn straight_joint(start: Landmark, joint: Landmark, end: Landmark) -> f32 {
    let left = subtract(start, joint);
    let right = subtract(end, joint);
    let denominator = magnitude(left) * magnitude(right);
    if denominator <= f32::EPSILON {
        return 0.0;
    }
    let cosine = dot(left, right) / denominator;
    ((-cosine.clamp(-1.0, 1.0) - 0.15) / 0.85).clamp(0.0, 1.0)
}

fn low(value: f32, threshold: f32, softness: f32) -> f32 {
    ((threshold + softness - value) / softness).clamp(0.0, 1.0)
}

fn high(value: f32, threshold: f32, softness: f32) -> f32 {
    ((value - threshold + softness) / softness).clamp(0.0, 1.0)
}

fn minimum(values: &[f32]) -> f32 {
    values.iter().copied().fold(1.0, f32::min)
}

fn distance(left: Landmark, right: Landmark) -> f32 {
    magnitude(subtract(left, right))
}

fn subtract(left: Landmark, right: Landmark) -> [f32; 3] {
    [left.x - right.x, left.y - right.y, left.z - right.z]
}

fn dot(left: [f32; 3], right: [f32; 3]) -> f32 {
    left[0] * right[0] + left[1] * right[1] + left[2] * right[2]
}

fn magnitude(value: [f32; 3]) -> f32 {
    dot(value, value).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn authored_pose(
        straight: [bool; 4],
        tips: [(f32, f32); 4],
        thumb_tip: (f32, f32),
    ) -> [Landmark; HAND_LANDMARK_COUNT] {
        let mut landmarks = [Landmark::default(); HAND_LANDMARK_COUNT];
        landmarks[WRIST] = Landmark {
            x: 0.0,
            y: -1.0,
            z: 0.0,
        };
        landmarks[THUMB_TIP] = Landmark {
            x: thumb_tip.0,
            y: thumb_tip.1,
            z: 0.0,
        };
        for (finger, (mcp, pip, dip, tip)) in [
            (INDEX_MCP, INDEX_PIP, INDEX_DIP, INDEX_TIP),
            (MIDDLE_MCP, MIDDLE_PIP, MIDDLE_DIP, MIDDLE_TIP),
            (RING_MCP, RING_PIP, RING_DIP, RING_TIP),
            (PINKY_MCP, PINKY_PIP, PINKY_DIP, PINKY_TIP),
        ]
        .into_iter()
        .enumerate()
        {
            let mcp_x = -0.6 + finger as f32 * 0.4;
            landmarks[mcp] = Landmark {
                x: mcp_x,
                y: 0.0,
                z: 0.0,
            };
            if straight[finger] {
                landmarks[pip] = Landmark {
                    x: mcp_x,
                    y: 0.4,
                    z: 0.0,
                };
                landmarks[dip] = Landmark {
                    x: mcp_x,
                    y: 0.8,
                    z: 0.0,
                };
            } else {
                landmarks[pip] = Landmark {
                    x: mcp_x,
                    y: 0.35,
                    z: 0.0,
                };
                landmarks[dip] = Landmark {
                    x: tips[finger].0,
                    y: 0.35,
                    z: 0.0,
                };
            }
            landmarks[tip] = Landmark {
                x: tips[finger].0,
                y: tips[finger].1,
                z: 0.0,
            };
        }
        landmarks
    }

    #[test]
    fn invalid_geometry_is_unknown() {
        let mut landmarks = [Landmark::default(); HAND_LANDMARK_COUNT];
        landmarks[0].x = f32::NAN;
        assert_eq!(
            recognize(&landmarks),
            PoseRecognition {
                pose: HandPose::Unknown,
                score: 0.0,
            }
        );
    }

    #[test]
    fn collapsed_geometry_is_unknown() {
        assert_eq!(
            recognize(&[Landmark::default(); HAND_LANDMARK_COUNT]).pose,
            HandPose::Unknown
        );
    }

    #[test]
    fn authored_geometry_covers_the_complete_pose_vocabulary() {
        let cases = [
            (
                HandPose::Anchor,
                authored_pose(
                    [true; 4],
                    [(-0.6, 1.15), (-0.2, 1.15), (0.2, 1.15), (0.6, 1.15)],
                    (-1.2, 0.5),
                ),
            ),
            (
                HandPose::IndexPinch,
                authored_pose(
                    [false; 4],
                    [(-0.4, 0.05), (0.05, 0.05), (0.45, 0.05), (0.85, 0.05)],
                    (-0.4, 0.05),
                ),
            ),
            (
                HandPose::MiddlePinch,
                authored_pose(
                    [false; 4],
                    [(-0.4, 0.05), (0.05, 0.05), (0.45, 0.05), (0.85, 0.05)],
                    (0.05, 0.05),
                ),
            ),
            (
                HandPose::SoftFist,
                authored_pose(
                    [false; 4],
                    [(-0.4, 0.05), (-0.05, 0.05), (0.0, 0.05), (0.2, 0.05)],
                    (-0.7, 0.05),
                ),
            ),
            (
                HandPose::Point,
                authored_pose(
                    [true, false, false, false],
                    [(-0.6, 1.15), (0.0, 0.05), (0.4, 0.05), (0.8, 0.05)],
                    (0.0, 0.05),
                ),
            ),
            (
                HandPose::GatheredPinch,
                authored_pose(
                    [false; 4],
                    [(-0.1, 0.05), (0.0, 0.05), (0.1, 0.05), (0.2, 0.05)],
                    (0.05, 0.05),
                ),
            ),
        ];

        for (expected, landmarks) in cases {
            let recognized = recognize(&landmarks);
            assert_eq!(recognized.pose, expected);
            assert!(recognized.score >= MIN_POSE_SCORE);
        }
    }
}
