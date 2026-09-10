import type { JsonValue, ResponsibilityRecord, ResponsibilitySourcePolicy, ScheduleRecord } from "@humansandmachines/gsv/protocol";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/preact-query";
import { useState } from "preact/hooks";
import { LoadingState } from "../../../components/ui/Spinner";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { ConsoleAccount, ConsoleProcess } from "../../../domain/system/consoleModels";
import type { FleetRow } from "../Instrument";
import { canConfigure } from "../settings/settingsModel";
import { INSTRUMENT_RESPONSIBILITIES_KEY, INSTRUMENT_ROUTINES_KEY, INSTRUMENT_SOURCES_KEY } from "../wire/queryKeys";
import { relativeTime } from "./fleetModel";
import { cadenceLabel, routineEditable } from "./routineModel";
import { RoutineEditor } from "./RoutineEditor";

export function assignedTo(record: ResponsibilityRecord, process: Pick<ConsoleProcess, "pid" | "personal">): boolean {
  return record.assignee.kind === "ship" ? process.personal : record.assignee.processId === process.pid;
}

export function useFleetWork(account?: ConsoleAccount) {
  const { client, connected } = useGateway();
  const [history, setHistory] = useState(false);
  const [filterPid, setFilterPid] = useState<string | null>(null);
  const allowed = (call: string) => connected && Boolean(account && canConfigure(account, call));
  const current = useInfiniteQuery({
    queryKey: [...INSTRUMENT_RESPONSIBILITIES_KEY, "current"], enabled: allowed("r12y.list"), initialPageParam: 0,
    queryFn: ({ pageParam }) => client.r12y.list({ states: ["open", "active", "waiting"], limit: 500, offset: pageParam }),
    getNextPageParam: (last, pages) => { const n = pages.reduce((sum, page) => sum + page.responsibilities.length, 0); return n < last.count && last.responsibilities.length ? n : undefined; },
  });
  const past = useInfiniteQuery({
    queryKey: [...INSTRUMENT_RESPONSIBILITIES_KEY, "history"], enabled: history && allowed("r12y.list"), initialPageParam: 0,
    queryFn: ({ pageParam }) => client.r12y.list({ states: ["resolved", "cancelled"], includeTerminal: true, limit: 100, offset: pageParam }),
    getNextPageParam: (last, pages) => { const n = pages.reduce((sum, page) => sum + page.responsibilities.length, 0); return n < last.count && last.responsibilities.length ? n : undefined; },
  });
  const routines = useInfiniteQuery({
    queryKey: INSTRUMENT_ROUTINES_KEY, enabled: allowed("sched.list"), initialPageParam: 0,
    queryFn: ({ pageParam }) => client.sched.list({ includeDisabled: true, limit: 100, offset: pageParam }),
    getNextPageParam: (last, pages) => { const n = pages.reduce((sum, page) => sum + page.schedules.length, 0); return n < last.count && last.schedules.length ? n : undefined; },
  });
  return { current, past, routines, history, setHistory, filterPid, setFilterPid,
    open: current.data?.pages.flatMap((page) => page.responsibilities) ?? [],
    records: (history ? past : current).data?.pages.flatMap((page) => page.responsibilities) ?? [],
    schedules: routines.data?.pages.flatMap((page) => page.schedules) ?? [],
  };
}

type Work = ReturnType<typeof useFleetWork>;
function nextTime(value: number, now: number): string {
  if (value <= now) return relativeTime(value, now);
  const minutes = Math.ceil((value - now) / 60_000);
  return minutes < 60 ? `in ${minutes}m` : minutes < 1440 ? `in ${Math.ceil(minutes / 60)}h` : `in ${Math.ceil(minutes / 1440)}d`;
}
type WorkProps = { work: Work; account?: ConsoleAccount; processes: ConsoleProcess[]; selected: FleetRow | null; onSelect: (row: FleetRow) => void; onCreate: () => void; onSources: () => void; now: number };

export function WorkSections({ work, account, processes, selected, onSelect, onCreate, onSources, now }: WorkProps) {
  const query = work.history ? work.past : work.current;
  const filter = processes.find((process) => process.pid === work.filterPid);
  const records = work.filterPid ? work.records.filter((record) => assignedTo(record, filter ?? { pid: work.filterPid!, personal: false })) : work.records;
  const name = (record: ResponsibilityRecord) => record.assignee.kind === "ship" ? "ship" : processes.find((process) => record.assignee.kind === "process" && process.pid === record.assignee.processId)?.label ?? record.assignee.processId.slice(0, 8);
  return <>
    <section class="fleet-block" id="fleet-responsibilities" aria-label="Responsibilities">
      <h2><i />Responsibilities<button class="fleet-heading-action" onClick={onSources} disabled={!account || !canConfigure(account, "r12y.source.list")}>standing</button><span class="count">{query.data?.pages[0]?.count ?? "-"}</span></h2>
      <div class="fleet-work-filters" role="group" aria-label="Responsibility filters">
        <button type="button" aria-pressed={!work.history} onClick={() => work.setHistory(false)}>current</button><button type="button" aria-pressed={work.history} onClick={() => work.setHistory(true)}>history</button>
        {work.filterPid && <button type="button" onClick={() => work.setFilterPid(null)} aria-label="Clear process filter">{filter?.personal ? "ship" : filter?.label ?? work.filterPid.slice(0, 8)} ×</button>}
      </div>
      {query.error && <p class="error" role="alert">{query.error.message}</p>}
      {account && !canConfigure(account, "r12y.list") ? <p class="fleet-empty">Your account cannot list responsibilities.</p> : query.isPending ? <LoadingState>Loading responsibilities…</LoadingState> : <>
        {records.length ? <div class="tablewrap"><table><thead><tr><th>Responsibility</th><th>Assignee</th><th>State</th><th>Next check</th></tr></thead><tbody>{records.map((record) => <tr key={record.id} data-row={`work:${record.id}`} tabIndex={0} class={selected === `work:${record.id}` ? "is-sel" : ""} onClick={() => onSelect(`work:${record.id}`)}>
          <td class="grow">{record.title}</td><td class="dim">{name(record)}</td><td><span class={`dot ${record.state === "active" ? "is-live" : record.state === "waiting" ? "is-warn" : record.state === "resolved" ? "is-on" : ""}`} />{record.state}</td><td class="dim">{record.nextCheckAtMs ? nextTime(record.nextCheckAtMs, now) : "-"}</td>
        </tr>)}</tbody></table></div> : <p class="fleet-empty">{work.history ? "No completed responsibilities here yet." : work.filterPid ? "No current responsibilities for this process." : "Nothing outstanding. Promises and follow-ups appear here."}</p>}
        {query.hasNextPage && <button class="fleet-heading-action" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? "loading…" : "show more responsibilities"}</button>}
      </>}
    </section>
    <section class="fleet-block" aria-label="Routines">
      <h2><i />Routines<button type="button" class="fleet-heading-action" onClick={onCreate} disabled={!account || !canConfigure(account, "sched.add")}>new routine</button><span class="count">{work.routines.data?.pages[0]?.count ?? "-"}</span></h2>
      {work.routines.error && <p class="error" role="alert">{work.routines.error.message}</p>}
      {account && !canConfigure(account, "sched.list") ? <p class="fleet-empty">Your account cannot list routines.</p> : work.routines.isPending ? <LoadingState>Loading routines…</LoadingState> : work.schedules.length ? <div class="tablewrap"><table><thead><tr><th>Routine</th><th>Repeat</th><th>State</th><th>Next run</th></tr></thead><tbody>{work.schedules.map((schedule) => <tr key={schedule.id} tabIndex={0} data-row={`routine:${schedule.id}`} class={selected === `routine:${schedule.id}` ? "is-sel" : ""} onClick={() => onSelect(`routine:${schedule.id}`)}>
        <td class="grow">{schedule.name}</td><td class="dim grow">{cadenceLabel(schedule.expression)}</td><td><span class={`dot ${schedule.state.runningAtMs ? "is-live" : schedule.state.lastStatus === "error" ? "is-err" : schedule.enabled ? "is-on" : ""}`} />{schedule.state.runningAtMs ? "running" : !schedule.enabled ? "paused" : schedule.state.lastStatus === "error" ? "failed" : schedule.state.nextRunAtMs ? "ready" : "finished"}</td><td class="dim">{schedule.state.nextRunAtMs ? nextTime(schedule.state.nextRunAtMs, now) : "-"}</td>
      </tr>)}</tbody></table></div> : <p class="fleet-empty">Give Ship something to take care of regularly.</p>}
      {work.routines.hasNextPage && <button class="fleet-heading-action" disabled={work.routines.isFetchingNextPage} onClick={() => void work.routines.fetchNextPage()}>show more routines</button>}
    </section>
  </>;
}

function isDetailRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function DetailValue({ value }: { value: JsonValue }) {
  if (value === null) return <>-</>;
  if (Array.isArray(value)) return <ul>{value.map((entry, index) => <li key={index}><DetailValue value={entry} /></li>)}</ul>;
  if (isDetailRecord(value)) return <dl class="fleet-work-details">{Object.entries(value).map(([key, entry]) => <div key={key}><dt>{key.replaceAll("_", " ")}</dt><dd><DetailValue value={entry} /></dd></div>)}</dl>;
  return <span class="fleet-work-text">{String(value)}</span>;
}

function WorkDate({ value }: { value?: number | null }) { return <>{value ? new Date(value).toLocaleString() : "-"}</>; }

export function ResponsibilityInspector({ record, account, processName, onProcess }: { record: ResponsibilityRecord; account?: ConsoleAccount; processName: (pid: string) => string; onProcess: (pid?: string) => void }) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const cancel = useMutation({
    mutationFn: () => client.r12y.update({ id: record.id, expectedRevision: record.revision, patch: { state: "cancelled" } }),
    onSuccess: async () => { setConfirm(false); await cache.invalidateQueries({ queryKey: INSTRUMENT_RESPONSIBILITIES_KEY }); },
    onError: async () => { await cache.invalidateQueries({ queryKey: INSTRUMENT_RESPONSIBILITIES_KEY }); },
  });
  const terminal = record.state === "resolved" || record.state === "cancelled";
  return <>
    <h3>{record.title}</h3><p class="inspector-sub">{record.state} · {record.priority} priority</p>
    <dl class="fleet-work-details"><div><dt>Assignee</dt><dd><button class="fleet-text-action" onClick={() => onProcess(record.assignee.kind === "process" ? record.assignee.processId : undefined)}>{record.assignee.kind === "ship" ? "ship" : processName(record.assignee.processId)}</button></dd></div>
      {record.blocker && <div><dt>Waiting for</dt><dd>{record.blocker}</dd></div>}
      {record.dueAtMs && <div><dt>Due</dt><dd><WorkDate value={record.dueAtMs} /></dd></div>}
      {record.nextCheckAtMs && <div><dt>Next check</dt><dd><WorkDate value={record.nextCheckAtMs} /></dd></div>}
    </dl>
    {record.details && <><h4>Details</h4><DetailValue value={record.details} /></>}
    {record.resolution && <><h4>Resolution</h4><DetailValue value={record.resolution} /></>}
    <p class="dim">Updated <WorkDate value={record.updatedAtMs} /></p>
    {!terminal && account && canConfigure(account, "r12y.update") && (confirm ? <div><p>Cancel this responsibility? Work already running continues until it stops or yields.</p><div class="fleet-work-actions"><button class="fleet-text-action" disabled={cancel.isPending} onClick={() => setConfirm(false)}>keep it</button><button class="fleet-text-action is-danger" disabled={!connected || cancel.isPending} onClick={() => cancel.mutate()}>cancel responsibility</button></div></div> : <button class="fleet-text-action is-danger" onClick={() => setConfirm(true)}>cancel responsibility</button>)}
    {cancel.error && <p class="error" role="alert">{cancel.error.message}</p>}
    <details class="fleet-work-technical"><summary>Record</summary><dl class="fleet-work-details"><div><dt>Id</dt><dd>{record.id}</dd></div><div><dt>Source</dt><dd><DetailValue value={record.source} /></dd></div>{record.parentId && <div><dt>Parent</dt><dd>{record.parentId}</dd></div>}</dl></details>
  </>;
}

export function RoutineInspector({ schedule, account, onDirty, onSelect }: { schedule: ScheduleRecord; account?: ConsoleAccount; onDirty: (dirty: boolean) => void; onSelect: (id: string) => void }) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const [editing, setEditing] = useState<ScheduleRecord | null>(null);
  const update = useMutation({ mutationFn: () => client.sched.update({ id: schedule.id, patch: { enabled: !schedule.enabled } }), onSuccess: () => cache.invalidateQueries({ queryKey: INSTRUMENT_ROUTINES_KEY }) });
  if (editing) return <RoutineEditor original={editing} onDirty={onDirty} onSaved={(id) => { setEditing(null); onSelect(id); }} onCancel={() => setEditing(null)} />;
  // SAFETY: A schedule target comes from the parsed JSON syscall response.
  const targetDetails = schedule.target as JsonValue;
  return <>
    <h3>{schedule.name}</h3><p class="inspector-sub">{cadenceLabel(schedule.expression)}</p>
    {schedule.description && <p>{schedule.description}</p>}
    {schedule.target.kind === "responsibility" ? <p class="fleet-work-text">{schedule.target.message}</p> : <DetailValue value={targetDetails} />}
    <dl class="fleet-work-details"><div><dt>State</dt><dd>{schedule.enabled ? "enabled" : "paused"}</dd></div><div><dt>Next run</dt><dd><WorkDate value={schedule.state.nextRunAtMs} /></dd></div><div><dt>Last run</dt><dd><WorkDate value={schedule.state.lastRunAtMs} />{schedule.state.lastStatus ? ` · ${schedule.state.lastStatus}` : ""}</dd></div><div><dt>Times run</dt><dd>{schedule.state.runCount}</dd></div></dl>
    {schedule.state.lastError && <p class="error">{schedule.state.lastError}</p>}
    {update.error && <p class="error" role="alert">{update.error.message}</p>}
    {account && canConfigure(account, "sched.update") && <div class="fleet-work-actions">{routineEditable(schedule) && <button class="fleet-text-action" disabled={!connected || update.isPending} onClick={() => setEditing(schedule)}>edit routine</button>}<button class="fleet-text-action" disabled={!connected || update.isPending} onClick={() => update.mutate()}>{update.isPending ? "saving…" : schedule.enabled ? "pause routine" : "enable routine"}</button></div>}
    {!routineEditable(schedule) && <p class="dim">This scheduled task can be inspected and paused here. Its definition is managed through the command interface.</p>}
  </>;
}

export function StandingResponsibilities({ account }: { account?: ConsoleAccount }) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const query = useQuery({ queryKey: INSTRUMENT_SOURCES_KEY, queryFn: () => client.r12y.source.list({}), enabled: connected && Boolean(account && canConfigure(account, "r12y.source.list")) });
  const update = useMutation({ mutationFn: (source: ResponsibilitySourcePolicy) => {
    if (source.control !== "configurable") throw new Error("This responsibility is always on.");
    return client.r12y.source.update({ id: source.id, enabled: !source.enabled });
  }, onSuccess: () => cache.invalidateQueries({ queryKey: INSTRUMENT_SOURCES_KEY }) });
  return <><h3>Standing responsibilities</h3><p>What Ship takes care of when something happens.</p>
    {query.isPending && <LoadingState>Loading…</LoadingState>}
    {(query.error ?? update.error) && <p class="error" role="alert">{(query.error ?? update.error)?.message}</p>}
    {query.data?.sources.map((source) => <div class="fleet-work-source" key={source.id}><label><span>{source.name}</span><input type="checkbox" checked={source.enabled} disabled={source.control === "required" || !connected || update.isPending || !account || !canConfigure(account, "r12y.source.update")} onChange={() => update.mutate(source)} /></label><p>{source.description}{source.control === "required" ? " Always on." : ""}</p></div>)}
  </>;
}
