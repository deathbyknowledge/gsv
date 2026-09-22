import { useEffect, useRef, useState } from "preact/hooks";
import type { NativeSnapshot } from "./PlatformProvider";
import { playInputCue, soundPreferences, subscribeSoundPreferences } from "./inputSounds";

export function useSoundPreferences() {
  const [preferences, setPreferences] = useState(soundPreferences);
  useEffect(() => subscribeSoundPreferences(() => setPreferences(soundPreferences())), []);
  return preferences;
}

/** Only acknowledged actions and state transitions make sounds; pose updates stay silent. */
export function useNativeSoundFeedback(snapshot: NativeSnapshot | null) {
  const previous = useRef<NativeSnapshot | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = snapshot;
    if (!snapshot || !before || before.lease !== snapshot.lease) return;
    const listening = snapshot.voice?.phase === "listening";
    const wasListening = before.voice?.phase === "listening";
    if (before.gestures_enabled && !snapshot.gestures_enabled) playInputCue("off");
    else if (snapshot.gesture_practice?.feedback
      && snapshot.gesture_practice.feedback_sequence !== before.gesture_practice?.feedback_sequence) playInputCue("practice_error");
    else if (listening && !wasListening) playInputCue("listening");
    else if (before.voice && !snapshot.voice) playInputCue(snapshot.notice ? "attention" : "paused");
    else if (snapshot.gesture_status === "ready" && before.gesture_status !== "ready") playInputCue("ready");
    else if (snapshot.notice && snapshot.notice !== before.notice) playInputCue("attention");
    else if (snapshot.gesture_reset_after_action > before.gesture_reset_after_action) playInputCue("accepted");
    else if (snapshot.gesture_action_sequence !== before.gesture_action_sequence) {
      const action = snapshot.gesture_action;
      if (action === "send") playInputCue("commit");
      else if (action === "delete_backward") playInputCue("delete");
      else if (action === "clear_dictation") playInputCue("clear");
      else if (action === "start_transcription" || action === "stop_transcription") playInputCue("accepted");
    }
  }, [snapshot]);
}
