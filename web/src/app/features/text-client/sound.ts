export type TextClientSound = "character" | "space" | "delete" | "commit" | "navigate";

export type TextClientSoundEvent = "send" | "select" | "stop";

export interface TextClientSoundGate {
  allows: (sound: TextClientSound, at?: number) => boolean;
  reset: () => void;
}

export interface TextClientSoundController {
  play: (event: TextClientSoundEvent) => boolean;
  playTextChange: (previous: string, next: string) => boolean;
  setMuted: (muted: boolean) => void;
  dispose: () => void;
}

export type TextClientSoundOptions = {
  muted?: boolean;
  now?: () => number;
  audioContextFactory?: () => AudioContext | null;
};

const SAMPLE_RATE = 48_000;
const EFFECTS_GAIN = 1.28;
const MIN_PLAYBACK_INTERVAL_MS = 18;
const MIN_NAVIGATION_INTERVAL_MS = 82;

type SoundProfile = {
  durationMs: number;
  gain: number;
  surfaceResponse: number;
  bodyResponse: number;
  grain: number;
};

const SOUND_PROFILES: Readonly<Record<TextClientSound, SoundProfile>> = {
  character: {
    durationMs: 24,
    gain: 0.028,
    surfaceResponse: 0.28,
    bodyResponse: 0.055,
    grain: 0.07,
  },
  space: {
    durationMs: 31,
    gain: 0.024,
    surfaceResponse: 0.11,
    bodyResponse: 0.032,
    grain: 0.025,
  },
  delete: {
    durationMs: 38,
    gain: 0.025,
    surfaceResponse: 0.19,
    bodyResponse: 0.041,
    grain: 0.11,
  },
  commit: {
    durationMs: 68,
    gain: 0.03,
    surfaceResponse: 0.14,
    bodyResponse: 0.027,
    grain: 0.04,
  },
  navigate: {
    durationMs: 94,
    gain: 0.036,
    surfaceResponse: 0.065,
    bodyResponse: 0.016,
    grain: 0.012,
  },
};

const SOUND_SEEDS: Readonly<Record<TextClientSound, number>> = {
  character: 0x243f6a88,
  space: 0x13198a2e,
  delete: 0xa4093822,
  commit: 0x082efa98,
  navigate: 0x452821e6,
};

type AudioWindow = Window & {
  webkitAudioContext?: typeof AudioContext;
};

export function soundForTextChange(previous: string, next: string): TextClientSound | null {
  if (previous === next) return null;

  const previousCharacters = Array.from(previous);
  const nextCharacters = Array.from(next);
  let prefixLength = 0;
  while (
    prefixLength < previousCharacters.length
    && prefixLength < nextCharacters.length
    && previousCharacters[prefixLength] === nextCharacters[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < previousCharacters.length - prefixLength
    && suffixLength < nextCharacters.length - prefixLength
    && previousCharacters[previousCharacters.length - 1 - suffixLength]
      === nextCharacters[nextCharacters.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  const insertedEnd = nextCharacters.length - suffixLength;
  const inserted = nextCharacters.slice(prefixLength, insertedEnd);
  if (inserted.length === 0) return "delete";

  const finalCharacter = inserted[inserted.length - 1];
  if (finalCharacter === " " || finalCharacter === "\t") return "space";
  if (finalCharacter === "\n" || finalCharacter === "\r") return "commit";
  return "character";
}

export function soundForInteraction(event: TextClientSoundEvent): TextClientSound {
  if (event === "send") return "commit";
  if (event === "select") return "navigate";
  return "delete";
}

export function createTextClientSoundGate(now: () => number = monotonicNow): TextClientSoundGate {
  let lastPlayback: number | null = null;
  let lastNavigation: number | null = null;

  return {
    allows(sound, at = now()) {
      if (
        sound === "navigate"
        && lastNavigation !== null
        && at - lastNavigation < MIN_NAVIGATION_INTERVAL_MS
      ) {
        return false;
      }
      if (
        sound !== "commit"
        && lastPlayback !== null
        && at - lastPlayback < MIN_PLAYBACK_INTERVAL_MS
      ) {
        return false;
      }

      lastPlayback = at;
      if (sound === "navigate") lastNavigation = at;
      return true;
    },
    reset() {
      lastPlayback = null;
      lastNavigation = null;
    },
  };
}

export function createTextClientSounds(options: TextClientSoundOptions = {}): TextClientSoundController {
  const gate = createTextClientSoundGate(options.now);
  const createAudioContext = options.audioContextFactory ?? defaultAudioContextFactory;
  let muted = options.muted ?? false;
  let disposed = false;
  let context: AudioContext | null = null;
  let sequence = 0;
  let lifecycle = 0;
  let resumePromise: Promise<void> | null = null;
  let pendingSound: { sound: TextClientSound; sequence: number } | null = null;

  const suspend = (audioContext: AudioContext) => {
    if (audioContext.state !== "running") return;
    void audioContext.suspend().catch(() => {});
  };

  const emit = (audioContext: AudioContext, sound: TextClientSound, soundSequence: number) => {
    if (disposed || muted || audioContext.state !== "running") return;
    playBuffer(audioContext, sound, soundSequence);
  };

  const resume = (audioContext: AudioContext) => {
    if (resumePromise) return;
    const expectedLifecycle = lifecycle;
    try {
      resumePromise = audioContext.resume()
        .then(() => {
          if (
            disposed
            || muted
            || lifecycle !== expectedLifecycle
            || context !== audioContext
          ) {
            suspend(audioContext);
            return;
          }
          const queued = pendingSound;
          pendingSound = null;
          if (queued) emit(audioContext, queued.sound, queued.sequence);
        })
        .catch(() => {
          pendingSound = null;
        })
        .finally(() => {
          resumePromise = null;
        });
    } catch {
      pendingSound = null;
      resumePromise = null;
    }
  };

  const playSound = (sound: TextClientSound): boolean => {
    if (disposed || muted || !gate.allows(sound)) return false;
    if (context?.state === "closed") context = null;
    if (!context) {
      try {
        context = createAudioContext();
      } catch {
        context = null;
      }
    }
    if (!context) return false;

    sequence = sequence >= Number.MAX_SAFE_INTEGER ? 1 : sequence + 1;
    if (context.state === "running" && !resumePromise) {
      emit(context, sound, sequence);
    } else {
      // Keep at most one transient while the browser unlocks audio so a held key
      // cannot turn into a delayed burst after the user gesture completes.
      pendingSound = { sound, sequence };
      resume(context);
    }
    return true;
  };

  return {
    play(event) {
      return playSound(soundForInteraction(event));
    },
    playTextChange(previous, next) {
      const sound = soundForTextChange(previous, next);
      return sound ? playSound(sound) : false;
    },
    setMuted(nextMuted) {
      if (muted === nextMuted || disposed) return;
      muted = nextMuted;
      lifecycle += 1;
      gate.reset();
      pendingSound = null;
      if (muted && context) suspend(context);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      lifecycle += 1;
      gate.reset();
      pendingSound = null;
      const closingContext = context;
      context = null;
      if (closingContext && closingContext.state !== "closed") {
        void closingContext.close().catch(() => {});
      }
    },
  };
}

function monotonicNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function defaultAudioContextFactory(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const audioWindow = window as AudioWindow;
  const AudioContextConstructor = window.AudioContext ?? audioWindow.webkitAudioContext;
  if (!AudioContextConstructor) return null;
  try {
    return new AudioContextConstructor({ sampleRate: SAMPLE_RATE });
  } catch {
    try {
      return new AudioContextConstructor();
    } catch {
      return null;
    }
  }
}

function playBuffer(context: AudioContext, sound: TextClientSound, sequence: number): void {
  try {
    const samples = synthesizeSound(sound, sequence, context.sampleRate);
    const buffer = context.createBuffer(1, samples.length, context.sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.onended = () => source.disconnect();
    source.start();
  } catch {
    // Interaction audio is enhancement-only and must never interrupt input.
  }
}

function synthesizeSound(
  sound: TextClientSound,
  sequence: number,
  sampleRate: number,
): Float32Array<ArrayBuffer> {
  const profile = SOUND_PROFILES[sound];
  const sampleCount = Math.max(1, Math.floor(sampleRate * profile.durationMs / 1_000));
  const samples = new Float32Array(sampleCount);
  const noise = createNoise(SOUND_SEEDS[sound] ^ Math.imul(sequence, 0x9e3779b1));
  const timbreVariation = (Math.imul(sequence, 17) % 9 - 4) * 0.004;
  const surfaceResponse = Math.max(0.04, Math.min(0.42, profile.surfaceResponse + timbreVariation));
  let surface = 0;
  let body = 0;
  let thudPhase = 0;

  for (let index = 0; index < sampleCount; index += 1) {
    const white = noise();
    surface += surfaceResponse * (white - surface);
    body += profile.bodyResponse * (surface - body);

    const position = index / Math.max(1, sampleCount - 1);
    const envelope = soundEnvelope(sound, position);
    let thud = 0;
    if (sound === "navigate") {
      const frequency = 110 - position * 32;
      thudPhase += Math.PI * 2 * frequency / sampleRate;
      thud = Math.sin(thudPhase) * 0.34;
    }
    const texture = body * 0.54 + surface * 0.42 + white * profile.grain + thud;
    const fadeOut = Math.min(1, (sampleCount - 1 - index) / 48);
    samples[index] = texture * envelope * fadeOut * profile.gain * EFFECTS_GAIN;
  }

  return samples;
}

function soundEnvelope(sound: TextClientSound, position: number): number {
  if (sound === "character") {
    return pulse(position, 0, 0.68, 3.8) + pulse(position, 0.24, 0.52, 3.2) * 0.16;
  }
  if (sound === "space") {
    return pulse(position, 0, 0.9, 2.8) * 0.62 + pulse(position, 0.34, 0.5, 2.5) * 0.15;
  }
  if (sound === "delete") {
    return pulse(position, 0, 0.46, 2.5) * 0.48
      + pulse(position, 0.12, 0.86, 1.7) * 0.58
      + pulse(position, 0.44, 0.34, 2.2) * 0.18;
  }
  if (sound === "commit") {
    return pulse(position, 0, 0.42, 2.9) * 0.78
      + pulse(position, 0.21, 0.46, 2.5) * 0.55
      + pulse(position, 0.46, 0.54, 1.8) * 0.2;
  }
  return pulse(position, 0, 0.96, 2.4) * 0.82;
}

function pulse(position: number, start: number, span: number, decay: number): number {
  const local = (position - start) / span;
  if (local < 0 || local > 1) return 0;
  const attackPosition = Math.min(1, local / 0.065);
  const attack = attackPosition * attackPosition * (3 - 2 * attackPosition);
  return attack * (1 - local) ** decay;
}

function createNoise(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffff_ffff * 2 - 1;
  };
}
