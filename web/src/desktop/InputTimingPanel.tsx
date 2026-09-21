import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { useDismissOnOutsideClick } from "../app/features/instrument/shared/useDismissOnOutsideClick";

const ORIGINAL_SCANLINES = "data-desktop-original-scanlines";

function readReport() {
  const bounds = (selector: string) => {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return {
      width: Math.round(rect.width), height: Math.round(rect.height),
      layoutWidth: element.clientWidth, layoutHeight: element.clientHeight,
    };
  };
  const instrument = document.querySelector(".instrument");
  return {
    input: window.gsvInputTiming.read(),
    work: window.gsvInputTiming.readWork(),
    appearance: {
      theme: instrument ? instrument.classList.contains("is-light") ? "light" : "dark" : null,
      originalScanlineBlend: document.documentElement.hasAttribute(ORIGINAL_SCANLINES),
    },
    loadedMoments: document.querySelectorAll(".zen-content > [data-moment-id]").length,
    viewport: { width: window.innerWidth, height: window.innerHeight, pixelRatio: window.devicePixelRatio },
    instrument: bounds(".instrument"),
    scaled: bounds(".instrument-scaled"),
  };
}

/** Prototype-only, on-demand inspection. Opening the panel never starts a sampling loop. */
export function InputTimingPanel() {
  const [report, setReport] = useState<ReturnType<typeof readReport> | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const close = () => {
    setReport(null);
    button.current?.focus({ preventScroll: true });
  };
  useDismissOnOutsideClick(report !== null, () => [button.current, panel.current], () => setReport(null));
  useLayoutEffect(() => () => document.documentElement.removeAttribute(ORIGINAL_SCANLINES), []);
  useLayoutEffect(() => { if (report) panel.current?.focus({ preventScroll: true }); }, [report !== null]);
  useLayoutEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "F8" || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat) return;
      event.preventDefault();
      event.stopPropagation();
      setCopied(null);
      setReport((current) => current ? null : readReport());
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return <>
    <button ref={button} type="button" aria-expanded={report !== null} aria-controls="desktop-input-timings"
      title="Input timings (F8)" aria-keyshortcuts="F8"
      onKeyDown={(event) => event.stopPropagation()}
      onClick={() => { setCopied(null); setReport((current) => current ? null : readReport()); }}>timings</button>
    {report && <section ref={panel} id="desktop-input-timings" class="desktop-timings" role="dialog"
      aria-labelledby="desktop-input-timings-title" tabIndex={-1}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault(); close(); }
      }}>
      <header><h2 id="desktop-input-timings-title">Input timings</h2><button type="button" onClick={close}>close</button></header>
      <p>Clear samples and close this panel. Tap j/k with a pause between presses, then briefly hold each key. Click the prompt, type without sending, and move through the draft with the arrow keys. Reopen it to read the result.</p>
      <table>
        <thead><tr><th>Input</th><th>Samples</th><th>Dispatch p95</th><th>Frame median</th><th>Frame p95</th><th>Frame max</th></tr></thead>
        <tbody>{(["keyboard", "navigation", "navigationTap", "navigationRepeat", "typing", "promptClick"] as const).map((kind) => {
          const sample = report.input[kind];
          const label = { keyboard: "keyboard", navigation: "j/k navigation", navigationTap: "j/k taps", navigationRepeat: "j/k held", typing: "typing", promptClick: "prompt click" }[kind];
          return <tr key={kind}><th>{label}</th><td>{sample?.count ?? 0}</td>
            <td>{sample ? `${sample.dispatchP95Ms} ms` : "—"}</td><td>{sample ? `${sample.nextFrameP50Ms} ms` : "—"}</td>
            <td>{sample ? `${sample.nextFrameP95Ms} ms` : "—"}</td>
            <td>{sample ? `${sample.nextFrameMaxMs} ms` : "—"}</td></tr>;
        })}</tbody>
      </table>
      <p>p95: 95% of samples were this fast or faster. Next frame measures JavaScript scheduling, before painting and display. A fast result can still accompany slow drawing.</p>
      <table>
        <thead><tr><th>Navigation work</th><th>Samples</th><th>Median</th><th>p95</th><th>Max</th></tr></thead>
        <tbody>{(["navigationHandler", "navigationUpdateQueue", "navigationUpdate"] as const).map((kind) => {
          const sample = report.work.phases[kind];
          const label = { navigationHandler: "j/k handler", navigationUpdateQueue: "UI update wait", navigationUpdate: "UI update work" }[kind];
          return <tr key={kind}><th>{label}</th><td>{sample?.count ?? 0}</td>
            <td>{sample ? `${sample.p50Ms} ms` : "—"}</td><td>{sample ? `${sample.p95Ms} ms` : "—"}</td><td>{sample ? `${sample.maxMs} ms` : "—"}</td></tr>;
        })}</tbody>
      </table>
      <p>The handler includes synchronous scroll measurements. UI update work measures Preact and its layout effects while navigation awaits a frame; it excludes later painting and presentation. These percentiles cannot be added or subtracted as one event.</p>
      <table>
        <thead><tr><th>Prompt</th><th>Samples</th><th>Median</th><th>p95</th><th>Max</th></tr></thead>
        <tbody>{(["promptMeasure", "promptInputToCaret", "promptCursorToCaret"] as const).map((kind) => {
          const sample = report.work.phases[kind];
          const label = { promptMeasure: "Measurement work", promptInputToCaret: "Input → caret", promptCursorToCaret: "Arrow/Home/End → caret" }[kind];
          return <tr key={kind}><th>{label}</th><td>{sample?.count ?? 0}</td>
            <td>{sample ? `${sample.p50Ms} ms` : "—"}</td><td>{sample ? `${sample.p95Ms} ms` : "—"}</td><td>{sample ? `${sample.maxMs} ms` : "—"}</td></tr>;
        })}</tbody>
      </table>
      <p>Caret timings end after the prompt refresh has applied its cursor position, before painting and display. Input starts at the text-change event; arrows, Home and End start at keydown. The earlier next-frame callback can run before this work.</p>
      {!report.work.handlerSupported && <p>Work and caret timing are unavailable in this renderer.</p>}
      <div class="desktop-timing-actions">
        <button type="button" onClick={() => { window.gsvInputTiming.reset(); setReport(readReport()); setCopied(null); }}>clear samples</button>
        <button type="button" onClick={() => { setReport(readReport()); setCopied(null); }}>refresh</button>
        <button type="button" onClick={() => {
          void (async () => {
            try {
              await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
              setCopied("Report copied.");
            } catch { setCopied("Open the report below to select and copy it."); }
          })();
        }}>copy report</button>
      </div>
      {copied && <p role="status">{copied}</p>}
      <details class="desktop-rendering-comparison">
        <summary>Dark-mode rendering comparison</summary>
        <p>Keep dark mode selected and compare the same navigation and typing with this option off, then on. Close this panel for each pass.</p>
        <label><input type="checkbox" checked={report.appearance.originalScanlineBlend}
          onChange={(event) => {
            document.documentElement.toggleAttribute(ORIGINAL_SCANLINES, event.currentTarget.checked);
            window.gsvInputTiming.reset();
            setReport(readReport());
            setCopied(null);
          }} /> Original scanline blend</label>
        <p>Off uses ordinary transparency; on restores the previous multiply blend. Changing it clears samples. This comparison resets when the app restarts.</p>
      </details>
      <details><summary>Report</summary><pre>{JSON.stringify(report, null, 2)}</pre></details>
      <p>Each input type keeps its own last 200 events, so these rows can cover different periods. Appearance describes the current setting; clear samples after switching themes. No keys, draft text or conversation content are recorded.</p>
    </section>}
  </>;
}
