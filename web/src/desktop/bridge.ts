import type { NativeCommand, NativeInput, NativeSnapshot } from "../app/services/platform/PlatformProvider";
import type { SessionStorage } from "../app/services/session/sessionService";

declare global {
  interface Window {
    __TAURI__?: { core: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> } };
  }
}

export function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!window.__TAURI__) return Promise.reject(new Error("Open this frontend in GSV Tauri Prototype."));
  return window.__TAURI__.core.invoke<T>(command, args);
}

export type DesktopSession = { generation: string; origin: string | null; values: Record<string, string> };

/** Synchronous session-service view backed by serialized, generation-fenced host writes. */
export function nativeSessionStorage(session: DesktopSession, onError: (message: string) => void, mock = false): SessionStorage {
  const values = { ...session.values };
  let pending = Promise.resolve();
  const persist = () => {
    if (mock) return;
    const snapshot = { ...values };
    pending = pending.then(() => invoke<void>("desktop_store", { generation: session.generation, values: snapshot }))
      .catch(() => onError("This session could not be saved. Sign in again after restarting."));
  };
  return {
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => { values[key] = value; persist(); },
    removeItem: (key) => { delete values[key]; persist(); },
  };
}

export function nativeInput(generation: string): NativeInput {
  return {
    attach: () => invoke<NativeSnapshot>("input_attach", { generation }),
    poll: (lease, ack) => invoke<NativeSnapshot>("input_poll", { lease, ack }),
    command: (lease: string, command: NativeCommand) => invoke<void>("input_command", { lease, command }),
  };
}
