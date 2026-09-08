import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { useQuery } from "@tanstack/preact-query";
import type { JSX } from "preact";
import type { ProcHilRequest } from "@humansandmachines/gsv/protocol";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useSession } from "../../../services/session/SessionProvider";
import {
  decideChatHil,
  getChatHistory,
  listChatProcesses,
  sendChatMessage,
  spawnChatProcess,
} from "../../chat/backend/chatService";
import {
  applyChatSignal,
  chatRuntimeStateFromHistory,
  emptyChatRuntimeState,
  type ChatRuntimeState,
} from "../../chat/domain/transcript";
import { useChatConversation } from "../../chat/hooks/useChatConversation";
import { loadConsoleTargets } from "../../gsv-console/backend/consoleService";
import { executeTerminalCommand } from "../../terminal/backend/terminalService";
import type { FleetRow } from "../Instrument";
import { INSTRUMENT_TARGETS_KEY } from "../wire/queryKeys";
import { renderMarkdownHtml, escapeHtml } from "../shared/markdown";
import { PromptLine, type PromptPlace } from "../shared/PromptLine";
import { Wordmark } from "../shared/Wordmark";
import {
  activityDuration,
  countLabel,
  defaultPlace,
  formatSeconds,
  isStringValue,
  linkPlaceReferences,
  momentsFromConversation,
  parsePromptInput,
  PLACE_REFERENCE_PREFIX,
  placeLabel,
  placesUsed,
  resolvePlace,
  resolveTail,
  trimOutput,
  noteSummary,
  receiptDuration,
  receiptPhrases,
  receiptRunning,
  receiptSteps,
  CLOUD_PLACE_ID,
  RESOLVE_TAIL,
  type Activity,
  type Moment,
  type Place,
  type ReceiptPhrase,
} from "./zenModel";
import "./zen.css";

export type ZenProps = {
  /** Step back to Fleet, optionally landing on a row (a place mentioned in a response, for instance). */
  onFleet: (row?: FleetRow) => void;
  /** Open the first day: the places manifest with empty rows. */
  onFirstDay: () => void;
  /** Text to place in the prompt on arrival, such as a file reference from Fleet. */
  prefill?: string | null;
  onPrefillUsed?: () => void;
  /** A specific process to show instead of the ship, for a helper opened from Fleet. */
  pid?: string | null;
  /** Back to the ship's own conversation. */
  onShip?: () => void;
};

type StatusTone = "" | "is-on" | "is-live" | "is-warn" | "is-err";
type StatusPart = { tone: StatusTone; text: string };
const part = (tone: StatusTone, text: string): StatusPart => ({ tone, text });

type LocalRun = {
  id: string;
  target: string;
  command: string;
  output: string;
  failed: boolean;
  startedAt: number;
  endedAt: number;
  pending: boolean;
};

const HISTORY_LIMIT = 400;
const RESOLVE_FRAME_MS = 60;
/** How long a message that arrived whole takes to settle out of glyph noise: brisk for a line, longer for a page, never a wait. */
function settleDuration(length: number): number {
  return Math.min(1600, Math.max(700, length * 2.5));
}

function reducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function placesFromTargets(targets: Awaited<ReturnType<typeof loadConsoleTargets>>): Place[] {
  return targets.map((target) => ({ id: target.deviceId, label: target.label || target.deviceId, online: target.online }));
}

function railHtml(activity: Activity): string {
  const where = escapeHtml(activity.target);
  return activity.calls
    .map((call) => {
      const head = `<span class="cmd"><span class="where">${where}</span> <span class="dir">~</span> $ ${call.syscall === "shell.exec" ? escapeHtml(call.summary) : `${escapeHtml(call.syscall)} ${escapeHtml(call.summary)}`}</span>`;
      const body = call.output ? `\n${escapeHtml(call.output)}` : call.finished ? "" : `\n<span class="meta">running…</span>`;
      const failed = call.failed ? `\n<span class="err">failed</span>` : "";
      return `${head}${body}${failed}`;
    })
    .join("\n\n");
}

function ActivityLine({
  activity,
  places,
  open,
  onToggle,
}: {
  activity: Activity;
  places: readonly Place[];
  open: boolean;
  onToggle: () => void;
}) {
  const label = placeLabel(activity.target, places);
  const running = activity.calls.find((call) => !call.finished);
  const head = activity.live && running ? (
    <>
      <span class="pulse blink" />
      on <span class="place">{label}</span>{" "}
      <span class="n">· {running.syscall} {running.summary}</span>
    </>
  ) : (
    <>
      {activity.you ? "you used" : "used"} <span class="place">{label}</span>{" "}
      <span class="n">
        · {countLabel(activity.calls.length, "command")}
        {activityDuration(activity) ? ` · ${activityDuration(activity)}` : ""}
        {activity.you ? " · no model" : ""}
      </span>
    </>
  );
  return (
    <div class={`activity${open ? " is-open" : ""}${activity.you ? " is-you" : ""}`}>
      <div
        class="line"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onToggle();
          }
        }}
      >
        <span class="tri">{open ? "▾" : "▸"}</span>
        {head}
      </div>
      <div class="detail">
        <div class="machine-rail" dangerouslySetInnerHTML={{ __html: railHtml(activity) }} />
      </div>
    </div>
  );
}

/** One line under a ship's message: what it did, generated from its calls; the working opens beneath. */
function Receipt({ moment, places, open, onToggle }: { moment: Moment; places: readonly Place[]; open: boolean; onToggle: () => void }) {
  const phrases = receiptPhrases(moment);
  const running = receiptRunning(moment);
  const steps = receiptSteps(moment);
  const duration = receiptDuration(moment);
  const notes = moment.narration ? moment.narration.split(/\n\n+/).length : 0;
  const worked = moment.activities.filter((activity) => !activity.you);
  const phrase = (entry: ReceiptPhrase) =>
    entry.what === null ? (
      <>
        {entry.verb} {entry.count} {entry.noun}
      </>
    ) : (
      <>
        {entry.verb} <em>{entry.what}</em>
      </>
    );
  return (
    <div class={`receipt${open ? " is-open" : ""}`}>
      <div
        class="line"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onToggle();
          }
        }}
      >
        {running ? (
          <span class="now">
            <span class="pulse blink" />
            {phrase(running)}
          </span>
        ) : null}
        {phrases.map((entry, index) => (
          <span key={index} class={entry.failed ? "is-failed" : ""}>
            {index > 0 || running ? " · " : ""}
            {phrase(entry)}
            {entry.failed ? " · failed" : ""}
          </span>
        ))}
        <span class="n">
          {steps > 0 ? ` · ${countLabel(steps, "step")}${duration ? `, ${duration}` : ""}` : ""}
          {notes > 0 ? ` · ${countLabel(notes, "note")}` : ""}
          {` · ${open ? "close" : "open"}`}
        </span>
      </div>
      <div class="detail">
        {worked.map((activity) => (
          <div key={activity.key} class="place-rail">
            <div class="ph">on {placeLabel(activity.target, places)}</div>
            <div class="machine-rail" dangerouslySetInnerHTML={{ __html: railHtml(activity) }} />
          </div>
        ))}
        {moment.narration ? (
          <div class="place-rail">
            <div class="ph">thought it through</div>
            <div class="machine-rail narration">{moment.narration}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function StreamingText({ text, tick }: { text: string; tick: number }) {
  void tick;
  if (reducedMotion()) return <>{text}</>;
  const resolved = resolveTail(text, Math.random);
  return (
    <>
      {resolved.head}
      {resolved.tail.map((entry, index) =>
        entry.noise ? (
          <span class="noise" key={index}>
            {entry.noise}
          </span>
        ) : (
          entry.char
        ),
      )}
    </>
  );
}

function NoteMoment({ moment, open, focus, index, onToggle }: { moment: Moment; open: boolean; focus: boolean; index: number; onToggle: () => void }) {
  return (
    <div data-index={index} class={`zen-moment is-note${open ? " is-open" : ""}${focus ? " is-focus" : ""}`}>
      <div class="who">memory</div>
      <button type="button" class="note-line" aria-expanded={open} onClick={onToggle}>
        <span class="tri">{open ? "▾" : "▸"}</span>
        <span class="note-summary">{noteSummary(moment.text)}</span>
      </button>
      {open ? <div class="note-text">{moment.text}</div> : null}
    </div>
  );
}

export function Zen({ onFleet, onFirstDay, prefill, onPrefillUsed, pid: pidProp, onShip }: ZenProps) {
  const { client, connected } = useGateway();
  const { snapshot } = useSession();
  const who = snapshot.username || "you";

  const [pid, setPid] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<ChatRuntimeState>(() => emptyChatRuntimeState());
  /* the conversation is what was actually said, both ways; the process transcript is what the ship did */
  const conversation = useChatConversation({ processId: pid ?? "", enabled: pid !== null });
  const runtimeRef = useRef(runtime);
  const [places, setPlaces] = useState<Place[]>([]);
  const [where, setWhere] = useState<string | null>(null);
  const [localRuns, setLocalRuns] = useState<LocalRun[]>([]);
  const [openActivities, setOpenActivities] = useState<ReadonlySet<string>>(() => new Set());
  const [openNotes, setOpenNotes] = useState<ReadonlySet<string>>(() => new Set());
  /* browse mode: null while the prompt has focus, else the index of the focused moment (the TUI's browse cursor) */
  const [browse, setBrowse] = useState<number | null>(null);
  /* the place picker: shown while the prompt holds only "@" and a prefix; filtered as you type */
  const [pickerQuery, setPickerQuery] = useState<string | null>(null);
  const [pickerIndex, setPickerIndex] = useState(0);
  const pickerPlaces = useMemo(() => {
    if (pickerQuery === null) return [];
    const all = [{ id: "gsv", label: "your cloud home", online: true }, ...places.filter((place) => place.id !== "gsv" && place.online)];
    const needle = pickerQuery.toLowerCase();
    return all.filter((place) => !needle || place.id.toLowerCase().includes(needle) || place.label.toLowerCase().includes(needle)).slice(0, 8);
  }, [pickerQuery, places]);
  const onPromptInput = useCallback((value: string) => {
    const match = value.match(/^@(\S*)$/);
    setPickerQuery(match ? match[1] : null);
    setPickerIndex(0);
  }, []);
  const pickPlace = useCallback((id: string) => {
    setWhere(id);
    setPickerQuery(null);
    const input = promptRef.current?.querySelector("input");
    if (input) input.value = "";
  }, []);
  /* the chip opens the same picker that typing "@" does */
  const openPicker = useCallback(() => {
    const input = promptRef.current?.querySelector("input");
    if (!input) return;
    input.value = "@";
    input.focus();
    setPickerQuery("");
    setPickerIndex(0);
  }, []);
  const currentPlace = useMemo<PromptPlace>(() => {
    const id = where ?? CLOUD_PLACE_ID;
    if (id === CLOUD_PLACE_ID) return { id, label: "your cloud home", online: true };
    const place = places.find((entry) => entry.id === id);
    return { id, label: place?.label ?? id, online: place?.online ?? false };
  }, [places, where]);
  const onPromptKey = useCallback(
    (event: KeyboardEvent): boolean => {
      if (pickerQuery === null || pickerPlaces.length === 0) return false;
      if (event.key === "ArrowDown" || (event.key === "Tab" && !event.shiftKey)) {
        event.preventDefault();
        setPickerIndex((index) => (index + 1) % pickerPlaces.length);
        return true;
      }
      if (event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey)) {
        event.preventDefault();
        setPickerIndex((index) => (index - 1 + pickerPlaces.length) % pickerPlaces.length);
        return true;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        pickPlace(pickerPlaces[pickerIndex].id);
        return true;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setPickerQuery(null);
        return true;
      }
      return false;
    },
    [pickPlace, pickerIndex, pickerPlaces, pickerQuery],
  );
  const browseRef = useRef<number | null>(null);
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [lastRun, setLastRun] = useState<{ startedAt: number; endedAt: number | null } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [tick, setTick] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const momentsRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    runtimeRef.current = runtime;
  }, [runtime]);

  /* the personal process, spawned if the account has none yet */
  useEffect(() => {
    if (!connected) return undefined;
    if (pidProp) {
      setPid(pidProp);
      return undefined;
    }
    let cancelled = false;
    void (async () => {
      try {
        const processes = await listChatProcesses(client, {});
        const personal = processes.find((process) => process.personal) ?? processes.find((process) => process.interactive);
        if (personal) {
          if (!cancelled) setPid(personal.pid);
          return;
        }
        const spawned = await spawnChatProcess(client, { interactive: true, label: "ship" });
        if (!cancelled) setPid(spawned.pid);
      } catch (error) {
        if (!cancelled) setNote(error instanceof Error ? error.message : "Could not reach your ship.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, connected, pidProp]);

  /* places, from the instrument's targets cache; WireSync keeps it current from the wire */
  const targetsQuery = useQuery({
    queryKey: INSTRUMENT_TARGETS_KEY,
    queryFn: () => loadConsoleTargets(client),
    enabled: connected,
  });
  useEffect(() => {
    if (!targetsQuery.data) return;
    const next = placesFromTargets(targetsQuery.data);
    setPlaces(next);
    setWhere((current) => current ?? defaultPlace(next));
  }, [targetsQuery.data]);

  /* history, then live signals reduced into the runtime state */
  const refreshHistory = useCallback(async () => {
    if (!pid) return;
    const history = await getChatHistory(client, { pid, tail: true, limit: HISTORY_LIMIT });
    const next = chatRuntimeStateFromHistory(history);
    runtimeRef.current = next;
    setRuntime(next);
  }, [client, pid]);

  useEffect(() => {
    if (!connected || !pid) return undefined;
    let active = true;
    let observing = false;
    void refreshHistory().catch((error: Error) => setNote(error.message));
    void client.proc
      .observe({ pid })
      .then(() => {
        if (!active) return client.proc.unobserve({ pid }).then(() => undefined);
        observing = true;
        return undefined;
      })
      .catch(() => undefined);
    const unsubscribe = client.onSignal((signal, payload) => {
      const reduction = applyChatSignal(runtimeRef.current, signal, payload, { pid });
      if (!reduction.matched) return;
      runtimeRef.current = reduction.state;
      setRuntime(reduction.state);
      if (reduction.refreshHistory) void refreshHistory().catch(() => undefined);
    });
    return () => {
      active = false;
      unsubscribe();
      if (observing) void client.proc.unobserve({ pid }).catch(() => undefined);
    };
  }, [client, connected, pid, refreshHistory]);

  /* the run clock and the resolve animation */
  const thinking = runtime.activeRunId !== null;
  useEffect(() => {
    if (thinking) {
      setLastRun({ startedAt: Date.now(), endedAt: null });
      const interval = window.setInterval(() => setNow(Date.now()), 100);
      return () => window.clearInterval(interval);
    }
    setLastRun((current) => (current && current.endedAt === null ? { ...current, endedAt: Date.now() } : current));
    return undefined;
  }, [thinking]);

  const streaming = runtime.rows.some((row) => row.streaming);
  /* a message that arrives whole settles out of noise on arrival; a streamed one already did, character by character */
  const [settling, setSettling] = useState<ReadonlyMap<string, number>>(() => new Map());
  const animating = streaming || settling.size > 0;
  useEffect(() => {
    if (!animating || reducedMotion()) return undefined;
    const interval = window.setInterval(() => setTick((value) => value + 1), RESOLVE_FRAME_MS);
    return () => window.clearInterval(interval);
  }, [animating]);

  /* moments: the runtime's, plus the commands run by hand */
  const moments = useMemo(() => {
    const fromRuntime = momentsFromConversation(conversation.rows, runtime.rows, runtime.activeRunId);
    const fromLocal: Moment[] = localRuns.map((run) => ({
      id: run.id,
      role: "ship",
      text: "",
      streaming: false,
      thinking: false,
      runId: null,
      timestamp: run.startedAt,
      narration: "",
      activities: [
        {
          key: run.id,
          target: run.target,
          calls: [
            {
              callId: run.id,
              syscall: "shell.exec",
              summary: run.command,
              output: run.output,
              finished: !run.pending,
              failed: run.failed,
            },
          ],
          live: run.pending,
          you: true,
          startedAt: run.startedAt,
          endedAt: run.endedAt,
        },
      ],
    }));
    return [...fromRuntime, ...fromLocal].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  }, [conversation.rows, localRuns, runtime.activeRunId, runtime.rows]);

  const seenMomentsRef = useRef<Set<string> | null>(null);
  const streamedMomentsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const moment of moments) if (moment.streaming) streamedMomentsRef.current.add(moment.id);
    const whole = moments.filter((moment) => moment.role === "ship" && moment.text && !moment.streaming).map((moment) => moment.id);
    if (seenMomentsRef.current === null) {
      // the history as first loaded is not news
      seenMomentsRef.current = new Set(whole);
      return;
    }
    const seen = seenMomentsRef.current;
    const fresh = whole.filter((id) => !seen.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) seen.add(id);
    const arrived = fresh.filter((id) => !streamedMomentsRef.current.has(id));
    if (arrived.length === 0 || reducedMotion()) return;
    const startedAt = Date.now();
    setSettling((current) => {
      const next = new Map(current);
      for (const id of arrived) next.set(id, startedAt);
      return next;
    });
  }, [moments]);
  useEffect(() => {
    if (settling.size === 0) return;
    const done = [...settling].filter(([id, startedAt]) => {
      const moment = moments.find((entry) => entry.id === id);
      return !moment || Date.now() - startedAt >= settleDuration(moment.text.length);
    });
    if (done.length === 0) return;
    setSettling((current) => {
      const next = new Map(current);
      for (const [id] of done) next.delete(id);
      return next;
    });
  }, [moments, settling, tick]);
  /** How much of a settling message is shown so far: the settled head plus the noisy tail sweeping to the end. */
  const settlePrefix = (moment: Moment): number | null => {
    const startedAt = settling.get(moment.id);
    if (startedAt === undefined) return null;
    const progress = (Date.now() - startedAt) / settleDuration(moment.text.length);
    if (progress >= 1) return null;
    return Math.ceil(progress * (moment.text.length + RESOLVE_TAIL));
  };

  useEffect(() => {
    if (browseRef.current !== null) return;
    const element = momentsRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [moments, tick]);

  const latest = moments[moments.length - 1];
  const pendingHil: ProcHilRequest | null = runtime.pendingHil;

  const toggleActivity = useCallback((key: string) => {
    setOpenActivities((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /* the prompt */
  const say = useCallback(
    async (text: string) => {
      if (!pid) {
        setNote("Your ship is still starting.");
        return;
      }
      conversation.appendOptimistic(text);
      try {
        await sendChatMessage(client, { pid, message: text });
      } catch (error) {
        setNote(error instanceof Error ? error.message : "The message did not go through.");
      }
    },
    [client, conversation, pid],
  );

  const runDirectly = useCallback(
    async (command: string) => {
      const target = where ?? defaultPlace(places);
      const id = `you:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      const startedAt = Date.now();
      setLocalRuns((current) => [...current, { id, target, command, output: "", failed: false, startedAt, endedAt: startedAt, pending: true }]);
      setOpenActivities((current) => new Set([...current, id]));
      try {
        const entry = await executeTerminalCommand(client, { input: command, target: target === "gsv" ? null : target });
        const output = trimOutput([entry.stdout, entry.stderr].filter((part) => part.trim()).join("\n"));
        setLocalRuns((current) =>
          current.map((run) =>
            run.id === id
              ? { ...run, output: output || (entry.exitCode === 0 ? "(no output)" : ""), failed: entry.status === "failed" || (entry.exitCode ?? 0) !== 0, endedAt: Date.now(), pending: false }
              : run,
          ),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "The command did not run.";
        setLocalRuns((current) => current.map((run) => (run.id === id ? { ...run, output: message, failed: true, endedAt: Date.now(), pending: false } : run)));
      }
    },
    [client, places, where],
  );

  const onSubmit = useCallback(
    (raw: string) => {
      setNote(null);
      setInputHistory((current) => [...current.filter((entry) => entry !== raw), raw].slice(-50));
      setHistoryIndex(null);
      const intent = parsePromptInput(raw);
      if (!intent) return;
      if (intent.kind === "switch") {
        const id = resolvePlace(intent.name, places);
        if (id) setWhere(id);
        else setNote(`No place called ${intent.name}.`);
        return;
      }
      if (intent.kind === "run") {
        void runDirectly(intent.command);
        return;
      }
      void say(intent.text);
    },
    [places, runDirectly, say],
  );

  const onHistory = useCallback(
    (direction: -1 | 1) => {
      if (inputHistory.length === 0) return;
      const nextIndex = historyIndex === null ? (direction === -1 ? inputHistory.length - 1 : null) : Math.min(inputHistory.length - 1, Math.max(0, historyIndex + direction));
      setHistoryIndex(nextIndex);
      const input = promptRef.current?.querySelector("input");
      if (input) input.value = nextIndex === null ? "" : inputHistory[nextIndex];
    },
    [historyIndex, inputHistory],
  );

  /* approvals */
  const decide = useCallback(
    async (decision: "approve" | "deny") => {
      if (!pid || !pendingHil) return;
      try {
        await decideChatHil(client, { pid, requestId: pendingHil.requestId, decision });
      } catch (error) {
        setNote(error instanceof Error ? error.message : "The decision did not go through.");
      }
    },
    [client, pendingHil, pid],
  );

  /* an approval takes the keys: the prompt lets go so y and n reach the decision */
  useEffect(() => {
    if (pendingHil) promptRef.current?.querySelector("input")?.blur();
  }, [pendingHil]);

  useEffect(() => {
    if (!prefill) return;
    const input = promptRef.current?.querySelector("input");
    if (!input) return;
    input.value = prefill;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    onPrefillUsed?.();
  }, [prefill, onPrefillUsed]);

  const focusPrompt = useCallback(() => {
    promptRef.current?.querySelector("input")?.focus();
  }, []);
  const onPromptFocus = useCallback(
    (focused: boolean) => {
      if (focused) {
        browseRef.current = null;
        setBrowse(null);
      } else {
        const index = moments.length > 0 ? moments.length - 1 : null;
        browseRef.current = index;
        setBrowse(index);
      }
    },
    [moments.length],
  );
  useEffect(() => {
    browseRef.current = browse;
    if (browse === null) return;
    const container = momentsRef.current;
    const focused = container?.querySelector<HTMLElement>(`[data-index="${browse}"]`);
    if (!container || !focused) return;
    // keep the focused moment inside the reading area with a margin, scrolling the container itself
    const margin = 48;
    const top = focused.offsetTop - container.offsetTop;
    const bottom = top + focused.offsetHeight;
    if (top - margin < container.scrollTop) container.scrollTop = Math.max(0, top - margin);
    else if (bottom + margin > container.scrollTop + container.clientHeight) container.scrollTop = bottom + margin - container.clientHeight;
  }, [browse]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      const typing = target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");
      if (typing && event.key === "Escape") {
        // Escape leaves the prompt even if the input's own handler did not run.
        event.preventDefault();
        target.blur();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (pendingHil && !typing && (event.key === "y" || event.key === "n")) {
        event.preventDefault();
        void decide(event.key === "y" ? "approve" : "deny");
        return;
      }
      if (typing) return;
      const focused = browse !== null ? moments[browse] : latest;
      if (event.key === "o" && focused && focused.activities.length > 0) {
        event.preventDefault();
        toggleActivity(focused.activities[focused.activities.length - 1].key);
        return;
      }
      if (browse !== null && (event.key === "j" || event.key === "ArrowDown")) {
        event.preventDefault();
        setBrowse(Math.min(moments.length - 1, browse + 1));
        return;
      }
      if (browse !== null && (event.key === "k" || event.key === "ArrowUp")) {
        event.preventDefault();
        setBrowse(Math.max(0, browse - 1));
        return;
      }
      if (event.key === "Escape" || event.key === "Enter") {
        event.preventDefault();
        focusPrompt();
        return;
      }
      if (event.key.length === 1 && !["z", "n", "j", "k", "o", "l", "x", "?"].includes(event.key)) {
        focusPrompt();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [browse, decide, focusPrompt, latest, moments, pendingHil, toggleActivity]);

  /* references to places inside ship text */
  const onTextClick = useCallback(
    (event: JSX.TargetedMouseEvent<HTMLDivElement>) => {
      const target = event.target;
      if (!(target instanceof HTMLAnchorElement)) return;
      const href = target.getAttribute("href") ?? "";
      if (!href.startsWith(PLACE_REFERENCE_PREFIX)) return;
      event.preventDefault();
      onFleet(`target:${decodeURIComponent(href.slice(PLACE_REFERENCE_PREFIX.length))}`);
    },
    [onFleet],
  );

  /* the status line */
  const status = useMemo<StatusPart[]>(() => {
    if (browse !== null) {
      return [part("is-live", "browse"), part("", `${browse + 1} of ${moments.length}`), part("", "j k move"), part("", "o show the run"), part("", "esc or type to return")];
    }
    if (!connected) return [part("is-err", "not connected")];
    if (!pid) return [part("", "starting your ship")];
    if (thinking) {
      const elapsed = lastRun ? now - lastRun.startedAt : 0;
      return [
        part("is-live", "thinking"),
        part("", formatSeconds(elapsed)),
        part("", runtime.context?.model ?? ""),
        part("", `${placeLabel(where ?? "gsv", places)} ready`),
      ].filter((entry) => entry.text);
    }
    if (pendingHil) {
      return [
        part("is-warn", "waiting for your approval"),
        part("", `${pendingHil.syscall} on ${placeLabel(pendingHil.target, places)}`),
        part("", "nothing has run"),
      ];
    }
    const lastLocal = localRuns[localRuns.length - 1];
    if (latest && lastLocal && latest.id === lastLocal.id) {
      return [
        part(lastLocal.failed ? "is-err" : "is-on", `${lastLocal.failed ? "failed" : "ran"} on ${placeLabel(lastLocal.target, places)}`),
        part("", formatSeconds(lastLocal.endedAt - lastLocal.startedAt)),
        part("", "no model in the loop"),
      ];
    }
    const parts: StatusPart[] = [];
    if (runtime.context?.model) parts.push(part("is-on", `answered by ${runtime.context.model}`));
    if (lastRun && lastRun.endedAt !== null) parts.push(part("", formatSeconds(lastRun.endedAt - lastRun.startedAt)));
    const usage = runtime.context?.usage;
    if (usage?.cost) parts.push(part("", `$${usage.cost.total.toFixed(2)} so far`));
    else if (usage?.totalTokens) parts.push(part("", `${usage.totalTokens.toLocaleString()} tokens so far`));
    if (latest && latest.role === "ship") parts.push(part("", `${countLabel(placesUsed(latest), "place")} used`));
    if (parts.length === 0) parts.push(part("", "nothing yet"));
    return parts;
  }, [browse, connected, lastRun, latest, localRuns, moments.length, now, pendingHil, pid, places, runtime.context, thinking, where]);

  const onlinePlaces = places.filter((place) => place.online);
  const empty = moments.length === 0 && pid !== null;

  return (
    <main class={`zen${browse !== null ? " is-browse" : ""}`} aria-label="Zen">
      <div class="instrument-top">
        <Wordmark />
        <span>
          ship ·{" "}
          <span class={connected ? "is-on" : "is-err"} style={connected ? "color: var(--online)" : "color: var(--error)"}>
            {pidProp ? (
              <>
                helper ·{" "}
                <button type="button" onClick={onShip}>
                  back to your ship
                </button>
              </>
            ) : connected ? (
              `${countLabel(onlinePlaces.length + 1, "place")} reachable`
            ) : (
              "offline"
            )}
          </span>
        </span>
        <span class="keys">
        <button type="button" onClick={() => onFleet()}>
          <kbd>z</kbd>fleet
        </button>
        <button type="button" onClick={onFirstDay}>
          <kbd>n</kbd>first day
        </button>
        <span>
          <kbd>?</kbd>keys
        </span>
      </span>
      </div>

      <div class="zen-body">
        <div class="zen-timeline" aria-hidden="true">
          {moments.map((moment, index) => (
            <i key={moment.id} class={`${moment.role === "human" ? "is-human" : moment.role === "note" ? "is-note" : ""}${index === moments.length - 1 ? " is-here" : ""}${browse === index ? " is-focus" : ""}`} />
          ))}
        </div>
        {empty ? (
          <div class="zen-empty">
            <p>
              Ask anything. I can reach <span class="place">your cloud home</span>
              {onlinePlaces.map((place) => (
                <span key={place.id}>
                  , <span class="place">{place.label}</span>
                </span>
              ))}
              . Press <span class="place">n</span> to connect more places.
            </p>
          </div>
        ) : (
          <div class="zen-moments" ref={momentsRef}>
            {moments.map((moment, index) => {
              const isLatest = index === moments.length - 1;
              if (moment.role === "note") {
                return (
                  <NoteMoment
                    key={moment.id}
                    moment={moment}
                    index={index}
                    focus={browse === index}
                    open={openNotes.has(moment.id)}
                    onToggle={() =>
                      setOpenNotes((current) => {
                        const next = new Set(current);
                        if (next.has(moment.id)) next.delete(moment.id);
                        else next.add(moment.id);
                        return next;
                      })
                    }
                  />
                );
              }
              return (
                <div key={moment.id} data-index={index} class={`zen-moment ${moment.role === "human" ? "is-human" : "is-ship"}${isLatest ? "" : " is-older"}${browse === index ? " is-focus" : ""}`}>
                  <div class="who">{moment.role === "human" ? who : "ship"}</div>
                  {moment.activities
                    .filter((activity) => activity.you)
                    .map((activity) => (
                      <ActivityLine
                        key={activity.key}
                        activity={activity}
                        places={places}
                        open={openActivities.has(activity.key)}
                        onToggle={() => toggleActivity(activity.key)}
                      />
                    ))}
                  {moment.role === "human" ? (
                    <div class="text">{moment.text}</div>
                  ) : moment.streaming ? (
                    <div class="text">
                      <StreamingText text={moment.text} tick={tick} />
                      <span class="zen-caret blink" />
                    </div>
                  ) : settlePrefix(moment) !== null ? (
                    <div class="text is-settling">
                      <StreamingText text={moment.text.slice(0, settlePrefix(moment) ?? 0)} tick={tick} />
                    </div>
                  ) : moment.text ? (
                    <div class="text" onClick={onTextClick} dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(linkPlaceReferences(moment.text, places)) }} />
                  ) : moment.thinking ? (
                    <div class="text">
                      <span class="zen-caret blink" />
                    </div>
                  ) : null}
                  {moment.role === "ship" && (moment.activities.some((activity) => !activity.you) || moment.narration) ? (
                    <Receipt
                      moment={moment}
                      places={places}
                      open={openActivities.has(`receipt:${moment.id}`)}
                      onToggle={() => toggleActivity(`receipt:${moment.id}`)}
                    />
                  ) : null}
                  {isLatest && pendingHil ? (
                    <div class="zen-approval">
                      <div class="q">approval · {placeLabel(pendingHil.target, places)}</div>
                      <div class="machine-rail">
                        <span class="cmd">
                          <span class="who">{who}</span>@<span class="where">{pendingHil.target}</span> $ {pendingHil.syscall}{" "}
                          {describeHilArgs(pendingHil)}
                        </span>
                      </div>
                      <div class="keys">
                        <button type="button" class="ibtn is-primary" onClick={() => void decide("approve")}>
                          <kbd>y</kbd> run it
                        </button>
                        <button type="button" class="ibtn" onClick={() => void decide("deny")}>
                          <kbd>n</kbd> don't
                        </button>
                        <span>nothing runs until you answer</span>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
        <div />
      </div>

      <div class="zen-bottom">
        <div class="instrument-status">
          {status.map((part, index) => (
            <span key={index} class={part.tone}>
              {part.text}
            </span>
          ))}
          {note ? <span class="is-err">{note}</span> : null}
        </div>
        <div ref={promptRef}>
          {pickerQuery !== null && pickerPlaces.length > 0 ? (
            <div class="zen-picker" role="listbox" aria-label="Places">
              {pickerPlaces.map((place, index) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={index === pickerIndex}
                  class={`pick${index === pickerIndex ? " is-sel" : ""}`}
                  key={place.id}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    pickPlace(place.id);
                  }}
                >
                  <span class={`dot ${place.online ? "is-on" : "is-idle"}`} />
                  <span class="label">{place.label}</span>
                  <span class="id">@{place.id}</span>
                </button>
              ))}
              <div class="hint">↑ ↓ choose · enter move the prompt · esc</div>
            </div>
          ) : null}

          <PromptLine
            onFocusChange={onPromptFocus}
            onInput={onPromptInput}
            onKeyIntercept={onPromptKey}
            onPlace={openPicker}
            place={currentPlace}
            dir="~"
            placeholder={
              pendingHil
                ? "answer the approval first"
                : currentPlace.online
                  ? "Ask in plain words, or start with $ to run a command yourself"
                  : `Ask in plain words; ${currentPlace.label} will run it when it's back`
            }
            disabled={!connected || !pid}
            onSubmit={onSubmit}
            onHistory={onHistory}
            autoFocus
          />
        </div>
      </div>
    </main>
  );
}

function describeHilArgs(request: ProcHilRequest): string {
  const args = request.args;
  const pick = (key: string): string | null => {
    const value = args[key];
    return isStringValue(value) ? value : null;
  };
  return pick("input") ?? pick("command") ?? pick("path") ?? pick("url") ?? request.toolName;
}
