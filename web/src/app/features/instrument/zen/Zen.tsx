import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { useQuery } from "@tanstack/preact-query";
import type { JSX } from "preact";
import type { ProcHilRequest } from "@humansandmachines/gsv/protocol";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useSession } from "../../../services/session/SessionProvider";
import { LoadingState } from "../../../components/ui/Spinner";
import { MAX_CHAT_PROCESS_MEDIA_BYTES } from "../../../services/chat/domain/processes";
import {
  decideChatHil,
  listChatProcesses,
  sendChatMessage,
  spawnChatProcess,
} from "../../../services/chat/backend/chatService";
import { useChatConversation } from "../../../services/chat/hooks/useChatConversation";
import { useChatRuntime } from "../../../services/chat/hooks/useChatRuntime";
import { loadConsoleTargets } from "../../../services/system/consoleService";
import { listLibraryCollections } from "../../../services/memory/libraryService";
import { libraryTitleFromPath } from "../../../services/memory/libraryModel";
import type { LibraryCollection } from "../../../services/memory/libraryTypes";
import { executeTerminalCommand } from "../../../services/terminal/backend/terminalService";
import type { FleetReference } from "../fleet/fleetModel";
import { INSTRUMENT_MEMORY_KEY, INSTRUMENT_TARGETS_KEY } from "../wire/queryKeys";
import type { MemoryPageRef } from "../shared/navigation";
import { PromptLine, type PromptLineHandle, type PromptPlace } from "../shared/PromptLine";
import { FirstDay } from "../firstday/FirstDay";
import { ActivityWorking } from "./ActivityWorking";
import { RunFeedback } from "./RunFeedback";
import { useZenScroll } from "./useZenScroll";
import { ZenText } from "./ZenText";
import { ZenDraftAttachment, ZenMedia } from "./ZenMedia";
import { zenAttachment, zenSendIntent, type ZenAttachment, type ZenSendIntent } from "./zenAttachments";
import {
  activityDuration,
  answerAttribution,
  answerHistorySnapshot,
  countLabel,
  defaultPlace,
  isStringValue,
  linkPlaceReferences,
  momentsFromConversation,
  memoryPagesForMoment,
  parsePromptInput,
  PLACE_REFERENCE_PREFIX,
  placeLabel,
  resolvePlace,
  trimOutput,
  noteSummary,
  receiptDuration,
  receiptTargets,
  receiptSteps,
  CLOUD_PLACE_ID,
  type Activity,
  type Moment,
  type Place,
} from "./zenModel";
import "./zen.css";

export type ZenProps = {
  onMemory?: (page?: MemoryPageRef) => void;
  /** Step back to Fleet, optionally landing on a row (a place mentioned in a response, for instance). */
  onFleet: (reference?: FleetReference) => void;
  /** Text to place in the prompt on arrival, such as a file reference from Fleet. */
  prefill?: string | null;
  initialTarget?: string | null;
  onPrefillUsed?: () => void;
  /** A specific process to show instead of the ship, for a helper opened from Fleet. */
  pid?: string | null;
  onDraftChange?: (dirty: boolean) => void;
};

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
  return Math.min(430, Math.max(250, length * 0.54));
}
/** How many of the loaded messages settle on first paint, and how far apart they start. */
const SETTLE_ON_LOAD = 12;
const SETTLE_STAGGER_MS = 6;

function reducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function placesFromTargets(targets: Awaited<ReturnType<typeof loadConsoleTargets>>): Place[] {
  return targets.map((target) => ({ id: target.deviceId, label: target.label || target.deviceId, online: target.online }));
}

function ActivityLine({
  activity,
  places,
  open,
  onToggle,
  onFleet,
}: {
  activity: Activity;
  places: readonly Place[];
  open: boolean;
  onToggle: () => void;
  onFleet: ZenProps["onFleet"];
}) {
  const label = activity.target === null ? "process working" : placeLabel(activity.target, places);
  const running = activity.calls.find((call) => !call.finished);
  const head = activity.live && running ? (
    <>
      <span class="pulse blink" />
      {activity.you ? "you are using" : "using"} <span class="place">{label}</span>
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
      {open ? (
        <div class="detail">
          {activity.target !== null ? <button type="button" class="work-link" onClick={() => onFleet(`target:${activity.target}`)}>view {label} in fleet</button> : null}
          <ActivityWorking activity={activity} />
        </div>
      ) : null}
    </div>
  );
}

/** One line under a ship's message: what it did, generated from its calls; the working opens beneath. */
function Receipt({ moment, places, collections, open, onToggle, onMemory, onFleet }: {
  moment: Moment;
  places: readonly Place[];
  collections: readonly LibraryCollection[];
  open: boolean;
  onToggle: () => void;
  onMemory: ZenProps["onMemory"];
  onFleet: ZenProps["onFleet"];
}) {
  const targets = receiptTargets(moment);
  const steps = receiptSteps(moment);
  const duration = receiptDuration(moment);
  const notes = moment.narration ? moment.narration.split(/\n\n+/).length : 0;
  const worked = moment.activities.filter((activity) => !activity.you);
  const processWork = worked.filter((activity) => activity.target === null);
  const pages = onMemory ? memoryPagesForMoment(moment, collections) : [];
  return (
    <div class={`receipt${open ? " is-open" : ""}`}>
      <div class="line">
        <button type="button" class="receipt-toggle" aria-expanded={open} onClick={onToggle}>
          {targets.map((target, index) => (
            <span key={target.target} class={target.live ? "now" : target.failed ? "is-failed" : ""}>
              {index > 0 ? " · " : ""}
              {target.live ? <span class="pulse blink" /> : null}
              {target.live ? "using" : "used"} <span class="place">{placeLabel(target.target, places)}</span>
              {target.failed ? " · failed" : ""}
            </span>
          ))}
          {targets.length === 0 ? (processWork.length > 0 ? (processWork.some((activity) => activity.live) ? "working" : "worked") : moment.narration ? (moment.thinking ? "thinking" : "thought it through") : "response details") : null}
          {processWork.some((activity) => activity.calls.some((call) => call.failed)) ? <span class="is-failed"> · work failed</span> : null}
          {moment.attribution?.fallbacks.length ? <span class="is-failed"> · fallback used</span> : null}
          <span class="n"> · {open ? "close" : "open"}</span>
        </button>
        {pages.length > 0 ? (
          <span class="memory-references"> · from your memory: {pages.map((page, index) => (
            <span key={`${page.db}:${page.path}`}>
              {index > 0 ? ", " : ""}
              <button type="button" class="work-link" title={page.path} onClick={() => onMemory?.(page)}>{page.path === `${page.db}/index.md` ? "Overview" : libraryTitleFromPath(page.path)}</button>
            </span>
          ))}</span>
        ) : null}
      </div>
      {open ? (
        <div class="detail">
          <div class="receipt-meta">
            {moment.attribution?.model ? <span class="answer-model" title={moment.attribution.provider ?? undefined}>answered by {moment.attribution.model}</span> : null}
            {steps > 0 ? <span>{countLabel(steps, "step")}{duration ? ` · ${duration}` : ""}</span> : null}
            {notes > 0 ? <span>{countLabel(notes, "note")}</span> : null}
          </div>
          {moment.attribution?.fallbacks.length ? (
            <div class="zen-model-fallback">
              {moment.attribution.fallbacks.map((fallback, index) => (
                <span key={`${fallback.from}:${fallback.to}`} title={fallback.reason ?? undefined}>
                  {index ? " · " : "fallback: "}{fallback.from} → {fallback.to}
                </span>
              ))}
              {moment.attribution.omittedFallbacks ? ` · ${moment.attribution.omittedFallbacks} earlier` : ""}
            </div>
          ) : null}
          {worked.map((activity) => (
            <div key={activity.key} class="place-rail">
              <div class="ph">{activity.target === null ? "working" : <>on {activity.target === "unknown target" ? placeLabel(activity.target, places) : (
                <button type="button" class="work-link" onClick={() => onFleet(`target:${activity.target}`)}>{placeLabel(activity.target, places)}</button>
              )}</>}</div>
              <ActivityWorking activity={activity} />
            </div>
          ))}
          {moment.narration ? (
            <div class="place-rail">
              <div class="ph">thought it through</div>
              <div class="machine-rail narration">{moment.narration}</div>
            </div>
          ) : null}
          {moment.processId ? <button type="button" class="work-link" onClick={() => onFleet(`proc:${moment.processId}`)}>view process</button> : null}
        </div>
      ) : null}
    </div>
  );
}

function NoteMoment({
  moment,
  open,
  focus,
  index,
  phase,
  onToggle,
}: {
  moment: Moment;
  open: boolean;
  focus: boolean;
  index: number;
  /** Where the note is in the load cascade: waiting its turn, taking it, or settled. */
  phase: "pending" | "materialising" | "settled";
  onToggle: () => void;
}) {
  return (
    <div
      data-index={index}
      data-moment-id={moment.id}
      class={`zen-moment is-note${open ? " is-open" : ""}${focus ? " is-focus" : ""}${phase === "pending" ? " is-pending" : phase === "materialising" ? " is-materialising" : ""}`}
    >
      <div class="who">{moment.event && moment.event.kind !== "history.compacted" ? moment.event.severity === "error" ? "error" : "event" : "memory"}</div>
      <button type="button" class="note-line" aria-expanded={open} onClick={onToggle}>
        <span class="tri">{open ? "▾" : "▸"}</span>
        <span class="note-summary">{noteSummary(moment.text)}</span>
      </button>
      {open ? <div class="note-text">{moment.text}</div> : null}
    </div>
  );
}

export function Zen({ onFleet, onMemory, initialTarget, prefill, onPrefillUsed, pid: pidProp, onDraftChange }: ZenProps) {
  const { client, connected } = useGateway();
  const { snapshot } = useSession();
  const who = snapshot.username || "you";

  const [pid, setPid] = useState<string | null>(null);
  /* the conversation is what was actually said, both ways; the process transcript is what the ship did */
  const conversation = useChatConversation({ processId: pid ?? "", enabled: pid !== null });
  const processRuntime = useChatRuntime({ processId: pid ?? "", enabled: pid !== null, observe: true, historyLimit: HISTORY_LIMIT });
  const runtime = processRuntime.runtime;
  const [places, setPlaces] = useState<Place[]>([]);
  const [where, setWhere] = useState<string | null>(initialTarget ?? null);
  const [attachments, setAttachments] = useState<ZenAttachment[]>([]);
  const [draftText, setDraftText] = useState("");
  const [sending, setSending] = useState<"uploading" | "sending" | null>(null);
  const pendingSend = useRef<{ intent: ZenSendIntent; controller: AbortController } | null>(null);
  const retryIntent = useRef<ZenSendIntent | null>(null);
  const mounted = useRef(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const dirty = draftText !== "" || attachments.length > 0 || sending !== null;
  useLayoutEffect(() => { onDraftChange?.(dirty); }, [dirty, onDraftChange]);
  useLayoutEffect(() => () => onDraftChange?.(false), [onDraftChange]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; pendingSend.current?.controller.abort(new Error("Upload cancelled")); };
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const [localRuns, setLocalRuns] = useState<LocalRun[]>([]);
  const [openActivities, setOpenActivities] = useState<ReadonlySet<string>>(() => new Set());
  const [openNotes, setOpenNotes] = useState<ReadonlySet<string>>(() => new Set());
  /* browse mode: null while the prompt has focus, else the index of the focused moment (the TUI's browse cursor) */
  const [promptFocused, setPromptFocused] = useState(false);
  const firstGoKey = useRef<number | null>(null);
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
    setDraftText(value);
    const match = value.match(/^@(\S*)$/);
    setPickerQuery(match ? match[1] : null);
    setPickerIndex(0);
  }, []);
  const pickPlace = useCallback((id: string) => {
    setWhere(id);
    setPickerQuery(null);
    promptRef.current?.setValue("");
  }, []);
  /* the chip opens the same picker that typing "@" does */
  const openPicker = useCallback(() => {
    const input = promptRef.current;
    if (!input) return;
    input.setValue("@");
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
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const promptRef = useRef<PromptLineHandle>(null);

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
  const historyLoaded = Boolean(processRuntime.history.data) || processRuntime.history.isError;
  const answerHistory = useMemo(() => answerHistorySnapshot(processRuntime.history.data, pid), [pid, processRuntime.history.data]);
  /* both halves of the transcript, what was said and what was done, are shown together or not yet */
  const ready = historyLoaded && conversation.loaded;
  useEffect(() => {
    if (processRuntime.history.error) setNote(processRuntime.history.error.message);
  }, [processRuntime.history.error]);

  /* the run clock and the resolve animation */
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
    const fromRuntime = momentsFromConversation(conversation.rows, runtime.rows, runtime.activeRunId)
      .map((moment) => ({ ...moment, attribution: answerAttribution(moment, answerHistory.entries, answerHistory.through) }));
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
  }, [answerHistory, conversation.rows, localRuns, runtime.activeRunId, runtime.rows]);

  const loadOlder = useCallback(async () => {
    await Promise.all([conversation.loadOlder(), processRuntime.loadOlderHistory()]);
  }, [conversation.loadOlder, processRuntime.loadOlderHistory]);
  const scrolling = useZenScroll({ moments, ready, promptFocused,
    hasOlder: conversation.hasMore || processRuntime.hasOlderHistory,
    loadingOlder: conversation.loadingOlder || processRuntime.loadingOlderHistory, loadOlder });
  const { browse, viewport: momentsRef, content: contentRef } = scrolling;
  const hasMemoryRead = moments.some((moment) => moment.activities.some((activity) =>
    !activity.you && activity.target === "gsv" && activity.calls.some((call) =>
      call.syscall === "fs.read" && call.finished && !call.failed && call.filePath?.startsWith("/src/repos/"),
    ),
  ));
  const memoryCollections = useQuery({
    queryKey: [...INSTRUMENT_MEMORY_KEY, "collections"],
    queryFn: () => listLibraryCollections(client),
    enabled: connected && Boolean(onMemory) && hasMemoryRead,
  });

  const seenMomentsRef = useRef<Set<string> | null>(null);
  const streamedMomentsRef = useRef<Set<string>>(new Set());
  useLayoutEffect(() => {
    if (!ready) return;
    for (const moment of moments) if (moment.streaming) streamedMomentsRef.current.add(moment.id);
    const whole = moments.filter((moment) => moment.role === "ship" && moment.text && !moment.streaming).map((moment) => moment.id);
    if (seenMomentsRef.current === null) {
      // the history as first loaded is not news, but it does materialise: the recent messages settle one after another
      seenMomentsRef.current = new Set(whole);
      if (reducedMotion()) return;
      const recent = moments.filter((moment) => !moment.streaming).map((moment) => moment.id).slice(-SETTLE_ON_LOAD);
      const startedAt = Date.now();
      setSettling((current) => {
        const next = new Map(current);
        recent.forEach((id, index) => next.set(id, startedAt + index * SETTLE_STAGGER_MS));
        return next;
      });
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
  }, [moments, ready]);
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
  /* the first ready render happens before the cascade is set; nothing shows in it, so no frame ever holds the transcript unsettled */
  const cascadeUnset = ready && seenMomentsRef.current === null && !reducedMotion();
  /** How much of a settling message is shown so far: the settled head plus the noisy tail sweeping to the end. */
  const settleProgress = (moment: Moment): number | null => {
    const startedAt = settling.get(moment.id);
    if (startedAt === undefined) return null;
    const progress = (Date.now() - startedAt) / settleDuration(moment.text.length);
    if (progress >= 1) return null;
    return Math.max(0, progress);
  };

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
  const addFiles = useCallback((files: File[]) => {
    const accepted = files.filter((file) => file.size <= MAX_CHAT_PROCESS_MEDIA_BYTES);
    setAttachments((current) => [...current, ...accepted.map(zenAttachment)]);
    setNote(accepted.length < files.length ? "Each attachment must be 25 MiB or smaller." : null);
    promptRef.current?.focus();
  }, []);
  const say = useCallback(
    async (text: string) => {
      if (pendingSend.current) return false;
      if (!pid) {
        setNote("Your ship is still starting.");
        return false;
      }
      const intent = zenSendIntent(retryIntent.current, pid, text, attachments);
      scrolling.follow();
      retryIntent.current = intent;
      const pending = { intent, controller: new AbortController() };
      pendingSend.current = pending;
      setSending(attachments.length > 0 ? "uploading" : "sending");
      try {
        const result = await sendChatMessage(client, {
          pid, conversationId: conversation.conversation?.id, message: text,
          media: [...intent.media], idempotencyKey: intent.idempotencyKey,
        }, {
          signal: pending.controller.signal,
          onUploaded: () => { if (mounted.current) setSending("sending"); },
        });
        if (mounted.current) {
          conversation.acceptMessage(result.message);
          setAttachments((current) => current.filter((file) => !intent.media.some((sent) => sent.id === file.id)));
          retryIntent.current = null;
          setNote(null);
        }
        return true;
      } catch (error) {
        if (mounted.current) setNote(error instanceof Error ? error.message : "The message did not go through.");
        return false;
      } finally {
        if (pendingSend.current === pending) pendingSend.current = null;
        if (mounted.current) setSending(null);
      }
    },
    [attachments, client, conversation, pid, scrolling.follow],
  );

  const runDirectly = useCallback(
    async (command: string) => {
      const target = where ?? defaultPlace(places);
      const id = `you:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      const startedAt = Date.now();
      scrolling.follow();
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
    [client, places, where, scrolling.follow],
  );

  const onSubmit = useCallback(
    (raw: string) => {
      if (pendingSend.current) return false;
      setNote(null);
      if (raw) setInputHistory((current) => [...current.filter((entry) => entry !== raw), raw].slice(-50));
      setHistoryIndex(null);
      const intent = parsePromptInput(raw);
      if (!intent) return attachments.length > 0 ? say("") : false;
      if (intent.kind === "switch") {
        const id = resolvePlace(intent.name, places);
        if (id) setWhere(id);
        else setNote(`No place called ${intent.name}.`);
        return true;
      }
      if (intent.kind === "run") {
        if (attachments.length > 0) { setNote("Remove attachments before running a command, or send them to your Ship in plain words."); return false; }
        void runDirectly(intent.command);
        return true;
      }
      return say(intent.text);
    },
    [attachments.length, places, runDirectly, say],
  );

  const onHistory = useCallback(
    (direction: -1 | 1) => {
      if (inputHistory.length === 0) return;
      const nextIndex = historyIndex === null ? (direction === -1 ? inputHistory.length - 1 : null) : Math.min(inputHistory.length - 1, Math.max(0, historyIndex + direction));
      setHistoryIndex(nextIndex);
      promptRef.current?.setValue(nextIndex === null ? "" : inputHistory[nextIndex]);
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
    if (pendingHil) promptRef.current?.blur();
  }, [pendingHil]);

  useEffect(() => {
    if (!prefill || !connected || !pid) return;
    const input = promptRef.current;
    if (!input || input.disabled) return;
    input.setValue(prefill);
    input.focus();
    onPrefillUsed?.();
  }, [prefill, onPrefillUsed, connected, pid]);

  const focusPrompt = useCallback(() => {
    promptRef.current?.focus();
  }, []);
  const onPromptFocus = useCallback(
    (focused: boolean) => {
      setPromptFocused(focused);
    },
    [],
  );

  useLayoutEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const target = event.target;
      const typing = target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      if (typing && event.key === "Escape") {
        // Escape leaves the prompt even if the input's own handler did not run.
        event.preventDefault();
        target.blur();
        return;
      }
      if (event.metaKey || event.altKey) return;
      if (event.ctrlKey) {
        firstGoKey.current = null;
        if (!typing && (event.key === "u" || event.key === "d")) {
          event.preventDefault();
          scrolling.page(event.key === "u" ? "up" : "down");
        }
        return;
      }
      if (pendingHil && !typing && (event.key === "y" || event.key === "n")) {
        event.preventDefault();
        void decide(event.key === "y" ? "approve" : "deny");
        return;
      }
      if (typing) return;
      if (event.key === "g") {
        event.preventDefault();
        if (firstGoKey.current !== null && event.timeStamp - firstGoKey.current < 700) {
          scrolling.page("start");
          firstGoKey.current = null;
        } else firstGoKey.current = event.timeStamp;
        return;
      }
      firstGoKey.current = null;
      if (event.key === "G") {
        event.preventDefault();
        scrolling.page("end");
        return;
      }
      const focused = browse !== null ? moments[browse] : latest;
      if (event.key === "o" && focused && (focused.activities.length > 0 || focused.narration || focused.attribution)) {
        event.preventDefault();
        scrolling.stopFollowing();
        const yours = focused.activities.filter((activity) => activity.you);
        const worked = focused.role === "ship" && (focused.activities.some((activity) => !activity.you) || focused.narration || focused.attribution);
        toggleActivity(worked ? `receipt:${focused.id}` : yours[yours.length - 1].key);
        return;
      }
      if (browse !== null && event.key === "j") {
        event.preventDefault();
        scrolling.select(Math.min(moments.length - 1, browse + 1));
        return;
      }
      if (browse !== null && event.key === "k") {
        event.preventDefault();
        scrolling.select(Math.max(0, browse - 1));
        return;
      }
      if (event.key === "i") {
        event.preventDefault();
        focusPrompt();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [browse, decide, focusPrompt, latest, moments, pendingHil, scrolling.page, scrolling.select, scrolling.stopFollowing, toggleActivity]);

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
  const activeRun = connected ? runtime.activeRunId : null;
  const runStartedAt = useMemo(() => runtime.rows.reduce<number | null>((first, row) =>
    row.runId === activeRun && row.timestamp !== null ? Math.min(first ?? row.timestamp, row.timestamp) : first,
  null), [activeRun, runtime.rows]);
  const attemptedModel = runtime.context?.runId === activeRun ? runtime.context.model : null;
  const showFeedback = !connected || !currentPlace.online || note !== null || activeRun !== null;

  const latestMessageIndex = moments.reduce((latest, moment, index) =>
    moment.role === "human" || (moment.role === "ship" && (moment.text !== "" || moment.media?.length || moment.streaming)) ? index : latest, -1);
  const historyFailure = conversation.historyError ? (
    <div class="zen-history-status is-err" role="alert">
      <span>Could not load your conversation: {conversation.historyError.message}</span>
      <button type="button" disabled={!connected || conversation.historyFetching} onClick={() => void conversation.retryHistory()}>retry</button>
    </div>
  ) : null;
  const empty = ready && moments.length === 0 && pid !== null;

  return (
    <main class={`zen${!promptFocused ? " is-browse" : ""}${draggingFiles ? " is-file-drop" : ""}`} aria-label="Zen"
      onDragEnter={(event) => { if (event.dataTransfer?.types.includes("Files")) { event.preventDefault(); dragDepth.current++; setDraggingFiles(true); } }}
      onDragOver={(event) => { if (event.dataTransfer?.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }}
      onDragLeave={(event) => { if (event.dataTransfer?.types.includes("Files") && --dragDepth.current <= 0) { dragDepth.current = 0; setDraggingFiles(false); } }}
      onDrop={(event) => {
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (files.length === 0) return;
        event.preventDefault(); dragDepth.current = 0; setDraggingFiles(false); addFiles(files);
      }}>
      {draggingFiles && <div class="zen-drop-hint">drop to attach</div>}

      <div class="zen-body">
        <div class="zen-timeline" aria-hidden="true">
          {moments.map((moment, index) => (
            <i key={moment.id} class={`${moment.role === "human" ? "is-human" : moment.role === "note" ? "is-note" : ""}${index === moments.length - 1 ? " is-here" : ""}${browse === index ? " is-focus" : ""}`} />
          ))}
        </div>
        {empty ? (
          pidProp ? <div class="zen-empty"><p>This helper has no messages yet.</p></div> : <FirstDay />
        ) : !ready ? (
          <div class="zen-moments" ref={momentsRef}>
            <div class="zen-content" ref={contentRef}>{historyFailure}</div>
          </div>
        ) : (
          <div class="zen-moments" ref={momentsRef}>
            <div class="zen-content" ref={contentRef}>
              {historyFailure}
              {(conversation.loadingOlder || processRuntime.loadingOlderHistory) && <div class="zen-history-status"><LoadingState>loading earlier messages</LoadingState></div>}
              {(conversation.error || processRuntime.historyError) && <div class="zen-history-status is-err" role="alert">
                {conversation.error || processRuntime.historyError}
                <button type="button" onClick={scrolling.readOlder}>retry</button>
              </div>}
              {moments.map((moment, index) => {
                const isLatest = index === moments.length - 1;
                const settleStart = settling.get(moment.id);
                const pending = cascadeUnset || (settleStart !== undefined && Date.now() < settleStart);
                const materialising = !cascadeUnset && settleStart !== undefined && !pending;
                if (moment.role === "note") {
                  return (
                    <NoteMoment
                      key={moment.id}
                      moment={moment}
                      index={index}
                      phase={pending ? "pending" : materialising ? "materialising" : "settled"}
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
                  <div key={moment.id} data-index={index} data-moment-id={moment.id} class={`zen-moment ${moment.role === "human" ? "is-human" : "is-ship"}${!moment.text && !moment.media?.length && !moment.streaming ? " is-work" : ""}${pending ? " is-pending" : ""}${materialising ? " is-materialising" : ""}${index < latestMessageIndex ? " is-older" : ""}${browse === index ? " is-focus" : ""}`}>
                    {moment.role === "human" || moment.text || moment.media?.length || moment.streaming ? <div class="who">
                      {moment.role === "human" ? who : "ship"}
                    </div> : null}
                    {moment.activities
                      .filter((activity) => activity.you)
                      .map((activity) => (
                        <ActivityLine
                          key={activity.key}
                          activity={activity}
                          places={places}
                          open={openActivities.has(activity.key)}
                          onToggle={() => toggleActivity(activity.key)}
                          onFleet={onFleet}
                        />
                      ))}
                    {moment.role === "ship" && (moment.activities.some((activity) => !activity.you) || moment.narration || moment.attribution) ? (
                      <Receipt
                        moment={moment}
                        places={places}
                        collections={memoryCollections.data ?? []}
                        onMemory={onMemory}
                        onFleet={onFleet}
                        open={openActivities.has(`receipt:${moment.id}`)}
                        onToggle={() => toggleActivity(`receipt:${moment.id}`)}
                      />
                    ) : null}
                    {moment.role === "human" ? (
                      <ZenText text={moment.text} markdown={false} progress={settleProgress(moment)} tick={tick} />
                    ) : moment.text ? (
                      <ZenText text={linkPlaceReferences(moment.text, places)} markdown progress={moment.streaming ? -1 : settleProgress(moment)} tick={tick} onClick={onTextClick} />
                    ) : moment.thinking ? (
                      <div class="text">
                        <span class="zen-caret blink" />
                      </div>
                    ) : null}
                    {moment.media?.map((media, index) => <ZenMedia key={index} media={media} processId={moment.processId ?? pid ?? ""} />)}
                    {isLatest && pendingHil ? (
                      <div class="zen-approval">
                        <div class="q">
                          <button type="button" onClick={() => {
                            if (pid) onFleet({ kind: "approval", pid, requestId: pendingHil.requestId });
                          }} title="Inspect this approval in Fleet">approval · {placeLabel(pendingHil.target, places)}</button>
                        </div>
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
          </div>
        )}
        <div />
      </div>

      <div class="zen-bottom">
        {showFeedback && <div class="zen-feedback">
          {activeRun && <RunFeedback key={activeRun} startedAt={runStartedAt} model={attemptedModel}
            place={currentPlace.label} online={currentPlace.online} awaitingApproval={pendingHil !== null} />}
          {!connected && <span role="status">Not connected</span>}
          {connected && !currentPlace.online ? (
            <button type="button" class="is-warn" onClick={() => onFleet(`target:${currentPlace.id}`)}>
              {currentPlace.label} is offline · view place
            </button>
          ) : null}
          {note ? <span class="is-err" role="alert">{note}</span> : null}
        </div>}
        <div>
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

          {attachments.length > 0 && <ul class="zen-draft-attachments" aria-label="Attachments to send">
            {attachments.map((attachment) => <ZenDraftAttachment key={attachment.id} attachment={attachment}
              disabled={pendingSend.current?.intent.media.some((file) => file.id === attachment.id)}
              onRemove={() => setAttachments((current) => current.filter((file) => file.id !== attachment.id))} />)}
          </ul>}
          <PromptLine
            ref={promptRef}
            onFocusChange={onPromptFocus}
            onInput={onPromptInput}
            onKeyIntercept={onPromptKey}
            onPlace={openPicker}
            place={currentPlace}
            dir="~"
            placeholder={
              pendingHil
                ? "answer the approval first"
                : !promptFocused
                  ? "Press i or click here to write"
                  : currentPlace.online
                    ? "Ask in plain words, or start with $ to run a command yourself"
                    : `Ask in plain words; ${currentPlace.label} will run it when it's back`
            }
            disabled={!connected || !pid}
            onSubmit={onSubmit}
            allowEmpty={attachments.length > 0}
            onFiles={addFiles}
            onHistory={onHistory}
          />
          <div class="zen-compose-actions">
            <input ref={fileInput} type="file" multiple hidden aria-label="Choose attachments" onChange={(event) => {
              addFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = "";
            }} />
            <button type="button" onClick={() => fileInput.current?.click()}>attach</button>
            {sending ? <>
              <LoadingState>{sending === "uploading" ? "uploading…" : "sending…"}</LoadingState>
              {sending === "uploading" && <button type="button" onClick={() => pendingSend.current?.controller.abort(new Error("Upload cancelled. Your draft is still here."))}>cancel upload</button>}
            </> : attachments.length > 0 && <button type="button" disabled={!connected || !pid} onClick={() => promptRef.current?.submit()}>send</button>}
          </div>
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
