import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { ChatFeedbackStatus } from "../components/ChatFeedbackMessage";

/** One ephemeral feedback line shown at the tail of the transcript. Never
 *  server-persisted — session-local operation status only. */
export type ChatFeedbackEntry = {
  /** Operation key ("compact", "abort", "voice"); re-begin replaces. */
  key: string;
  /** Stable render key for this occurrence of the operation. */
  id: string;
  status: ChatFeedbackStatus;
  label: string;
  /** Persist after resolve (compact/stop) vs auto-remove (voice). */
  persist: boolean;
};

const TRANSIENT_LINGER_MS = 2500;

export type ChatFeedback = {
  entries: readonly ChatFeedbackEntry[];
  /** Start (or restart) an operation line in the running state. */
  begin: (key: string, label: string, options?: { persist?: boolean }) => void;
  /** Update the label of a running line (e.g. Listening… → Transcribing…). */
  update: (key: string, label: string) => void;
  /** Mark the outcome; transient lines linger briefly then disappear. */
  resolve: (key: string, status: "success" | "error", label?: string) => void;
  /** Remove a line immediately. */
  clear: (key: string) => void;
  /** Drop everything (e.g. when switching process). */
  reset: () => void;
};

export function useChatFeedback(): ChatFeedback {
  const [entries, setEntries] = useState<ChatFeedbackEntry[]>([]);
  const entriesRef = useRef<ChatFeedbackEntry[]>([]);
  const counterRef = useRef(0);
  const timersRef = useRef(new Map<string, ReturnType<typeof globalThis.setTimeout>>());

  const apply = useCallback((updater: (current: ChatFeedbackEntry[]) => ChatFeedbackEntry[]) => {
    setEntries((current) => {
      const next = updater(current);
      entriesRef.current = next;
      return next;
    });
  }, []);

  const clearTimer = useCallback((key: string) => {
    const timer = timersRef.current.get(key);
    if (timer !== undefined) {
      globalThis.clearTimeout(timer);
      timersRef.current.delete(key);
    }
  }, []);

  useEffect(() => () => {
    for (const timer of timersRef.current.values()) {
      globalThis.clearTimeout(timer);
    }
    timersRef.current.clear();
  }, []);

  const begin = useCallback((key: string, label: string, options?: { persist?: boolean }) => {
    clearTimer(key);
    counterRef.current += 1;
    const entry: ChatFeedbackEntry = {
      key,
      id: `${key}:${counterRef.current}`,
      label,
      persist: options?.persist ?? true,
      status: "running",
    };
    apply((current) => [...current.filter((item) => item.key !== key), entry]);
  }, [apply, clearTimer]);

  const update = useCallback((key: string, label: string) => {
    apply((current) => current.map((item) => item.key === key ? { ...item, label } : item));
  }, [apply]);

  const clear = useCallback((key: string) => {
    clearTimer(key);
    apply((current) => current.filter((item) => item.key !== key));
  }, [apply, clearTimer]);

  const resolve = useCallback((key: string, status: "success" | "error", label?: string) => {
    clearTimer(key);
    const existing = entriesRef.current.find((item) => item.key === key);
    if (!existing) {
      return;
    }
    apply((current) => current.map((item) => item.key === key
      ? { ...item, status, label: label ?? item.label }
      : item));
    if (!existing.persist) {
      const timer = globalThis.setTimeout(() => {
        timersRef.current.delete(key);
        apply((current) => current.filter((item) => item.key !== key));
      }, TRANSIENT_LINGER_MS);
      timersRef.current.set(key, timer);
    }
  }, [apply, clearTimer]);

  const reset = useCallback(() => {
    for (const timer of timersRef.current.values()) {
      globalThis.clearTimeout(timer);
    }
    timersRef.current.clear();
    apply(() => []);
  }, [apply]);

  return { entries, begin, update, resolve, clear, reset };
}
