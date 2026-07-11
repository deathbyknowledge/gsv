export type PresenceMode = "ambient" | "push";

export type PresenceState =
  | "idle"
  | "listening"
  | "capturing"
  | "recording"
  | "transcribing"
  | "sending"
  | "unsupported"
  | "error";

export type PresenceLogStatus =
  | "Sending"
  | "Queued"
  | "Working"
  | "Responding"
  | "Using tools"
  | "Needs approval"
  | "Done"
  | "Stopped"
  | "Failed";

export type PresenceSendResult = {
  runId: string;
  queued?: boolean;
};

export type PresenceRun = {
  logId: string | null;
  prompt: string;
  answer: string;
  status: PresenceLogStatus;
  updatedAt: number;
  timing?: VoiceTimingTrace;
  speechCursor?: number;
  speechChunkIndex?: number;
  speechStarted?: boolean;
};

export type BufferedRunSignal = {
  signal: string;
  payload: unknown;
  receivedAt: number;
};

export type SpeechChunk = {
  text: string;
  index: number;
  total: number;
};

export type VoiceTimingTrace = {
  id: string;
  source: "ambient" | "manual";
  createdAt: number;
  marks: Record<string, number>;
  chunks: VoiceTimingChunk[];
  runId?: string;
  promptChars?: number;
  answerChars?: number;
  error?: string;
  lastChunkEndedAt?: number;
  logged?: boolean;
};

export type VoiceTimingChunk = {
  index: number;
  chars: number;
  requestStartedAt: number;
  audioReadyAt?: number;
  playbackStartedAt?: number;
  playbackEndedAt?: number;
  provider?: string;
  model?: string;
  gapMs?: number;
};
