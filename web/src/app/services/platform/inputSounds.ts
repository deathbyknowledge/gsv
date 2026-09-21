/** Quiet, cached synthesis based on the original native desktop's audio.rs. */
export type SoundPreferences = { keys: boolean; gestures: boolean };
export type InputCue = "character" | "space" | "delete" | "commit" | "navigate"
  | "ready" | "listening" | "paused" | "off" | "accepted" | "clear" | "attention";
const storageKey = "gsv.input-sounds";
let preferences: SoundPreferences = { keys: true, gestures: true };
try {
  const stored: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "null");
  if (stored && typeof stored === "object") {
    if ("keys" in stored && typeof stored.keys === "boolean") preferences.keys = stored.keys;
    if ("gestures" in stored && typeof stored.gestures === "boolean") preferences.gestures = stored.gestures;
  }
} catch { /* Sound preferences are optional when local storage is unavailable. */ }
const listeners = new Set<() => void>();
export const soundPreferences = () => preferences;
export const subscribeSoundPreferences = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export function setSoundPreferences(next: SoundPreferences) {
  preferences = next;
  try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Keep the session preference. */ }
  for (const listener of listeners) listener();
}
let context: AudioContext | null = null;
const buffers = new Map<InputCue, AudioBuffer>();
let lastKey = -Infinity, lastNavigation = -Infinity;
let activeSources = 0;

// Called only inside a trusted user interaction. Native events never create or resume audio.
export function unlockInputAudio() {
  if (!preferences.keys && !preferences.gestures) return;
  try {
    context ??= new AudioContext();
    if (context.state === "suspended") void context.resume().catch(() => {});
  } catch { /* Input remains available without an audio output. */ }
}
const profiles = {
  character: [24, .028, .28, .055, .07], space: [31, .024, .11, .032, .025],
  delete: [38, .025, .19, .041, .11], commit: [68, .030, .14, .027, .04],
  navigate: [94, .036, .065, .016, .012],
} as const;
const notes: Partial<Record<InputCue, readonly number[]>> = {
  ready: [440, 660], listening: [520, 780], paused: [620, 440],
  off: [440, 330, 220], accepted: [740], clear: [520, 390], attention: [280, 280],
};
function bufferFor(cue: InputCue, audio: AudioContext): AudioBuffer {
  const cached = buffers.get(cue);
  if (cached) return cached;
  const rate = audio.sampleRate;
  const profile = cue in profiles ? profiles[cue as keyof typeof profiles] : null;
  const tones = notes[cue] ?? [];
  const duration = profile ? profile[0] / 1000 : tones.length * .075 + .025;
  const buffer = audio.createBuffer(1, Math.ceil(rate * duration), rate);
  const samples = buffer.getChannelData(0);
  if (profile) {
    let random = 0x70d15a, surface = 0, body = 0;
    const pulse = (position: number, start: number, span: number, decay: number) => {
      const local = (position - start) / span;
      if (local < 0 || local >= 1) return 0;
      const attack = Math.min(local / .065, 1);
      return attack * attack * (3 - 2 * attack) * (1 - local) ** decay;
    };
    for (let i = 0; i < samples.length; i++) {
      random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
      const white = (random >>> 0) / 0x80000000 - 1;
      surface += profile[2] * (white - surface);
      body += profile[3] * (surface - body);
      const t = i / samples.length;
      const envelope = cue === "character" ? pulse(t, 0, .68, 3.8) + .16 * pulse(t, .24, .52, 3.2)
        : cue === "space" ? .62 * pulse(t, 0, .9, 2.8) + .15 * pulse(t, .34, .5, 2.5)
        : cue === "delete" ? .48 * pulse(t, 0, .46, 2.5) + .58 * pulse(t, .12, .86, 1.7) + .18 * pulse(t, .44, .34, 2.2)
        : cue === "commit" ? .78 * pulse(t, 0, .42, 2.9) + .55 * pulse(t, .21, .46, 2.5) + .2 * pulse(t, .46, .54, 1.8)
        : .82 * pulse(t, 0, .96, 2.4);
      const thud = cue === "navigate" ? Math.sin(2 * Math.PI * (110 - t * 16) * i / rate) * .34 : 0;
      samples[i] = (body * .54 + surface * .42 + white * profile[4] + thud)
        * envelope * Math.min(1, (samples.length - i) / 48) * profile[1] * 1.28;
    }
  } else {
    for (let i = 0; i < samples.length; i++) {
      const time = i / rate, note = Math.floor(time / .075), local = time - note * .075;
      if (note >= tones.length || local > .065) continue;
      const envelope = Math.sin(Math.PI * local / .065) ** 2;
      const wave = Math.sin(2 * Math.PI * tones[note] * local);
      samples[i] = wave * envelope * .022;
    }
  }
  buffers.set(cue, buffer);
  return buffer;
}
export function playInputCue(cue: InputCue, channel: keyof SoundPreferences = "gestures") {
  const audio = context;
  if (!preferences[channel] || !audio || audio.state !== "running" || activeSources >= 8) return;
  const now = performance.now();
  if (channel === "keys") {
    if (cue !== "commit" && now - lastKey < 18) return;
    if (cue === "navigate" && now - lastNavigation < 82) return;
    lastKey = now;
    if (cue === "navigate") lastNavigation = now;
  }
  try {
    const source = audio.createBufferSource();
    source.buffer = bufferFor(cue, audio);
    source.connect(audio.destination);
    source.onended = () => { source.disconnect(); activeSources--; };
    source.start();
    activeSources++;
  } catch { /* Audio must never interrupt an input action. */ }
}
export function installInputSounds(): () => void {
  const unlock = (event: Event) => { if (event.isTrusted) unlockInputAudio(); };
  const key = (event: KeyboardEvent) => {
    if (!event.isTrusted || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement) || target.disabled || target.readOnly
      || !target.matches(".prompt-line textarea, .native-practice-draft")) return;
    unlockInputAudio();
    const cue = event.key === "Enter" ? "commit" : event.key === " " ? "space"
      : event.key === "Backspace" || event.key === "Delete" ? "delete"
      : event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End" ? "navigate"
      : event.key.length === 1 ? "character" : null;
    if (cue) playInputCue(cue, "keys");
  };
  document.addEventListener("pointerdown", unlock, true);
  document.addEventListener("keydown", unlock, true);
  document.addEventListener("keydown", key, true);
  return () => {
    document.removeEventListener("pointerdown", unlock, true);
    document.removeEventListener("keydown", unlock, true);
    document.removeEventListener("keydown", key, true);
  };
}
