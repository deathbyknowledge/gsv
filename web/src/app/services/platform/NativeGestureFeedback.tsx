import type { GestureCandidate, NativeSnapshot } from "./PlatformProvider";

const candidates: Record<GestureCandidate, string> = {
  arm: "enable hands-free", disarm: "turn hands-free off", start_transcription: "listen",
  stop_transcription: "pause listening", send: "send", delete_backward: "delete a character",
  clear_dictation: "clear dictation", mute: "pause the mic", unmute: "resume the mic",
};
const accepted: Record<GestureCandidate, string> = {
  arm: "Ready", disarm: "Hands-free off", start_transcription: "Starting listening",
  stop_transcription: "Pausing", send: "Send requested", delete_backward: "Delete requested",
  clear_dictation: "Clear requested", mute: "Mute requested", unmute: "Unmute requested",
};
const lifecycle: Record<string, string> = {
  off: "Off · camera and microphone stopped",
  starting: "Starting camera…",
  ready: "Camera on",
  stopped: "Camera stopped. Enable gestures to restart.",
  disabled: "Gestures are disabled for this app launch.",
  assets_unavailable: "Gesture models are unavailable. Rebuild the gesture helper.",
  camera_unavailable: "The camera could not open. Check camera access or close another camera app.",
  camera_stopped: "The camera stopped. Turn gestures off and on to retry.",
  inference_unavailable: "Hand recognition could not start. Turn gestures off and on to retry.",
  window_unavailable: "The gesture diagnostic window could not open.",
  worker_unavailable: "The gesture helper could not start. Enable gestures to retry.",
  protocol_error: "The gesture helper is incompatible with this build.",
  interrupted: "The gesture helper stopped. Enable gestures to retry.",
};

export function gestureFeedback(snapshot: NativeSnapshot): { message: string; progress: number | null; action: string | null } {
  const action = snapshot.gesture_action ? accepted[snapshot.gesture_action] : null;
  if (snapshot.gesture_status !== "ready") return {
    message: lifecycle[snapshot.gesture_status] ?? "Gesture control is unavailable.", progress: null, action: snapshot.gesture_status === "off" ? action : null,
  };
  if (snapshot.gesture_progress) return {
    message: `Hold to ${candidates[snapshot.gesture_progress.candidate]}`,
    progress: snapshot.gesture_progress.progress_permille,
    action,
  };
  if (snapshot.scroll_velocity) return {
    message: snapshot.scroll_velocity < 0 ? "Scrolling up · return to neutral to pause" : "Scrolling down · return to neutral to pause",
    progress: null, action,
  };
  if (snapshot.gesture_needs_reset) return { message: "Make a fist to reset", progress: null, action };
  const { gesture_context: context } = snapshot;
  const message = context.mode === "disarmed" ? "Hands-free off"
    : context.mode === "disabled" ? "Preparing · both fists to stop"
    : context.mode === "standby" ? "Ready · one finger to listen"
    : "Listening · fist between commands";
  return { message, progress: null, action };
}
