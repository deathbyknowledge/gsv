export const TARGET_CHAT_PROCESS_EVENT = "gsv:target-chat-process";

export type TargetChatProcess = {
  conversationId: string | null;
  pid: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeTargetChatProcess(value: unknown): TargetChatProcess | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const pid = asTrimmedString(record.pid) || asTrimmedString(record.processId);
  if (!pid) {
    return null;
  }
  const conversationId = asTrimmedString(record.conversationId);
  return {
    pid,
    conversationId: conversationId || null,
  };
}

export function dispatchTargetChatProcess(target: TargetChatProcess): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent(TARGET_CHAT_PROCESS_EVENT, { detail: target }));
}
