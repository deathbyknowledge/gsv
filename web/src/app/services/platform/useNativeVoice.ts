import { useEffect, useRef, useState } from "preact/hooks";
import type { RefObject } from "preact";
import type { PromptLineHandle } from "../../features/instrument/shared/PromptLine";
import { useNativeInput, type NativeCommand, type NativeSnapshot } from "./PlatformProvider";
import { VoiceDraft } from "./voiceDraft";

export function useNativeVoice({ prompt, scope, enabled, send, scroll }: {
  prompt: RefObject<PromptLineHandle>;
  scope: string;
  enabled: boolean;
  send(text: string): boolean;
  scroll(delta: number): void;
}) {
  const input = useNativeInput();
  const [snapshot, setSnapshot] = useState<NativeSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attachment, setAttachment] = useState(0);
  const [device, setDevice] = useState("");
  const lease = useRef<string | null>(null);
  const draft = useRef<VoiceDraft | null>(null);
  const writing = useRef(false);
  const latest = useRef({ send, scroll, enabled });
  latest.current = { send, scroll, enabled };
  const state = useRef<NativeSnapshot | null>(null);
  const command = async (value: NativeCommand): Promise<void> => {
    if (!input || !lease.current) return;
    const id = lease.current;
    setError(null);
    try { await input.command(id, value); }
    catch (error) { if (lease.current === id) setError(String(error)); }
  };
  const write = (value: string, caret?: number) => {
    writing.current = true;
    try { prompt.current?.setValue(value, caret); } finally { writing.current = false; }
  };

  useEffect(() => {
    if (!input || !enabled) return;
    let active = true, ownedLease: string | null = null, timer = 0, frame = 0, ack = 0;
    let scrollVelocity = 0, scrollAt = 0, previousFrame = performance.now();
    state.current = null;
    setSnapshot(null);
    const animate = (now: number) => {
      const elapsed = Math.min(50, now - previousFrame);
      previousFrame = now;
      if (active && scrollVelocity && now - scrollAt < 250) latest.current.scroll(scrollVelocity / 1000 * .8 * elapsed);
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    const apply = (next: NativeSnapshot) => {
      for (const event of next.events) {
        if (event.id <= ack) continue;
        // Acknowledge only after applying; the host retains this bounded lane until the next poll.
        if (event.kind === "started") {
          const selection = prompt.current?.selection();
          if (selection) draft.current = new VoiceDraft(event.request_id, selection);
        } else if (draft.current) {
          const result = draft.current.finish(event);
          if (result) {
            write(result.value, result.caret);
            if (event.action === "send") {
              if (latest.current.enabled && latest.current.send(result.value.trim())) {
                write("");
                const selection = prompt.current?.selection();
                if (selection) draft.current.sent(selection);
              } else {
                draft.current = null;
                void command({ kind: "cancel" });
                setError("Dictation stopped. Your unsent text is still in the prompt.");
              }
            }
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
      scrollAt = performance.now();
      state.current = next;
      setSnapshot(next);
    };
    const poll = async () => {
      if (!active || !ownedLease) return;
      try {
        const requestedAt = Date.now();
        const next = await input.poll(ownedLease, ack);
        if (Date.now() - requestedAt > 1000) throw new Error("Native input paused while the view was suspended. Reconnect input to continue.");
        if (!active || next.lease !== ownedLease) return;
        apply(next);
        timer = window.setTimeout(() => void poll(), 100);
      } catch (error) {
        if (!active) return;
        void input.command(ownedLease, { kind: "detach" }).catch(() => {});
        lease.current = null;
        draft.current = null;
        state.current = null;
        scrollVelocity = 0;
        setSnapshot(null);
        setError(String(error));
      }
    };
    void input.attach().then((next) => {
      if (!active) { void input.command(next.lease, { kind: "detach" }).catch(() => {}); return; }
      ownedLease = next.lease;
      lease.current = next.lease;
      setError(null);
      apply(next);
      void poll();
    }).catch((error) => { if (active) setError(String(error)); });
    return () => {
      active = false;
      window.clearTimeout(timer);
      cancelAnimationFrame(frame);
      draft.current = null;
      if (lease.current === ownedLease) lease.current = null;
      if (ownedLease) void input.command(ownedLease, { kind: "detach" }).catch(() => {});
    };
  }, [input, scope, enabled, attachment]);

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
