import { useMutation, useQuery, useQueryClient } from "@tanstack/preact-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useSession } from "../../../services/session/SessionProvider";
import { decideChatHil, getChatHistory, getChatProcessAiConfig } from "../../chat/backend/chatService";
import { transcriptRowsFromHistory } from "../../chat/domain/transcript";
import {
  loadConsoleAccounts,
  loadConsoleModels,
  loadConsoleProcesses,
  loadConsoleTargets,
  runConsoleProcessAction,
  saveConsoleConfig,
} from "../../gsv-console/backend/consoleService";
import type { ConsoleProcess } from "../../gsv-console/domain/consoleModels";
import { preferredModelSaveEntry } from "../../gsv-console/domain/consoleSettings";
import { loadResponsibilitiesWorkspace } from "../../gsv-console/responsibilities/responsibilitiesService";
import { readFilesPath } from "../../files/backend/filesService";
import { executeTerminalCommand } from "../../terminal/backend/terminalService";
import type { FleetRow } from "../Instrument";
import { Wordmark } from "../shared/Wordmark";
import {
  CLOUD_TARGET_ID,
  clockTime,
  formatUsd,
  ledgerFromRows,
  mergeLedger,
  orderPlaces,
  orderProcesses,
  placeStateLabel,
  processRow,
  processStateLabel,
  processStateTone,
  recentlyTouched,
  relativeTime,
  rowKeys,
  runsTodayByPlace,
  targetRow,
  type LedgerLine,
  type Place,
  shortPid,
  ledgerRow,
} from "./fleetModel";
import "./fleet.css";

export type FleetProps = {
  /** The row to land on, when Zen sent us here from a reference. */
  initialRow: FleetRow | null;
  /** Back to Zen, optionally with text placed in the prompt (a file reference, for instance) and a process to open instead of the ship. */
  onZen: (prefill?: string, pid?: string) => void;
};

const LEDGER_PROCESSES = 3;
const LEDGER_ROWS_PER_PROCESS = 40;
const LEDGER_CAP = 60;
const PROCESS_PAGE = 8;
type OpenFile = { target: string; path: string; name: string };
const LEDGER_QUERY_KEY = ["fleet", "ledger"] as const;

type ProcessLedger = {
  pid: string;
  lines: LedgerLine[];
  costTotal: number | null;
  model: string | null;
};

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** The Fleet distance: places, processes, the ledger, and files, with an inspector for the selected row. */
function outcomeWord(outcome: string): string {
  if (outcome === "completed") return "done";
  if (outcome === "held" || outcome === "pending") return "held";
  return outcome;
}

export function Fleet({ initialRow, onZen }: FleetProps) {
  const { client, connected } = useGateway();
  const { snapshot } = useSession();
  const queryClient = useQueryClient();
  const now = useNow();

  const targetsQuery = useQuery({
    queryKey: ["devices", "fleet-targets"],
    queryFn: () => loadConsoleTargets(client),
    enabled: connected,
  });
  const processesQuery = useQuery({
    queryKey: ["processes", "fleet"],
    queryFn: () => loadConsoleProcesses(client),
    enabled: connected,
  });
  const responsibilitiesQuery = useQuery({
    queryKey: ["fleet", "responsibilities"],
    queryFn: () => loadResponsibilitiesWorkspace(client),
    enabled: connected,
  });
  const modelsQuery = useQuery({
    queryKey: ["fleet", "models"],
    queryFn: () => loadConsoleModels(client),
    enabled: connected,
  });
  const accountsQuery = useQuery({
    queryKey: ["fleet", "accounts"],
    queryFn: () => loadConsoleAccounts(client),
    enabled: connected,
  });

  const places = useMemo(() => orderPlaces(targetsQuery.data ?? []), [targetsQuery.data]);
  const processes = useMemo(() => orderProcesses(processesQuery.data ?? []), [processesQuery.data]);
  const ledgerPids = useMemo(() => processes.slice(0, LEDGER_PROCESSES).map((process) => process.pid), [processes]);

  const ledgerQuery = useQuery({
    queryKey: [...LEDGER_QUERY_KEY, ledgerPids.join(",")],
    enabled: connected && ledgerPids.length > 0,
    queryFn: async (): Promise<ProcessLedger[]> =>
      Promise.all(
        ledgerPids.map(async (pid) => {
          const history = await getChatHistory(client, { pid, limit: LEDGER_ROWS_PER_PROCESS, tail: true });
          return {
            pid,
            lines: ledgerFromRows(transcriptRowsFromHistory(history), pid),
            costTotal: history.context?.usage?.cost?.total ?? null,
            model: history.context?.model ?? null,
          };
        }),
      ),
  });

  useEffect(() => {
    return client.onSignal((signal) => {
      if (signal === "proc.run.finished" || signal === "proc.run.tool.finished") {
        void queryClient.invalidateQueries({ queryKey: LEDGER_QUERY_KEY });
      }
    });
  }, [client, queryClient]);

  const ledger = useMemo(
    () => mergeLedger((ledgerQuery.data ?? []).map((entry) => entry.lines), LEDGER_CAP),
    [ledgerQuery.data],
  );
  const runsToday = useMemo(() => runsTodayByPlace(ledger, now), [ledger, now]);
  const placeLabel = useCallback(
    (id: string) => places.find((place) => place.id === id)?.label ?? id,
    [places],
  );

  const [selected, setSelected] = useState<FleetRow | null>(initialRow);

  const selectedPlace = useMemo(
    () => (selected?.startsWith("target:") ? places.find((place) => targetRow(place.id) === selected) ?? null : null),
    [selected, places],
  );
  const selectedProcess = useMemo(
    () => (selected?.startsWith("proc:") ? processes.find((process) => processRow(process.pid) === selected) ?? null : null),
    [selected, processes],
  );

  const [cmdOpen, setCmdOpen] = useState(false);
  /* the technical view shows raw syscalls and arguments; t toggles it */
  const [technical, setTechnical] = useState(false);
  const [processLimit, setProcessLimit] = useState(PROCESS_PAGE);
  const [openFile, setOpenFile] = useState<OpenFile | null>(null);
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
          outcome: entry.status === "failed" ? "failed" : "completed",
          runId: null,
        },
        ...lines,
      ]);
    },
  });

  const shownLedger = useMemo(() => mergeLedger([localLines, ledger], LEDGER_CAP), [localLines, ledger]);
  const rows = useMemo(() => rowKeys(places, processes, shownLedger), [places, processes, shownLedger]);
  useEffect(() => {
    if (rows.length === 0) return;
    if (!selected || !rows.includes(selected)) setSelected(initialRow && rows.includes(initialRow) ? initialRow : rows[0]);
  }, [rows, selected, initialRow]);
  const selectedLine = useMemo(
    () => (selected?.startsWith("ledger:") ? shownLedger.find((line) => ledgerRow(line.id) === selected) ?? null : null),
    [selected, shownLedger],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");
      if (typing) {
        if (event.key === "Escape" && target === cmdInputRef.current) {
          event.preventDefault();
          setCmdOpen(false);
        }
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || rows.length === 0) return;
      const index = selected ? rows.indexOf(selected) : 0;
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        setSelected(rows[Math.min(rows.length - 1, index + 1)]);
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        setSelected(rows[Math.max(0, index - 1)]);
      } else if (event.key === "t") {
        event.preventDefault();
        setTechnical((value) => !value);
      } else if (event.key === "/") {
        event.preventDefault();
        openCmd();
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
  }, [rows, selected, openCmd]);

  useEffect(() => {
    if (!selected) return;
    const row = document.querySelector<HTMLElement>(`.fleet tr[data-row="${selected}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const submitCommand = (event: Event) => {
    event.preventDefault();
    const input = cmdInputRef.current;
    if (!input) return;
    const text = input.value.trim();
    input.value = "";
    setCmdOpen(false);
    if (text) runCommand.mutate(text);
  };

  const ledgerState = ledgerQuery.isPending && ledgerPids.length > 0 ? "ledger loading" : "ledger current";
  const responsibilityCount = (pid: string) =>
    (responsibilitiesQuery.data?.open ?? []).filter(
      (record) => record.assignee.kind === "process" && record.assignee.processId === pid,
    ).length;
  const costFor = (pid: string) => ledgerQuery.data?.find((entry) => entry.pid === pid)?.costTotal ?? null;
  const modelFor = (pid: string) => ledgerQuery.data?.find((entry) => entry.pid === pid)?.model ?? null;

  return (
    <main class="fleet" aria-label="Fleet">
      <div class="fleet-top">
        <div>
          <Wordmark /> &nbsp;·&nbsp; fleet
        </div>
        <div class="center">
          {snapshot.username ? `${snapshot.username}'s installation` : "installation"} · {places.length} places ·{" "}
          {processes.length} processes
          {modelsQuery.data?.preferredModelId ? ` · ${modelsQuery.data.preferredModelId}` : ""}
        </div>
        <div class="right">
          <button type="button" onClick={() => onZen()}>
            <kbd>z</kbd>zen
          </button>
        </div>
      </div>

      <div class="fleet-body">
        <div class="fleet-manifest">
          <section class="fleet-block">
            <h2>
              <i /> Places <span class="count">{places.length}</span>
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
                    onClick={() => setSelected(targetRow(place.id))}
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
              <i /> Processes <span class="count">{processes.length}</span>
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
                {processes.slice(0, processLimit).map((process) => (
                  <tr
                    key={process.pid}
                    data-row={processRow(process.pid)}
                    class={selected === processRow(process.pid) ? "is-sel" : ""}
                    tabIndex={0}
                    onClick={() => setSelected(processRow(process.pid))}
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
                  <tr class="more">
                    <td colSpan={6}>
                      {processLimit < processes.length ? (
                        <button type="button" onClick={() => setProcessLimit(processLimit + 20)}>
                          show {Math.min(20, processes.length - processLimit)} more of {processes.length}
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

          <section class="fleet-block">
            <h2>
              <i /> Ledger <span class="count">{ledgerState}</span>
            </h2>
            {ledgerPids.length < processes.length ? (
              <p class="note">Showing the {ledgerPids.length} most recently active processes.</p>
            ) : null}
            {ledgerQuery.error ? <p class="error">Could not read history: {String(ledgerQuery.error)}</p> : null}
            <div class="fleet-ledger" role="table">
              {shownLedger.map((line) => (
                <div class={`row${selected === ledgerRow(line.id) ? " is-sel" : ""}`} role="row" key={line.id} data-row={ledgerRow(line.id)} tabIndex={0} onClick={() => setSelected(ledgerRow(line.id))}>
                  <span class="t">{clockTime(line.timestamp)}</span>
                  <span class="place">{placeLabel(line.place)}</span>
                  <span class="what">{technical ? line.syscall : line.what}</span>
                  <span class="m detail" title={line.detail}>{line.detail}</span>
                  <span class={line.outcome === "completed" ? "ok" : line.outcome === "failed" || line.outcome === "denied" ? "no" : "m"}>
                    {outcomeWord(line.outcome)}
                  </span>
                  <span class="m who">{line.processId === "you" ? "you" : processNameFor(line.processId)}</span>
                </div>
              ))}
              {shownLedger.length === 0 ? <span class="m">{ledgerState === "ledger loading" ? "reading…" : "nothing has run yet"}</span> : null}
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
                <PlaceTree key={place.id} place={place} enabled={connected && place.online} onOpenFile={setOpenFile} />
              ))}
            </div>
          </section>
        </div>

        <aside class="fleet-inspector" ref={inspectorRef}>
          {selectedLine && !openFile ? (
            <LineInspector line={selectedLine} placeLabelFor={placeLabel} processName={selectedLine.processId === "you" ? "you" : processNameFor(selectedLine.processId)} now={now} technical={technical} onZen={onZen} />
          ) : openFile ? (
            <FileInspector file={openFile} placeLabel={placeLabel(openFile.target)} onClose={() => setOpenFile(null)} onZen={onZen} />
          ) : selectedPlace ? (
            <PlaceInspector
              place={selectedPlace}
              runsToday={runsToday.get(selectedPlace.id) ?? 0}
              now={now}
              onRun={openCmd}
              onBrowse={() => document.querySelector(".fleet-tree")?.scrollIntoView({ block: "start" })}
              onZen={onZen}
            />
          ) : selectedProcess ? (
            <ProcessInspector
              process={selectedProcess}
              model={modelFor(selectedProcess.pid)}
              cost={costFor(selectedProcess.pid)}
              responsibilities={responsibilityCount(selectedProcess.pid)}
              models={modelsQuery.data?.models.map((entry) => ({ id: entry.id, name: entry.name })) ?? []}
              preferredModelId={modelsQuery.data?.preferredModelId ?? null}
              uid={accountsQuery.data?.find((account) => account.relation === "self")?.uid ?? null}
              now={now}
              onZen={onZen}
              lines={shownLedger.filter((line) => line.processId === selectedProcess.pid).slice(0, 8)}
              placeLabelFor={placeLabel}
            />
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
        {runCommand.isPending ? <span class="is-live">running…</span> : null}
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
}: {
  place: Place;
  path: string;
  name: string;
  depth: number;
  enabled: boolean;
  onOpenFile: OpenFileHandler;
}) {
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
        class={`place-head${open ? " is-open" : ""}`}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
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
          {listing.isPending ? <li class="m">reading…</li> : null}
          {error ? <li class="m">{error}</li> : null}
          {entries.slice(0, 60).map((entry) =>
            entry.kind === "directory" ? (
              <li key={entry.path}>
                <DirNode place={place} path={entry.path} name={entry.name} depth={depth + 1} enabled={enabled} onOpenFile={onOpenFile} />
              </li>
            ) : (
              <li key={entry.path} class="f">
                <button type="button" class="file" onClick={() => onOpenFile({ target: place.id, path: entry.path, name: entry.name })}>
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

function PlaceTree({ place, enabled, onOpenFile }: { place: Place; enabled: boolean; onOpenFile: OpenFileHandler }) {
  // the cloud home understands "~"; a machine reads relative to the daemon's home, so "." is the same place there
  return <DirNode place={place} path={place.id === CLOUD_TARGET_ID ? "~" : "."} name={place.label} depth={0} enabled={enabled} onOpenFile={onOpenFile} />;
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
        {read.isPending ? <p class="note">reading…</p> : null}
        {error ? <p class="error">{error}</p> : null}
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
  runsToday: number;
  now: number;
  onRun: () => void;
  onBrowse: () => void;
  onZen: () => void;
};

function PlaceInspector({ place, runsToday, now, onRun, onBrowse, onZen }: PlaceInspectorProps) {
  return (
    <div>
      <h3>{place.label}</h3>
      <div class="sub">
        {place.kind} · {placeStateLabel(place)}
      </div>
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
        {place.kind === "machine" ? (
          <button type="button" class="ibtn is-danger" disabled title="Disconnecting lives in the console for now.">
            disconnect
          </button>
        ) : null}
      </div>
      <p class="note">
        Everything the ship can do here, you can do from this panel. A command runs with no model in the loop and lands in the ledger like any other run.
      </p>
    </div>
  );
}

type ProcessInspectorProps = {
  process: ConsoleProcess;
  model: string | null;
  cost: number | null;
  responsibilities: number;
  models: readonly { id: string; name: string }[];
  preferredModelId: string | null;
  uid: number | null;
  now: number;
  onZen: (prefill?: string, pid?: string) => void;
  lines: LedgerLine[];
  placeLabelFor: (placeId: string) => string;
};

function ProcessInspector({ process, model, cost, responsibilities, models, preferredModelId, uid, now, onZen, lines, placeLabelFor }: ProcessInspectorProps) {
  const { client } = useGateway();
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["processes"] });
    void queryClient.invalidateQueries({ queryKey: LEDGER_QUERY_KEY });
  };
  const stop = useMutation({
    mutationFn: () => runConsoleProcessAction(client, { pid: process.pid, action: "abort" }),
    onSuccess: invalidate,
  });
  const pending = useQuery({
    queryKey: ["fleet", "pending-hil", process.pid],
    queryFn: async () => (await getChatHistory(client, { pid: process.pid, limit: 1, tail: true })).pendingHil,
    enabled: process.state === "waiting_hil",
  });
  const decide = useMutation({
    mutationFn: (decision: "approve" | "deny") => {
      const request = pending.data;
      if (!request) throw new Error("The approval request is no longer pending.");
      return decideChatHil(client, { pid: process.pid, requestId: request.requestId, decision });
    },
    onSuccess: invalidate,
  });
  const aiConfig = useQuery({
    queryKey: ["fleet", "ai-config", process.pid],
    queryFn: () => getChatProcessAiConfig(client, { pid: process.pid }),
  });
  const changeModel = useMutation({
    mutationFn: (modelId: string) => {
      if (uid === null) throw new Error("Your account id is not known yet.");
      return saveConsoleConfig(client, preferredModelSaveEntry(uid, modelId || null));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["fleet", "models"] });
    },
  });
  const [showModels, setShowModels] = useState(false);
  const effectiveModel = aiConfig.data?.modelId ?? preferredModelId ?? model ?? "gsv/default";
  const error = stop.error ?? decide.error ?? changeModel.error ?? null;

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
        <dt>Model</dt>
        <dd>{effectiveModel}</dd>
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
      <div class="fleet-actions">
        {process.state === "waiting_hil" ? (
          <>
            <button type="button" class="ibtn is-primary" onClick={() => decide.mutate("approve")} disabled={!pending.data || decide.isPending}>
              approve
            </button>
            <button type="button" class="ibtn is-danger" onClick={() => decide.mutate("deny")} disabled={!pending.data || decide.isPending}>
              deny
            </button>
          </>
        ) : (
          <button type="button" class="ibtn is-primary" onClick={() => onZen(undefined, process.personal ? undefined : process.pid)}>
            open conversation
          </button>
        )}
        <button type="button" class="ibtn" onClick={() => stop.mutate()} disabled={process.state !== "running" || stop.isPending}>
          stop
        </button>
        <button type="button" class="ibtn" onClick={() => setShowModels(!showModels)}>
          change model
        </button>
        {showModels ? (
          <select
            class="fleet-select"
            aria-label="Preferred model"
            value={preferredModelId ?? ""}
            disabled={changeModel.isPending}
            onChange={(event) => {
              if (event.currentTarget instanceof HTMLSelectElement) changeModel.mutate(event.currentTarget.value);
            }}
          >
            <option value="">deployment default</option>
            {models.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      {error ? <p class="error">{String(error)}</p> : null}
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
      <p class="note">
        {process.state === "waiting_hil" && pending.data
          ? `The process is held on ${pending.data.syscall} on ${pending.data.target}. Approving runs exactly what it asked for, nothing else.`
          : "Responsibilities are the standing instructions this process carries between runs; the preferred model applies to your whole installation."}
      </p>
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
        <dt>Detail</dt>
        <dd>
          <pre class="line-detail">{line.detail}</pre>
        </dd>
      </dl>
      <div class="fleet-actions">
        {line.processId !== "you" ? (
          <button type="button" class="ibtn is-primary" onClick={() => onZen(undefined, line.processId)}>
            open the conversation
          </button>
        ) : null}
        <button type="button" class="ibtn" onClick={() => void navigator.clipboard?.writeText(line.detail)}>
          copy
        </button>
      </div>
      <p class="note">{technical ? "Raw view. Press t for plain words." : "Press t for the raw syscall and arguments."}</p>
    </div>
  );
}
