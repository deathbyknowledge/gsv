import type { ThreadContext } from "@humansandmachines/gsv/sdk/host";

export const TARGET_CHAT_PROCESS_EVENT = "gsv:target-chat-process";

const PENDING_TARGETS_KEY = "__gsvPendingChatProcessTargets";

type PendingTargetStore = Map<string, ThreadContext>;

declare global {
  interface Window {
    [PENDING_TARGETS_KEY]?: PendingTargetStore;
  }
}

export type TargetChatProcessEventDetail = ThreadContext & {
  windowId: string;
};

function getPendingStore(): PendingTargetStore {
  const existing = window[PENDING_TARGETS_KEY];
  if (existing instanceof Map) {
    return existing;
  }

  const created = new Map<string, ThreadContext>();
  window[PENDING_TARGETS_KEY] = created;
  return created;
}

export function queuePendingChatProcess(windowId: string, detail: ThreadContext): void {
  getPendingStore().set(windowId, detail);
}
