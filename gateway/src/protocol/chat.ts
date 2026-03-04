import type { SessionOutputContext } from "./channel";

export type ChatEventPayload = {
  runId: string | null;
  sessionKey: string;
  threadId?: string;
  stateId?: string;
  state: "partial" | "final" | "error" | "paused";
  message?: unknown;
  error?: string;
  channelContext?: SessionOutputContext;
};
