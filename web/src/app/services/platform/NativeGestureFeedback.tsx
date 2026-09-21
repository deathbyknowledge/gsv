import type { GestureCandidate, NativeSnapshot } from "./PlatformProvider";

const candidates: Record<GestureCandidate, string> = {
  arm: "arm gestures", disarm: "disarm gestures", start_transcription: "start voice",
  stop_transcription: "finish voice", send: "send", delete_backward: "delete a character",
  clear_dictation: "clear dictation", mute: "pause the mic", unmute: "resume the mic",
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

export function GestureGuide() {
  return <div class="native-gesture-guide">
      <h3>Your action hand <span>right by default</span></h3>
      <p>Hold until the indicator fills. Make a fist between commands.</p>
      <table>
        <caption>Gesture guide</caption>
        <tbody>
          <tr><th scope="row">Both fists</th><td>Arm / disarm <small>hold 0.7 s</small></td></tr>
          <tr><th scope="row"><b>1</b> Index</th><td>Start / finish voice</td></tr>
          <tr><th scope="row"><b>2</b> + middle</th><td>Send, keep listening</td></tr>
          <tr><th scope="row"><b>3</b> + ring</th><td>Delete a dictated character</td></tr>
          <tr><th scope="row"><b>4</b> Thumb closed</th><td>Clear dictation <small>hold 1 s</small></td></tr>
          <tr><th scope="row"><b>5</b> Open hand</th><td>Pause / resume microphone</td></tr>
        </tbody>
      </table>
      <details>
        <summary>Scrolling and corrections</summary>
        <p>Open your control palm and close your action fist. Let the pose settle, then tilt the line between your hands. Return to neutral to pause; release either hand to stop.</p>
        <p>Clear and delete affect only unsent dictation. Typed text and attachments stay.</p>
      </details>
  </div>;
}
