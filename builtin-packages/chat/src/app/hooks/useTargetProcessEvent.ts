import { getAppClientId } from "@gsv/package/host";
import { useEffect } from "preact/hooks";
import type { ThreadContext } from "../types";
import { asRecord, asString, normalizeThreadContext } from "../view-helpers";

const TARGET_CHAT_PROCESS_EVENT = "gsv:target-chat-process";
const PENDING_TARGETS_KEY = "__gsvPendingChatProcessTargets";
const WINDOW_ID = getAppClientId();

export function useTargetProcessEvent(onTarget: (target: ThreadContext) => void) {
  useEffect(() => {
    function handleTargetEvent(event: Event) {
      const detail = asRecord((event as CustomEvent).detail);
      if (!detail) {
        return;
      }
      const targetWindowId = asString(detail.windowId)?.trim() || "";
      if (WINDOW_ID && targetWindowId && targetWindowId !== WINDOW_ID) {
        return;
      }
      const next = normalizeThreadContext(detail);
      if (next) {
        onTarget(next);
      }
    }

    try {
      const store = window.parent?.[PENDING_TARGETS_KEY as keyof Window];
      if (WINDOW_ID && store instanceof Map && store.has(WINDOW_ID)) {
        const pending = normalizeThreadContext(store.get(WINDOW_ID));
        store.delete(WINDOW_ID);
        if (pending) {
          onTarget(pending);
        }
      }
      window.parent?.addEventListener(TARGET_CHAT_PROCESS_EVENT, handleTargetEvent);
    } catch {
      // Ignore parent access issues outside the desktop shell.
    }
    return () => {
      try {
        window.parent?.removeEventListener(TARGET_CHAT_PROCESS_EVENT, handleTargetEvent);
      } catch {}
    };
  }, [onTarget]);
}
