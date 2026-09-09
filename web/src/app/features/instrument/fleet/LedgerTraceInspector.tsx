import { useQuery } from "@tanstack/preact-query";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { LoadingState } from "../../../components/ui/Spinner";
import { transcriptRowsFromRecords } from "../../chat/domain/typedHistory";
import { formatTraceDuration } from "../../gsv-console/runtime/runtimeTrace";
import { ActivityWorking } from "../zen/ActivityWorking";
import { activitiesForRows } from "../zen/zenModel";
import { clockTime, shortPid } from "./fleetModel";
import type { TraceSelection } from "./LedgerTimeline";
import { loadAnalysisHistory } from "./ledgerAnalyticsService";

export function LedgerTraceInspector({ selection, processName, placeName, onZen, onClose }: {
  selection: TraceSelection;
  processName: string;
  placeName: (id: string) => string;
  onZen: (prefill?: string, pid?: string) => void;
  onClose: () => void;
}) {
  const { client, connected } = useGateway();
  const { run, span, capturedAt } = selection;
  let reference = span.reference;
  let parentId = span.parentId;
  const seen = new Set<string>();
  while (!reference && parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = run.spans.find((entry) => entry.id === parentId);
    reference = parent?.reference;
    parentId = parent?.parentId;
  }
  const messageId = reference?.kind === "message" ? reference.messageId : null;
  const callId = reference && "callId" in reference ? reference.callId : undefined;
  const history = useQuery({
    queryKey: ["ledger-span-history", run.pid, run.id, messageId, capturedAt],
    queryFn: ({ signal }) => loadAnalysisHistory(client, {
      pid: run.pid,
      ...(messageId !== null ? { afterMessageId: messageId - 1, limit: 1 } : { tail: true, limit: 200 }),
    }, signal),
    enabled: connected,
    refetchOnWindowFocus: false,
  });
  const records = (history.data?.records ?? []).filter((record) => record.runId === run.id && (
    messageId !== null ? record.messageId === messageId
      : callId ? (record.kind === "call" || record.kind === "result") && record.payload.callId === callId : true
  ));
  const rows = transcriptRowsFromRecords(records);
  const activities = activitiesForRows(rows, run.id, span.status === "running");
  const notes = rows.filter((row) => row.role !== "tool" && row.role !== "toolResult" && (row.text || row.thinking?.length));
  return (
    <div class="ledger-trace-inspector">
      <h3>{span.kind === "inference" ? "Inference" : span.name}</h3>
      <div class="sub">{processName} · run {shortPid(run.id)}</div>
      <dl class="fleet-kv">
        <dt>State</dt><dd>{span.status}</dd>
        <dt>Started</dt><dd>{clockTime(span.startedAt)}</dd>
        <dt>Duration</dt><dd>{formatTraceDuration(Math.max(0, (span.endedAt ?? capturedAt) - span.startedAt))}{span.endedAt === undefined ? " at capture" : ""}</dd>
      </dl>
      <div class="fleet-actions">
        <button class="ibtn is-primary" type="button" onClick={() => onZen(undefined, run.pid)}>open conversation</button>
        <button class="ibtn" type="button" onClick={onClose}>close</button>
      </div>
      {history.isPending ? <LoadingState>reading activity…</LoadingState> : history.error ? <p class="error" role="alert">{history.error.message}</p> : <>
        <h4>{span.kind === "run" ? "Recent activity in this run" : "Recorded activity"}</h4>
        {activities.map((activity) => <section key={activity.key}>
          <div class="kicker">{activity.target ? placeName(activity.target) : "across places"}</div>
          <ActivityWorking activity={activity} />
        </section>)}
        {notes.slice(-12).map((row) => <section key={row.id}>
          <div class="kicker">{row.role === "user" ? "input" : row.role === "system" ? "event" : "model note"}</div>
          {row.thinking?.length ? <details open={span.kind === "reasoning"}><summary>reasoning</summary><pre>{row.thinking.join("\n\n")}</pre></details> : null}
          {row.text && span.kind !== "reasoning" ? <pre>{row.text}</pre> : null}
        </section>)}
        {!activities.length && !notes.length ? <p class="note">No matching activity remains in the history window read for this span.</p> : null}
        {history.data?.hasMoreBefore && messageId === null ? <p class="note">Earlier activity may be outside the latest 200 history entries.</p> : null}
      </>}
    </div>
  );
}
