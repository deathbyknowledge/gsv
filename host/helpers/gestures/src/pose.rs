//! Camera-local recognition for the fist-and-finger-count vocabulary.
//!
//! The native landmark model supplies 21 world-space joints. This module turns
//! that private geometry into a palm-normalized count from zero through five.
//! It owns no temporal action or application semantics.

use crate::observation::{HandPose, Landmark, HAND_LANDMARK_COUNT};

const WRIST: usize = 0;
const THUMB_CMC: usize = 1;
const THUMB_MCP: usize = 2;
const THUMB_IP: usize = 3;
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

    let fingers = features
        .fingers
        .into_iter()
        .map(|straightness| {
            (
                high(straightness, 0.68, 0.28),
                low(straightness, 0.50, 0.30),
            )
        })
        .chain(std::iter::once((features.thumb_open, features.thumb_closed)));
    let mut count = 0;
    let mut score = 1.0_f32;
    for (open, closed) in fingers {
        match (open >= MIN_POSE_SCORE, closed >= MIN_POSE_SCORE) {
            (true, false) => {
                count += 1;
                score = score.min(open);
            }
            (false, true) => score = score.min(closed),
            // Conflicting or weak evidence for a digit must not become a lower command.
            _ => {
                return PoseRecognition {
                    pose: HandPose::Unknown,
                    score: 0.0,
                };
            }
        }
    }
    let pose = [
        HandPose::Fist,
        HandPose::OneFinger,
        HandPose::TwoFingers,
        HandPose::ThreeFingers,
        HandPose::FourFingers,
        HandPose::FiveFingers,
    ][count];
    PoseRecognition { pose, score }
}

struct Features {
    fingers: [f32; 4],
    thumb_open: f32,
    thumb_closed: f32,
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

        let (thumb_straight, thumb_palm_distance, thumb_outward) = thumb_geometry(landmarks, scale);
        Some(Self {
            fingers: [
                finger_straightness(
                    landmarks[INDEX_MCP],
                    landmarks[INDEX_PIP],
                    landmarks[INDEX_DIP],
                    landmarks[INDEX_TIP],
                ),
                finger_straightness(
                    landmarks[MIDDLE_MCP],
                    landmarks[MIDDLE_PIP],
                    landmarks[MIDDLE_DIP],
                    landmarks[MIDDLE_TIP],
                ),
                finger_straightness(
                    landmarks[RING_MCP],
                    landmarks[RING_PIP],
                    landmarks[RING_DIP],
                    landmarks[RING_TIP],
                ),
                finger_straightness(
                    landmarks[PINKY_MCP],
                    landmarks[PINKY_PIP],
                    landmarks[PINKY_DIP],
                    landmarks[PINKY_TIP],
                ),
            ],
            thumb_open: minimum(&[
                high(thumb_straight, 0.62, 0.25),
                high(thumb_palm_distance, 0.58, 0.24),
                high(thumb_outward, 0.35, 0.25),
            ]),
            thumb_closed: minimum(&[
                low(thumb_palm_distance, 0.48, 0.28),
                low(thumb_outward, 0.12, 0.28),
            ]),
        })
    }
}

fn thumb_geometry(landmarks: &[Landmark; HAND_LANDMARK_COUNT], scale: f32) -> (f32, f32, f32) {
    let thumb_straight = finger_straightness(
        landmarks[THUMB_CMC],
        landmarks[THUMB_MCP],
        landmarks[THUMB_IP],
        landmarks[THUMB_TIP],
    );
    let palm_center = average(&[
        landmarks[INDEX_MCP],
        landmarks[MIDDLE_MCP],
        landmarks[RING_MCP],
        landmarks[PINKY_MCP],
    ]);
    let thumb_palm_distance = distance(landmarks[THUMB_TIP], palm_center) / scale;
    let outward_axis = subtract(landmarks[INDEX_MCP], landmarks[PINKY_MCP]);
    let outward_denominator = dot(outward_axis, outward_axis);
    let thumb_outward = if outward_denominator <= f32::EPSILON {
        0.0
    } else {
        dot(
            subtract(landmarks[THUMB_TIP], landmarks[INDEX_MCP]),
            outward_axis,
        ) / outward_denominator
    };
    (thumb_straight, thumb_palm_distance, thumb_outward)
}

fn average(values: &[Landmark]) -> Landmark {
    let count = values.len() as f32;
    let sum = values
        .iter()
        .fold(Landmark::default(), |sum, value| Landmark {
            x: sum.x + value.x,
            y: sum.y + value.y,
            z: sum.z + value.z,
        });
    Landmark {
        x: sum.x / count,
        y: sum.y / count,
        z: sum.z / count,
    }
}

fn finger_straightness(mcp: Landmark, pip: Landmark, dip: Landmark, tip: Landmark) -> f32 {
    straight_joint(mcp, pip, dip).min(straight_joint(pip, dip, tip))
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

    fn finger_count(count: usize) -> [Landmark; HAND_LANDMARK_COUNT] {
        let mut landmarks = [Landmark::default(); HAND_LANDMARK_COUNT];
        landmarks[WRIST] = Landmark {
            x: 0.0,
            y: -1.0,
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
            let x = -0.6 + finger as f32 * 0.4;
            landmarks[mcp] = Landmark { x, y: 0.0, z: 0.0 };
            landmarks[pip] = Landmark { x, y: 0.4, z: 0.0 };
            if finger < count.min(4) {
                landmarks[dip] = Landmark { x, y: 0.8, z: 0.0 };
                landmarks[tip] = Landmark { x, y: 1.2, z: 0.0 };
            } else {
                landmarks[dip] = Landmark {
                    x: x + 0.25,
                    y: 0.4,
                    z: 0.0,
                };
                landmarks[tip] = Landmark {
                    x: x + 0.25,
                    y: 0.05,
                    z: 0.0,
                };
            }
        }

        if count == 5 {
            landmarks[THUMB_CMC] = Landmark {
                x: -0.72,
                y: -0.02,
                z: 0.0,
            };
            landmarks[THUMB_MCP] = Landmark {
                x: -0.92,
                y: 0.20,
                z: 0.0,
            };
            landmarks[THUMB_IP] = Landmark {
                x: -1.12,
                y: 0.42,
                z: 0.0,
            };
            landmarks[THUMB_TIP] = Landmark {
                x: -1.32,
                y: 0.64,
                z: 0.0,
            };
        } else {
            landmarks[THUMB_CMC] = Landmark {
                x: -0.72,
                y: 0.0,
                z: 0.0,
            };
            landmarks[THUMB_MCP] = Landmark {
                x: -0.82,
                y: 0.14,
                z: 0.0,
            };
            landmarks[THUMB_IP] = Landmark {
                x: -0.65,
                y: 0.20,
                z: 0.0,
            };
            landmarks[THUMB_TIP] = Landmark {
                x: -0.45,
                y: 0.10,
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
    fn sequential_opening_covers_zero_through_five() {
        let poses = [
            HandPose::Fist,
            HandPose::OneFinger,
            HandPose::TwoFingers,
            HandPose::ThreeFingers,
            HandPose::FourFingers,
            HandPose::FiveFingers,
        ];
        for (count, expected) in poses.into_iter().enumerate() {
            let recognized = recognize(&finger_count(count));
            assert_eq!(recognized.pose, expected, "finger count {count}");
            assert!(recognized.score >= MIN_POSE_SCORE, "finger count {count}");
        }
    }

    #[test]
    fn a_thumb_alone_is_one_and_not_a_fist_reset() {
        let mut landmarks = finger_count(0);
        let open_thumb = finger_count(5);
        landmarks[THUMB_CMC..=THUMB_TIP].copy_from_slice(&open_thumb[THUMB_CMC..=THUMB_TIP]);
        assert_eq!(recognize(&landmarks).pose, HandPose::OneFinger);
    }

    #[test]
    fn every_combination_counts_all_five_digits() {
        let closed = finger_count(0);
        let open = finger_count(5);
        let poses = [
            HandPose::Fist,
            HandPose::OneFinger,
            HandPose::TwoFingers,
            HandPose::ThreeFingers,
            HandPose::FourFingers,
            HandPose::FiveFingers,
        ];
        for mask in 0_u32..32 {
            let mut landmarks = closed;
            for digit in 0..5 {
                if mask & (1 << digit) != 0 {
                    let start = 1 + digit * 4;
                    landmarks[start..start + 4].copy_from_slice(&open[start..start + 4]);
                }
            }
            let expected = poses[mask.count_ones() as usize];
            for mirrored in [false, true] {
                let transformed = landmarks.map(|point| {
                    let x = if mirrored { -point.x } else { point.x };
                    Landmark {
                        x: 4.0 + 0.2 * (x * 0.8 - point.y * 0.6),
                        y: -2.0 + 0.2 * (x * 0.6 + point.y * 0.8),
                        z: 1.0 + 0.2 * point.z,
                    }
                });
                let recognized = recognize(&transformed);
                assert_eq!(
                    recognized.pose, expected,
                    "mask {mask:05b}, mirrored {mirrored}"
                );
                assert!(recognized.score >= MIN_POSE_SCORE);
            }
        }
    }

    #[test]
    fn thumb_index_and_middle_are_three_not_send() {
        let mut landmarks = finger_count(2);
        let open = finger_count(5);
        landmarks[THUMB_CMC..=THUMB_TIP].copy_from_slice(&open[THUMB_CMC..=THUMB_TIP]);
        assert_eq!(recognize(&landmarks).pose, HandPose::ThreeFingers);
    }

    #[test]
    fn a_partly_bent_digit_is_unknown() {
        let mut landmarks = finger_count(0);
        let bend = 0.66_f32.acos();
        landmarks[INDEX_DIP] = Landmark {
            x: -0.6 + 0.4 * bend.sin(),
            y: 0.4 + 0.4 * bend.cos(),
            z: 0.0,
        };
        landmarks[INDEX_TIP] = Landmark {
            x: -0.6 + 0.8 * bend.sin(),
            y: 0.4 + 0.8 * bend.cos(),
            z: 0.0,
        };
        assert_eq!(recognize(&landmarks).pose, HandPose::Unknown);
    }

    #[test]
    fn a_thumb_tucked_across_the_palm_is_four_not_five() {
        let mut landmarks = finger_count(4);
        for (joint, x, y) in [
            (THUMB_CMC, -0.72, 0.0),
            (THUMB_MCP, -0.45, 0.10),
            (THUMB_IP, -0.05, 0.15),
            (THUMB_TIP, 0.35, 0.15),
        ] {
            landmarks[joint] = Landmark { x, y, z: 0.0 };
        }
        assert_eq!(recognize(&landmarks).pose, HandPose::FourFingers);
    }
}
