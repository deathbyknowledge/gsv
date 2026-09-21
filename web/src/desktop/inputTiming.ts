type Sample = { dispatch: number; frame: number };
type InputKind = "keyboard" | "typing";
type TimingSummary = { count: number; dispatchP95Ms: number; nextFrameP95Ms: number; nextFrameMaxMs: number } | null;

declare global {
  interface Window {
    gsvInputTiming: { read(): Record<InputKind, TimingSummary>; reset(): void };
  }
}

/** Bounded, local timing data for the prototype's human acceptance pass; no keys, text or targets. */
export function installInputTiming(): void {
  const samples: Record<InputKind, Sample[]> = { keyboard: [], typing: [] };
  const pending: { kind: InputKind; started: number; dispatch: number }[] = [];
  let frame = 0;
  const collect = (event: Event) => {
    const now = performance.now();
    const started = event.timeStamp;
    if (started < 0 || started > now || pending.length >= 64) return;
    pending.push({ kind: event.type === "input" ? "typing" : "keyboard", started, dispatch: now - started });
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const now = performance.now();
      for (const sample of pending.splice(0)) {
        const list = samples[sample.kind];
        list.push({ dispatch: sample.dispatch, frame: now - sample.started });
        if (list.length > 200) list.shift();
      }
    });
  };
  const summary = (list: Sample[]): TimingSummary => {
    if (!list.length) return null;
    const dispatch = list.map((sample) => sample.dispatch).sort((a, b) => a - b);
    const frames = list.map((sample) => sample.frame).sort((a, b) => a - b);
    const index = Math.ceil(list.length * .95) - 1;
    const round = (value: number) => Math.round(value * 10) / 10;
    return { count: list.length, dispatchP95Ms: round(dispatch[index]), nextFrameP95Ms: round(frames[index]), nextFrameMaxMs: round(frames.at(-1)!) };
  };
  window.gsvInputTiming = {
    read: () => ({ keyboard: summary(samples.keyboard), typing: summary(samples.typing) }),
    reset: () => { samples.keyboard.length = 0; samples.typing.length = 0; pending.length = 0; },
  };
  document.addEventListener("keydown", collect, { capture: true, passive: true });
  document.addEventListener("input", collect, { capture: true, passive: true });
}
