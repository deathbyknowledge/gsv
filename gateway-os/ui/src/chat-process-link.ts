export const OPEN_CHAT_PROCESS_EVENT = "gsv:open-chat-process";
export const TARGET_CHAT_PROCESS_EVENT = "gsv:target-chat-process";

const PENDING_TARGETS_KEY = "__gsvPendingChatProcessTargets";

type PendingTargetStore = Map<string, string>;

declare global {
  interface Window {
    [PENDING_TARGETS_KEY]?: PendingTargetStore;
  }
}

export type OpenChatProcessEventDetail = {
  pid: string;
};

export type TargetChatProcessEventDetail = {
  pid: string;
  windowId: string;
};

function getPendingStore(): PendingTargetStore {
  const existing = window[PENDING_TARGETS_KEY];
  if (existing instanceof Map) {
    return existing;
  }

  const created = new Map<string, string>();
  window[PENDING_TARGETS_KEY] = created;
  return created;
}

export function normalizeProcessId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function queuePendingChatProcess(windowId: string, pid: string): void {
  getPendingStore().set(windowId, pid);
}

export function consumePendingChatProcess(windowId: string): string | null {
  const store = getPendingStore();
  const pid = store.get(windowId) ?? null;
  if (pid !== null) {
    store.delete(windowId);
  }
  return pid;
}
