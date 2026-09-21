import { options } from "preact";

type Sample = { dispatch: number; frame: number };
type InputKind = "keyboard" | "navigation" | "navigationTap" | "navigationRepeat" | "typing" | "promptClick";
type TimingSummary = { count: number; dispatchP50Ms: number; dispatchP95Ms: number; nextFrameP50Ms: number; nextFrameP95Ms: number; nextFrameMaxMs: number } | null;
type WorkKind = "navigationHandler" | "navigationUpdateQueue" | "navigationUpdate";
type WorkSummary = { count: number; p50Ms: number; p95Ms: number; maxMs: number } | null;

declare global {
  interface Window {
    gsvInputTiming: {
      read(): Record<InputKind, TimingSummary>;
      readWork(): { handlerSupported: boolean; phases: Record<WorkKind, WorkSummary> };
      reset(): void;
    };
  }
}

/** Bounded, local timing data for the prototype's human acceptance pass; no keys, text or targets. */
export function installInputTiming(): void {
  const samples: Record<InputKind, Sample[]> = { keyboard: [], navigation: [], navigationTap: [], navigationRepeat: [], typing: [], promptClick: [] };
  const work: Record<WorkKind, number[]> = { navigationHandler: [], navigationUpdateQueue: [], navigationUpdate: [] };
  const pending: { kind: InputKind; navigation: boolean; repeat: boolean; started: number; dispatch: number }[] = [];
  const recordWork = (kind: WorkKind, duration: number) => {
    work[kind].push(duration);
    if (work[kind].length > 200) work[kind].shift();
  };
  const collectMeasures = (entries: PerformanceEntry[]) => {
    for (const entry of entries) {
      if (entry.name === "gsv.zen.navigate") recordWork("navigationHandler", entry.duration);
    }
  };
  const observer = typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes.includes("measure")
    ? new PerformanceObserver((list) => collectMeasures(list.getEntries())) : null;
  observer?.observe({ entryTypes: ["measure"] });

  // Preserve Preact's installed scheduler, or its current Promise-microtask default.
  const resolved = Promise.resolve();
  const schedule = options.debounceRendering ?? ((callback: () => void) => { void resolved.then(callback); });
  options.debounceRendering = (callback) => {
    const queued = performance.now();
    schedule(() => {
      const navigation = pending.some((sample) => sample.navigation);
      const started = performance.now();
      try { callback(); }
      finally {
        if (navigation) {
          recordWork("navigationUpdateQueue", started - queued);
          recordWork("navigationUpdate", performance.now() - started);
        }
      }
    });
  };
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
    pending.push({ kind, navigation, repeat: event instanceof KeyboardEvent && event.repeat, started, dispatch: now - started });
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const now = performance.now();
      for (const sample of pending.splice(0)) {
        const value = { dispatch: sample.dispatch, frame: now - sample.started };
        const kinds: InputKind[] = sample.navigation ? [sample.kind, "navigation", sample.repeat ? "navigationRepeat" : "navigationTap"] : [sample.kind];
        for (const kind of kinds) {
          const list = samples[kind];
          list.push(value);
          if (list.length > 200) list.shift();
        }
      }
    });
  };
  const round = (value: number) => Math.round(value * 10) / 10;
  const summary = (list: Sample[]): TimingSummary => {
    if (!list.length) return null;
    const dispatch = list.map((sample) => sample.dispatch).sort((a, b) => a - b);
    const frames = list.map((sample) => sample.frame).sort((a, b) => a - b);
    const median = Math.ceil(list.length * .5) - 1;
    const index = Math.ceil(list.length * .95) - 1;
    return {
      count: list.length, dispatchP50Ms: round(dispatch[median]), dispatchP95Ms: round(dispatch[index]),
      nextFrameP50Ms: round(frames[median]), nextFrameP95Ms: round(frames[index]), nextFrameMaxMs: round(frames.at(-1)!),
    };
  };
  const summarizeWork = (values: number[]): WorkSummary => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return { count: values.length, p50Ms: round(sorted[Math.ceil(sorted.length * .5) - 1]), p95Ms: round(sorted[Math.ceil(sorted.length * .95) - 1]), maxMs: round(sorted.at(-1)!) };
  };
  window.gsvInputTiming = {
    read: () => ({
      keyboard: summary(samples.keyboard), navigation: summary(samples.navigation),
      navigationTap: summary(samples.navigationTap), navigationRepeat: summary(samples.navigationRepeat),
      typing: summary(samples.typing), promptClick: summary(samples.promptClick),
    }),
    readWork: () => {
      if (observer) collectMeasures(observer.takeRecords());
      return { handlerSupported: observer !== null, phases: {
        navigationHandler: summarizeWork(work.navigationHandler),
        navigationUpdateQueue: summarizeWork(work.navigationUpdateQueue),
        navigationUpdate: summarizeWork(work.navigationUpdate),
      } };
    },
    reset: () => {
      observer?.takeRecords();
      for (const list of Object.values(samples)) list.length = 0;
      for (const list of Object.values(work)) list.length = 0;
      pending.length = 0;
    },
  };
  document.addEventListener("keydown", collect, { capture: true, passive: true });
  document.addEventListener("input", collect, { capture: true, passive: true });
  document.addEventListener("pointerdown", collect, { capture: true, passive: true });
}
