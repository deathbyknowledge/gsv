import { relativeTime, type LedgerLine } from "../fleet/fleetModel";

export function outcomeWord(outcome: string): string {
  if (outcome === "completed") return "done";
  if (outcome === "held" || outcome === "pending") return "held";
  return outcome;
}

/** One line of the ledger, in full: everything the row truncated, and the way to the run it belongs to. */
export function LineInspector({
  line,
  placeLabelFor,
  processName,
  now,
  technical,
  onProcess,
}: {
  line: LedgerLine;
  placeLabelFor: (placeId: string) => string;
  processName: string;
  now: number;
  technical: boolean;
  onProcess: (pid: string) => void;
}) {
  const failed = line.outcome === "failed" || line.outcome === "denied";
  return (
    <div>
      <h3>{line.what}</h3>
      <div class="sub">
        {placeLabelFor(line.place)} · {relativeTime(line.timestamp, now)}
      </div>
      <dl class="fleet-kv">
        <dt>Outcome</dt>
        <dd class={failed ? "error" : ""}>{outcomeWord(line.outcome)}</dd>
        <dt>By</dt>
        <dd>{processName}</dd>
        {line.durationMs != null && <><dt>Duration</dt><dd>{line.durationMs < 1000 ? `${line.durationMs} ms` : `${(line.durationMs / 1000).toFixed(1)} s`}</dd></>}
        {technical ? (
          <>
            <dt>Syscall</dt>
            <dd>{line.syscall}</dd>
          </>
        ) : null}
        {(technical || line.detail) && <>
          <dt>{technical ? "Arguments" : "Detail"}</dt>
          <dd><pre class="line-detail">{technical ? line.args : line.detail}</pre></dd>
        </>}
      </dl>
      {line.error && <div class="fleet-line-error"><h4>Failure</h4><pre class="line-detail error">{line.error}</pre></div>}
      <details class="fleet-work-technical"><summary>Request details</summary><dl class="fleet-work-details"><div><dt>Call</dt><dd>{line.syscall}</dd></div><div><dt>Target</dt><dd>{line.place}</dd></div>{line.runId && <div><dt>Run</dt><dd>{line.runId}</dd></div>}</dl><pre class="line-detail">{line.args}</pre></details>
      <div class="fleet-actions">
        {line.processId !== "you" ? (
          <button type="button" class="fleet-text-action is-primary" onClick={() => onProcess(line.processId)}>
            inspect process
          </button>
        ) : null}
        {(technical || line.detail) && <button type="button" class="fleet-text-action" onClick={() => void navigator.clipboard?.writeText(technical ? line.args ?? "" : line.detail)}>
          copy
        </button>}
      </div>
      <p class="note">{technical ? "Raw view. Press t for plain words." : "Press t for the raw syscall and arguments."}</p>
    </div>
  );
}
