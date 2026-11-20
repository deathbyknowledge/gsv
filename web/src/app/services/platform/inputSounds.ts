/** Quiet, cached voice cues based on the original native desktop's audio.rs. */
export type InputCue = "listening" | "paused" | "attention";
let context: AudioContext | null = null;
const buffers = new Map<InputCue, AudioBuffer>();
let activeSources = 0;

// Called only inside a trusted user interaction. Native events never create or resume audio.
function unlockInputAudio() {
  try {
    context ??= new AudioContext();
    if (context.state === "suspended") void context.resume().catch(() => {});
  } catch { /* Input remains available without an audio output. */ }
}
const notes = {
  listening: [520, 780], paused: [620, 440], attention: [280, 280],
} as const;
function bufferFor(cue: InputCue, audio: AudioContext): AudioBuffer {
  const cached = buffers.get(cue);
  if (cached) return cached;
  const rate = audio.sampleRate;
  const tones = notes[cue];
  const span = .065;
  const gap = .01;
  const buffer = audio.createBuffer(1, Math.ceil(rate * (.025 + tones.length * (span + gap))), rate);
  const samples = buffer.getChannelData(0);
  let offset = 0;
  for (const tone of tones) {
    const start = Math.round(offset * rate);
    for (let i = 0; i < Math.floor(span * rate); i++) {
      const local = i / rate;
      const envelope = Math.sin(Math.PI * local / span) ** 2;
      const wave = Math.sin(2 * Math.PI * tone * local);
      samples[start + i] = wave * envelope * .022;
    }
    offset += span + gap;
  }
  buffers.set(cue, buffer);
  return buffer;
}
export function playInputCue(cue: InputCue) {
  const audio = context;
  if (!audio || audio.state !== "running" || activeSources >= 8) return;
  try {
    const source = audio.createBufferSource();
    source.buffer = bufferFor(cue, audio);
    source.connect(audio.destination);
    source.onended = () => { source.disconnect(); activeSources--; };
    source.start();
    activeSources++;
  } catch { /* Audio must never interrupt an input action. */ }
}
/** Voice cues can play once a trusted pointer or key press has unlocked audio. */
export function installInputAudioUnlock(): () => void {
  const unlock = (event: Event) => { if (event.isTrusted) unlockInputAudio(); };
  document.addEventListener("pointerdown", unlock, true);
  document.addEventListener("keydown", unlock, true);
  return () => {
    document.removeEventListener("pointerdown", unlock, true);
    document.removeEventListener("keydown", unlock, true);
  };
}
