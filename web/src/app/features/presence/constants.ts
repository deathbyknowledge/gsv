export const VOICE_AUDIO_BITS_PER_SECOND = 128000;
export const MAX_PUSH_RECORDING_MS = 2 * 60 * 1000;
export const MAX_AMBIENT_SEGMENT_MS = 45 * 1000;
export const AMBIENT_SAMPLE_MS = 100;
export const AMBIENT_START_MS = 100;
export const AMBIENT_END_SILENCE_MS = 1100;
export const AMBIENT_MIN_SEGMENT_MS = 450;
export const AMBIENT_MIN_SEGMENT_BYTES = 900;
export const AMBIENT_RMS_THRESHOLD = 0.018;
export const SPEECH_FIRST_CHUNK_MIN_CHARS = 48;
export const SPEECH_FIRST_CHUNK_TARGET_CHARS = 90;
export const SPEECH_FIRST_CHUNK_MAX_CHARS = 120;
export const SPEECH_CHUNK_MAX_CHARS = 420;
export const SPEECH_PREFETCH_CONCURRENCY = 3;
export const INTERIM_SPEECH_COOLDOWN_MS = 7000;
export const RUN_SIGNAL_BUFFER_TTL_MS = 60 * 1000;
export const MAX_BUFFERED_RUN_SIGNALS = 64;

export const PRESENCE_RECORDER_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/webm",
];
