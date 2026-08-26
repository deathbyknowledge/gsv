import type { ProcTraceResult } from "@humansandmachines/gsv/protocol";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { ChatTranscriptRow } from "../../chat/domain/transcript";
import {
  buildRuntimeFlameChart,
  formatTraceDuration,
  runtimeTraceInspectorSections,
  runtimeTraceRuns,
} from "./runtimeTrace";

type RuntimeFlameChartProps = {
  rows: readonly ChatTranscriptRow[];
  trace: Extract<ProcTraceResult, { ok: true }>;
};

const AXIS_TICKS = [0, 0.25, 0.5, 0.75, 1];

export function RuntimeFlameChart({ rows, trace }: RuntimeFlameChartProps) {
  const runs = useMemo(() => runtimeTraceRuns(trace.spans), [trace.spans]);
  const preferredRunId = runs.some((run) => run.id === trace.activeRunId)
    ? trace.activeRunId
    : runs[0]?.id ?? null;
  const [runId, setRunId] = useState<string | null>(preferredRunId);
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);

  useEffect(() => {
    if (!runId || !runs.some((run) => run.id === runId)) {
      setRunId(preferredRunId);
      setSelectedSpanId(null);
    }
  }, [preferredRunId, runId, runs]);

  const chart = useMemo(
    () => runId ? buildRuntimeFlameChart(trace.spans, runId) : null,
    [runId, trace.spans],
  );
  const selected = chart?.spans.find((span) => span.id === selectedSpanId)
    ?? chart?.spans.find((span) => span.kind === "run")
    ?? chart?.spans[0]
    ?? null;
  const inspectorSections = selected
    ? runtimeTraceInspectorSections(selected, trace.spans, rows)
    : [];

  if (!chart || !runId) {
    return (
      <div class="gsv-runtime-trace-empty">
        <strong>NO TRACE YET</strong>
        <span>Run timing will appear when this process starts work.</span>
      </div>
    );
  }

  return (
    <div class="gsv-runtime-trace">
      <div class="gsv-runtime-trace-toolbar">
        <label>
          <span>RUN</span>
          <select
            value={runId}
            onChange={(event) => {
              setRunId(event.currentTarget.value);
              setSelectedSpanId(null);
            }}
          >
            {runs.map((run, index) => (
              <option value={run.id} key={run.id}>
                {`${index === 0 ? "LATEST · " : ""}${shortTraceId(run.id)} · ${run.status.toUpperCase()}`}
              </option>
            ))}
          </select>
        </label>
        <span class={`gsv-runtime-trace-state is-${chart.spans.find((span) => span.kind === "run")?.status ?? "ok"}`}>
          {trace.activeRunId === runId ? "LIVE" : formatTraceDuration(chart.durationMs)}
        </span>
      </div>

      <div class="gsv-runtime-trace-workspace">
        <div class="gsv-runtime-chart-scroll">
          <div class="gsv-runtime-chart-axis" aria-hidden="true">
            {AXIS_TICKS.map((tick) => (
              <span style={{ left: `${tick * 100}%` }} key={tick}>
                {formatTraceDuration(chart.durationMs * tick)}
              </span>
            ))}
          </div>
          <div
            class="gsv-runtime-chart"
            style={{ height: `${Math.max(1, chart.laneCount) * 34}px` }}
            aria-label={`Wall-clock trace for run ${runId}`}
          >
            {AXIS_TICKS.map((tick) => (
              <i class="gsv-runtime-chart-gridline" style={{ left: `${tick * 100}%` }} key={tick} />
            ))}
            {chart.spans.map((span) => (
              <button
                type="button"
                class={`gsv-runtime-flame is-${span.kind} is-${span.status}${selected?.id === span.id ? " is-selected" : ""}`}
                style={{
                  left: `${span.leftPercent}%`,
                  top: `${span.lane * 34 + 3}px`,
                  width: `${span.widthPercent}%`,
                }}
                title={`${span.name} · ${formatTraceDuration(span.durationMs)}`}
                aria-pressed={selected?.id === span.id}
                onClick={() => setSelectedSpanId(span.id)}
                key={span.id}
              >
                <span>{span.name}</span>
                <small>{formatTraceDuration(span.durationMs)}</small>
              </button>
            ))}
          </div>
        </div>

        <aside class="gsv-runtime-trace-inspector" aria-label="Selected trace span">
          {selected ? (
            <>
              <header>
                <div>
                  <span>{selected.kind.toUpperCase()}</span>
                  <strong>{selected.name}</strong>
                </div>
                <b class={`is-${selected.status}`}>{selected.status.toUpperCase()}</b>
              </header>
              <dl class="gsv-runtime-trace-metrics">
                <div><dt>ELAPSED</dt><dd>{formatTraceDuration(selected.durationMs)}</dd></div>
                <div><dt>START</dt><dd>+{formatTraceDuration(selected.startedAt - chart.startedAt)}</dd></div>
              </dl>
              <div class="gsv-runtime-trace-values">
                {inspectorSections.length > 0 ? inspectorSections.map((section) => (
                  <section key={`${selected.id}:${section.label}`}>
                    <h4>{section.label}</h4>
                    <pre>{section.value}</pre>
                  </section>
                )) : (
                  <p>This span has timing metadata but no stored payload.</p>
                )}
              </div>
            </>
          ) : null}
        </aside>
      </div>
      {trace.truncated ? (
        <p class="gsv-runtime-trace-truncated">Showing the newest {trace.spans.length} of {trace.spanCount} spans.</p>
      ) : null}
    </div>
  );
}

function shortTraceId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}
