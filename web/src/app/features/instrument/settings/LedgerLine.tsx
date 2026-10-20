import { useEffect, useState } from "preact/hooks";
import { useViewActive } from "../../../services/navigation/ViewActivity";
import { relativeTime, type LedgerLine } from "../fleet/fleetModel";
import { useT, type Translate } from "../../../i18n/locale";

export function outcomeWord(t: Translate, outcome: string): string {
  if (outcome === "completed") return t("settings.logs.outcomes.done");
  if (outcome === "held" || outcome === "pending") return t("settings.logs.outcomes.held");
  if (outcome === "running") return t("settings.logs.outcomes.running");
  if (outcome === "failed") return t("settings.logs.outcomes.failed");
  if (outcome === "denied") return t("settings.logs.outcomes.denied");
  if (outcome === "cancelled") return t("settings.logs.outcomes.cancelled");
  return outcome;
}

function LineTime({ timestamp }: { timestamp: number | null }) {
  const active = useViewActive();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || timestamp === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, timestamp]);
  return <span>{relativeTime(timestamp, now)}</span>;
}

/** One line of the ledger, in full: everything the row truncated, and the way to the run it belongs to. */
export function LineInspector({
  line,
  placeLabelFor,
  processName,
  technical,
  onProcess,
}: {
  line: LedgerLine;
  placeLabelFor: (placeId: string) => string;
  processName: string;
  technical: boolean;
  onProcess: (pid: string) => void;
}) {
  const t = useT();
  const failed = line.outcome === "failed" || line.outcome === "denied";
  return (
    <div>
      <h3>{line.what}</h3>
      <div class="sub">
        {placeLabelFor(line.place)} · <LineTime timestamp={line.timestamp} />
      </div>
      <dl class="fleet-kv">
        <dt>{t("settings.logs.outcome")}</dt>
        <dd class={failed ? "error" : ""}>{outcomeWord(t, line.outcome)}</dd>
        <dt>{t("settings.logs.by")}</dt>
        <dd>{processName}</dd>
        {line.durationMs != null && <><dt>{t("settings.logs.duration")}</dt><dd>{line.durationMs < 1000 ? `${line.durationMs} ms` : `${(line.durationMs / 1000).toFixed(1)} s`}</dd></>}
        {technical ? (
          <>
            <dt>{t("settings.logs.syscall")}</dt>
            <dd>{line.syscall}</dd>
          </>
        ) : null}
        {(technical || line.detail) && <>
          <dt>{t(technical ? "settings.logs.arguments" : "settings.logs.detail")}</dt>
          <dd><pre class="line-detail">{technical ? line.args : line.detail}</pre></dd>
        </>}
      </dl>
      {line.error && <div class="fleet-line-error"><h4>{t("settings.logs.failure")}</h4><pre class="line-detail error">{line.error}</pre></div>}
      <details class="fleet-work-technical"><summary>{t("settings.logs.requestDetails")}</summary><dl class="fleet-work-details"><div><dt>{t("settings.logs.call")}</dt><dd>{line.syscall}</dd></div><div><dt>{t("settings.logs.target")}</dt><dd>{line.place}</dd></div>{line.runId && <div><dt>{t("settings.logs.run")}</dt><dd>{line.runId}</dd></div>}</dl><pre class="line-detail">{line.args}</pre></details>
      <div class="fleet-actions">
        {line.processId !== "you" ? (
          <button type="button" class="fleet-text-action is-primary" onClick={() => onProcess(line.processId)}>
            {t("settings.logs.inspectProcess")}
          </button>
        ) : null}
        {(technical || line.detail) && <button type="button" class="fleet-text-action" onClick={() => void navigator.clipboard?.writeText(technical ? line.args ?? "" : line.detail)}>
          {t("settings.logs.copy")}
        </button>}
      </div>
      <p class="note">{t(technical ? "settings.logs.rawHint" : "settings.logs.plainHint")}</p>
    </div>
  );
}
