import { useEffect, useRef, useState } from "preact/hooks";
import type { NativeSnapshot } from "./PlatformProvider";
import { playInputCue, soundPreferences, subscribeSoundPreferences } from "./inputSounds";
import { useNativeSpeech } from "./NativeSpeech";

export function useSoundPreferences() {
  const [preferences, setPreferences] = useState(soundPreferences);
  useEffect(() => subscribeSoundPreferences(() => setPreferences(soundPreferences())), []);
  return preferences;
}

/** Only acknowledged actions and state transitions make sounds; pose updates stay silent. */
export function useNativeSoundFeedback(snapshot: NativeSnapshot | null) {
  const speech = useNativeSpeech();
  const previous = useRef<NativeSnapshot | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = snapshot;
    if (!snapshot || !before || before.lease !== snapshot.lease) return;
    const listening = snapshot.voice?.phase === "listening";
    const wasListening = before.voice?.phase === "listening";
    const play = (cue: "listening" | "attention" | "paused") => {
      if (speech?.preferences.enabled) speech.cue(cue === "paused" ? "cancelled" : cue);
      else playInputCue(cue);
    };
    if (listening && !wasListening) play("listening");
    else if (before.voice && !snapshot.voice && !snapshot.events.some((event) => event.action === "send")) play(snapshot.notice ? "attention" : "paused");
    else if (snapshot.notice && snapshot.notice !== before.notice) play("attention");
  }, [snapshot]);
}
