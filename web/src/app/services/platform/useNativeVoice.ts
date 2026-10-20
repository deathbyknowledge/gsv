import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { RefObject } from "preact";
import { promptAfterSubmit, type PromptLineHandle } from "../../features/instrument/shared/PromptLine";
import { useNativeInput, useNativeMicrophone, type NativeCommand, type NativeSnapshot, type NativeSubscription, type NativeUpdate } from "./PlatformProvider";
import { VoiceDraft } from "./voiceDraft";
import { sameNativePresentation } from "./nativePresentation";
import { useNativeSoundFeedback } from "./useInputSounds";
import { ClientControlError, useClientControl, type MicrophoneStatus } from "./ClientControl";
import { useNativeSpeech } from "./NativeSpeech";

export type VoiceComposer = Pick<PromptLineHandle, "selection" | "setValue" | "commands">;

export function useNativeVoice({ prompt, scope, enabled, send, global = false, sendGlobal, prepareHandsfree }: {
  prompt: RefObject<VoiceComposer>;
  scope: string;
  enabled: boolean;
  send(text: string): boolean;
  global?: boolean;
  sendGlobal?(text: string): boolean;
  prepareHandsfree?(): string | null;
}) {
  const input = useNativeInput();
  const speech = useNativeSpeech();
  const speaking = useRef(speech);
  speaking.current = speech;
  const globalCapture = useRef(false);
  const finishRequested = useRef(false);
  const requestAck = useRef(() => {});
  const [snapshot, setSnapshot] = useState<NativeSnapshot | null>(null);
  useNativeSoundFeedback(snapshot);
  const [error, setError] = useState<string | null>(null);
  const [attachment, setAttachment] = useState(0);
  const [, setStarting] = useState(false);
  const startingRef = useRef(false);
  const operation = useRef(0);
  const accepting = useRef(true);
  const microphone = useNativeMicrophone();
  const device = microphone?.device ?? "";
  const setDevice = (value: string) => microphone?.setDevice(value);
  const lease = useRef<string | null>(null);
  const draft = useRef<VoiceDraft | null>(null);
  const writing = useRef(false);
  const latest = useRef({ send, sendGlobal, enabled, prepareHandsfree });
  latest.current = { send, sendGlobal, enabled, prepareHandsfree };
  const state = useRef<NativeSnapshot | null>(null);
  const deviceWaiters = useRef(new Set<(snapshot: NativeSnapshot) => void>());
  const command = async (value: NativeCommand): Promise<boolean> => {
    if (!input || !lease.current) return false;
    const id = lease.current;
    if (value.kind !== "devices") setError(null);
    try { await input.command(id, value); return lease.current === id; }
    catch (error) { if (lease.current === id) setError(String(error)); return false; }
  };
  const write = (value: string, caret?: number) => {
    writing.current = true;
    try { prompt.current?.setValue(value, caret); } finally { writing.current = false; }
  };
  const preparing = (value: boolean) => { startingRef.current = value; setStarting(value); };
  const cancel = () => {
    operation.current++;
    accepting.current = false;
    preparing(false);
    globalCapture.current = false;
    finishRequested.current = false;
    speaking.current?.recording(false);
    draft.current = null;
    void command({ kind: "cancel" });
  };
  const requestFinish = () => {
    finishRequested.current = true;
    requestAck.current();
  };

  const finish = async () => {
    const owned = lease.current;
    const voice = state.current?.voice;
    if (!finishRequested.current || !voice || voice.phase === "finishing") return;
    finishRequested.current = false;
    if (!await command({ kind: "finish", request_id: voice.request_id }) && lease.current === owned) globalCapture.current = false;
  };
  useLayoutEffect(() => {
    if (!speech || !global || !enabled || !speech.preferences.enabled) return;
    const unregister = speech.register((action) => {
      if (action === "cancel") {
        cancel();
        speaking.current?.cue("cancelled");
        return;
      }
      if (action === "release" && speaking.current?.preferences.mode !== "hold") return;
      if (action === "press" && speaking.current?.preferences.mode === "hold" && globalCapture.current) return;
      if (globalCapture.current) {
        // The next acknowledged native frame finishes capture, after pending started/segment events.
        requestFinish();
        return;
      }
      if (action === "release") return;
      if (state.current?.voice || startingRef.current) {
        setError("Finish the current recording before starting handsfree mode.");
        speaking.current?.cue("attention");
        return;
      }
      if (!lease.current) { setError("Reconnect microphone controls to start recording."); return; }
      const unavailable = latest.current.prepareHandsfree?.();
      if (unavailable) { setError(unavailable); speaking.current?.cue("attention"); return; }
      globalCapture.current = true;
      accepting.current = true;
      preparing(true);
      speaking.current?.recording(true);
      const owned = lease.current;
      const attempt = ++operation.current;
      void (async () => {
        const stopped = await speaking.current?.command({ kind: "cancel" });
        if (lease.current !== owned || operation.current !== attempt || !globalCapture.current || !latest.current.enabled) return;
        if ((stopped === false || !await command({ kind: "start", device_id: device || null })) && lease.current === owned && operation.current === attempt) {
          preparing(false);
          globalCapture.current = false;
          finishRequested.current = false;
          speaking.current?.recording(false);
          if (stopped === false) setError("Could not stop playback. Try recording again.");
        }
      })();
    });
    return () => {
      unregister();
      if (!globalCapture.current) return;
      cancel();
    };
  }, [speech?.register, speech?.preferences.enabled, global, enabled, scope, device]);

  useClientControl(["microphoneList", "microphoneUse", "microphoneDefault"], async ({ command: request, checkpoint, signal }) => {
    if (!state.current || startingRef.current || state.current.voice || state.current.devices_loading) throw new ClientControlError("busy");
    const revision = state.current.devices_revision;
    await checkpoint();
    const devices = await new Promise<NativeSnapshot>((resolve, reject) => {
      const cleanup = () => { deviceWaiters.current.delete(receive); signal.removeEventListener("abort", cancel); };
      const cancel = () => { cleanup(); reject(new ClientControlError("conflict")); };
      const receive = (next: NativeSnapshot) => {
        if (next.devices_revision > revision && !next.devices_loading) {
          cleanup();
          if (next.notice) reject(new ClientControlError("unavailable"));
          else resolve(next);
        }
      };
      signal.addEventListener("abort", cancel, { once: true });
      deviceWaiters.current.add(receive);
      if (signal.aborted) { cancel(); return; }
      void command({ kind: "devices" }).then((ok) => {
        if (!ok) { cleanup(); reject(new ClientControlError("unavailable")); }
      });
    });
    await checkpoint();
    let selected = device;
    if (request.type === "microphoneUse") {
      const matches = devices.devices.filter((entry) => entry.name === request.name);
      if (matches.length !== 1) throw new ClientControlError("conflict");
      selected = matches[0].id;
      setDevice(selected);
    } else if (request.type === "microphoneDefault") {
      selected = "";
      setDevice(selected);
    }
    const name = devices.devices.find((entry) => entry.id === selected)?.name;
    const status: MicrophoneStatus = {
      devices: devices.devices.map((entry) => ({ name: entry.name, isDefault: entry.is_default })),
      selected: name ? { type: "device", name } : { type: "systemDefault" },
      environmentOverride: null,
    };
    return { type: request.type === "microphoneList" ? "microphonesListed" : request.type === "microphoneUse" ? "microphoneSelected" : "defaultMicrophoneSelected", status };
  }, enabled);

  useLayoutEffect(() => {
    state.current = null;
    setSnapshot(null);
    if (!input || !enabled) return;
    accepting.current = true;
    let active = true, ownedLease: string | null = null, timer = 0, ack = 0, revision = 0;
    let subscription: NativeSubscription | null = null, pending: NativeUpdate | null = null;
    let acknowledging = false, acknowledgeAgain = false;
    const fail = (message: string) => {
      if (!active) return;
      active = false;
      window.clearTimeout(timer);

      subscription?.dispose();
      operation.current++;
      preparing(false);
      lease.current = null;
      globalCapture.current = false;
      finishRequested.current = false;
      draft.current = null;
      state.current = null;
      speaking.current?.recording(false);

      setSnapshot(null);
      setError(message);
    };
    const acknowledge = async () => {
      if (!active || !ownedLease) return;
      window.clearTimeout(timer);
      if (acknowledging) { acknowledgeAgain = true; return; }
      acknowledging = true;
      acknowledgeAgain = false;
      try {
        const requestedAt = Date.now();
        await input.acknowledge(ownedLease, revision, ack);
        if (!active || lease.current !== ownedLease) return;
        if (Date.now() - requestedAt > 1000) throw new Error("Native input paused while the view was suspended. Reconnect input to continue.");
        if (finishRequested.current && state.current?.voice) await finish();
      } catch (error) { fail(String(error)); }
      finally {
        acknowledging = false;
        if (active) {
          if (acknowledgeAgain) void acknowledge();
          else timer = window.setTimeout(() => void acknowledge(), 1000);
        }
      }
    };
    const apply = (next: NativeSnapshot) => {
      for (const event of next.events) {
        if (event.id <= ack) continue;
        if (!accepting.current) { ack = event.id; continue; }
        // Acknowledge only after applying; the host retains this bounded lane until delivery completes.
        if (event.kind === "started") {
          const selection = prompt.current?.selection();
          if (selection) draft.current = new VoiceDraft(event.request_id, selection);
        } else if (draft.current) {
          const result = draft.current.finish(event);
          if (result) {
            write(result.value, result.caret);
            if (event.action === "send") {
              const submit = globalCapture.current ? latest.current.sendGlobal ?? latest.current.send : latest.current.send;
              if (!event.text.trim()) {
                setError("No speech detected. Your draft is still here.");
              } else if (latest.current.enabled && submit(result.value.trim())) {
                speaking.current?.voiceSent();
                speaking.current?.cue("sent");
                write(promptAfterSubmit(result.value, prompt.current?.commands));
                const selection = prompt.current?.selection();
                if (selection) draft.current.sent(selection);
              } else {
                draft.current = null;
                void command({ kind: "cancel" });
                setError(globalCapture.current ? "Your message could not be sent. The voice draft is still here." : "Dictation stopped. Your unsent text is still in the prompt.");
              }
            }
            if (event.kind === "final") { draft.current = null; globalCapture.current = false; finishRequested.current = false; }
          }
        }
        ack = event.id;
      }
      if (next.voice && draft.current) {
        const result = draft.current.partial(next.voice);
        if (result) write(result.value, result.caret);
      } else if (!next.voice) draft.current = null;
      if (!next.voice && (state.current?.voice || next.notice)) {
        globalCapture.current = false;
        finishRequested.current = false;
      }
      state.current = next;
      if (next.voice || next.notice) preparing(false);
      speaking.current?.recording(globalCapture.current || startingRef.current || !!next.voice);
      for (const receive of deviceWaiters.current) receive(next);
      setSnapshot((current) => sameNativePresentation(current, next) ? current : next);
    };
    requestAck.current = () => void acknowledge();
    const receive = (update: NativeUpdate) => {
      if (!active) return;
      if (!ownedLease) { pending = update; return; }
      if (update.snapshot.lease !== ownedLease || update.revision <= revision) return;
      try {
        const age = Date.now() - update.sent_at_ms;
        if (age > 1000 || age < -1000) throw new Error("Native input paused while the view was suspended. Reconnect input to continue.");
        revision = update.revision;
        apply(update.snapshot);
        void acknowledge();
      } catch (error) { fail(String(error)); }
    };
    try {
      subscription = input.subscribe(receive);
      void subscription.initial.then((next) => {
        if (!active) return;
        ownedLease = next.lease;
        lease.current = next.lease;
        setError(null);
        apply(next);
        if (pending) { const update = pending; pending = null; receive(update); }
        else void acknowledge();
      }).catch((error) => fail(String(error)));
    } catch (error) { fail(String(error)); }
    return () => {
      active = false;
      window.clearTimeout(timer);
      operation.current++;
      preparing(false);

      draft.current = null;
      globalCapture.current = false;
      finishRequested.current = false;
      speaking.current?.recording(false);
      if (lease.current === ownedLease) lease.current = null;
      subscription?.dispose();
    };
  }, [input, scope, enabled, attachment]);

  const segment = () => {
    const voice = state.current?.voice;
    if (voice) void command({ kind: "segment", request_id: voice.request_id, segment_id: voice.segment_id, action: "send" });
  };
  return {
    available: input !== null, snapshot, error, device, setDevice, command,
    get capturing() { return startingRef.current || !!state.current?.voice; },
    clearError: () => setError(null),
    reconnect: () => setAttachment((value) => value + 1),
    start: () => {
      if (!lease.current || startingRef.current || state.current?.voice || !latest.current.enabled) return;
      setError(null);
      accepting.current = true;
      preparing(true);
      speaking.current?.recording(true);
      const owned = lease.current;
      const attempt = ++operation.current;
      void (async () => {
        const stopped = await speaking.current?.command({ kind: "cancel" });
        if (lease.current !== owned || operation.current !== attempt || !latest.current.enabled) return;
        if ((stopped === false || !await command({ kind: "start", device_id: device || null })) && operation.current === attempt) {
          preparing(false);
          speaking.current?.recording(false);
          if (stopped === false) setError("Could not stop playback. Try recording again.");
        }
      })();
    },
    stop: () => { const voice = state.current?.voice; if (voice) void command({ kind: "stop", request_id: voice.request_id }); },
    cancel,
    finish: requestFinish,
    /** Sends the dictated draft and pauses capture: the host's finish settles the final text with a send action. */
    send: () => { if (state.current?.voice?.phase === "listening") requestFinish(); },
    onInput: (value: string) => {
      if (writing.current || !draft.current) return;
      if (!draft.current.edit(value)) {
        cancel();
        setError("Dictation stopped for your edit. Start voice again to continue.");
      }
    },
    interceptSubmit: () => {
      if (!state.current?.voice) return false;
      segment();
      return true;
    },
  };
}
