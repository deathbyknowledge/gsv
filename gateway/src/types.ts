
export type RequestFrame<Params = unknown> = {
  type: "req";
  id: string;
  method: string;
  params?: Params;
};

export type ErrorShape = {
  code: number;
  message: string;
  details?: unknown;
  retryable?: boolean;
};

export type ResponseFrame<Payload = unknown> =
  | { type: "res"; id: string; ok: true; payload?: Payload }
  | { type: "res"; id: string; ok: false; error: ErrorShape };

export type EventFrame<Payload = unknown> = {
  type: "evt";
  event: string;
  payload?: Payload;
  seq?: number;
};

export type Frame = RequestFrame | ResponseFrame | EventFrame;

export type ConnectParams = {
  minProtocol: number;
  maxProtocol: number;
  client: {
    id: string;
    version: string;
    platform: string;
    mode: "client" | "node";
  };
  tools?: ToolDefinition[];
};

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ChatSendParams = {
  sessionKey: string;
  message: string;
  runId: string;
};

export type ToolRequestParams = {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  sessionKey: string;
};

export type ToolResultParams = {
  callId: string;
  result?: unknown;
  error?: string;
};

export type ToolInvokePayload = {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
};

export type ChatEventPayload = {
  runId: string | null;
  sessionKey: string;
  state: "partial" | "final" | "error";
  message?: unknown;
  error?: string;
};

export type Message = {
  role: "user" | "assistant" | "tool";
  content: string | unknown[];
  toolCallId?: string;
};

export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
};
