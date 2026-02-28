import type { SessionOutputContext } from "./channel";

export type ChatEventPayload = {
  runId: string | null;
  sessionKey: string;
  state: "partial" | "final" | "error";
  message?: unknown;
  error?: string;
  channelContext?: SessionOutputContext;
};
