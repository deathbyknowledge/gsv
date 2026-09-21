import type { GestureCandidate, NativeSnapshot } from "./PlatformProvider";

const candidates: Record<GestureCandidate, string> = {
  arm: "arm gestures", disarm: "disarm gestures", start_transcription: "start voice",
  stop_transcription: "finish voice", send: "send this segment", delete_backward: "delete one voice character",
  clear_dictation: "clear unsent dictation", mute: "mute the microphone", unmute: "unmute the microphone",
};
const accepted: Record<GestureCandidate, string> = {
  arm: "Gestures armed", disarm: "Gestures disarmed", start_transcription: "Starting voice",
  stop_transcription: "Finishing voice", send: "Send requested", delete_backward: "Delete requested",
  clear_dictation: "Clear requested", mute: "Mute requested", unmute: "Unmute requested",
};
const lifecycle: Record<string, string> = {
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
    message: lifecycle[snapshot.gesture_status] ?? "Gesture control is unavailable.", progress: null, action: null,
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
  const { gesture_context: context } = snapshot;
  const message = context.mode === "disarmed" ? "Hold both fists for 0.7 s to arm, or use arm gestures."
    : context.mode === "disabled" ? "Voice is busy. Gestures will resume when it is ready; both fists still disarm."
    : context.mode === "standby" ? "Ready · hold up your index finger to start voice."
    : context.mode === "active" && context.muted ? "Microphone muted · five fingers to unmute."
    : "Listening · show a command, then make a fist before the next one.";
  return { message, progress: null, action };
}

export function NativeGestureFeedback({ snapshot }: { snapshot: NativeSnapshot }) {
  if (!snapshot.gestures_enabled && snapshot.gesture_status === "off") return null;
  const feedback = gestureFeedback(snapshot);
  return <section class="native-gesture-feedback" aria-label="Gesture feedback">
    <div class="native-gesture-heading">
      <span class={snapshot.armed ? "is-armed" : ""}>{snapshot.armed ? "gestures armed" : "gestures disarmed"}</span>
      {snapshot.gesture_status === "ready" && <span>camera on</span>}
      {feedback.action && <span class="native-gesture-action" role="status">{feedback.action}</span>}
    </div>
    <div class="native-gesture-recognition">
      <span>{feedback.message}</span>
      {feedback.progress !== null && <>
        <progress max={1000} value={feedback.progress} aria-label={feedback.message} />
        <span class="native-gesture-percent" aria-hidden="true">{Math.round(feedback.progress / 10)}%</span>
      </>}
    </div>
    <details class="native-gesture-guide">
      <summary>gesture guide</summary>
      <table>
        <thead><tr><th>Gesture</th><th>Action</th><th>Hold</th></tr></thead>
        <tbody>
          <tr><td>Both hands in fists</td><td>Arm / disarm</td><td>0.7 s</td></tr>
          <tr><td>1 · index finger</td><td>Start / finish voice</td><td>0.35 s</td></tr>
          <tr><td>2 · index + middle</td><td>Send segment, keep listening</td><td>0.35 s</td></tr>
          <tr><td>3 · add ring finger</td><td>Delete one dictated character</td><td>0.35 s</td></tr>
          <tr><td>4 · four fingers, thumb closed</td><td>Clear unsent dictation</td><td>1 s</td></tr>
          <tr><td>5 · all fingers open</td><td>Mute / unmute</td><td>0.35 s</td></tr>
        </tbody>
      </table>
      <p>Use your action hand (right by default). Make a fist between commands. Typed text and attachments stay when dictation is cleared.</p>
      <p>To scroll, open your control palm and close your action fist. Let the pose settle, then tilt the line between your hands. Return to neutral to pause; release either hand to stop.</p>
    </details>
  </section>;
}
