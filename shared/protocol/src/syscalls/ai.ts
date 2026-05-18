export type AiTranscriptionCreateArgs = {
  audio: {
    data: string;
    mimeType: string;
    filename?: string;
    size?: number;
  };
  language?: string;
  prompt?: string;
  mode?: "transcribe" | "translate";
};

export type AiTranscriptionCreateResult = {
  text: string;
  language?: string;
  duration?: number;
  segments?: unknown[];
  provider: string;
  model: string;
};

export type AiSpeechCreateArgs = {
  text: string;
  textFormat?: "markdown" | "plain";
  model?: string;
  voice?: string;
  language?: string;
  encoding?: string;
  container?: string;
  sampleRate?: number;
  bitRate?: number;
};

export type AiSpeechCreateResult = {
  audio: {
    data: string;
    mimeType: string;
    size: number;
  };
  provider: string;
  model: string;
  voice?: string;
  encoding?: string;
  container?: string;
  skipped?: boolean;
};
