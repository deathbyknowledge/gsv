import { z } from "zod";
import type { NativeCommand, NativeInput, NativeSnapshot, NativeUpdate } from "../app/services/platform/PlatformProvider";
import type { SessionService, SessionStorage } from "../app/services/session/sessionService";
import type { ControlEvent, ControlReply } from "./control";
import type { MachineCommand, MachineSnapshot, NativeMachine } from "./machineSetup";
import type { WelcomeSnapshot, WelcomeState } from "../app/services/session/ownerWelcome";
import type { NativeSpeechDriver, SpeechCommand, SpeechEvent, SpeechStatus, ShortcutSettings } from "../app/services/platform/NativeSpeech";
import { t, type TextKey } from "../app/i18n/locale";

export type DesktopSession = { generation: string; origin: string | null; values: Record<string, string> };
type NativeChannel<T> = { onmessage: (message: T) => void };
type DesktopCommands = {
  desktop_session: { args: undefined; result: DesktopSession };
  desktop_configure: { args: { origin: string | null; onboardingToken?: string | null }; result: DesktopSession };
  desktop_store: { args: { generation: string; values: Record<string, string> }; result: void };
  desktop_welcome: { args: undefined; result: WelcomeSnapshot };
  desktop_save_welcome: { args: { revision: string; value: WelcomeState | null }; result: WelcomeSnapshot };
  desktop_open: { args: { url: string }; result: void };
  desktop_quit: { args: undefined; result: void };
  machine_status: { args: { generation: string; username: string }; result: MachineSnapshot };
  machine_command: { args: { generation: string; username: string; command: MachineCommand }; result: MachineSnapshot };
  control_attach: { args: { generation: string; updates: NativeChannel<ControlEvent> }; result: string };
  control_detach: { args: { lease: string }; result: void };
  control_active: { args: { lease: string; id: string }; result: boolean };
  control_reply: { args: { lease: string; id: string; reply: ControlReply }; result: void };
  input_attach: { args: { generation: string; updates: NativeChannel<NativeUpdate> }; result: NativeSnapshot };
  input_acknowledge: { args: { lease: string; revision: number; ack: number }; result: void };
  input_command: { args: { lease: string; command: NativeCommand }; result: void };
  speech_attach: { args: { generation: string; updates: NativeChannel<SpeechEvent> }; result: SpeechStatus };
  speech_command: { args: { generation: string; command: SpeechCommand }; result: void };
  shortcuts_configure: { args: { generation: string; settings: ShortcutSettings }; result: void };
  shortcuts_edit: { args: { generation: string }; result: void };
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
      event: {
        listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void>;
      };
    };
  }
}

export function invoke<C extends keyof DesktopCommands>(command: C, ...args: CommandArguments<C>): Promise<DesktopCommands[C]["result"]> {
  if (!window.__TAURI__) return Promise.reject(new Error(t("desktop.errors.openInShip")));
  return window.__TAURI__.core.invoke(command, ...args);
}

export async function openInBrowser(url: string): Promise<void> {
  try { await invoke("desktop_open", { url }); }
  catch { throw new Error(t("desktop.errors.openBrowser")); }
}

/** Synchronous session-service view backed by serialized, generation-fenced host writes. */
export type NativeSessionStorage = SessionStorage & {
  flush(): Promise<void>;
  /** Native operations require the saved identity, which may lag behind gateway sign-in. */
  subscribeSignedIn(listener: (username: string | null) => void): () => void;
};

const nativeLoginSchema = z.object({ username: z.string().min(1), token: z.string().min(1) });

function savedUsername(values: Record<string, string>): string | null {
  try { return nativeLoginSchema.parse(JSON.parse(values["gsv.ui.session.token.v1"] ?? "null")).username; }
  catch { return null; }
}

export function nativeSessionStorage(session: DesktopSession, onError: (message: TextKey) => void, mock = false): NativeSessionStorage {
  const values = { ...session.values };
  let pending = Promise.resolve();
  let username = savedUsername(values);
  const listeners = new Set<(username: string | null) => void>();
  const persist = () => {
    if (mock) return;
    const snapshot = { ...values };
    pending = pending.catch(() => {}).then(async () => {
      await invoke("desktop_store", { generation: session.generation, values: snapshot });
      const next = savedUsername(snapshot);
      if (next === username) return;
      username = next;
      listeners.forEach((listener) => listener(username));
    });
    void pending.catch(() => onError("desktop.errors.sessionNotSaved"));
  };
  return {
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => { values[key] = value; persist(); },
    removeItem: (key) => { delete values[key]; persist(); },
    flush: () => pending,
    subscribeSignedIn: (listener) => {
      listeners.add(listener);
      listener(username);
      return () => { listeners.delete(listener); };
    },
  };
}

export async function disconnectSpace(service: SessionService, storage: NativeSessionStorage): Promise<void> {
  await service.lock("Disconnected");
  await storage.flush();
  await invoke("desktop_configure", { origin: null });
  service.dispose?.();
}

export function nativeInput(generation: string): NativeInput {
  return {
    subscribe: (receive) => {
      if (!window.__TAURI__) throw new Error(t("desktop.errors.openInShip"));
      const updates = new window.__TAURI__.core.Channel<NativeUpdate>(receive);
      const initial = invoke("input_attach", { generation, updates });
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

export function nativeSpeech(generation: string): NativeSpeechDriver {
  let configured = Promise.resolve();
  return {
    subscribe(receive) {
      if (!window.__TAURI__) throw new Error(t("desktop.errors.openInShip"));
      const updates = new window.__TAURI__.core.Channel<SpeechEvent>(receive);
      return { initial: invoke("speech_attach", { generation, updates }), dispose() { updates.onmessage = () => {}; } };
    },
    command: (command) => invoke("speech_command", { generation, command }),
    editShortcuts: () => invoke("shortcuts_edit", { generation }),
    configure(settings) {
      configured = configured.catch(() => {}).then(() => invoke("shortcuts_configure", { generation, settings }));
      return configured;
    },
  };
}

export function nativeMachine(generation: string, username: string): NativeMachine {
  return {
    status: async () => {
      try { return await invoke("machine_status", { generation, username }); }
      catch (error) {
        const message = z.string().safeParse(error);
        throw new Error(message.success ? message.data : t("desktop.machine.checkFailed"));
      }
    },
    command: async (command) => {
      try { return await invoke("machine_command", { generation, username, command }); }
      catch (error) {
        const message = z.string().safeParse(error);
        throw new Error(message.success ? message.data : t("desktop.machine.connectFailed"));
      }
    },
  };
}
