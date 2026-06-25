export function runIdFromSignalPayload(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  return typeof payload.runId === "string" && payload.runId.length > 0 ? payload.runId : null;
}

export function isPresenceRunSignal(signal: string): boolean {
  return signal === "chat.text"
    || signal === "chat.tool_call"
    || signal === "chat.tool_result"
    || signal === "chat.hil"
    || signal === "chat.complete"
    || signal === "proc.run.stream"
    || signal === "proc.run.retrying"
    || signal === "proc.run.output"
    || signal === "proc.run.tool.started"
    || signal === "proc.run.tool.finished"
    || signal === "proc.run.hil.requested"
    || signal === "proc.run.finished";
}

export function signalPayloadError(payload: unknown): string | null {
  if (!isRecord(payload) || typeof payload.error !== "string") {
    return null;
  }
  const error = payload.error.trim();
  return error.length > 0 ? error : null;
}

export function signalPayloadAborted(payload: unknown): boolean {
  return isRecord(payload) && payload.aborted === true;
}

export function signalPayloadText(payload: unknown): string | null {
  if (!isRecord(payload) || typeof payload.text !== "string") {
    return null;
  }
  const text = payload.text.trim();
  return text.length > 0 ? text : null;
}

export function signalPayloadToolLabel(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  const syscall = typeof payload.syscall === "string" ? payload.syscall.trim() : "";
  const label = name || syscall;
  return label.length > 0 ? label : null;
}

export function signalPayloadStreamTextDelta(payload: unknown): string | null {
  const event = signalPayloadStreamEvent(payload);
  if (!event || event.type !== "text_delta" || typeof event.delta !== "string") {
    return null;
  }
  return event.delta.length > 0 ? event.delta : null;
}

export function signalPayloadStreamToolLabel(payload: unknown): string | null {
  const event = signalPayloadStreamEvent(payload);
  if (!event) {
    return null;
  }
  const type = typeof event.type === "string" ? event.type : "";
  if (type !== "toolcall_start" && type !== "toolcall_delta" && type !== "toolcall_end") {
    return null;
  }
  const toolCall = isRecord(event.toolCall) ? event.toolCall : streamToolCallBlock(event);
  if (!toolCall) {
    return null;
  }
  const name = typeof toolCall.name === "string" ? toolCall.name.trim() : "";
  const syscall = typeof toolCall.syscall === "string" ? toolCall.syscall.trim() : "";
  const label = name || syscall;
  return label.length > 0 ? label : null;
}

function signalPayloadStreamEvent(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload) || !isRecord(payload.event)) {
    return null;
  }
  return payload.event;
}

function streamToolCallBlock(event: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof event.contentIndex !== "number") {
    return null;
  }
  const partial = isRecord(event.partial) ? event.partial : null;
  const content = Array.isArray(partial?.content) ? partial.content : [];
  const block = content[event.contentIndex];
  return isRecord(block) && block.type === "toolCall" ? block : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
