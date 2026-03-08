export type SessionSendResult =
  | {
      ok: true;
      status: "started";
      runId: string;
      queued?: boolean;
    }
  | {
      ok: true;
      status: "command";
      command: string;
      response?: string;
      error?: string;
    }
  | { ok: false; error: string };

export type ResetResult = {
  ok: true;
  archivedMessages: number;
  archivedTo?: string;
  newSessionId: string;
};

export type HistoryMessage = {
  role: "user" | "assistant" | "system";
  content: unknown;
  timestamp?: number;
};

export type HistoryResult = {
  sessionId: string;
  messages: HistoryMessage[];
  messageCount: number;
  truncated?: boolean;
};
