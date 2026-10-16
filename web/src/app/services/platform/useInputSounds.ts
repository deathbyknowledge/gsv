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
    if (listening && !wasListening) playInputCue("listening");
    else if (before.voice && !snapshot.voice) playInputCue(snapshot.notice ? "attention" : "paused");
    else if (snapshot.notice && snapshot.notice !== before.notice) playInputCue("attention");
  }, [snapshot]);
}
