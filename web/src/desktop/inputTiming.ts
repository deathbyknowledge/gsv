type Sample = { dispatch: number; frame: number };
type InputKind = "keyboard" | "navigation" | "typing" | "promptClick";
type TimingSummary = { count: number; dispatchP95Ms: number; nextFrameP95Ms: number; nextFrameMaxMs: number } | null;

declare global {
  interface Window {
    gsvInputTiming: { read(): Record<InputKind, TimingSummary>; reset(): void };
  }
}

/** Bounded, local timing data for the prototype's human acceptance pass; no keys, text or targets. */
export function installInputTiming(): void {
  const samples: Record<InputKind, Sample[]> = { keyboard: [], navigation: [], typing: [], promptClick: [] };
  const pending: { kind: InputKind; navigation: boolean; started: number; dispatch: number }[] = [];
  let frame = 0;
  const collect = (event: Event) => {
    if (event.type === "pointerdown" && !(event.target instanceof Element && event.target.matches(".prompt-line textarea"))) return;
    const now = performance.now();
    const started = event.timeStamp;
    if (started < 0 || started > now || pending.length >= 64) return;
    const kind = event.type === "input" ? "typing" : event.type === "pointerdown" ? "promptClick" : "keyboard";
    const navigation = event instanceof KeyboardEvent && !event.isComposing
      && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
      && (event.key === "j" || event.key === "k")
      && !(event.target instanceof HTMLElement && (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)))
      && document.querySelector(".zen.is-browse") !== null
      && document.querySelector(".desktop-timings") === null;
    pending.push({ kind, navigation, started, dispatch: now - started });
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const now = performance.now();
      for (const sample of pending.splice(0)) {
        const value = { dispatch: sample.dispatch, frame: now - sample.started };
        const kinds: InputKind[] = sample.navigation ? [sample.kind, "navigation"] : [sample.kind];
        for (const kind of kinds) {
          const list = samples[kind];
          list.push(value);
          if (list.length > 200) list.shift();
        }
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
    read: () => ({ keyboard: summary(samples.keyboard), navigation: summary(samples.navigation), typing: summary(samples.typing), promptClick: summary(samples.promptClick) }),
    reset: () => { for (const list of Object.values(samples)) list.length = 0; pending.length = 0; },
  };
  document.addEventListener("keydown", collect, { capture: true, passive: true });
  document.addEventListener("input", collect, { capture: true, passive: true });
  document.addEventListener("pointerdown", collect, { capture: true, passive: true });
}
