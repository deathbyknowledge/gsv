import { useLedger } from "../wire/useLedger";
import { FileReader } from "./FileReader";
import { FilePreview } from "../shared/FilePreview";
import { PlaceTree, type OpenFile } from "../shared/PlaceFiles";
import { FleetDialog } from "./FleetDialog";
import { assignedTo, useResponsibilities } from "../shared/Responsibilities";
import { useDraftGuard } from "../shared/useDraftGuard";
import type { ActivityRequest } from "../zen/chatContextModel";
import type { GSVClient } from "@humansandmachines/gsv/client";
import { ConnectPlace } from "./ConnectPlace";
import { LoadingState } from "../../../components/ui/Spinner";
import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { RetainedView, useViewActive } from "../../../services/navigation/ViewActivity";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import {
  loadConsoleAccounts,
  loadConsoleProcesses,
  loadConsoleTargets,
  runConsoleProcessAction,
} from "../../../services/system/consoleService";
import type { ConsoleProcess } from "../../../domain/system/consoleModels";
import type { FleetRow } from "../Instrument";
import { INSTRUMENT_LEDGER_KEY, INSTRUMENT_PROCESSES_KEY, INSTRUMENT_TARGETS_KEY } from "../wire/queryKeys";
import {
  CLOUD_TARGET_ID,
  formatUsd,
  costTodayByProcess,
  modelByProcess,
  orderPlaces,
  orderProcesses,
  PLACE_KIND_LABELS,
  placeStateLabel,
  processRow,
  processStateLabel,
  processStateTone,
  relativeTime,
  runsTodayByPlace,
  targetRow,
  visibleProcesses,
  type LedgerLine,
  type Place,
  shortPid,
  fleetReferenceRow,
  isApprovalReference,
  isConnectReference,
  type FleetReference,
} from "./fleetModel";
import { PlaceActions } from "./PlaceActions";
import { CloudBrowserActions, StartCloudBrowser } from "../browser/CloudInstances";
import { useBrowserControl, useCloudInstances } from "../browser/BrowserControl";
import { FleetApproval } from "./FleetApproval";
import { NewProcess, ProcessAiControls } from "./ProcessControls";
import { canConfigure } from "../settings/settingsModel";
import { useT } from "../../../i18n/locale";
import "./fleet.css";

export type FleetProps = {
  onCommand: (target: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** The row to land on, when Zen sent us here from a reference. */
  openRequest: { reference: FleetReference } | null;
  /** Back to Zen, optionally with text placed in the prompt (a file reference, for instance) and a process to open instead of the ship. */
  onZen: (prefill?: string, pid?: string, request?: string) => void;
  onActivity: (request: ActivityRequest) => void;
};

const PROCESS_PAGE = 8;

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/** The Fleet distance: places, processes, the ledger, and files, with an inspector for the selected row. */
const ROW_PREFIXES = ["target:", "proc:", "more:", "dir:", "file:"];
function isFleetRow(value: string | undefined): value is FleetRow {
  return value !== undefined && ROW_PREFIXES.some((prefix) => value.startsWith(prefix));
}

export function Fleet({ openRequest, onZen, onCommand, onDirtyChange, onActivity }: FleetProps) {
  const t = useT();
  useCloudInstances();
  const active = useViewActive();
  const [fileDirty, setFileDirty] = useState(false);
  useDraftGuard(fileDirty, onDirtyChange);
  const { client, connected } = useGateway();
  const now = useNow(active);
  const initialReference = openRequest?.reference ?? null;
  const initialRow = fleetReferenceRow(initialReference);
  const initialConnect = isConnectReference(initialReference) ? initialReference.to : null;
  const approvalReference = isApprovalReference(initialReference) ? initialReference : null;

  const targetsQuery = useQuery({
    queryKey: INSTRUMENT_TARGETS_KEY,
    queryFn: () => loadConsoleTargets(client),
    refetchOnMount: (query) => initialRow?.startsWith("target:") && initialRow !== targetRow(CLOUD_TARGET_ID)
      && !query.state.data?.some((target) => targetRow(target.deviceId) === initialRow) ? "always" : true,
    enabled: connected,
  });
  const processesQuery = useQuery({
    queryKey: INSTRUMENT_PROCESSES_KEY,
    queryFn: () => loadConsoleProcesses(client),
    refetchOnMount: (query) => initialRow?.startsWith("proc:")
      && !query.state.data?.some((process) => processRow(process.pid) === initialRow) ? "always" : true,
    enabled: connected,
  });
  const accountsQuery = useQuery({
    queryKey: ["fleet", "accounts"],
    queryFn: () => loadConsoleAccounts(client),
    enabled: connected,
  });
  const viewer = accountsQuery.data?.find((account) => account.relation === "self");
  const work = useResponsibilities(viewer, { routines: false });

  // The cloud home's name is interface text, so the list follows the language.
  const places = useMemo(() => orderPlaces(targetsQuery.data ?? []), [targetsQuery.data, t]);
  const processes = useMemo(() => orderProcesses(processesQuery.data ?? []), [processesQuery.data]);
  const sysLedgerQuery = useLedger(!!viewer && canConfigure(viewer, "sys.ledger.list"));

  const ledger = useMemo(() => (sysLedgerQuery.data?.pages ?? []).flatMap((page) => page.lines), [sysLedgerQuery.data]);
  const costToday = useMemo(() => costTodayByProcess(ledger, now), [ledger, now]);
  const modelByPid = useMemo(() => modelByProcess(ledger), [ledger]);
  const runsToday = useMemo(() => runsTodayByPlace(ledger, now), [ledger, now]);
  const placeLabel = useCallback(
    (id: string) => places.find((place) => place.id === id)?.label ?? id,
    [places],
  );

  /** A linked process or target keeps its identity when unavailable; ordinary row navigation can leave it. */
  // Only explicit activation changes the inspector. Keyboard browsing uses DOM focus.
  const [selected, setSelected] = useState<FleetRow | null>(initialRow);
  const [inspectorOpen, setInspectorOpen] = useState(Boolean(initialRow || initialConnect));
  const [creatingProcess, setCreatingProcess] = useState(false);
  const [connecting, setConnecting] = useState<"place" | null>(initialConnect);
  useLayoutEffect(() => {
    setSelected(initialRow);
    setFilesPlace(null);
    setOpenFile(null);
    setExpandedFile(null);
    setCreatingProcess(false);
    setConnecting(initialConnect);
    setInspectorOpen(Boolean(initialRow || initialConnect));
    if (initialRow) focusedRow.current = initialRow;
  }, [openRequest]);

  const selectedPlace = useMemo(
    () => (selected?.startsWith("target:") ? places.find((place) => targetRow(place.id) === selected) ?? null : null),
    [selected, places],
  );
  const selectedProcess = useMemo(
    () => (selected?.startsWith("proc:") ? processes.find((process) => processRow(process.pid) === selected) ?? null : null),
    [selected, processes],
  );
  const browserControl = useBrowserControl();
  useLayoutEffect(() => {
    if (inspectorOpen && browserControl.available && selectedPlace?.kind === "browser" && selectedPlace.instance && ["starting", "ready"].includes(selectedPlace.instance.state)) {
      setInspectorOpen(false);
      browserControl.open({ instanceId: selectedPlace.instance.instanceId });
    }
  }, [inspectorOpen, selectedPlace?.kind, selectedPlace?.instance?.instanceId, selectedPlace?.instance?.state, browserControl.available, browserControl.open]);
  const missingRequestedRow = selected !== null && selected === initialRow && (
    (selected.startsWith("proc:") && !selectedProcess) || (selected.startsWith("target:") && !selectedPlace)
  );
  const requestedProcess = selected?.startsWith("proc:") ?? false;
  const requestedQuery = selected?.startsWith("proc:") ? processesQuery : targetsQuery;

  const [processLimit, setProcessLimit] = useState(PROCESS_PAGE);
  const shownProcesses = useMemo(() => visibleProcesses(processes, inspectorOpen ? selected : null, processLimit), [processes, inspectorOpen, selected, processLimit]);
  useEffect(() => {
    if (shownProcesses.length > processLimit) setProcessLimit(shownProcesses.length);
  }, [shownProcesses.length, processLimit]);
  const [openFile, setOpenFile] = useState<OpenFile | null>(null);
  const [filesPlace, setFilesPlace] = useState<Place | null>(null);
  const [expandedFile, setExpandedFile] = useState<OpenFile | null>(null);
  const savedScroll = useRef(0);
  const selectRow = useCallback((row: FleetRow) => {
    setSelected(row);
    setFilesPlace(null);
    setOpenFile(null);
    setCreatingProcess(false);
    setConnecting(null);
    setInspectorOpen(true);
  }, []);
  const selectFile = useCallback((file: OpenFile) => {
    setSelected(`file:${file.target}:${file.path}`);
    setOpenFile(file);
    setCreatingProcess(false);
    setConnecting(null);
    setInspectorOpen(true);
  }, []);
  const cmdPlace = selectedPlace ?? places.find((place) => place.id === CLOUD_TARGET_ID) ?? null;

  const openCmd = useCallback(() => onCommand(cmdPlace?.id ?? CLOUD_TARGET_ID), [onCommand, cmdPlace?.id]);
  const shownLedger = ledger;
  const moreRow: FleetRow = "more:processes";
  /* the rows are whatever is on screen, in reading order: places, processes, the ledger, folders and files */
  // Full log rows now live in Settings; navigation follows the remaining manifest rows.
  const manifestRef = useRef<HTMLDivElement>(null);
  const focusedRow = useRef<FleetRow | null>(initialRow);
  useEffect(() => {
    if (!active || !inspectorOpen || !selected) return;
    const row = Array.from(manifestRef.current?.querySelectorAll<HTMLElement>("[data-row]") ?? []).find((entry) => entry.dataset.row === selected);
    // ledger rows are display: contents and have no box of their own; their first cell does
    // They now have grid boxes, so every row can scroll directly.
    row?.scrollIntoView({ block: "nearest" });
  }, [active, inspectorOpen, selected, places, shownProcesses]);
  useLayoutEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest(".fleet-process-form, .fleet-connection")) return;
      const typing =
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      if (typing || expandedFile || event.metaKey || event.ctrlKey || event.altKey) return;
      if (inspectorOpen || (target instanceof HTMLElement && target.closest("[role=dialog], dialog"))) return;
      if (event.key === "j" || event.key === "ArrowDown" || event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        const rows = Array.from(manifestRef.current?.querySelectorAll<HTMLElement>("[data-row]") ?? []).filter((row) => !row.matches(":disabled"));
        const focused = target instanceof HTMLElement ? target.closest<HTMLElement>("[data-row]") : null;
        let at = rows.findIndex((row) => row === focused);
        if (at < 0) at = rows.findIndex((row) => row.dataset.row === focusedRow.current);
        const direction = event.key === "j" || event.key === "ArrowDown" ? 1 : -1;
        const next = rows[Math.max(0, Math.min(rows.length - 1, at + direction))];
        if (next) {
          next.focus({ preventScroll: true });
          next.scrollIntoView({ block: "nearest" });
        }
      } else if (event.key === "Enter" || event.key === " ") {
        if (!(target instanceof HTMLElement) || target.closest("button, a[href], summary")) return;
        const row = target.closest<HTMLElement>("[data-row]");
        if (!row || !manifestRef.current?.contains(row)) return;
        event.preventDefault();
        if (!event.repeat) row.click();
      } else if (event.key === "/") {
        event.preventDefault();
        const place = places.find((place) => targetRow(place.id) === focusedRow.current);
        onCommand(place?.id ?? CLOUD_TARGET_ID);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, inspectorOpen, expandedFile, places, onCommand]);

  const connect = (to: "place") => {
    setSelected(null);
    setOpenFile(null);
    setCreatingProcess(false);
    setConnecting(to);
    setFilesPlace(null);
    setInspectorOpen(true);
  };
  const selectConnected = (row: FleetRow) => {
    setConnecting(null);
    setSelected(row);
    setInspectorOpen(true);
  };

  const responsibilityCount = (pid: string) =>
    work.open.filter((record) => assignedTo(record, processes.find((process) => process.pid === pid) ?? { pid, personal: false })).length;
  const costFor = (pid: string) => costToday.get(pid) ?? null;
  const modelFor = (pid: string) => modelByPid.get(pid) ?? null;
  const closeInspector = () => {
    setInspectorOpen(false);
    requestAnimationFrame(() => {
      const manifest = manifestRef.current;
      if (!manifest || manifest.closest("[hidden]") || manifest.contains(document.activeElement)) return;
      // An expanded file or a view change can remove the dialog's original opener.
      const row = Array.from(manifest.querySelectorAll<HTMLElement>("[data-row]")).find((entry) => entry.dataset.row === focusedRow.current);
      row?.focus({ preventScroll: true });
    });
  };
  const inspectorTitle = connecting === "place" ? t("fleet.connect.title")
    : creatingProcess ? t("fleet.newProcess.title") : openFile ? t("fleet.inspector.file") : filesPlace ? t("fleet.inspector.files", { place: filesPlace.label })
      : selected?.startsWith("proc:") ? t("fleet.field.process") : t("fleet.field.place");

  return (
    <main class="fleet" aria-label="Fleet">
      {expandedFile && <FileReader key={`${expandedFile.target}:${expandedFile.path}`} file={expandedFile} account={viewer} onDirtyChange={setFileDirty} onClose={(deleted) => {
        if (deleted) { setOpenFile(null); setInspectorOpen(false); }
        setExpandedFile(null);
        requestAnimationFrame(() => { if (manifestRef.current) manifestRef.current.scrollTop = savedScroll.current; });
      }} />}
      <div class="fleet-body" hidden={Boolean(expandedFile)}>
        <div ref={manifestRef} class="fleet-manifest" data-scroll-edge onFocusCapture={(event) => {
          const row = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("[data-row]") : null;
          const key = row?.dataset.row;
          if (isFleetRow(key)) focusedRow.current = key;
        }} onClickCapture={(event) => {
          if (!(event.target instanceof HTMLElement)) return;
          const row = event.target.closest<HTMLElement>("[data-row]");
          if (row && !event.target.closest("button, a[href]")) row.focus({ preventScroll: true });
        }}>

          <section class="fleet-block">
            <h2>
              <i /> {t("fleet.places.title")}
              <StartCloudBrowser allowed={Boolean(viewer && canConfigure(viewer, "sys.instance.start"))} />
              <button type="button" class="fleet-heading-action" disabled={!connected || !viewer || !canConfigure(viewer, "sys.pair.create")} onClick={() => connect("place")}>{t("fleet.places.connect")}</button>
              <span class="count">{places.length}</span>
            </h2>
            {targetsQuery.error ? <p class="error">{t("fleet.places.failed", { error: String(targetsQuery.error) })}</p> : null}
            <div class="tablewrap">
            <table class="fleet-places-table">
              <thead>
                <tr>
                  <th>{t("fleet.field.place")}</th>
                  <th>{t("fleet.field.kind")}</th>
                  <th>{t("fleet.field.state")}</th>
                  <th>{t("fleet.field.lastSeen")}</th>
                  <th class="num">{t("fleet.field.runsToday")}</th>
                </tr>
              </thead>
              <tbody>
                {places.map((place) => (
                  <tr
                    key={place.id}
                    data-row={targetRow(place.id)}
                    tabIndex={0}
                    onClick={() => selectRow(targetRow(place.id))}
                  >
                    <td>
                      <span class={`dot ${place.kind === "cloud" ? "is-on" : place.online ? "is-on" : "is-idle"}`} role="img" aria-label={t(placeStateLabel(place))} />
                      {place.label}
                    </td>
                    <td class="kind">{t(PLACE_KIND_LABELS[place.kind])}</td>
                    <td class="dim">{t(placeStateLabel(place))}</td>
                    <td class="dim">{place.kind === "cloud" ? t("fleet.places.always") : relativeTime(place.lastSeenAt, now)}</td>
                    <td class="num">{runsToday.get(place.id) ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </section>

          <section class="fleet-block">
            <h2>
              <i /> {t("fleet.processes.title")}
              {viewer && canConfigure(viewer, "proc.spawn") ? <button type="button" class="fleet-heading-action" disabled={!connected} onClick={() => {
                setSelected(null);
                setOpenFile(null);
                setConnecting(null);
                setCreatingProcess(true);
                setInspectorOpen(true);
              }}>{t("fleet.processes.new")}</button> : null}
              <span class="count">{processes.length}</span>
            </h2>
            {processesQuery.error ? <p class="error">{t("fleet.processes.failed", { error: String(processesQuery.error) })}</p> : null}
            <div class="tablewrap">
            <table class="fleet-processes-table">
              <thead>
                <tr>
                  <th>{t("fleet.field.process")}</th>
                  <th>{t("fleet.field.id")}</th>
                  <th>{t("fleet.field.responsibilities")}</th>
                  <th>{t("fleet.field.state")}</th>
                  <th>{t("fleet.field.lastActive")}</th>
                  <th class="num">{t("fleet.field.today")}</th>
                </tr>
              </thead>
              <tbody>
                {shownProcesses.map((process) => (
                  <tr
                    key={process.pid}
                    data-row={processRow(process.pid)}
                    tabIndex={0}
                    onClick={() => selectRow(processRow(process.pid))}
                  >
                    <td class="name">{process.personal ? "Ship" : process.label}</td>
                    <td class="id" title={process.pid}>{shortPid(process.pid)}</td>
                    <td class="dim"><button type="button" class="fleet-count-action" aria-label={t("fleet.processes.responsibilitiesFor", { name: process.personal ? "ship" : process.label })} onClick={(event) => { event.stopPropagation(); onActivity({ processId: process.pid }); }}>
                      <ResponsibilityCount count={work.current.isPending || work.current.isError ? null : responsibilityCount(process.pid)} more={work.current.hasNextPage} />
                    </button></td>
                    <td>
                      <span class={`dot is-${processStateTone(process.state)}`} />
                      {t(processStateLabel(process.state))}
                    </td>
                    <td class="dim">{relativeTime(process.lastActiveAt, now)}</td>
                    <td class="num">{formatUsd(costFor(process.pid))}</td>
                  </tr>
                ))}
                {processes.length > PROCESS_PAGE ? (
                  <tr class="more">
                    <td colSpan={6}>
                      {shownProcesses.length < processes.length ? (
                        <button type="button" data-row={moreRow} onClick={() => setProcessLimit(shownProcesses.length + 20)}>
                          {t("fleet.processes.showMore", { count: Math.min(20, processes.length - shownProcesses.length), total: processes.length })}
                        </button>
                      ) : (
                        <button type="button" data-row={moreRow} onClick={() => setProcessLimit(PROCESS_PAGE)}>
                          {t("fleet.processes.showFewer")}
                        </button>
                      )}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
            </div>
          </section>

        </div>

        <FleetDialog open={active && inspectorOpen && !expandedFile} title={inspectorTitle} onClose={closeInspector}>
          {connecting === "place" ? (
            <ConnectPlace account={viewer} targets={targetsQuery.data ?? []} ready={!!targetsQuery.data && !targetsQuery.isError} onClose={closeInspector} onConnected={(id) => selectConnected(targetRow(id))} />
          ) : creatingProcess ? (
            <NewProcess onCreated={(pid) => onZen(undefined, pid)} onCancel={() => { setCreatingProcess(false); closeInspector(); }} />
          ) : filesPlace || openFile ? (
            <>
              {filesPlace && <RetainedView active={active && inspectorOpen && !expandedFile && !openFile}>
                <button type="button" class="fleet-text-action chat-context-back" onClick={() => setFilesPlace(null)}>← {filesPlace.label}</button>
                <div class="fleet-tree"><PlaceTree key={filesPlace.id} place={filesPlace} enabled={connected && filesPlace.online} onOpenFile={selectFile} initiallyOpen /></div>
              </RetainedView>}
              {openFile && <FilePreview file={openFile} placeLabel={placeLabel(openFile.target)} onClose={() => { if (filesPlace) setOpenFile(null); else closeInspector(); }} onAsk={(text) => onZen(undefined, undefined, text)} onExpand={() => {
              savedScroll.current = manifestRef.current?.scrollTop ?? 0;
              setExpandedFile(openFile);
            }} />}
            </>
          ) : selectedPlace ? (
            <PlaceInspector
              key={selectedPlace.id}
              place={selectedPlace}
              uid={accountsQuery.data?.find((account) => account.relation === "self")?.uid ?? null}
              focusPair={selected === initialRow}
              runsToday={runsToday.get(selectedPlace.id) ?? 0}
              now={now}
              onRun={openCmd}
              onBrowse={() => setFilesPlace(selectedPlace)}
              onZen={onZen}
            />
          ) : selectedProcess ? (
            <ProcessInspector
              key={selectedProcess.pid}
              client={client}
              process={selectedProcess}
              requestedApprovalId={approvalReference?.pid === selectedProcess.pid ? approvalReference.requestId : undefined}
              model={modelFor(selectedProcess.pid)}
              cost={costFor(selectedProcess.pid)}
              responsibilities={responsibilityCount(selectedProcess.pid)}
              canEditAi={!!viewer && canConfigure(viewer, "proc.ai.config.set")}
              now={now}
              onZen={onZen}
              lines={shownLedger.filter((line) => line.processId === selectedProcess.pid).slice(0, 8)}
              placeLabelFor={placeLabel}
            />
          ) : missingRequestedRow ? (
            <div>
              <h3>{requestedProcess ? t("fleet.field.process") : t("fleet.field.place")}</h3>
              <div class="sub">{selected?.slice(selected.indexOf(":") + 1)}</div>
              {!connected || requestedQuery.isPending || requestedQuery.isFetching ? (
                <p class="note"><LoadingState>{!connected ? t("fleet.connecting") : requestedProcess ? t("fleet.missing.loadingProcess") : t("fleet.missing.loadingPlace")}</LoadingState></p>
              ) : requestedQuery.isError ? (
                <p class="error" role="alert">{t(requestedProcess ? "fleet.missing.processFailed" : "fleet.missing.placeFailed", { error: requestedQuery.error.message })}</p>
              ) : (
                <p class="note" role="status">{requestedProcess ? t("fleet.missing.processGone") : t("fleet.missing.placeGone")}</p>
              )}
            </div>
          ) : (
            <p class="note">{connected ? t("fleet.inspector.empty") : t("fleet.connecting")}</p>
          )}
        </FleetDialog>
      </div>


    </main>
  );
}

type PlaceInspectorProps = {
  place: Place;
  uid: number | null;
  focusPair: boolean;
  runsToday: number;
  now: number;
  onRun: () => void;
  onBrowse: () => void;
  onZen: () => void;
};

function PlaceInspector({ place, uid, focusPair, runsToday, now, onRun, onBrowse, onZen }: PlaceInspectorProps) {
  const t = useT();
  return (
    <div>
      <h3>{place.label}</h3>
      <div class="sub">
        {t(PLACE_KIND_LABELS[place.kind])} · {t(placeStateLabel(place))}
      </div>
      <div class="full-id">{place.id}</div>
      <dl class="fleet-kv">
        <dt>{t("fleet.field.runtime")}</dt>
        <dd>{place.platform || "—"}</dd>
        <dt>{t("fleet.field.driver")}</dt>
        <dd>{place.version ? `${place.kind === "cloud" ? "gateway" : "gsvd"} ${place.version}` : place.kind === "cloud" ? "gateway" : "—"}</dd>
        <dt>{t("fleet.field.lastSeen")}</dt>
        <dd>{place.kind === "cloud" ? t("fleet.place.alwaysOn") : relativeTime(place.lastSeenAt, now)}</dd>
        <dt>{t("fleet.field.today")}</dt>
        <dd>{t("fleet.place.runs", { count: runsToday })}</dd>
        {place.description ? (
          <>
            <dt>{t("fleet.field.about")}</dt>
            <dd>{place.description}</dd>
          </>
        ) : null}
      </dl>
      <div class="fleet-actions">
        <button type="button" class="fleet-text-action is-primary" onClick={onRun} disabled={!place.online}>
          {t("fleet.place.runCommand")}
        </button>
        <button type="button" class="fleet-text-action" onClick={onBrowse}>
          {t("fleet.place.browse")}
        </button>
        <button type="button" class="fleet-text-action" onClick={() => onZen()}>
          {t("fleet.place.talk")}
        </button>
      </div>
      {place.instance
        ? <CloudBrowserActions targetId={place.id} allowed={uid === place.ownerUid} />
        : <PlaceActions place={place} uid={uid} focusPair={focusPair} />}
      <p class="note">
        {t("fleet.place.note")}
      </p>
    </div>
  );
}

type ProcessInspectorProps = {
  client: Pick<GSVClient, "proc">;
  process: ConsoleProcess;
  requestedApprovalId?: string;
  model: string | null;
  cost: number | null;
  responsibilities: number;
  canEditAi: boolean;
  now: number;
  onZen: (prefill?: string, pid?: string, request?: string) => void;
  lines: LedgerLine[];
  placeLabelFor: (placeId: string) => string;
};

export function ProcessInspector({ client, process, requestedApprovalId, model, cost, responsibilities, canEditAi, now, onZen, lines, placeLabelFor }: ProcessInspectorProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: INSTRUMENT_PROCESSES_KEY });
    void queryClient.invalidateQueries({ queryKey: INSTRUMENT_LEDGER_KEY });
  };
  const stop = useMutation({
    mutationFn: () => runConsoleProcessAction(client, { pid: process.pid, runId: process.activeRunId ?? undefined, action: "abort" }),
    onSuccess: invalidate,
  });
  const error = stop.error;

  return (
    <div>
      <h3>{process.personal ? "Ship" : process.label}</h3>
      <div class="sub">
        {shortPid(process.pid)} · {t(processStateLabel(process.state))}
      </div>
      <div class="full-id">{process.pid}</div>
      <dl class="fleet-kv">
        <dt>{t("fleet.field.state")}</dt>
        <dd>
          {t(process.activeRunId ? "fleet.process.state.running" : processStateLabel(process.state))}
          {process.queuedCount > 0 ? ` · ${t("fleet.process.queued", { count: process.queuedCount })}` : ""}
        </dd>
        <dt>{t("fleet.field.lastModel")}</dt>
        <dd>{model ?? "—"}</dd>
        <dt>{t("fleet.field.responsibilities")}</dt>
        <dd>{responsibilities === 0 ? t("fleet.process.noneOpen") : t("fleet.process.open", { count: responsibilities })}</dd>
        <dt>{t("fleet.field.lastActive")}</dt>
        <dd>{relativeTime(process.lastActiveAt, now)}</dd>
        <dt>{t("fleet.field.today")}</dt>
        <dd>{formatUsd(cost)}</dd>
        <dt>{t("fleet.field.runsAs")}</dt>
        <dd>
          {process.username} · {process.cwd}
        </dd>
      </dl>
      {requestedApprovalId || process.state === "waiting_hil" ? <FleetApproval key={requestedApprovalId ?? "pending"}
        pid={process.pid} who={process.username} label={process.personal ? undefined : process.label}
        requestId={requestedApprovalId} placeLabelFor={placeLabelFor} /> : null}
      <div class="fleet-actions">
        {process.interactive && (
          <button type="button" class="fleet-text-action is-primary" onClick={() => onZen(undefined, process.personal ? undefined : process.pid)}>
            {t("fleet.process.openConversation")}
          </button>
        )}
        <button type="button" class="fleet-text-action is-danger" onClick={() => stop.mutate()} disabled={!process.activeRunId || stop.isPending}>
          {t("fleet.process.stop")}
        </button>
      </div>
      {error ? <p class="error">{String(error)}</p> : null}
      <ProcessAiControls pid={process.pid} canEdit={canEditAi} />
      {lines.length > 0 ? (
        <div class="inspector-lines">
          <div class="kicker">{t("fleet.process.recently")}</div>
          {lines.map((line) => (
            <div class="line" key={line.id}>
              <span class="t">{relativeTime(line.timestamp, now)}</span> <span class="place">{placeLabelFor(line.place)}</span> {t(line.action.key, line.action.values)}
              <span class="m"> · {line.detail}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A process's open responsibilities: the bare count in the table, the counted phrase where the table collapses on narrow screens. */
function ResponsibilityCount({ count, more }: { count: number | null; more: boolean }) {
  const t = useT();
  return <>
    <span class="fleet-desktop-label">{count === null ? "-" : `${count}${more ? "+" : ""}`}</span>
    <span class="fleet-mobile-label">{count === null ? t("fleet.processes.responsibilitiesPending")
      : more ? t("fleet.processes.responsibilitiesMore", { count }) : t("fleet.processes.responsibilityCount", { count })}</span>
  </>;
}
