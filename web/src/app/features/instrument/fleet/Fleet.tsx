import { useMutation, useQuery, useQueryClient } from "@tanstack/preact-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { AsciiPlanet } from "../../../components/ui/AsciiPlanet";
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
  padRight,
  placeStateLabel,
  planetVariantForKind,
  processRow,
  processStateLabel,
  processStateTone,
  recentlyTouched,
  relativeTime,
  rowKeys,
  runsTodayByPlace,
  shortenPath,
  targetRow,
  type LedgerLine,
  type Place,
} from "./fleetModel";
import "./fleet.css";

export type FleetProps = {
  /** The row to land on, when Zen sent us here from a reference. */
  initialRow: FleetRow | null;
  onZen: () => void;
};

const LEDGER_PROCESSES = 3;
const LEDGER_ROWS_PER_PROCESS = 40;
const LEDGER_CAP = 60;
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

  const rows = useMemo(() => rowKeys(places, processes), [places, processes]);
  const [selected, setSelected] = useState<FleetRow | null>(initialRow);
  useEffect(() => {
    if (rows.length === 0) return;
    if (!selected || !rows.includes(selected)) setSelected(initialRow && rows.includes(initialRow) ? initialRow : rows[0]);
  }, [rows, selected, initialRow]);

  const selectedPlace = useMemo(
    () => (selected?.startsWith("target:") ? places.find((place) => targetRow(place.id) === selected) ?? null : null),
    [selected, places],
  );
  const selectedProcess = useMemo(
    () => (selected?.startsWith("proc:") ? processes.find((process) => processRow(process.pid) === selected) ?? null : null),
    [selected, processes],
  );

  const [cmdOpen, setCmdOpen] = useState(false);
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
          what: `${entry.command} · by you`,
          outcome: entry.status === "failed" ? "failed" : "completed",
          runId: null,
        },
        ...lines,
      ]);
    },
  });

  const shownLedger = useMemo(() => mergeLedger([localLines, ledger], LEDGER_CAP), [localLines, ledger]);

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
          <button type="button" onClick={onZen}>
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
                      <span class={`dot${place.online ? " is-on" : ""}`} />
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
          </section>

          <section class="fleet-block">
            <h2>
              <i /> Processes <span class="count">{processes.length}</span>
            </h2>
            {processesQuery.error ? <p class="error">Could not list processes: {String(processesQuery.error)}</p> : null}
            <table>
              <thead>
                <tr>
                  <th>PID</th>
                  <th>Name</th>
                  <th>Responsibilities</th>
                  <th>State</th>
                  <th>Last active</th>
                  <th class="num">Today</th>
                </tr>
              </thead>
              <tbody>
                {processes.map((process) => (
                  <tr
                    key={process.pid}
                    data-row={processRow(process.pid)}
                    class={selected === processRow(process.pid) ? "is-sel" : ""}
                    tabIndex={0}
                    onClick={() => setSelected(processRow(process.pid))}
                  >
                    <td>{process.pid}</td>
                    <td>{process.personal ? "ship" : process.label}</td>
                    <td class="dim">{responsibilityCount(process.pid) || "—"}</td>
                    <td>
                      <span class={`dot is-${processStateTone(process.state)}`} />
                      {processStateLabel(process.state)}
                    </td>
                    <td class="dim">{relativeTime(process.lastActiveAt, now)}</td>
                    <td class="num">{formatUsd(costFor(process.pid))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section class="fleet-block">
            <h2>
              <i /> Ledger <span class="count">{ledgerState}</span>
            </h2>
            {ledgerPids.length < processes.length ? (
              <p class="note">Showing the {ledgerPids.length} most recently active processes.</p>
            ) : null}
            {ledgerQuery.error ? <p class="error">Could not read history: {String(ledgerQuery.error)}</p> : null}
            <pre class="fleet-ledger">
              {shownLedger.map((line) => (
                <span key={line.id}>
                  <span class="t">{clockTime(line.timestamp)}</span>
                  {"  "}
                  <span class="place">{padRight(shortenPath(placeLabel(line.place), 16), 17)}</span>
                  {padRight(line.syscall, 14)}
                  {padRight(shortenPath(line.what, 44), 46)}
                  <span class={line.outcome === "completed" ? "ok" : line.outcome === "failed" || line.outcome === "denied" ? "no" : "m"}>
                    {padRight(line.outcome, 10)}
                  </span>
                  <span class="m">{line.processId === "you" ? "you" : `pid ${line.processId}`}</span>
                  {"\n"}
                </span>
              ))}
              {shownLedger.length === 0 ? <span class="m">{ledgerState === "ledger loading" ? "reading…" : "nothing has run yet"}</span> : null}
            </pre>
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
                      <span class="place">{placeLabel(line.place)}</span> {line.what}{" "}
                      <span class="m">· {relativeTime(line.timestamp, now)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {places.map((place) => (
                <PlaceTree key={place.id} place={place} enabled={connected && place.online} />
              ))}
            </div>
          </section>
        </div>

        <aside class="fleet-inspector" ref={inspectorRef}>
          {selectedPlace ? (
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
          <kbd>/</kbd>command
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

function PlaceTree({ place, enabled }: { place: Place; enabled: boolean }) {
  const { client } = useGateway();
  const [open, setOpen] = useState(false);
  const listing = useQuery({
    queryKey: ["fleet", "files", place.id],
    queryFn: () => readFilesPath(client, { target: place.id === CLOUD_TARGET_ID ? null : place.id, path: "~" }),
    enabled: enabled && open,
  });
  const entries = listing.data && listing.data.ok && "entries" in listing.data ? listing.data.entries : [];
  const error = listing.data && !listing.data.ok ? listing.data.error : listing.error ? String(listing.error) : null;
  return (
    <div>
      <div
        class={`place-head${open ? " is-open" : ""}`}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen(!open);
          }
        }}
      >
        <span class="tri">{open ? "▾" : "▸"}</span>
        {place.label}
        <span class="m">{enabled ? "~" : "offline"}</span>
      </div>
      {open ? (
        <ul>
          {listing.isPending ? <li class="m">reading…</li> : null}
          {error ? <li class="m">{error}</li> : null}
          {entries.slice(0, 40).map((entry) => (
            <li key={entry.path} class={entry.kind === "directory" ? "d" : "f"}>
              {entry.name}
              {entry.kind === "directory" ? "/" : ""}
            </li>
          ))}
          {entries.length > 40 ? <li class="m">… {entries.length - 40} more</li> : null}
          {!listing.isPending && !error && entries.length === 0 ? <li class="m">empty</li> : null}
        </ul>
      ) : null}
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
      <div class="body">
        <AsciiPlanet variant={planetVariantForKind(place.kind)} animate={false} showStars={false} label={`${place.label} as a planet`} />
      </div>
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
        <button type="button" class="ibtn" onClick={onZen}>
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
  onZen: () => void;
};

function ProcessInspector({ process, model, cost, responsibilities, models, preferredModelId, uid, now, onZen }: ProcessInspectorProps) {
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
        pid {process.pid} · {processStateLabel(process.state)}
      </div>
      <dl class="fleet-kv">
        <dt>State</dt>
        <dd>
          {process.activeRunId ? `running ${process.activeRunId}` : processStateLabel(process.state)}
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
          <button type="button" class="ibtn is-primary" onClick={onZen}>
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
      <p class="note">
        {process.state === "waiting_hil" && pending.data
          ? `The process is held on ${pending.data.syscall} on ${pending.data.target}. Approving runs exactly what it asked for, nothing else.`
          : "Responsibilities are the standing instructions this process carries between runs; the preferred model applies to your whole installation."}
      </p>
    </div>
  );
}
