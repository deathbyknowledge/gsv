export type TerminalTarget = {
  id: string;
  label: string;
  online: boolean;
  platform: string;
  description: string;
};

export type TerminalCommandInput = {
  input: string;
  target?: string | null;
  sessionId?: string | null;
  cwd?: string | null;
  timeoutMs?: number | string | null;
  yieldMs?: number | string | null;
  background?: boolean;
};

export type TerminalTranscriptEntry = {
  id: string;
  target: string;
  command: string;
  cwd: string;
  timeoutMs: number | null;
  yieldMs: number | null;
  background: boolean;
  startedAt: number;
  completedAt: number;
  status: "completed" | "running" | "failed";
  stdout: string;
  stderr: string;
  exitCode: number | null;
  sessionId: string | null;
  truncated: boolean;
};
