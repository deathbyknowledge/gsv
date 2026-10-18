import { createContext, type ComponentChildren } from "preact";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { z } from "zod";
import { soundPreferences } from "./inputSounds";
import { shortcutDefaults } from "./shortcutKeys";

export type SpeechStatus = { phase: string; id: string | null; error: string | null };
export type SpeechLanguage = "en" | "es";
export type ShortcutStatus = { description: string; managed: boolean; can_configure: boolean; error: string | null };
export type SpeechEvent =
  | { kind: "status"; status: SpeechStatus }
  | { kind: "shortcut"; action: "press" | "release" | "cancel"; sent_at_ms: number }
  | ({ kind: "shortcuts" } & ShortcutStatus);
export type SpeechCommand =
  | { kind: "prepare" | "cancel" }
  | { kind: "speak"; id: string; chunks: string[]; language: SpeechLanguage }
  | { kind: "cue"; cue: "listening" | "sent" | "cancelled" | "attention" };
export type ShortcutSettings = { enabled: boolean; talk: string; stop: string };
export type NativeSpeechDriver = {
  subscribe(receive: (event: SpeechEvent) => void): { initial: Promise<SpeechStatus>; dispose(): void };
  command(command: SpeechCommand): Promise<void>;
  configure(settings: ShortcutSettings): Promise<void>;
  editShortcuts(): Promise<void>;
};

const preferencesSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(["toggle", "hold"]),
  replies: z.enum(["voice", "all", "off"]),
  talk: z.string().min(1).max(80),
  stop: z.string().min(1).max(80),
});
export type SpeechPreferences = z.infer<typeof preferencesSchema>;
const key = "gsv.desktop.voice.v1";
function readPreferences(): SpeechPreferences {
  try { return preferencesSchema.parse(JSON.parse(localStorage.getItem(key) ?? "null")); }
  catch { return { enabled: false, mode: "toggle", replies: "voice", ...shortcutDefaults() }; }
}

type NativeSpeech = {
  preferences: SpeechPreferences;
  setPreferences(patch: Partial<SpeechPreferences>): void;
  status: SpeechStatus;
  shortcuts: ShortcutStatus | null;
  captureShortcuts(active: boolean): Promise<boolean>;
  applyShortcuts(talk: string, stop: string): Promise<boolean>;
  editShortcuts(): Promise<void>;
  error: string | null;
  command(command: SpeechCommand): Promise<boolean>;
  cue(cue: "listening" | "sent" | "cancelled" | "attention"): void;
  register(handler: (action: "press" | "release" | "cancel") => void): () => void;
  voiceSent(): void;
  typed(): void;
  recording(active: boolean): void;
  shouldSpeak(): boolean;
};
const Context = createContext<NativeSpeech | null>(null);
export const useNativeSpeech = () => useContext(Context);

export function NativeSpeechProvider({ driver, active, children }: {
  driver: NativeSpeechDriver; active: boolean; children: ComponentChildren;
}) {
  const [preferences, setPreferences] = useState(readPreferences);
  const [status, setStatus] = useState<SpeechStatus>({ phase: "idle", id: null, error: null });
  const [shortcuts, setShortcuts] = useState<ShortcutStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<((action: "press" | "release" | "cancel") => void) | null>(null);
  const spokenConversation = useRef(false);
  const recording = useRef(false);
  const capturingShortcut = useRef(false);
  const current = useRef({ active, preferences });
  current.current = { active, preferences };
  const updatePreferences = useCallback((patch: Partial<SpeechPreferences>) => {
    setPreferences((before) => {
      const next = { ...before, ...patch };
      try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Keep the current session setting. */ }
      return next;
    });
  }, []);
  const actions = useMemo(() => {
    const command = async (command: SpeechCommand) => {
      try { await driver.command(command); return true; }
      catch (error) { setError(String(error)); return false; }
    };
    return {
      command,
      async captureShortcuts(capturing: boolean) {
        if (capturing && recording.current) { setError("Finish recording before choosing a shortcut."); return false; }
        capturingShortcut.current = capturing;
        const { active, preferences } = current.current;
        try {
          await driver.configure({ enabled: active && preferences.enabled && !capturing, talk: preferences.talk, stop: preferences.stop });
          return active && preferences.enabled;
        } catch (error) { setError(String(error)); return false; }
      },
      async applyShortcuts(talk: string, stop: string) {
        setError(null);
        try {
          const { active, preferences } = current.current;
          await driver.configure({ enabled: active && preferences.enabled, talk, stop });
          updatePreferences({ talk, stop });
          return true;
        } catch (error) { setError(String(error)); return false; }
      },
      async editShortcuts() {
        setError(null);
        try { await driver.editShortcuts(); } catch (error) { setError(String(error)); }
      },
      cue(cue: "listening" | "sent" | "cancelled" | "attention") {
        if (current.current.active && current.current.preferences.enabled && soundPreferences().voice) void command({ kind: "cue", cue });
      },
      register(handler: (action: "press" | "release" | "cancel") => void) {
        controller.current = handler;
        return () => { if (controller.current === handler) controller.current = null; };
      },
      voiceSent() { spokenConversation.current = true; },
      typed() { spokenConversation.current = false; },
      recording(active: boolean) { recording.current = active; },
      shouldSpeak() {
        const { active, preferences } = current.current;
        return active && !recording.current && preferences.enabled && (preferences.replies === "all" || (preferences.replies === "voice" && spokenConversation.current));
      },
    };
  }, [driver, updatePreferences]);
  useEffect(() => {
    let mounted = true;
    const subscription = driver.subscribe((event) => {
      if (!mounted) return;
      if (event.kind === "status") setStatus(event.status);
      else if (event.kind === "shortcuts") { setShortcuts(event); setError(event.error); }
      else if (!capturingShortcut.current && current.current.active && current.current.preferences.enabled && Math.abs(Date.now() - event.sent_at_ms) < 1000) {
        if (event.action === "cancel") void actions.command({ kind: "cancel" });
        if (controller.current) controller.current(event.action);
        else if (event.action === "press") {
          actions.cue("attention");
          setError("Handsfree mode is not ready. Reconnect microphone controls in Settings → voice.");
        }
      }
    });
    void subscription.initial.then((status) => { if (mounted) setStatus(status); }).catch((error) => { if (mounted) setError(String(error)); });
    return () => { mounted = false; subscription.dispose(); void driver.command({ kind: "cancel" }).catch(() => {}); };
  }, [driver, actions]);
  useEffect(() => {
    let mounted = true;
    setError(null);
    void driver.configure({ enabled: active && preferences.enabled && !capturingShortcut.current, talk: preferences.talk, stop: preferences.stop })
      .catch((error) => { if (mounted) setError(String(error)); });
    if (active && preferences.enabled && preferences.replies !== "off") void actions.command({ kind: "prepare" });
    else { spokenConversation.current = false; void actions.command({ kind: "cancel" }); }
    return () => { mounted = false; };
  }, [driver, active, preferences, actions]);
  useEffect(() => {
    if (!active || !preferences.enabled || !navigator.locks) return;
    const cancelled = new AbortController();
    let release = () => {};
    // A native voice session must keep its authenticated frontend alive while minimized.
    void navigator.locks.request("ship-desktop-voice", { signal: cancelled.signal }, () =>
      new Promise<void>((resolve) => { release = resolve; })).catch(() => {});
    return () => { release(); cancelled.abort(); };
  }, [active, preferences.enabled]);
  const value: NativeSpeech = {
    ...actions, preferences, status, shortcuts, error: error || status.error,
    setPreferences: updatePreferences,
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
