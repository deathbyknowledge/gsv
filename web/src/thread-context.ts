export { normalizeThreadContext, type ThreadContext } from "@gsv/app-link";
import { normalizeThreadContext, type ThreadContext } from "@gsv/app-link";

export const ACTIVE_THREAD_CONTEXT_EVENT = "gsv:active-thread-context";

const ACTIVE_THREAD_CONTEXT_KEY = "gsv.activeThreadContext.v1";

export function getActiveThreadContext(): ThreadContext | null {
  try {
    const raw = window.localStorage.getItem(ACTIVE_THREAD_CONTEXT_KEY);
    if (!raw) {
      return null;
    }
    return normalizeThreadContext(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function setActiveThreadContext(value: ThreadContext | null): void {
  const normalized = normalizeThreadContext(value);

  try {
    if (normalized) {
      window.localStorage.setItem(ACTIVE_THREAD_CONTEXT_KEY, JSON.stringify(normalized));
    } else {
      window.localStorage.removeItem(ACTIVE_THREAD_CONTEXT_KEY);
    }
  } catch {
    // Ignore storage failures and still emit the runtime event.
  }

  window.dispatchEvent(
    new CustomEvent<ThreadContext | null>(ACTIVE_THREAD_CONTEXT_EVENT, {
      detail: normalized,
    }),
  );
}

export function subscribeActiveThreadContext(
  listener: (context: ThreadContext | null) => void,
): () => void {
  const handler = (event: Event): void => {
    if (!(event instanceof CustomEvent)) {
      return;
    }
    listener(normalizeThreadContext(event.detail));
  };

  window.addEventListener(ACTIVE_THREAD_CONTEXT_EVENT, handler as EventListener);
  listener(getActiveThreadContext());
  return () => {
    window.removeEventListener(ACTIVE_THREAD_CONTEXT_EVENT, handler as EventListener);
  };
}
