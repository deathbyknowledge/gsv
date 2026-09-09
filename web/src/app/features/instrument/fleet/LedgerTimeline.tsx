import type { ProcTraceSpan } from "@humansandmachines/gsv/protocol";
import { useMemo, useState } from "preact/hooks";
import { buildRuntimeFlameChart, formatTraceDuration } from "../../gsv-console/runtime/runtimeTrace";
import { clockTime, shortPid } from "./fleetModel";
import { localDay, timelineBounds, timelinePosition, type LedgerWindow, type TimelineRun } from "./ledgerAnalytics";

export type TraceSelection = { kind: "trace"; run: TimelineRun; span: ProcTraceSpan; capturedAt: number };
const TICKS = [0, 0.25, 0.5, 0.75, 1];

export function LedgerTimeline({ runs, window, processName, onInspect }: {
  runs: TimelineRun[];
  window: LedgerWindow;
  processName: (pid: string) => string;
  onInspect: (selection: TraceSelection) => void;
}) {
  const [fit, setFit] = useState(true);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedSpan, setSelectedSpan] = useState<string | null>(null);
  const bounds = timelineBounds(runs, window, fit);
  const spansDays = localDay(bounds.since) !== localDay(bounds.until);
  const timestamp = (time: number) => `${spansDays ? `${new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric" })} ` : ""}${clockTime(time)}`;
  const selected = runs.find((run) => `${run.pid}/${run.id}` === selectedKey) ?? runs.at(-1);
  const chart = useMemo(() => selected ? buildRuntimeFlameChart(selected.spans, selected.id, window.until) : null, [selected, window.until]);
  const pids = [...new Set(runs.map((run) => run.pid))];
  const chooseRun = (run: TimelineRun) => {
    setSelectedKey(`${run.pid}/${run.id}`);
    const span = run.spans.find((entry) => entry.kind === "run") ?? run.spans[0];
    setSelectedSpan(span.id);
    onInspect({ kind: "trace", run, span, capturedAt: window.until });
  };

  if (!runs.length) return <p class="ledger-empty">No retained run traces overlap this window. Try a longer time range.</p>;
  return (
    <div class="ledger-timeline">
      <div class="ledger-subtoolbar">
        <span>{runs.length} runs · {pids.length} processes</span>
        <label><input type="checkbox" checked={fit} onChange={(event) => setFit(event.currentTarget.checked)} /> fit activity</label>
      </div>
      <div class="ledger-chart-scroll">
        <div class="ledger-run-overview" aria-label="Process run timeline">
          <div class="ledger-lane-label" />
          <div class="ledger-time-axis">
            {TICKS.map((tick) => <span key={tick} style={{ left: `${tick * 100}%` }}>{timestamp(bounds.since + (bounds.until - bounds.since) * tick)}</span>)}
          </div>
          {pids.map((pid) => <div class="ledger-process-lane" key={pid}>
            <div class="ledger-lane-label" title={pid}>{processName(pid)}</div>
            <div class="ledger-run-track">
              {TICKS.map((tick) => <i key={tick} class="ledger-gridline" style={{ left: `${tick * 100}%` }} />)}
              {runs.filter((run) => run.pid === pid).map((run) => {
                const position = timelinePosition(run.start, run.end, bounds);
                return <button type="button" key={run.id} class={`ledger-run-bar is-${run.status}${selected === run ? " is-selected" : ""}`}
                  style={{ left: `${position.left}%`, width: `${position.width}%` }}
                  title={`${processName(pid)} · ${timestamp(run.start)} · ${formatTraceDuration(run.end - run.start)} · ${run.status}${run.partial ? " · partial trace" : ""}`}
                  aria-label={`Inspect ${processName(pid)} run at ${timestamp(run.start)}`}
                  onClick={() => chooseRun(run)} />;
              })}
            </div>
          </div>)}
        </div>
      </div>
      {selected && chart ? <div class="ledger-run-detail">
        <div class="ledger-subtoolbar">
          <label>Run <select aria-label="Inspect run" value={`${selected.pid}/${selected.id}`} onChange={(event) => {
            const run = runs.find((entry) => `${entry.pid}/${entry.id}` === event.currentTarget.value);
            if (run) chooseRun(run);
          }}>
            {[...runs].reverse().map((run) => <option key={`${run.pid}/${run.id}`} value={`${run.pid}/${run.id}`}>
              {processName(run.pid)} · {timestamp(run.start)} · {shortPid(run.id)}
            </option>)}
          </select></label>
          <span>{formatTraceDuration(selected.end - selected.start)} · {selected.status}{selected.partial ? " · partial" : ""}</span>
        </div>
        <div class="ledger-trace-legend">
          {(["context", "inference", "reasoning", "output", "tool", "approval", "delivery"] as const).map((kind) => <span key={kind}><i class={`is-${kind}`} />{kind}</span>)}
        </div>
        <div class="ledger-chart-scroll ledger-flame-scroll">
          <div class="ledger-flame-wrap">
            <div class="ledger-time-axis">
              {TICKS.map((tick) => <span key={tick} style={{ left: `${tick * 100}%` }}>+{formatTraceDuration(chart.durationMs * tick)}</span>)}
            </div>
            <div class="ledger-flame" style={{ height: `${chart.laneCount * 30}px` }} aria-label="Timing within selected run">
              {TICKS.map((tick) => <i key={tick} class="ledger-gridline" style={{ left: `${tick * 100}%` }} />)}
              {chart.spans.map((span) => <button type="button" key={span.id}
                class={`ledger-flame-bar is-${span.kind} status-${span.status}${selectedSpan === span.id ? " is-selected" : ""}`}
                style={{ left: `${span.leftPercent}%`, width: `${span.widthPercent}%`, top: `${span.lane * 30}px` }}
                title={`${span.name} · ${formatTraceDuration(span.durationMs)} · ${span.status}`}
                aria-label={`Inspect ${span.kind}: ${span.name}`}
                onClick={() => { setSelectedSpan(span.id); onInspect({ kind: "trace", run: selected, span, capturedAt: window.until }); }}>
                {span.kind === "inference" ? "inference" : span.name}
              </button>)}
            </div>
          </div>
        </div>
        <p class="ledger-caption">Horizontal distance is wall time. Nested spans overlap; their durations are not added together.</p>
      </div> : null}
    </div>
  );
}
