import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { useDismissOnOutsideClick } from "../app/features/instrument/shared/useDismissOnOutsideClick";

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
  return {
    input: window.gsvInputTiming.read(),
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
  useLayoutEffect(() => { if (report) panel.current?.focus({ preventScroll: true }); }, [report !== null]);

  return <>
    <button ref={button} type="button" aria-expanded={report !== null} aria-controls="desktop-input-timings"
      onKeyDown={(event) => event.stopPropagation()}
      onClick={() => { setCopied(null); setReport((current) => current ? null : readReport()); }}>timings</button>
    {report && <section ref={panel} id="desktop-input-timings" class="desktop-timings" role="dialog"
      aria-labelledby="desktop-input-timings-title" tabIndex={-1}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault(); close(); }
      }}>
      <header><h2 id="desktop-input-timings-title">Input timings</h2><button type="button" onClick={close}>close</button></header>
      <p>Clear samples, close this panel, then use j/k, click the prompt and type without sending. Reopen it to read the result.</p>
      <table>
        <thead><tr><th>Input</th><th>Samples</th><th>Dispatch p95</th><th>Next frame p95</th><th>Next frame max</th></tr></thead>
        <tbody>{(["keyboard", "typing", "promptClick"] as const).map((kind) => {
          const sample = report.input[kind];
          return <tr key={kind}><th>{kind === "promptClick" ? "prompt click" : kind}</th><td>{sample?.count ?? 0}</td>
            <td>{sample ? `${sample.dispatchP95Ms} ms` : "—"}</td>
            <td>{sample ? `${sample.nextFrameP95Ms} ms` : "—"}</td>
            <td>{sample ? `${sample.nextFrameMaxMs} ms` : "—"}</td></tr>;
        })}</tbody>
      </table>
      <p>p95: 95% of samples were this fast or faster. Next frame measures JavaScript scheduling, before painting and display. A fast result can still accompany slow drawing.</p>
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
      <details><summary>Report</summary><pre>{JSON.stringify(report, null, 2)}</pre></details>
      <p>Last 200 events per input type, held locally in memory. No keys, draft text or conversation content are recorded.</p>
    </section>}
  </>;
}
