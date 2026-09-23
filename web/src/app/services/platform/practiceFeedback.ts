import type { GestureCandidate, NativeSnapshot, PracticeGesture, PracticeTarget } from "./PlatformProvider";

const detected = {
  one: "One finger", two: "Two fingers", three: "Three fingers", four: "Four fingers",
  five: "Five fingers", both_fists: "Both fists", scroll: "Scrolling",
} satisfies Record<PracticeGesture, string>;
const retry = {
  none: "choose a lesson", listen: "show one finger to listen", dictate: "speak a few words",
  send: "show two fingers to send", delete: "show three fingers to delete",
  clear: "show four fingers to clear", pause: "show one finger to pause",
  scroll: "open your left palm and close your right fist", off: "hold both fists",
} satisfies Record<PracticeTarget, string>;
const poses = new Map<GestureCandidate, PracticeGesture>([
  ["start_transcription", "one"], ["stop_transcription", "one"], ["send", "two"],
  ["delete_backward", "three"], ["clear_dictation", "four"], ["open_palm", "five"], ["disarm", "both_fists"],
]);
const expectedPoses = new Map<PracticeTarget, PracticeGesture>([
  ["listen", "one"], ["pause", "one"], ["send", "two"], ["delete", "three"], ["clear", "four"], ["off", "both_fists"], ["scroll", "scroll"],
]);

export function practiceCorrection(snapshot: NativeSnapshot, target: PracticeTarget): string | null {
  const practice = snapshot.gesture_practice;
  if (practice?.expected !== target || !practice.feedback || !snapshot.gestures_enabled || snapshot.gesture_status !== "ready") return null;
  const { gesture, reason } = practice.feedback;
  if (reason === "not_ready") return snapshot.voice
    ? "The microphone is busy. Make a fist, then try again when ready."
    : "Start listening below, then try this gesture again.";
  const next = retry[target];
  return `${detected[gesture]} detected. ${snapshot.gesture_needs_reset || gesture === "scroll" ? `Make a fist, then ${next}` : next[0].toUpperCase() + next.slice(1)}.`;
}

export function practiceHold(snapshot: NativeSnapshot, target: PracticeTarget): string | null {
  if (snapshot.gesture_practice?.expected !== target || !snapshot.gesture_progress) return null;
  const pose = poses.get(snapshot.gesture_progress.candidate);
  if (!pose) return null;
  if (pose === "both_fists") return "Hold to turn hands-free off";
  if (pose !== expectedPoses.get(target)) return `${detected[pose]} detected · this step: ${retry[target]}`;
  return target === "pause" ? "Hold to pause listening" : null;
}
