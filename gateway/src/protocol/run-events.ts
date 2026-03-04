export type RunProgressPhase =
  | "run_started"
  | "tool_dispatched"
  | "tool_result"
  | "paused"
  | "resumed"
  | "run_finished"
  | "run_error"
  | "run_aborted";

export type RunProgressToolPayload = {
  callId: string;
  name: string;
  args?: Record<string, unknown>;
  isError?: boolean;
  error?: string;
};

export type RunProgressEventPayload = {
  runId: string | null;
  sessionKey: string;
  phase: RunProgressPhase;
  timestamp: number;
  tool?: RunProgressToolPayload;
  message?: string;
};
