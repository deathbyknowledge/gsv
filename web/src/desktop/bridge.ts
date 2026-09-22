import type { NativeCommand, NativeInput, NativeSnapshot, NativeUpdate } from "../app/services/platform/PlatformProvider";
import type { SessionStorage } from "../app/services/session/sessionService";

export type DesktopSession = { generation: string; origin: string | null; values: Record<string, string> };
type NativeChannel<T> = { onmessage: (message: T) => void };
type DesktopCommands = {
  desktop_session: { args: undefined; result: DesktopSession };
  desktop_configure: { args: { origin: string | null }; result: DesktopSession };
  desktop_store: { args: { generation: string; values: Record<string, string> }; result: void };
  desktop_open: { args: { url: string }; result: void };
  desktop_quit: { args: undefined; result: void };
  input_attach: { args: { generation: string; updates: NativeChannel<NativeUpdate>; practice: boolean }; result: NativeSnapshot };
  input_acknowledge: { args: { lease: string; revision: number; ack: number }; result: void };
  input_command: { args: { lease: string; command: NativeCommand }; result: void };
};
type CommandArguments<C extends keyof DesktopCommands> = DesktopCommands[C]["args"] extends undefined
  ? [] : [args: DesktopCommands[C]["args"]];

declare global {
  interface Window {
    __TAURI__?: {
      core: {
        invoke<C extends keyof DesktopCommands>(command: C, ...args: CommandArguments<C>): Promise<DesktopCommands[C]["result"]>;
        Channel: new<T>(receive?: (message: T) => void) => NativeChannel<T>;
      };
      window: {
        getCurrentWindow(): {
          onCloseRequested(handler: (event: { preventDefault(): void }) => void): Promise<() => void>;
        };
      };
    };
  }
}

export function invoke<C extends keyof DesktopCommands>(command: C, ...args: CommandArguments<C>): Promise<DesktopCommands[C]["result"]> {
  if (!window.__TAURI__) return Promise.reject(new Error("Open this frontend in GSV Tauri Prototype."));
  return window.__TAURI__.core.invoke(command, ...args);
}

export async function openInBrowser(url: string): Promise<void> {
  try { await invoke("desktop_open", { url }); }
  catch { throw new Error("Could not open your browser."); }
}

/** Synchronous session-service view backed by serialized, generation-fenced host writes. */
export function nativeSessionStorage(session: DesktopSession, onError: (message: string) => void, mock = false): SessionStorage {
  const values = { ...session.values };
  let pending = Promise.resolve();
  const persist = () => {
    if (mock) return;
    const snapshot = { ...values };
    pending = pending.then(() => invoke("desktop_store", { generation: session.generation, values: snapshot }))
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
    subscribe: (receive, practice = false) => {
      if (!window.__TAURI__) throw new Error("Open this frontend in GSV Tauri Prototype.");
      const updates = new window.__TAURI__.core.Channel<NativeUpdate>(receive);
      const initial = invoke("input_attach", { generation, updates, practice });
      let disposed = false;
      return { initial, dispose() {
        if (disposed) return;
        disposed = true;
        updates.onmessage = () => {};
        void initial.then(({ lease }) => invoke("input_command", { lease, command: { kind: "detach" } })).catch(() => {});
      } };
    },
    acknowledge: (lease, revision, ack) => invoke("input_acknowledge", { lease, revision, ack }),
    command: (lease: string, command: NativeCommand) => invoke("input_command", { lease, command }),
  };
}
