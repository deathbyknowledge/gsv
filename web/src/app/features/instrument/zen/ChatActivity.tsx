import { useEffect, useLayoutEffect, useState } from "preact/hooks";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useViewActive } from "../../../services/navigation/ViewActivity";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { loadConsoleProcesses } from "../../../services/system/consoleService";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { LoadingState } from "../../../components/ui/Spinner";
import { canConfigure } from "../settings/settingsModel";
import { ResponsibilitiesSection, ResponsibilityInspector, RoutinesSection, RoutineInspector, StandingResponsibilities, useResponsibilities } from "../shared/Responsibilities";
import { INSTRUMENT_PROCESSES_KEY, INSTRUMENT_RESPONSIBILITIES_KEY } from "../wire/queryKeys";
import type { FleetReference } from "../fleet/fleetModel";
import type { ActivityRequest, ActivityRow } from "./chatContextModel";

export function ChatActivity({ account, request, onAsk, onFleet, onDirty }: {
  account?: ConsoleAccount;
  request?: ActivityRequest;
  onAsk: (text: string) => void;
  onFleet: (reference: FleetReference) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const active = useViewActive();
  const { client, connected } = useGateway();
  const work = useResponsibilities(account);
  const [tab, setTab] = useState<"current" | "routines" | "standing">("current");
  const [row, setRow] = useState<ActivityRow | null>(request?.row ?? null);
  const [dirty, setDirty] = useState(false);
  const [now, setNow] = useState(Date.now);
  useLayoutEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useLayoutEffect(() => {
    if (!request || (dirty && !window.confirm("Discard this unsaved routine?"))) return;
    setDirty(false);
    setRow(request?.row ?? null);
    work.setFilterPid(request?.processId ?? null);
    if (request?.row?.startsWith("routine:")) setTab("routines");
    else if (request) setTab(request.tab ?? "current");
  }, [request, work.setFilterPid]);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [active]);
  const processes = useQuery({ queryKey: INSTRUMENT_PROCESSES_KEY, queryFn: () => loadConsoleProcesses(client),
    enabled: connected && Boolean(account && canConfigure(account, "proc.list")) });
  const responsibilityId = row?.startsWith("work:") ? row.slice(5) : null;
  const responsibility = useQuery({ queryKey: [...INSTRUMENT_RESPONSIBILITIES_KEY, "detail", responsibilityId],
    queryFn: async () => (await client.r12y.get({ id: responsibilityId! })).responsibility,
    enabled: connected && !!responsibilityId && Boolean(account && canConfigure(account, "r12y.get")) });
  const record = responsibility.data ?? work.records.find((entry) => entry.id === responsibilityId);
  const routine = work.schedules.find((entry) => row === `routine:${entry.id}`);
  useEffect(() => {
    if (active && row?.startsWith("routine:") && !routine && work.routines.hasNextPage && !work.routines.isFetchingNextPage && !work.routines.error) {
      void work.routines.fetchNextPage();
    }
  }, [active, row, routine, work.routines.hasNextPage, work.routines.isFetchingNextPage, work.routines.error, work.routines.fetchNextPage]);
  const leaveDetail = () => !dirty || window.confirm("Discard this unsaved routine?");
  const select = (next: ActivityRow | null) => { if (leaveDetail()) { setDirty(false); setRow(next); } };

  return <div class="chat-activity">
    <nav class="chat-context-tabs" aria-label="Ship activity">
      {(["current", "routines", "standing"] as const).map((value) => <button type="button" aria-pressed={tab === value}
        onClick={() => { if (leaveDetail()) { setDirty(false); setRow(null); setTab(value); } }}>{value}</button>)}
    </nav>
    {row ? <>
      <button type="button" class="fleet-text-action chat-context-back" onClick={() => select(null)}>← {tab}</button>
      {record ? <>
        <ResponsibilityInspector key={record.id} record={record} account={account}
          processName={(pid) => processes.data?.find((process) => process.pid === pid)?.label ?? pid}
          onProcess={(pid) => { if (pid) onFleet(`proc:${pid}`); }} />
        <button type="button" class="fleet-text-action is-primary" disabled={!account || !canConfigure(account, "conversation.send")} onClick={() => onAsk(`Help me with the responsibility ${JSON.stringify(record.title)} (${record.id}).`)}>ask Ship</button>
        {record.source.kind === "schedule" && <button type="button" class="fleet-text-action" onClick={() => {
          if (record.source.kind === "schedule") { setTab("routines"); select(`routine:${record.source.scheduleId}`); }
        }}>view routine</button>}
      </> : routine ? <>
        <RoutineInspector key={routine.id} schedule={routine} account={account} onDirty={setDirty} onSelect={(id) => { setDirty(false); setRow(`routine:${id}`); }} />
        <button type="button" class="fleet-text-action is-primary" disabled={!account || !canConfigure(account, "conversation.send")}
          onClick={() => onAsk(`Help me with the routine ${JSON.stringify(routine.name)} (${routine.id}).`)}>ask Ship</button>
      </> : account && !canConfigure(account, responsibilityId ? "r12y.get" : "sched.list") ? <p class="note">Your account cannot read this item.</p>
        : (responsibilityId ? responsibility.isPending : work.routines.isPending || work.routines.isFetchingNextPage) ? <LoadingState>Loading…</LoadingState>
        : <p class="note" role="status">{responsibility.error?.message ?? work.routines.error?.message ?? "This item is no longer available."}</p>}
    </> : tab === "standing" ? <StandingResponsibilities account={account} />
      : tab === "routines" ? <RoutinesSection work={work} account={account} now={now} onSelect={select} onCreate={() => onAsk("Help me create a routine.")} />
        : <ResponsibilitiesSection work={work} account={account} now={now} processes={processes.data ?? []} onSelect={select} />}
  </div>;
}
