import type { JsonValue, ResponsibilityRecord, ScheduleRecord } from "@humansandmachines/gsv/protocol";
import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useInfiniteQuery } from "../../../services/navigation/viewQueries";
import { useState } from "preact/hooks";
import { LoadingState } from "../../../components/ui/Spinner";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { ConsoleAccount, ConsoleProcess } from "../../../domain/system/consoleModels";
import type { ActivityRow } from "../zen/chatContextModel";
import { canConfigure } from "../settings/settingsModel";
import { INSTRUMENT_RESPONSIBILITIES_KEY, INSTRUMENT_ROUTINES_KEY } from "../wire/queryKeys";
import { relativeTime } from "../fleet/fleetModel";
import { cadenceLabel, routineEditable } from "../fleet/routineModel";
import { responsibilityGroups } from "./responsibilityModel";
import type { ComponentChildren } from "preact";
import { RoutineEditor } from "../fleet/RoutineEditor";
import { rich, useT, type TextKey, type Translate } from "../../../i18n/locale";

export function assignedTo(record: ResponsibilityRecord, process: Pick<ConsoleProcess, "pid" | "personal">): boolean {
  return record.assignee.kind === "ship" ? process.personal : record.assignee.processId === process.pid;
}

export function useResponsibilities(account?: ConsoleAccount, { routines: includeRoutines = true, history = false } = {}) {
  const { client, connected } = useGateway();
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
    queryKey: INSTRUMENT_ROUTINES_KEY, enabled: includeRoutines && allowed("sched.list"), initialPageParam: 0,
    queryFn: ({ pageParam }) => client.sched.list({ includeDisabled: true, limit: 100, offset: pageParam }),
    getNextPageParam: (last, pages) => { const n = pages.reduce((sum, page) => sum + page.schedules.length, 0); return n < last.count && last.schedules.length ? n : undefined; },
  });
  return { current, past, routines, history, filterPid, setFilterPid,
    open: current.data?.pages.flatMap((page) => page.responsibilities) ?? [],
    records: (history ? past : current).data?.pages.flatMap((page) => page.responsibilities) ?? [],
    schedules: routines.data?.pages.flatMap((page) => page.schedules) ?? [],
  };
}

type Work = ReturnType<typeof useResponsibilities>;

const STATE_LABELS = {
  open: "shell.work.state.open",
  active: "shell.work.state.active",
  waiting: "shell.work.state.waiting",
  resolved: "shell.work.state.resolved",
  cancelled: "shell.work.state.cancelled",
} satisfies Record<ResponsibilityRecord["state"], TextKey>;

const PRIORITY_LABELS = {
  low: "shell.work.priority.low",
  normal: "shell.work.priority.normal",
  high: "shell.work.priority.high",
  critical: "shell.work.priority.critical",
} satisfies Record<ResponsibilityRecord["priority"], TextKey>;

const RUN_STATUS_LABELS = {
  ok: "shell.work.runStatus.ok",
  error: "shell.work.runStatus.error",
  skipped: "shell.work.runStatus.skipped",
} satisfies Record<NonNullable<ScheduleRecord["state"]["lastStatus"]>, TextKey>;

function nextTime(t: Translate, value: number, now: number): string {
  if (value <= now) return relativeTime(value, now);
  const minutes = Math.ceil((value - now) / 60_000);
  return minutes < 60 ? t("shell.work.inMinutes", { minutes }) : minutes < 1440 ? t("shell.work.inHours", { hours: Math.ceil(minutes / 60) })
    : t("shell.work.inDays", { days: Math.ceil(minutes / 1440) });
}
type WorkProps = { work: Work; account?: ConsoleAccount; processes: ConsoleProcess[]; onSelect: (row: ActivityRow) => void; onCreate: () => void; now: number };

export function ResponsibilitiesSection({ work, account, processes, onSelect, now }: Omit<WorkProps, "onCreate">) {
  const t = useT();
  const query = work.history ? work.past : work.current;
  const filter = processes.find((process) => process.pid === work.filterPid);
  const records = work.filterPid ? work.records.filter((record) => assignedTo(record, filter ?? { pid: work.filterPid!, personal: false })) : work.records;
  const name = (record: ResponsibilityRecord) => record.assignee.kind === "ship" ? "ship" : processes.find((process) => record.assignee.kind === "process" && process.pid === record.assignee.processId)?.label ?? record.assignee.processId.slice(0, 8);
  const groups = responsibilityGroups(records);
  const renderRow = (record: ResponsibilityRecord): ComponentChildren => {
    const children = groups.children(record.id);
    return <li key={record.id}>
          <button type="button" class="fleet-work-row" data-row={`work:${record.id}`} onClick={() => onSelect(`work:${record.id}`)}>
            <span class="fleet-work-title">{record.title}</span>
            <span class="fleet-work-summary">
              <span class="fleet-work-state" data-state={record.state}>{t(record.state === "active" ? "shell.work.inProgress" : STATE_LABELS[record.state])}</span>
              {record.assignee.kind === "process" && <span>{name(record)}</span>}
              {record.nextCheckAtMs !== undefined && <span title={new Date(record.nextCheckAtMs).toLocaleString()}>
                {t(record.nextCheckAtMs <= now ? "shell.work.checkDue" : "shell.work.check", { time: nextTime(t, record.nextCheckAtMs, now) })}
              </span>}
            </span>
          </button>
      {children.length > 0 && <details class="chat-responsibility-children"><summary>{t("shell.work.steps", { count: children.length })}</summary>
        <ul class="fleet-work-list">{children.map(renderRow)}</ul></details>}
    </li>;
  };
  return <section class="fleet-block fleet-responsibilities" id="fleet-responsibilities" aria-label={t("shell.work.responsibilities")} tabIndex={-1}>
      <h2><i />{t(work.history ? "shell.work.pastResponsibilities" : "shell.work.responsibilities")}<span class="count">{query.data?.pages[0]?.count ?? "-"}</span></h2>
      {work.filterPid && <div class="fleet-work-filters"><button type="button" onClick={() => work.setFilterPid(null)} aria-label={t("shell.work.clearFilter")}>{filter?.personal ? "ship" : filter?.label ?? work.filterPid.slice(0, 8)} ×</button></div>}
      {query.error && <p class="error" role="alert">{query.error.message}</p>}
      {account && !canConfigure(account, "r12y.list") ? <p class="fleet-empty">{t("shell.work.cannotListResponsibilities")}</p> : query.isPending ? <LoadingState>{t("shell.work.loadingResponsibilities")}</LoadingState> : <>
        {records.length ? <ul class="fleet-work-list">{groups.roots.map(renderRow)}</ul> : <p class="fleet-empty">{t(work.history ? "shell.work.noPast" : work.filterPid ? "shell.work.noneForProcess" : "shell.work.nothingOutstanding")}</p>}
        {query.hasNextPage && <button class="fleet-heading-action" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? t("shell.loading") : t("shell.work.moreResponsibilities")}</button>}
      </>}
    </section>;
}

export function RoutinesSection({ work, account, onSelect, onCreate, now }: Pick<WorkProps, "work" | "account" | "onSelect" | "onCreate" | "now">) {
  const t = useT();
  return <section class="fleet-block" aria-label={t("shell.work.routines")}>
      <h2><i />{t("shell.work.routines")}<button type="button" class="fleet-heading-action" onClick={onCreate} disabled={!account || !canConfigure(account, "conversation.send")}>{t("shell.work.newRoutine")}</button><span class="count">{work.routines.data?.pages[0]?.count ?? "-"}</span></h2>
      {work.routines.error && <p class="error" role="alert">{work.routines.error.message}</p>}
      {account && !canConfigure(account, "sched.list") ? <p class="fleet-empty">{t("shell.work.cannotListRoutines")}</p> : work.routines.isPending ? <LoadingState>{t("shell.work.loadingRoutines")}</LoadingState> : work.schedules.length ? <ul class="fleet-work-list">{work.schedules.map((schedule) => <li key={schedule.id}>
        <button type="button" class="fleet-work-row" data-row={`routine:${schedule.id}`} onClick={() => onSelect(`routine:${schedule.id}`)}>
          <span class="fleet-work-title">{schedule.name}</span>
          <span class="fleet-work-summary"><span>{cadenceLabel(schedule.expression)}</span>
            <span class="fleet-work-state" data-state={schedule.state.lastStatus === "error" ? "failed" : schedule.enabled ? "active" : "waiting"}>
              {schedule.state.runningAtMs ? t("shell.work.running") : !schedule.enabled ? t("shell.work.paused") : schedule.state.lastStatus === "error" ? t("shell.work.failed")
                : schedule.state.nextRunAtMs ? t("shell.work.nextRun", { time: nextTime(t, schedule.state.nextRunAtMs, now) }) : t("shell.work.finished")}
            </span>
          </span>
        </button>
      </li>)}</ul> : <p class="fleet-empty">{t("shell.work.noRoutines")}</p>}
      {work.routines.hasNextPage && <button class="fleet-heading-action" disabled={work.routines.isFetchingNextPage} onClick={() => void work.routines.fetchNextPage()}>{t("shell.work.moreRoutines")}</button>}
    </section>;
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
  const t = useT();
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
    <h3>{record.title}</h3><p class="inspector-sub">{t("shell.work.summary", { state: t(STATE_LABELS[record.state]), priority: t(PRIORITY_LABELS[record.priority]) })}</p>
    {record.blocker && <section class="responsibility-blocker"><h4>{t("shell.work.waitingFor")}</h4><p>{record.blocker}</p></section>}
    <dl class="fleet-work-details"><div><dt>{t("shell.work.assignee")}</dt><dd>{record.assignee.kind === "ship" ? "ship" : <button class="fleet-text-action" onClick={() => { if (record.assignee.kind === "process") onProcess(record.assignee.processId); }}>{processName(record.assignee.processId)}</button>}</dd></div>
      {record.dueAtMs && <div><dt>{t("shell.work.due")}</dt><dd><WorkDate value={record.dueAtMs} /></dd></div>}
      {record.nextCheckAtMs && <div><dt>{t("shell.work.nextCheck")}</dt><dd><WorkDate value={record.nextCheckAtMs} /></dd></div>}
    </dl>
    {record.details && <><h4>{t("shell.work.details")}</h4><DetailValue value={record.details} /></>}
    {record.resolution && <><h4>{t("shell.work.resolution")}</h4><DetailValue value={record.resolution} /></>}
    <p class="dim">{rich(t("shell.work.updated"), { date: <WorkDate value={record.updatedAtMs} /> })}</p>
    {!terminal && account && canConfigure(account, "r12y.update") && (confirm ? <div><p>{t("shell.work.confirmCancel")}</p><div class="fleet-work-actions"><button class="fleet-text-action" disabled={cancel.isPending} onClick={() => setConfirm(false)}>{t("shell.work.keep")}</button><button class="fleet-text-action is-danger" disabled={!connected || cancel.isPending} onClick={() => cancel.mutate()}>{t("shell.work.cancel")}</button></div></div> : <button class="fleet-text-action is-danger" onClick={() => setConfirm(true)}>{t("shell.work.cancel")}</button>)}
    {cancel.error && <p class="error" role="alert">{cancel.error.message}</p>}
    <details class="fleet-work-technical"><summary>{t("shell.work.record")}</summary><dl class="fleet-work-details"><div><dt>{t("shell.work.id")}</dt><dd>{record.id}</dd></div><div><dt>{t("shell.work.source")}</dt><dd><DetailValue value={record.source} /></dd></div>{record.parentId && <div><dt>{t("shell.work.parent")}</dt><dd>{record.parentId}</dd></div>}</dl></details>
  </>;
}

export function RoutineInspector({ schedule, account, onDirty, onSelect }: { schedule: ScheduleRecord; account?: ConsoleAccount; onDirty: (dirty: boolean) => void; onSelect: (id: string) => void }) {
  const t = useT();
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
    <dl class="fleet-work-details"><div><dt>{t("shell.work.routineState")}</dt><dd>{schedule.enabled ? t("shell.work.enabled") : t("shell.work.paused")}</dd></div>
      <div><dt>{t("shell.work.nextRunLabel")}</dt><dd><WorkDate value={schedule.state.nextRunAtMs} /></dd></div>
      <div><dt>{t("shell.work.lastRun")}</dt><dd><WorkDate value={schedule.state.lastRunAtMs} />{schedule.state.lastStatus ? ` · ${t(RUN_STATUS_LABELS[schedule.state.lastStatus])}` : ""}</dd></div>
      <div><dt>{t("shell.work.runCount")}</dt><dd>{schedule.state.runCount}</dd></div></dl>
    {schedule.state.lastError && <p class="error">{schedule.state.lastError}</p>}
    {update.error && <p class="error" role="alert">{update.error.message}</p>}
    {account && canConfigure(account, "sched.update") && <div class="fleet-work-actions">{routineEditable(schedule) && <button class="fleet-text-action" disabled={!connected || update.isPending} onClick={() => setEditing(schedule)}>{t("shell.work.editRoutine")}</button>}<button class="fleet-text-action" disabled={!connected || update.isPending} onClick={() => update.mutate()}>{update.isPending ? t("common.saving") : schedule.enabled ? t("shell.work.pauseRoutine") : t("shell.work.enableRoutine")}</button></div>}
    {!routineEditable(schedule) && <p class="dim">{t("shell.work.managedElsewhere")}</p>}
  </>;
}
