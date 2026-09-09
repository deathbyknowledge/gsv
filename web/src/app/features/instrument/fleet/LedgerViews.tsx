import { useInfiniteQuery, useQuery } from "@tanstack/preact-query";
import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { LoadingState } from "../../../components/ui/Spinner";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { ConsoleProcess } from "../../gsv-console/domain/consoleModels";
import { clockTime } from "./fleetModel";
import { LedgerTimeline, type TraceSelection } from "./LedgerTimeline";
import { groupFailures, groupUsage, reportedCost, timelineRuns, type AnalysisLine, type GenerationUsage, type LedgerWindow, type UsageAxis } from "./ledgerAnalytics";
import { loadLedgerBatch, loadTimeline, loadUsage } from "./ledgerAnalyticsService";
import "./ledgerViews.css";

export type LedgerInspection = TraceSelection | { kind: "line"; line: AnalysisLine };
type View = "rows" | "timeline" | "usage" | "failures";
const VIEWS: View[] = ["rows", "timeline", "usage", "failures"];
const HOUR = 60 * 60 * 1_000;

export function LedgerViews({ children, rowStatus, requestedRow, processes, processName, placeName, onInspect }: {
  children: ComponentChildren;
  rowStatus: string;
  requestedRow: string | null;
  processes: readonly ConsoleProcess[];
  processName: (pid: string) => string;
  placeName: (id: string) => string;
  onInspect: (selection: LedgerInspection | null) => void;
}) {
  const [view, setView] = useState<View>(requestedRow?.startsWith("ledger:") ? "rows" : "timeline");
  const [range, setRange] = useState(() => ({ hours: 24, until: Date.now() }));
  const window = { since: range.until - range.hours * HOUR, until: range.until };
  useEffect(() => {
    if (requestedRow?.startsWith("ledger:")) setView("rows");
  }, [requestedRow]);
  const refresh = (hours = range.hours) => {
    onInspect(null);
    setRange({ hours, until: Date.now() });
  };
  return (
    <div class="ledger-views">
      <h2><i /> Ledger <span class="count">{view === "rows" ? rowStatus : `as of ${clockTime(range.until)}`}</span></h2>
      <div class="ledger-toolbar">
        <div class="ledger-view-tabs" role="group" aria-label="Ledger view">
          {VIEWS.map((entry) => <button type="button" key={entry} aria-pressed={view === entry} onClick={() => { onInspect(null); setView(entry); }}>{entry}</button>)}
        </div>
        {view !== "rows" ? <div class="ledger-window-controls">
          <select aria-label="Ledger time range" value={range.hours} onChange={(event) => refresh(Number(event.currentTarget.value))}>
            <option value={1}>last hour</option><option value={24}>last 24 hours</option><option value={168}>last 7 days</option>
          </select>
          <button class="ibtn" type="button" onClick={() => refresh()}>refresh</button>
        </div> : null}
      </div>
      {view === "rows" ? children : view === "failures" ? (
        <LedgerFailures key={range.until} window={window} processName={processName} placeName={placeName} onInspect={onInspect} />
      ) : (
        <ProcessAnalysis key={`${view}:${range.until}`} view={view} window={window} processes={processes} processName={processName} onInspect={onInspect} />
      )}
    </div>
  );
}

function ProcessAnalysis({ view, window, processes, processName, onInspect }: {
  view: "timeline" | "usage";
  window: LedgerWindow;
  processes: readonly ConsoleProcess[];
  processName: (pid: string) => string;
  onInspect: (selection: LedgerInspection) => void;
}) {
  const { client, connected } = useGateway();
  const [limit, setLimit] = useState(8);
  const candidates = processes.filter((process) => process.activeRunId || (process.lastActiveAt ?? process.createdAt ?? 0) >= window.since);
  const pids = candidates.slice(0, limit).map((process) => process.pid).sort();
  const query = useQuery({
    queryKey: ["ledger-analysis", view, window.since, window.until, pids],
    queryFn: async ({ signal }) => view === "timeline"
      ? { kind: "timeline" as const, reads: await loadTimeline(client, pids, signal) }
      : { kind: "usage" as const, reads: await loadUsage(client, pids, window, signal) },
    enabled: connected,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    retry: false,
  });
  const data = query.data;
  const errors = data?.reads.filter((read) => "error" in read) ?? [];
  return (
    <>
      {query.isPending ? <div class="ledger-loading"><LoadingState variant="panel">{connected ? `reading ${view}…` : "connecting…"}</LoadingState></div> : query.error ? (
        <p class="error" role="alert">Could not read {view}: {query.error.message}</p>
      ) : data?.kind === "timeline" ? (
        <LedgerTimeline runs={timelineRuns(data.reads.flatMap((read) => "value" in read ? [read.value] : []), window)} window={window} processName={processName} onInspect={onInspect} />
      ) : data?.kind === "usage" ? (
        <LedgerUsage generations={data.reads.flatMap((read) => "value" in read ? read.value.generations : [])} processName={processName} />
      ) : null}
      {errors.length ? <p class="error" role="alert">Could not read {errors.map((read) => processName(read.pid)).join(", ")}. Their data is missing from this view.</p> : null}
      <p class="ledger-caption">
        {view === "timeline" ? "Recent retained traces; older or reset runs may be absent." : "Recorded generations from the latest 200 history entries per process. Archived and deleted histories are excluded; this is a partial usage view."}
        {candidates.length > limit ? ` Showing ${pids.length} of ${candidates.length} recently active processes.` : ` ${pids.length} recently active processes.`}
      </p>
      {data?.kind === "timeline" && data.reads.some((read) => "value" in read && read.value.truncated) ? <p class="ledger-caption">Some process traces exceed the read limit; those runs are marked partial.</p> : null}
      {candidates.length > limit ? <button class="ibtn" type="button" onClick={() => setLimit(limit + 8)}>include {Math.min(8, candidates.length - limit)} more processes</button> : null}
    </>
  );
}

function LedgerUsage({ generations, processName }: { generations: GenerationUsage[]; processName: (pid: string) => string }) {
  const [axis, setAxis] = useState<UsageAxis>("process");
  const [metric, setMetric] = useState<"tokens" | "cost">("tokens");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [shown, setShown] = useState(20);
  const groups = useMemo(() => groupUsage(generations, axis), [generations, axis]);
  const selected = groups.find((group) => group.id === selectedId);
  const totals = groupUsage(generations, "day").reduce((sum, group) => ({
    tokens: sum.tokens + group.tokens, cost: sum.cost + group.cost, costReports: sum.costReports + group.costReports,
    missingTokens: sum.missingTokens + group.missingTokens, missingCost: sum.missingCost + group.missingCost,
  }), { tokens: 0, cost: 0, costReports: 0, missingTokens: 0, missingCost: 0 });
  const max = Math.max(Number.EPSILON, ...groups.map((group) => group[metric]));
  const label = (id: string) => axis === "process" ? processName(id) : id;
  return (
    <div class="ledger-usage">
      <div class="ledger-subtoolbar">
        <div class="ledger-switches" role="group" aria-label="Group usage by">
          {(["process", "model", "day"] as const).map((by) => <button type="button" key={by} aria-pressed={axis === by} onClick={() => { setAxis(by); setSelectedId(null); }}>{by}</button>)}
        </div>
        <label>Bars <select aria-label="Usage bar metric" value={metric} onChange={(event) => setMetric(event.currentTarget.value === "cost" ? "cost" : "tokens")}>
          <option value="tokens">tokens</option><option value="cost">recorded cost</option>
        </select></label>
      </div>
      {!generations.length ? <p class="ledger-empty">No recorded generation usage in this window.</p> : <>
        <p class="ledger-usage-summary"><strong>{generations.length.toLocaleString()}</strong> generations · <strong>{totals.missingTokens === generations.length ? "—" : totals.tokens.toLocaleString()}</strong> recorded tokens · <strong>{reportedCost(totals.cost, totals.costReports > 0)}</strong> recorded cost</p>
        {totals.missingTokens || totals.missingCost ? <p class="ledger-caption">{totals.missingTokens ? `${totals.missingTokens} generations lack token counts. ` : ""}{totals.missingCost ? `${totals.missingCost} have missing or incomplete cost.` : ""}</p> : null}
        <div class="ledger-usage-table tablewrap"><table>
          <thead><tr><th>{axis}</th><th aria-label="Relative usage" /><th class="num">Generations</th><th class="num">Tokens</th><th class="num">Recorded cost</th></tr></thead>
          <tbody>{groups.map((group) => <tr key={group.id} class={selectedId === group.id ? "is-sel" : ""}>
            <td><button type="button" onClick={() => { setSelectedId(selectedId === group.id ? null : group.id); setShown(20); }} title={label(group.id)}>{label(group.id)}</button></td>
            <td><div class="ledger-usage-bar" aria-hidden="true"><i style={{ width: `${group[metric] / max * 100}%` }} /></div></td>
            <td class="num">{group.generations.length}</td>
            <td class="num">{group.missingTokens === group.generations.length ? "—" : group.tokens.toLocaleString()}{group.missingTokens && group.missingTokens < group.generations.length ? "+" : ""}</td>
            <td class="num">{reportedCost(group.cost, group.costReports > 0)}{group.missingCost && group.costReports ? "+" : ""}</td>
          </tr>)}</tbody>
        </table></div>
        <p class="ledger-caption">Models come from recorded responses, including fallbacks. Cost uses recorded provider or pricing estimates. “—” means unreported; “+” means incomplete.</p>
        {selected ? <div class="ledger-group-detail">
          <h4>{label(selected.id)} · {selected.fallbacks} fallbacks</h4>
          {[...selected.generations].sort((a, b) => b.timestamp - a.timestamp).slice(0, shown).map((generation) => <div class="ledger-generation" key={generation.id}>
            <time>{clockTime(generation.timestamp)}</time><span title={generation.pid}>{processName(generation.pid)}</span>
            <span>{generation.model ?? "unattributed"}{generation.fallback ? " · fallback" : ""}</span>
            <span>{generation.tokens?.toLocaleString() ?? "—"} tokens</span>
          </div>)}
          {selected.generations.length > shown ? <button class="ibtn" type="button" onClick={() => setShown(shown + 20)}>show more generations</button> : null}
        </div> : null}
      </>}
    </div>
  );
}

function LedgerFailures({ window, processName, placeName, onInspect }: {
  window: LedgerWindow;
  processName: (pid: string) => string;
  placeName: (id: string) => string;
  onInspect: (selection: LedgerInspection) => void;
}) {
  const { client, connected } = useGateway();
  const [outcome, setOutcome] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);
  const [shown, setShown] = useState(20);
  const query = useInfiniteQuery({
    queryKey: ["ledger-analysis", "failures", window.since, window.until],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => loadLedgerBatch(client, window, pageParam, signal),
    getNextPageParam: (page) => page.nextCursor,
    enabled: connected,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    retry: false,
  });
  const lines = useMemo(() => [...new Map((query.data?.pages ?? []).flatMap((page) => page.lines).map((line) => [line.id, line])).values()], [query.data]);
  const allGroups = useMemo(() => groupFailures(lines), [lines]);
  const groups = allGroups.filter((group) => outcome === "all" || group.outcome === outcome);
  const selected = groups.find((group) => group.id === selectedId);
  const count = allGroups.reduce((total, group) => total + group.lines.length, 0);
  const max = Math.max(1, ...groups.map((group) => group.lines.length));
  return (
    <div class="ledger-failures">
      <div class="ledger-subtoolbar"><span>{count} unsuccessful calls in {lines.length.toLocaleString()} loaded calls</span>
        <select aria-label="Failure outcome" value={outcome} onChange={(event) => { setOutcome(event.currentTarget.value); setSelectedId(null); }}>
          <option value="all">all outcomes</option><option value="failed">failed</option><option value="denied">denied</option><option value="cancelled">cancelled</option>
        </select>
      </div>
      {query.isPending ? <div class="ledger-loading"><LoadingState variant="panel">{connected ? "reading calls…" : "connecting…"}</LoadingState></div> : null}
      {query.error ? <p class="error" role="alert">Could not read the full window: {query.error.message}</p> : null}
      {!query.isPending && !groups.length ? <p class="ledger-empty">No matching failures in the calls loaded for this window.</p> : null}
      {groups.map((group) => <button type="button" key={group.id} class={`ledger-failure-group is-${group.outcome}${selectedId === group.id ? " is-selected" : ""}`}
        onClick={() => { setSelectedId(selectedId === group.id ? null : group.id); setShown(20); }}>
        <span>{group.syscall}</span><span>{placeName(group.place)}</span><span>{group.outcome}</span>
        <span class="ledger-failure-meter" aria-hidden="true"><i style={{ width: `${group.lines.length / max * 100}%` }} /></span><strong>{group.lines.length}</strong>
      </button>)}
      {selected ? <div class="ledger-group-detail">
        <h4>{selected.syscall} · {placeName(selected.place)}</h4>
        {selected.lines.slice(0, shown).map((line) => <button type="button" key={line.id} class={`ledger-failure-call${selectedLineId === line.id ? " is-selected" : ""}`} onClick={() => { setSelectedLineId(line.id); onInspect({ kind: "line", line }); }}>
          <time>{clockTime(line.timestamp)}</time><span>{processName(line.processId)}</span><span title={line.detail}>{line.detail || line.what}</span><span>inspect ↗</span>
        </button>)}
        {selected.lines.length > shown ? <button class="ibtn" type="button" onClick={() => setShown(shown + 20)}>show more calls</button> : null}
      </div> : null}
      <p class="ledger-caption">{query.isPending ? "Reading the selected window." : query.hasNextPage || query.error ? "Partial window: earlier calls are not included yet." : "All retained ledger calls in the selected window are loaded."} Grouped by operation, target and outcome; matching errors may have different causes.</p>
      {query.hasNextPage ? <button class="ibtn" type="button" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? <LoadingState>reading…</LoadingState> : "include earlier calls"}</button> : null}
    </div>
  );
}
