import { createContext, type ComponentChildren } from "preact";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { z } from "zod";
import { soundPreferences } from "./inputSounds";
import { ShortcutRecorder } from "./ShortcutRecorder";
import { shortcutDefaults } from "./shortcutKeys";

export type SpeechStatus = { phase: string; id: string | null; error: string | null };
export type ShortcutStatus = { description: string; managed: boolean; can_configure: boolean; error: string | null };
export type SpeechEvent =
  | { kind: "status"; status: SpeechStatus }
  | { kind: "shortcut"; action: "press" | "release" | "cancel"; sent_at_ms: number }
  | ({ kind: "shortcuts" } & ShortcutStatus);
export type SpeechCommand =
  | { kind: "prepare" | "cancel" }
  | { kind: "speak"; id: string; chunks: string[]; language: "en" | "es" }
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
  language: z.enum(["en", "es"]),
  talk: z.string().min(1).max(80),
  stop: z.string().min(1).max(80),
});
export type SpeechPreferences = z.infer<typeof preferencesSchema>;
const key = "gsv.desktop.voice.v1";
function readPreferences(): SpeechPreferences {
  try { return preferencesSchema.parse(JSON.parse(localStorage.getItem(key) ?? "null")); }
  catch { return { enabled: false, mode: "toggle", replies: "voice", language: "en", ...shortcutDefaults() }; }
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
          setError("Open Chat with Ship to use the voice shortcut. You can then leave the window in the background.");
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

export function NativeSpeechSettings() {
  const speech = useNativeSpeech();
  const [talk, setTalk] = useState(speech?.preferences.talk ?? shortcutDefaults().talk);
  const [stop, setStop] = useState(speech?.preferences.stop ?? shortcutDefaults().stop);
  const [saving, setSaving] = useState(false);
  if (!speech) return null;
  const { preferences, setPreferences } = speech;
  return <section class="native-speech-settings" aria-label="Talk to Ship from other apps">
    <label class="native-speech-enable"><input type="checkbox" checked={preferences.enabled}
      onChange={(event) => setPreferences({ enabled: event.currentTarget.checked })} />Talk to Ship from other apps</label>
    <p class="native-panel-footnote">Keep Chat open in the background. The shortcut records and sends without changing your focused app.</p>
    {preferences.enabled && <>
      <label class="native-device">Recording<select value={preferences.mode} onChange={(event) => setPreferences({ mode: event.currentTarget.value === "hold" ? "hold" : "toggle" })}>
        <option value="toggle">Press to start · press again to send</option><option value="hold">Hold to talk · release to send</option>
      </select></label>
      <label class="native-device">Read replies<select value={preferences.replies} onChange={(event) => setPreferences({ replies: event.currentTarget.value === "all" ? "all" : event.currentTarget.value === "off" ? "off" : "voice" })}>
        <option value="voice">While talking by voice</option><option value="all">All new Ship replies</option><option value="off">Off</option>
      </select></label>
      <label class="native-device">Voice<select value={preferences.language} onChange={(event) => setPreferences({ language: event.currentTarget.value === "es" ? "es" : "en" })}>
        <option value="en">Heart · English</option><option value="es">Dora · Spanish</option>
      </select></label>
      {!speech.shortcuts ? <p class="native-panel-footnote" role="status">Registering shortcuts…</p>
        : speech.shortcuts.managed ? <div class="native-shortcut-fields">
          <p class="native-panel-footnote">{speech.shortcuts.description}</p>
          {speech.shortcuts.can_configure
            ? <button type="button" onClick={() => void speech.editShortcuts()}>change shortcuts in desktop settings</button>
            : <p class="native-panel-footnote">Set “Talk to Ship” and “Stop Ship speaking or cancel recording” in your desktop’s keyboard configuration.</p>}
        </div> : <div class="native-shortcut-fields">
          <ShortcutRecorder label="Talk" value={talk} disabled={saving} capture={speech.captureShortcuts} onChange={setTalk} />
          <ShortcutRecorder label="Stop / cancel" value={stop} disabled={saving} capture={speech.captureShortcuts} onChange={setStop} />
          <button type="button" disabled={saving || (talk === preferences.talk && stop === preferences.stop)} onClick={async () => {
            setSaving(true);
            await speech.applyShortcuts(talk, stop);
            setSaving(false);
          }}>{saving ? "saving…" : "save shortcuts"}</button>
        </div>}
      <div class="native-panel-actions"><button type="button" onClick={() => void speech.command({ kind: "speak", id: "voice-preview", language: preferences.language,
        chunks: [preferences.language === "es" ? "Aquí estoy. Puedes seguir jugando mientras hablamos." : "I'm here. You can keep playing while we talk."] })}>test voice</button>
        <button type="button" onClick={() => void speech.command({ kind: "cancel" })}>stop speaking</button>
        <span role="status">{speech.status.phase === "loading" ? "Loading voice…" : speech.status.phase === "speaking" ? "Speaking" : "Local Kokoro"}</span>
      </div>
      {speech.error && <p class="native-input-error" role="alert">{speech.error}</p>}
    </>}
  </section>;
}
