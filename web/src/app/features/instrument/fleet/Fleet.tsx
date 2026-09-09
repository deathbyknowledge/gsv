import { contactDisplayName } from "@humansandmachines/gsv/protocol";
import { ConnectPlace } from "./ConnectPlace";
import { AddContact, ContactInspector, useFleetContacts } from "./Contacts";
import { LoadingState } from "../../../components/ui/Spinner";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/preact-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import {
  loadConsoleAccounts,
  loadConsoleProcesses,
  loadConsoleTargets,
  runConsoleProcessAction,
} from "../../gsv-console/backend/consoleService";
import type { ConsoleProcess } from "../../gsv-console/domain/consoleModels";
import { readFilesPath } from "../../files/backend/filesService";
import { executeTerminalCommand } from "../../terminal/backend/terminalService";
import type { FleetRow } from "../Instrument";
import { INSTRUMENT_LEDGER_KEY, INSTRUMENT_LEDGER_PAGE, INSTRUMENT_PROCESSES_KEY, INSTRUMENT_TARGETS_KEY } from "../wire/queryKeys";
import {
  CLOUD_TARGET_ID,
  clockTime,
  formatUsd,
  costTodayByProcess,
  modelByProcess,
  ledgerFromSysLines,
  sysLedgerListResultSchema,
  mergeLedger,
  orderPlaces,
  orderProcesses,
  placeStateLabel,
  processRow,
  processStateLabel,
  processStateTone,
  recentlyTouched,
  relativeTime,
  runsTodayByPlace,
  targetRow,
  visibleProcesses,
  reconcileFleetSelection,
  type LedgerLine,
  type Place,
  shortPid,
  ledgerRow,
  fleetReferenceRow,
  isApprovalReference,
  type FleetReference,
} from "./fleetModel";
import { PlaceActions } from "./PlaceActions";
import { FleetApproval } from "./FleetApproval";
import { NewProcess, ProcessAiControls } from "./ProcessControls";
import { canConfigure } from "../settings/settingsModel";
import "./fleet.css";

export type FleetProps = {
  /** The row to land on, when Zen sent us here from a reference. */
  initialReference: FleetReference | null;
  /** Back to Zen, optionally with text placed in the prompt (a file reference, for instance) and a process to open instead of the ship. */
  onZen: (prefill?: string, pid?: string) => void;
};

const LEDGER_PAGE = INSTRUMENT_LEDGER_PAGE;
const NO_CURSOR: string | null = null;
const PROCESS_PAGE = 8;
type OpenFile = { target: string; path: string; name: string };
const LEDGER_QUERY_KEY = INSTRUMENT_LEDGER_KEY;

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** The Fleet distance: places, processes, the ledger, and files, with an inspector for the selected row. */
const ROW_PREFIXES = ["target:", "proc:", "contact:", "ledger:", "more:", "dir:", "file:"];
function isFleetRow(value: string | undefined): value is FleetRow {
  return value !== undefined && ROW_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function outcomeWord(outcome: string): string {
  if (outcome === "completed") return "done";
  if (outcome === "held" || outcome === "pending") return "held";
  return outcome;
}

export function Fleet({ initialReference, onZen }: FleetProps) {
  const { client, connected } = useGateway();
  const now = useNow();
  const initialRow = fleetReferenceRow(initialReference);
  const initialConnect = typeof initialReference === "object" && initialReference?.kind === "connect" ? initialReference.to : null;
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
  const responsibilitiesQuery = useQuery({
    queryKey: ["fleet", "responsibilities", "open"],
    queryFn: () => client.r12y.list({ states: ["open", "active", "waiting"], limit: 500 }),
    enabled: connected,
  });
  const accountsQuery = useQuery({
    queryKey: ["fleet", "accounts"],
    queryFn: () => loadConsoleAccounts(client),
    enabled: connected,
  });
  const viewer = accountsQuery.data?.find((account) => account.relation === "self");

  const contactsQuery = useFleetContacts(viewer);
  const contacts = contactsQuery.data ?? [];

  const places = useMemo(() => orderPlaces(targetsQuery.data ?? []), [targetsQuery.data]);
  const processes = useMemo(() => orderProcesses(processesQuery.data ?? []), [processesQuery.data]);
  /* the Kernel's ledger, newest first, a page at a time; a refetch walks every loaded page again so there is never a gap */
  const sysLedgerQuery = useInfiniteQuery({
    queryKey: [...LEDGER_QUERY_KEY, "sys"],
    enabled: connected,
    retry: false,
    initialPageParam: NO_CURSOR,
    queryFn: async ({ pageParam }) => {
      const raw = await client.call("sys.ledger.list", pageParam ? { limit: LEDGER_PAGE, cursor: pageParam } : { limit: LEDGER_PAGE });
      const page = sysLedgerListResultSchema.parse(raw);
      return { lines: ledgerFromSysLines(page.lines), nextCursor: page.nextCursor };
    },
    getNextPageParam: (last) => last.nextCursor,
  });

  const ledger = useMemo(() => (sysLedgerQuery.data?.pages ?? []).flatMap((page) => page.lines), [sysLedgerQuery.data]);
  const costToday = useMemo(() => costTodayByProcess(ledger, now), [ledger, now]);
  const modelByPid = useMemo(() => modelByProcess(ledger), [ledger]);
  const runsToday = useMemo(() => runsTodayByPlace(ledger, now), [ledger, now]);
  const placeLabel = useCallback(
    (id: string) => places.find((place) => place.id === id)?.label ?? id,
    [places],
  );

  const [selected, setSelected] = useState<FleetRow | null>(initialRow);
  const [creatingProcess, setCreatingProcess] = useState(false);
  const [connecting, setConnecting] = useState<"place" | "contact" | null>(initialConnect);
  useLayoutEffect(() => {
    setSelected(initialRow);
    setOpenFile(null);
    setCreatingProcess(false);
    setConnecting(initialConnect);
  }, [initialReference]);

  const selectedContact = selected?.startsWith("contact:") ? contacts.find((contact) => `contact:${contact.id}` === selected) : undefined;

  const selectedPlace = useMemo(
    () => (selected?.startsWith("target:") ? places.find((place) => targetRow(place.id) === selected) ?? null : null),
    [selected, places],
  );
  const selectedProcess = useMemo(
    () => (selected?.startsWith("proc:") ? processes.find((process) => processRow(process.pid) === selected) ?? null : null),
    [selected, processes],
  );
  const missingRequestedRow = selected !== null && selected === initialRow && (
    (selected.startsWith("proc:") && !selectedProcess) || (selected.startsWith("target:") && !selectedPlace)
  );
  const requestedKind = selected?.startsWith("proc:") ? "process" : "place";
  const requestedQuery = selected?.startsWith("proc:") ? processesQuery : targetsQuery;

  const [cmdOpen, setCmdOpen] = useState(false);
  /* the technical view shows raw syscalls and arguments; t toggles it */
  const [technical, setTechnical] = useState(false);
  const [processLimit, setProcessLimit] = useState(PROCESS_PAGE);
  const shownProcesses = useMemo(() => visibleProcesses(processes, selected, processLimit), [processes, selected, processLimit]);
  useEffect(() => {
    if (shownProcesses.length > processLimit) setProcessLimit(shownProcesses.length);
  }, [shownProcesses.length, processLimit]);
  const [openFile, setOpenFile] = useState<OpenFile | null>(null);
  const selectRow = useCallback((row: FleetRow) => {
    setSelected(row);
    setOpenFile(null);
    setCreatingProcess(false);
    setConnecting(null);
  }, []);
  const selectFile = useCallback((file: OpenFile) => {
    setOpenFile(file);
    setCreatingProcess(false);
    setConnecting(null);
  }, []);
  const processNameFor = (pid: string): string => {
    const found = processes.find((process) => process.pid === pid);
    return found ? (found.personal ? "ship" : found.label) : shortPid(pid);
  };
  const cmdInputRef = useRef<HTMLInputElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const cmdPlace = selectedPlace ?? places.find((place) => place.id === CLOUD_TARGET_ID) ?? null;

  const openCmd = useCallback(() => {
    setCmdOpen(true);
    window.setTimeout(() => cmdInputRef.current?.focus(), 0);
  }, []);

  const [localLines, setLocalLines] = useState<LedgerLine[]>([]);
  const runCommand = useMutation({
    mutationFn: (input: string) =>
      executeTerminalCommand(client, { input, target: cmdPlace?.id ?? CLOUD_TARGET_ID }),
    onSuccess: (entry) => {
      setLocalLines((lines) => [
        {
          id: `you:${entry.id}`,
          timestamp: entry.completedAt,
          processId: "you",
          place: entry.target || CLOUD_TARGET_ID,
          syscall: "shell.exec",
          what: "ran a command",
          detail: `${entry.command} · by you`,
          args: "",
          outcome: entry.status === "failed" ? "failed" : "completed",
          runId: null,
          costNanoUsd: null,
        },
        ...lines,
      ]);
    },
  });

  const shownLedger = useMemo(() => mergeLedger([localLines, ledger], localLines.length + ledger.length), [localLines, ledger]);
  const moreRow: FleetRow = "more:processes";
  const olderRow: FleetRow = "more:ledger";
  const loadOlder = useCallback(() => {
    if (sysLedgerQuery.hasNextPage && !sysLedgerQuery.isFetchingNextPage) void sysLedgerQuery.fetchNextPage();
  }, [sysLedgerQuery]);
  /* the rows are whatever is on screen, in reading order: places, processes, the ledger, folders and files */
  const manifestRef = useRef<HTMLDivElement>(null);
  const visibleRows = useCallback((): FleetRow[] => {
    const nodes = manifestRef.current?.querySelectorAll<HTMLElement>("[data-row]") ?? [];
    return Array.from(nodes).map((node) => node.dataset.row).filter(isFleetRow);
  }, []);
  useEffect(() => {
    if (creatingProcess || connecting) return;
    if (selected?.startsWith("proc:") && (processesQuery.isPending || processesQuery.isFetching)) return;
    if (selected?.startsWith("target:") && (targetsQuery.isPending || targetsQuery.isFetching)) return;
    const rows = visibleRows();
    if (rows.length === 0) return;
    const next = reconcileFleetSelection(selected, initialRow, rows);
    if (next !== selected) setSelected(next);
  }, [places, shownProcesses, shownLedger, processesQuery.isPending, processesQuery.isFetching, targetsQuery.isPending, targetsQuery.isFetching, selected, initialRow, visibleRows, creatingProcess, connecting, contactsQuery.data]);
  useEffect(() => {
    if (!selected) return;
    const row = Array.from(manifestRef.current?.querySelectorAll<HTMLElement>("[data-row]") ?? []).find((entry) => entry.dataset.row === selected);
    // ledger rows are display: contents and have no box of their own; their first cell does
    row?.scrollIntoView({ block: "nearest" });
  }, [selected, places, shownProcesses]);
  const selectedLine = useMemo(
    () => (selected?.startsWith("ledger:") ? shownLedger.find((line) => ledgerRow(line.id) === selected) ?? null : null),
    [selected, shownLedger],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest(".fleet-process-form, .fleet-connection")) return;
      const typing =
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      if (typing) {
        if (event.key === "Escape" && target === cmdInputRef.current) {
          event.preventDefault();
          setCmdOpen(false);
        }
        return;
      }
      if (event.key === "Enter" && target instanceof HTMLElement && target.closest("button, a[href]")) return;
      const rows = visibleRows();
      if (event.metaKey || event.ctrlKey || event.altKey || rows.length === 0) return;
      const index = selected ? rows.indexOf(selected) : 0;
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        selectRow(rows[Math.min(rows.length - 1, index + 1)]);
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        selectRow(rows[Math.max(0, index - 1)]);
      } else if (event.key === "t") {
        event.preventDefault();
        setTechnical((value) => !value);
      } else if (event.key === "/") {
        event.preventDefault();
        openCmd();
      } else if (event.key === "Enter" && selected && (selected.startsWith("dir:") || selected.startsWith("file:"))) {
        event.preventDefault();
        manifestRef.current?.querySelector<HTMLElement>(`[data-row="${selected}"]`)?.click();
      } else if (event.key === "Enter" && selected === olderRow) {
        event.preventDefault();
        loadOlder();
      } else if (event.key === "Enter" && selected === moreRow) {
        event.preventDefault();
        setProcessLimit(shownProcesses.length < processes.length ? shownProcesses.length + 20 : PROCESS_PAGE);
      } else if (event.key === "Enter") {
        const primary = inspectorRef.current?.querySelector<HTMLButtonElement>(".ibtn.is-primary");
        if (primary) {
          event.preventDefault();
          primary.focus();
        }
      } else if (event.key === "Escape") {
        setCmdOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, openCmd, processes.length, shownProcesses.length, loadOlder, visibleRows, selectRow]);

  useEffect(() => {
    if (!selected) return;
    const row = document.querySelector<HTMLElement>(`.fleet tr[data-row="${selected}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const connect = (to: "place" | "contact") => {
    setSelected(null);
    setOpenFile(null);
    setCreatingProcess(false);
    setConnecting(to);
    inspectorRef.current?.scrollIntoView({ block: "nearest" });
  };
  const selectConnected = (row: FleetRow) => {
    setConnecting(null);
    setSelected(row);
  };

  const submitCommand = (event: Event) => {
    event.preventDefault();
    const input = cmdInputRef.current;
    if (!input) return;
    const text = input.value.trim();
    input.value = "";
    setCmdOpen(false);
    if (text) runCommand.mutate(text);
  };

  const ledgerState = sysLedgerQuery.isPending ? "ledger loading" : "ledger current";
  const responsibilityCount = (pid: string) =>
    (responsibilitiesQuery.data?.responsibilities ?? []).filter(
      (record) => record.assignee.kind === "process" && record.assignee.processId === pid,
    ).length;
  const costFor = (pid: string) => costToday.get(pid) ?? null;
  const modelFor = (pid: string) => modelByPid.get(pid) ?? null;

  return (
    <main class="fleet" aria-label="Fleet">
      <div class="fleet-body">
        <div ref={manifestRef} class="fleet-manifest">
          <section class="fleet-block">
            <h2>
              <i /> Places
              <button type="button" class="fleet-heading-action" disabled={!connected || !viewer || !canConfigure(viewer, "sys.token.create")} onClick={() => connect("place")}>connect</button>
              <span class="count">{places.length}</span>
            </h2>
            {targetsQuery.error ? <p class="error">Could not list places: {String(targetsQuery.error)}</p> : null}
            <div class="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Place</th>
                  <th>Kind</th>
                  <th>State</th>
                  <th>Last seen</th>
                  <th class="num">Runs today</th>
                </tr>
              </thead>
              <tbody>
                {places.map((place) => (
                  <tr
                    key={place.id}
                    data-row={targetRow(place.id)}
                    class={selected === targetRow(place.id) ? "is-sel" : ""}
                    tabIndex={0}
                    onClick={() => selectRow(targetRow(place.id))}
                  >
                    <td>
                      <span class={`dot ${place.kind === "cloud" ? "is-on" : place.online ? "is-on" : "is-idle"}`} />
                      {place.label}
                    </td>
                    <td class="kind">{place.kind}</td>
                    <td class="dim">{placeStateLabel(place)}</td>
                    <td class="dim">{place.kind === "cloud" ? "always" : relativeTime(place.lastSeenAt, now)}</td>
                    <td class="num">{runsToday.get(place.id) ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </section>

          <section class="fleet-block">
            <h2>
              <i /> Processes
              {viewer && canConfigure(viewer, "proc.spawn") ? <button type="button" class="fleet-heading-action" disabled={!connected} onClick={() => {
                setSelected(null);
                setOpenFile(null);
                setConnecting(null);
                setCreatingProcess(true);
                inspectorRef.current?.scrollIntoView({ block: "nearest" });
              }}>new process</button> : null}
              <span class="count">{processes.length}</span>
            </h2>
            {processesQuery.error ? <p class="error">Could not list processes: {String(processesQuery.error)}</p> : null}
            <div class="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Process</th>
                  <th>Id</th>
                  <th>Responsibilities</th>
                  <th>State</th>
                  <th>Last active</th>
                  <th class="num">Today</th>
                </tr>
              </thead>
              <tbody>
                {shownProcesses.map((process) => (
                  <tr
                    key={process.pid}
                    data-row={processRow(process.pid)}
                    class={selected === processRow(process.pid) ? "is-sel" : ""}
                    tabIndex={0}
                    onClick={() => selectRow(processRow(process.pid))}
                  >
                    <td class="name">{process.personal ? "ship" : process.label}</td>
                    <td class="id" title={process.pid}>{shortPid(process.pid)}</td>
                    <td class="dim">{responsibilityCount(process.pid) || "—"}</td>
                    <td>
                      <span class={`dot is-${processStateTone(process.state)}`} />
                      {processStateLabel(process.state)}
                    </td>
                    <td class="dim">{relativeTime(process.lastActiveAt, now)}</td>
                    <td class="num">{formatUsd(costFor(process.pid))}</td>
                  </tr>
                ))}
                {processes.length > PROCESS_PAGE ? (
                  <tr class={`more${selected === moreRow ? " is-sel" : ""}`} data-row={moreRow} tabIndex={0} onClick={() => selectRow(moreRow)}>
                    <td colSpan={6}>
                      {shownProcesses.length < processes.length ? (
                        <button type="button" onClick={() => setProcessLimit(shownProcesses.length + 20)}>
                          show {Math.min(20, processes.length - shownProcesses.length)} more of {processes.length}
                        </button>
                      ) : (
                        <button type="button" onClick={() => setProcessLimit(PROCESS_PAGE)}>
                          show fewer
                        </button>
                      )}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
            </div>
          </section>

          <section class="fleet-block" aria-label="Contacts">
            <h2>
              <i /> Contacts
              <button type="button" class="fleet-heading-action" disabled={!connected || !viewer || (!canConfigure(viewer, "contact.invite.create") && !canConfigure(viewer, "contact.invite.accept"))} onClick={() => connect("contact")}>add contact</button>
              <span class="count">{contacts.filter((contact) => contact.state === "active").length}</span>
            </h2>
            {contactsQuery.error && <p class="error" role="alert">Could not list contacts: {contactsQuery.error.message}</p>}
            {viewer && !canConfigure(viewer, "contact.list") ? <p class="fleet-empty">Your account cannot list contacts.</p>
              : contactsQuery.isPending ? <p class="fleet-empty"><LoadingState>Loading contacts…</LoadingState></p>
              : contacts.length === 0 ? <p class="fleet-empty">Connect with someone who has their own Ship.</p>
              : <div class="tablewrap"><table>
                <thead><tr><th>Contact</th><th>Ship</th><th>State</th></tr></thead>
                <tbody>{contacts.map((contact) => <tr key={contact.id} data-row={`contact:${contact.id}`} tabIndex={0} class={selected === `contact:${contact.id}` ? "is-sel" : ""} onClick={() => selectRow(`contact:${contact.id}`)}>
                  <td><span class={`dot ${contact.state === "active" ? "is-on" : "is-idle"}`} />{contactDisplayName(contact)}</td><td class="dim">{contact.remoteOrigin}</td><td class="dim">{contact.state === "active" ? "connected" : "revoked"}</td>
                </tr>)}</tbody>
              </table></div>}
          </section>

          <section class="fleet-block">
            <h2>
              <i /> Ledger <span class="count">{ledgerState}</span>
            </h2>
            {sysLedgerQuery.error ? <p class="error">Could not read the ledger: {String(sysLedgerQuery.error)}</p> : null}
            <div class="fleet-ledger" role="table">
              {shownLedger.map((line) => (
                <div class={`row${selected === ledgerRow(line.id) ? " is-sel" : ""}`} role="row" key={line.id} data-row={ledgerRow(line.id)} tabIndex={0} onClick={() => selectRow(ledgerRow(line.id))}>
                  <span class="t">{clockTime(line.timestamp)}</span>
                  <span class="place">{placeLabel(line.place)}</span>
                  <span class="what">{technical ? line.syscall : line.what}</span>
                  <span class="m detail" title={line.detail}>{line.detail || "-"}</span>
                  <span class={line.outcome === "completed" ? "ok" : line.outcome === "failed" || line.outcome === "denied" ? "no" : "m"}>
                    {outcomeWord(line.outcome)}
                  </span>
                  <span class="m who">{line.processId === "you" ? "you" : processNameFor(line.processId)}</span>
                </div>
              ))}
              {shownLedger.length === 0 ? <span class="m">{ledgerState === "ledger loading" ? <LoadingState>reading…</LoadingState> : "nothing has run yet"}</span> : null}
              {sysLedgerQuery.hasNextPage ? (
                <div class={`older${selected === olderRow ? " is-sel" : ""}`} data-row={olderRow} tabIndex={0} onClick={() => selectRow(olderRow)}>
                  <button type="button" onClick={loadOlder} disabled={sysLedgerQuery.isFetchingNextPage}>
                    {sysLedgerQuery.isFetchingNextPage ? <LoadingState>reading…</LoadingState> : `show ${LEDGER_PAGE} older`}
                  </button>
                </div>
              ) : null}
            </div>
          </section>

          <section class="fleet-block">
            <h2>
              <i /> Files <span class="count">across places</span>
            </h2>
            <div class="fleet-tree">
              {recentlyTouched(shownLedger, 6).length > 0 ? (
                <ul class="touched">
                  {recentlyTouched(shownLedger, 6).map((line) => (
                    <li key={line.id}>
                      <span class="place">{placeLabel(line.place)}</span> {line.detail}{" "}
                      <span class="m">· {relativeTime(line.timestamp, now)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {places.map((place) => (
                <PlaceTree key={place.id} place={place} enabled={connected && place.online} onOpenFile={selectFile} selectedRow={selected} onSelect={selectRow} />
              ))}
            </div>
          </section>
        </div>

        <aside class="fleet-inspector" ref={inspectorRef}>
          {connecting === "place" ? (
            <ConnectPlace account={viewer} targets={targetsQuery.data ?? []} ready={!!targetsQuery.data && !targetsQuery.isError} onClose={() => setConnecting(null)} onConnected={(id) => selectConnected(targetRow(id))} />
          ) : connecting === "contact" ? (
            <AddContact account={viewer} onClose={() => setConnecting(null)} onAdded={(id) => selectConnected(`contact:${id}`)} />
          ) : selectedContact && !openFile ? (
            <ContactInspector key={selectedContact.id} contact={selectedContact} account={viewer} />
          ) : creatingProcess ? (
            <NewProcess onCreated={(pid) => onZen(undefined, pid)} onCancel={() => setCreatingProcess(false)} />
          ) : selectedLine && !openFile ? (
            <LineInspector line={selectedLine} placeLabelFor={placeLabel} processName={selectedLine.processId === "you" ? "you" : processNameFor(selectedLine.processId)} now={now} technical={technical} onZen={onZen} />
          ) : openFile ? (
            <FileInspector file={openFile} placeLabel={placeLabel(openFile.target)} onClose={() => setOpenFile(null)} onZen={onZen} />
          ) : selectedPlace ? (
            <PlaceInspector
              key={selectedPlace.id}
              place={selectedPlace}
              uid={accountsQuery.data?.find((account) => account.relation === "self")?.uid ?? null}
              focusPair={selected === initialRow}
              runsToday={runsToday.get(selectedPlace.id) ?? 0}
              now={now}
              onRun={openCmd}
              onBrowse={() => document.querySelector(".fleet-tree")?.scrollIntoView({ block: "start" })}
              onZen={onZen}
            />
          ) : selectedProcess ? (
            <ProcessInspector
              key={selectedProcess.pid}
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
              <h3>{requestedKind === "process" ? "Process" : "Place"}</h3>
              <div class="sub">{selected?.slice(selected.indexOf(":") + 1)}</div>
              {!connected || requestedQuery.isPending || requestedQuery.isFetching ? (
                <p class="note"><LoadingState>{connected ? `Loading ${requestedKind}…` : "Connecting…"}</LoadingState></p>
              ) : requestedQuery.isError ? (
                <p class="error" role="alert">Could not load this {requestedKind}: {requestedQuery.error.message}</p>
              ) : (
                <p class="note" role="status">This {requestedKind} is unavailable.</p>
              )}
            </div>
          ) : (
            <p class="note">{connected ? "Nothing here yet." : "Connecting…"}</p>
          )}
        </aside>
      </div>

      <form class={`fleet-cmdline${cmdOpen ? " is-open" : ""}`} onSubmit={submitCommand}>
        <span class="s">›</span>
        <span class="place">{cmdPlace?.label ?? "your cloud home"}</span>
        <input ref={cmdInputRef} type="text" placeholder="run a command on this place" aria-label="Fleet command" spellcheck={false} />
      </form>

      <div class="fleet-status">
        <span>
          <kbd>j</kbd>
          <kbd>k</kbd>move
        </span>
        <span>
          <kbd>enter</kbd>open
        </span>
        <span>
          <kbd>/</kbd>command</span><span><kbd>t</kbd>{technical ? "plain words" : "technical"}
        </span>
        <span>
          <kbd>z</kbd>zen
        </span>
        {runCommand.isPending ? <span class="is-live"><LoadingState>running…</LoadingState></span> : null}
        {runCommand.error ? <span style="color: var(--error)">{String(runCommand.error)}</span> : null}
        <span class="right">
          {clockTime(now)} · {ledgerState}
        </span>
      </div>
    </main>
  );
}

type OpenFileHandler = (file: OpenFile) => void;

function readArgsFor(target: string, path: string) {
  return { target: target === CLOUD_TARGET_ID ? null : target, path };
}

/** One directory level, read when opened; directories open in place, files open in the inspector. */
function DirNode({
  place,
  path,
  name,
  depth,
  enabled,
  onOpenFile,
  selectedRow,
  onSelect,
}: {
  place: Place;
  path: string;
  name: string;
  depth: number;
  enabled: boolean;
  onOpenFile: OpenFileHandler;
  selectedRow: FleetRow | null;
  onSelect: (row: FleetRow) => void;
}) {
  const rowKey: FleetRow = `dir:${place.id}:${path}`;
  const { client } = useGateway();
  const [open, setOpen] = useState(false);
  const listing = useQuery({
    queryKey: ["fleet", "files", place.id, path],
    queryFn: () => readFilesPath(client, readArgsFor(place.id, path)),
    enabled: enabled && open,
  });
  const entries = listing.data && listing.data.ok && "entries" in listing.data ? listing.data.entries : [];
  const error = listing.data && !listing.data.ok ? listing.data.error : listing.error ? String(listing.error) : null;
  const toggle = () => setOpen(!open);
  return (
    <div class={depth === 0 ? "" : "dir"}>
      <div
        class={`place-head${open ? " is-open" : ""}${selectedRow === rowKey ? " is-sel" : ""}`}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        data-row={rowKey}
        onClick={() => {
          onSelect(rowKey);
          toggle();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggle();
          }
        }}
      >
        <span class="tri">{open ? "▾" : "▸"}</span>
        {depth === 0 ? place.label : `${name}/`}
        {depth === 0 ? <span class="m">{enabled ? "~" : "offline"}</span> : null}
      </div>
      {open ? (
        <ul>
          {listing.isPending ? <li class="m">{enabled ? <LoadingState>reading…</LoadingState> : "offline"}</li> : null}
          {error ? <li class="m">{error}</li> : null}
          {entries.slice(0, 60).map((entry) =>
            entry.kind === "directory" ? (
              <li key={entry.path}>
                <DirNode place={place} path={entry.path} name={entry.name} depth={depth + 1} enabled={enabled} onOpenFile={onOpenFile} selectedRow={selectedRow} onSelect={onSelect} />
              </li>
            ) : (
              <li key={entry.path} class="f">
                <button
                  type="button"
                  class={`file${selectedRow === `file:${place.id}:${entry.path}` ? " is-sel" : ""}`}
                  data-row={`file:${place.id}:${entry.path}`}
                  onClick={() => {
                    onSelect(`file:${place.id}:${entry.path}`);
                    onOpenFile({ target: place.id, path: entry.path, name: entry.name });
                  }}
                >
                  {entry.name}
                </button>
              </li>
            ),
          )}
          {entries.length > 60 ? <li class="m">… {entries.length - 60} more</li> : null}
          {!listing.isPending && !error && entries.length === 0 ? <li class="m">empty</li> : null}
        </ul>
      ) : null}
    </div>
  );
}

function PlaceTree({ place, enabled, onOpenFile, selectedRow, onSelect }: { place: Place; enabled: boolean; onOpenFile: OpenFileHandler; selectedRow: FleetRow | null; onSelect: (row: FleetRow) => void }) {
  // the cloud home understands "~"; a machine reads relative to the daemon's home, so "." is the same place there
  return <DirNode place={place} path={place.id === CLOUD_TARGET_ID ? "~" : "."} name={place.label} depth={0} enabled={enabled} onOpenFile={onOpenFile} selectedRow={selectedRow} onSelect={onSelect} />;
}

const PREVIEW_LINES = 40;

/** A file in the inspector: a bounded preview, and the two things a person does with it here. */
function FileInspector({
  file,
  placeLabel: label,
  onClose,
  onZen,
}: {
  file: OpenFile;
  placeLabel: string;
  onClose: () => void;
  onZen: (prefill?: string) => void;
}) {
  const { client } = useGateway();
  const read = useQuery({
    queryKey: ["fleet", "file", file.target, file.path],
    queryFn: () => readFilesPath(client, { ...readArgsFor(file.target, file.path), limit: PREVIEW_LINES }),
  });
  const payload = read.data;
  const linkedEntries = payload && payload.ok && "entries" in payload ? payload.entries : null;
  const content = payload && payload.ok && "content" in payload ? payload.content : null;
  const text = content !== null && !Array.isArray(content) ? content : null;
  const image = Array.isArray(content) ? content.find((item) => item.type === "image") : null;
  const error = payload && !payload.ok ? payload.error : read.error ? String(read.error) : null;
  const reference = `@${file.target === CLOUD_TARGET_ID ? "gsv" : file.target} ${file.path}`;
  return (
    <div>
      <h3>{file.name}</h3>
      <div class="sub">
        {label} · {file.path}
      </div>
      <dl class="fleet-kv">
        <dt>Size</dt>
        <dd>{payload && payload.ok && "size" in payload && payload.size !== null ? `${payload.size.toLocaleString()} bytes` : "—"}</dd>
        <dt>Lines</dt>
        <dd>{payload && payload.ok && "lines" in payload && payload.lines !== null ? payload.lines : "—"}</dd>
      </dl>
      <div class="file-preview">
        {read.isPending ? <p class="note"><LoadingState>reading…</LoadingState></p> : null}
        {error ? <p class="error">{error}</p> : null}
        {linkedEntries ? (
          <>
            {/* TODO: remove once fix/symlink-dirs is in a released daemon; machines then report linked folders as folders */}
            <p class="note">This is a folder reached through a link; the place reported it as a file. What it holds:</p>
            <pre>{linkedEntries.map((entry) => `${entry.name}${entry.kind === "directory" ? "/" : ""}`).join("\n")}</pre>
          </>
        ) : null}
        {text !== null ? <pre>{text}</pre> : null}
        {image && image.type === "image" ? <img src={`data:${image.mimeType};base64,${image.data}`} alt={file.name} /> : null}
      </div>
      <div class="fleet-actions">
        <button type="button" class="ibtn is-primary" onClick={() => onZen(`${reference} `)}>
          talk about it
        </button>
        <button type="button" class="ibtn" onClick={() => void navigator.clipboard?.writeText(file.path)}>
          copy path
        </button>
        <button type="button" class="ibtn" onClick={onClose}>
          close
        </button>
      </div>
      <p class="note">Talking about it puts a reference to this file in the prompt; the ship reads it from {label} when it needs to, without copying it.</p>
    </div>
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
  return (
    <div>
      <h3>{place.label}</h3>
      <div class="sub">
        {place.kind} · {placeStateLabel(place)}
      </div>
      <div class="full-id">{place.id}</div>
      <dl class="fleet-kv">
        <dt>Runtime</dt>
        <dd>{place.platform || "—"}</dd>
        <dt>Driver</dt>
        <dd>{place.version ? `${place.kind === "cloud" ? "gateway" : "gsvd"} ${place.version}` : place.kind === "cloud" ? "gateway" : "—"}</dd>
        <dt>Last seen</dt>
        <dd>{place.kind === "cloud" ? "always on" : relativeTime(place.lastSeenAt, now)}</dd>
        <dt>Today</dt>
        <dd>{runsToday} runs</dd>
        {place.description ? (
          <>
            <dt>About</dt>
            <dd>{place.description}</dd>
          </>
        ) : null}
      </dl>
      <div class="fleet-actions">
        <button type="button" class="ibtn is-primary" onClick={onRun} disabled={!place.online}>
          run a command
        </button>
        <button type="button" class="ibtn" onClick={onBrowse}>
          browse files
        </button>
        <button type="button" class="ibtn" onClick={() => onZen()}>
          talk about it
        </button>
      </div>
      <PlaceActions place={place} uid={uid} focusPair={focusPair} />
      <p class="note">
        Everything the ship can do here, you can do from this panel. A command runs with no model in the loop and lands in the ledger like any other run.
      </p>
    </div>
  );
}

type ProcessInspectorProps = {
  process: ConsoleProcess;
  requestedApprovalId?: string;
  model: string | null;
  cost: number | null;
  responsibilities: number;
  canEditAi: boolean;
  now: number;
  onZen: (prefill?: string, pid?: string) => void;
  lines: LedgerLine[];
  placeLabelFor: (placeId: string) => string;
};

function ProcessInspector({ process, requestedApprovalId, model, cost, responsibilities, canEditAi, now, onZen, lines, placeLabelFor }: ProcessInspectorProps) {
  const { client } = useGateway();
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: INSTRUMENT_PROCESSES_KEY });
    void queryClient.invalidateQueries({ queryKey: LEDGER_QUERY_KEY });
  };
  const stop = useMutation({
    mutationFn: () => runConsoleProcessAction(client, { pid: process.pid, action: "abort" }),
    onSuccess: invalidate,
  });
  const error = stop.error;

  return (
    <div>
      <h3>{process.personal ? "ship" : process.label}</h3>
      <div class="sub">
        {shortPid(process.pid)} · {processStateLabel(process.state)}
      </div>
      <div class="full-id">{process.pid}</div>
      <dl class="fleet-kv">
        <dt>State</dt>
        <dd>
          {process.activeRunId ? "running" : processStateLabel(process.state)}
          {process.queuedCount > 0 ? ` · ${process.queuedCount} queued` : ""}
        </dd>
        <dt>Last model request</dt>
        <dd>{model ?? "—"}</dd>
        <dt>Responsibilities</dt>
        <dd>{responsibilities === 0 ? "none open" : `${responsibilities} open`}</dd>
        <dt>Last active</dt>
        <dd>{relativeTime(process.lastActiveAt, now)}</dd>
        <dt>Today</dt>
        <dd>{formatUsd(cost)}</dd>
        <dt>Runs as</dt>
        <dd>
          {process.username} · {process.cwd}
        </dd>
      </dl>
      {requestedApprovalId || process.state === "waiting_hil" ? <FleetApproval key={requestedApprovalId ?? "pending"} pid={process.pid} requestId={requestedApprovalId} /> : null}
      <div class="fleet-actions">
          <button type="button" class="ibtn is-primary" onClick={() => onZen(undefined, process.personal ? undefined : process.pid)}>
            open conversation
          </button>
        <button type="button" class="ibtn" onClick={() => stop.mutate()} disabled={process.state !== "running" || stop.isPending}>
          stop
        </button>
      </div>
      {error ? <p class="error">{String(error)}</p> : null}
      <ProcessAiControls pid={process.pid} canEdit={canEditAi} />
      {lines.length > 0 ? (
        <div class="inspector-lines">
          <div class="kicker">recently</div>
          {lines.map((line) => (
            <div class="line" key={line.id}>
              <span class="t">{relativeTime(line.timestamp, now)}</span> <span class="place">{placeLabelFor(line.place)}</span> {line.what}
              <span class="m"> · {line.detail}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}


/** One line of the ledger, in full: everything the row truncated, and the way to the run it belongs to. */
function LineInspector({
  line,
  placeLabelFor,
  processName,
  now,
  technical,
  onZen,
}: {
  line: LedgerLine;
  placeLabelFor: (placeId: string) => string;
  processName: string;
  now: number;
  technical: boolean;
  onZen: (prefill?: string, pid?: string) => void;
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
      <div class="fleet-actions">
        {line.processId !== "you" ? (
          <button type="button" class="ibtn is-primary" onClick={() => onZen(undefined, line.processId)}>
            open the conversation
          </button>
        ) : null}
        {(technical || line.detail) && <button type="button" class="ibtn" onClick={() => void navigator.clipboard?.writeText(technical ? line.args ?? "" : line.detail)}>
          copy
        </button>}
      </div>
      <p class="note">{technical ? "Raw view. Press t for plain words." : "Press t for the raw syscall and arguments."}</p>
    </div>
  );
}
