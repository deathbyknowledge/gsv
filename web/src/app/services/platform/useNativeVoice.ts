import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { RefObject } from "preact";
import { promptAfterSubmit, type PromptLineHandle } from "../../features/instrument/shared/PromptLine";
import { useNativeInput, type NativeCommand, type NativeSnapshot, type NativeSubscription, type NativeUpdate, type SegmentAction } from "./PlatformProvider";
import { VoiceDraft } from "./voiceDraft";
import { sameNativePresentation } from "./nativePresentation";
import { useNativeSoundFeedback } from "./useInputSounds";

export type VoiceComposer = Pick<PromptLineHandle, "selection" | "setValue">;

export function useNativeVoice({ prompt, scope, enabled, practice = false, send, scroll, onAction }: {
  prompt: RefObject<VoiceComposer>;
  scope: string;
  enabled: boolean;
  practice?: boolean;
  send(text: string): boolean;
  scroll(delta: number): void;
  onAction?(action: SegmentAction): void;
}) {
  const input = useNativeInput();
  const [snapshot, setSnapshot] = useState<NativeSnapshot | null>(null);
  useNativeSoundFeedback(snapshot);
  const [error, setError] = useState<string | null>(null);
  const [attachment, setAttachment] = useState(0);
  const [device, setDevice] = useState("");
  const lease = useRef<string | null>(null);
  const draft = useRef<VoiceDraft | null>(null);
  const writing = useRef(false);
  const latest = useRef({ send, scroll, enabled, onAction });
  latest.current = { send, scroll, enabled, onAction };
  const state = useRef<NativeSnapshot | null>(null);
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

  useLayoutEffect(() => {
    state.current = null;
    setSnapshot(null);
    if (!input || !enabled) return;
    let active = true, ownedLease: string | null = null, timer = 0, frame = 0, ack = 0, revision = 0;
    let subscription: NativeSubscription | null = null, pending: NativeUpdate | null = null;
    let acknowledging = false, acknowledgeAgain = false;
    let scrollVelocity = 0, scrollAt = 0, previousFrame = performance.now();
    const fail = (message: string) => {
      if (!active) return;
      active = false;
      window.clearTimeout(timer);
      cancelAnimationFrame(frame);
      subscription?.dispose();
      lease.current = null;
      draft.current = null;
      state.current = null;
      scrollVelocity = 0;
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
        if (Date.now() - requestedAt > 1000) throw new Error("Native input paused while the view was suspended. Reconnect input to continue.");
      } catch (error) { fail(String(error)); }
      finally {
        acknowledging = false;
        if (active) {
          if (acknowledgeAgain) void acknowledge();
          else timer = window.setTimeout(() => void acknowledge(), 1000);
        }
      }
    };
    const animate = (now: number) => {
      const elapsed = Math.min(50, now - previousFrame);
      previousFrame = now;
      frame = 0;
      if (active && scrollVelocity && now - scrollAt < 250) {
        latest.current.scroll(scrollVelocity / 1000 * .8 * elapsed);
        frame = requestAnimationFrame(animate);
      }
    };
    const apply = (next: NativeSnapshot, scrollAge = 0) => {
      for (const event of next.events) {
        if (event.id <= ack) continue;
        // Acknowledge only after applying; the host retains this bounded lane until delivery completes.
        if (event.kind === "started") {
          const selection = prompt.current?.selection();
          if (selection) draft.current = new VoiceDraft(event.request_id, selection);
        } else if (draft.current) {
          const result = draft.current.finish(event);
          if (result) {
            write(result.value, result.caret);
            if (event.action === "send") {
              if (latest.current.enabled && latest.current.send(result.value.trim())) {
                write(practice ? "" : promptAfterSubmit(result.value));
                const selection = prompt.current?.selection();
                if (selection) draft.current.sent(selection);
                latest.current.onAction?.("send");
              } else {
                draft.current = null;
                void command({ kind: "cancel" });
                setError("Dictation stopped. Your unsent text is still in the prompt.");
              }
            }
            if (event.action === "delete" || event.action === "clear") latest.current.onAction?.(event.action);
            if (event.kind === "final") draft.current = null;
          }
        }
        ack = event.id;
      }
      if (next.voice && draft.current) {
        const result = draft.current.partial(next.voice);
        if (result) write(result.value, result.caret);
      } else if (!next.voice) draft.current = null;
      scrollVelocity = next.scroll_velocity;
      scrollAt = performance.now() - scrollAge;
      if (scrollVelocity && !frame) {
        previousFrame = performance.now();
        frame = requestAnimationFrame(animate);
      } else if (!scrollVelocity && frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      state.current = next;
      setSnapshot((current) => sameNativePresentation(current, next) ? current : next);
    };
    const receive = (update: NativeUpdate) => {
      if (!active) return;
      if (!ownedLease) { pending = update; return; }
      if (update.snapshot.lease !== ownedLease || update.revision <= revision) return;
      try {
        const age = Date.now() - update.sent_at_ms;
        if (age > 1000 || age < -1000) throw new Error("Native input paused while the view was suspended. Reconnect input to continue.");
        revision = update.revision;
        apply(update.snapshot, Math.max(0, age) + update.scroll_age_ms);
        void acknowledge();
      } catch (error) { fail(String(error)); }
    };
    try {
      subscription = input.subscribe(receive, practice);
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
      cancelAnimationFrame(frame);
      draft.current = null;
      if (lease.current === ownedLease) lease.current = null;
      subscription?.dispose();
    };
  }, [input, scope, enabled, practice, attachment]);

  const segment = (action: "send" | "delete" | "clear") => {
    const voice = state.current?.voice;
    if (voice) void command({ kind: "segment", request_id: voice.request_id, segment_id: voice.segment_id, action });
  };
  return {
    available: input !== null, snapshot, error, device, setDevice, command,
    reconnect: () => setAttachment((value) => value + 1),
    start: () => { setError(null); void command({ kind: "start", device_id: device || null }); },
    stop: () => { const voice = state.current?.voice; if (voice) void command({ kind: "stop", request_id: voice.request_id }); },
    cancel: () => { draft.current = null; void command({ kind: "cancel" }); },
    segment,
    onInput: (value: string) => {
      if (writing.current || !draft.current) return;
      if (!draft.current.edit(value)) {
        draft.current = null;
        void command({ kind: "cancel" });
        setError("Dictation stopped for your edit. Start voice again to continue.");
      }
    },
    interceptSubmit: () => {
      if (!state.current?.voice) return false;
      segment("send");
      return true;
    },
  };
}
