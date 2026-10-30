import { useEffect, useMemo, useState } from "preact/hooks";
import { LoadingState } from "../../../components/ui/Spinner";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useViewActive } from "../../../services/navigation/ViewActivity";
import { useQuery } from "../../../services/navigation/viewQueries";
import { loadConsoleProcesses, loadConsoleTargets } from "../../../services/system/consoleService";
import { FleetDialog } from "../fleet/FleetDialog";
import { clockTime, orderPlaces, shortPid } from "../fleet/fleetModel";
import { INSTRUMENT_LEDGER_PAGE, INSTRUMENT_PROCESSES_KEY, INSTRUMENT_TARGETS_KEY } from "../wire/queryKeys";
import { useLedger } from "../wire/useLedger";
import { LineInspector, outcomeWord } from "./LedgerLine";
import { canConfigure } from "./settingsModel";
import { useT } from "../../../i18n/locale";
import "../fleet/fleet.css";
import { PageHeading } from "../../../components/ui/PageHeading";

export function Logs({ account, onProcess }: { account: ConsoleAccount; onProcess: (pid: string) => void }) {
  const t = useT();
  const active = useViewActive();
  const { client, connected } = useGateway();
  const allowed = canConfigure(account, "sys.ledger.list");
  const query = useLedger(allowed);
  const targets = useQuery({ queryKey: INSTRUMENT_TARGETS_KEY, queryFn: () => loadConsoleTargets(client), enabled: connected && allowed && canConfigure(account, "sys.target.list") });
  const processes = useQuery({ queryKey: INSTRUMENT_PROCESSES_KEY, queryFn: () => loadConsoleProcesses(client), enabled: connected && allowed && canConfigure(account, "proc.list") });
  const places = useMemo(() => orderPlaces(targets.data ?? []), [targets.data, t]);
  const lines = useMemo(() => query.data?.pages.flatMap((page) => page.lines) ?? [], [query.data]);
  const [selected, setSelected] = useState<string | null>(null);
  /* the technical view shows raw syscalls and arguments; t toggles it */
  const [technical, setTechnical] = useState(false);
  const line = lines.find((entry) => entry.id === selected);
  const placeLabel = (id: string) => places.find((place) => place.id === id)?.label ?? id;
  const processName = (pid: string) => {
    if (pid === "you") return t("settings.logs.you");
    const process = processes.data?.find((entry) => entry.pid === pid);
    return process?.personal ? "Ship" : process?.label ?? shortPid(pid);
  };
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable=true]")) return;
      if (event.key === "t") { event.preventDefault(); setTechnical((value) => !value); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  return <section class="settings-logs" aria-label={t("settings.logs.title")}>
    <PageHeading title={t("settings.logs.title")} description={t("settings.logs.intro")} actions={allowed && <button type="button" class="settings-text-action" aria-pressed={technical} onClick={() => setTechnical((value) => !value)}>{t("settings.logs.raw")}</button>} />
    {!allowed ? <p class="settings-muted">{t("settings.logs.noAccess")}</p> : <>
      {query.error && <p class="settings-error" role="alert">{t("settings.logs.failed", { error: query.error.message })}</p>}
      {query.isPending && connected && <LoadingState variant="panel">{t("settings.logs.loading")}</LoadingState>}
      {query.data && lines.length === 0 && <p class="settings-muted">{t("settings.logs.empty")}</p>}
      <div class="settings-logs-list"><div class="fleet-ledger" role="table" aria-label={t("settings.logs.history")}>
        {lines.map((entry) => <div class="row" role="row" key={entry.id} tabIndex={0} onClick={() => setSelected(entry.id)} onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelected(entry.id); }
        }}>
          <span role="cell" class="t">{clockTime(entry.timestamp)}</span>
          <span role="cell" class="place">{placeLabel(entry.place)}</span>
          <span role="cell" class="what">{technical ? entry.syscall : t(entry.action.key, entry.action.values)}</span>
          <span role="cell" class="m detail" title={entry.purpose || entry.detail}>{entry.purpose || entry.detail || "—"}</span>
          <span role="cell" class={`outcome ${entry.outcome === "completed" ? "ok" : entry.outcome === "failed" || entry.outcome === "denied" ? "no" : "m"}`}>{outcomeWord(t, entry.outcome)}</span>
          <span role="cell" class="m who">{processName(entry.processId)}</span>
        </div>)}
      </div></div>
      {query.hasNextPage && <button type="button" class="settings-text-action" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
        {query.isFetchingNextPage ? <LoadingState>{t("common.loading")}</LoadingState> : t("settings.logs.older", { count: INSTRUMENT_LEDGER_PAGE })}
      </button>}
    </>}
    <FleetDialog open={active && allowed && !!line} title={t("settings.logs.activity")} onClose={() => setSelected(null)}>
      {line && <LineInspector line={line} placeLabelFor={placeLabel} processName={processName(line.processId)} technical={technical} onProcess={(pid) => { setSelected(null); onProcess(pid); }} />}
    </FleetDialog>
  </section>;
}
