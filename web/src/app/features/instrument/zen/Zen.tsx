import { NativeVoiceControls, type NativeVoiceHandle } from "../../../services/platform/NativeVoiceControls";
import { BrowserVoiceControls } from "../../../services/platform/BrowserVoiceControls";
import { useNativeInput } from "../../../services/platform/PlatformProvider";
import { useNativeSpeech } from "../../../services/platform/NativeSpeech";
import { ConversationSearch } from "../shared/ConversationSearch";
import { useViewActive } from "../../../services/navigation/ViewActivity";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { memo } from "preact/compat";
import { useQuery } from "../../../services/navigation/viewQueries";
import type { JSX } from "preact";
import type { ProcHilArgs, ProcHilRequest } from "@humansandmachines/gsv/protocol";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useSession } from "../../../services/session/SessionProvider";
import { LoadingState, Spinner } from "../../../components/ui/Spinner";
import { MAX_CHAT_PROCESS_MEDIA_BYTES } from "../../../services/chat/domain/processes";
import {
  decideChatHil,
} from "../../../services/chat/backend/chatService";
import { useChatConversation } from "../../../services/chat/hooks/useChatConversation";
import { useChatOutbox } from "../../../services/chat/hooks/useChatOutbox";
import { useChatRuntime } from "../../../services/chat/hooks/useChatRuntime";
import { loadConsoleTargets } from "../../../services/system/consoleService";
import { useConsoleAccounts, useConsoleConfig } from "../../../services/system/useConsoleData";
import { listLibraryCollections } from "../../../services/memory/libraryService";
import { libraryTitleFromPath } from "../../../services/memory/libraryModel";
import type { LibraryCollection } from "../../../services/memory/libraryTypes";
import { useTerminalSessions } from "../../../services/terminal/TerminalProvider";
import { terminalFinished } from "../../../services/terminal/terminalSessions";
import { TerminalControls } from "./TerminalControls";
import { fleetReferenceRow, orderPlaces, type FleetReference } from "../fleet/fleetModel";
import { ChatPlans } from "./ChatPlans";
import { ChatPanels } from "./ChatPanels";
import { canConfigure } from "../settings/settingsModel";
import { flushSync } from "preact/compat";
import type { ActivityRequest, ChatContext } from "./chatContextModel";
import { INSTRUMENT_MEMORY_KEY, INSTRUMENT_TARGETS_KEY } from "../wire/queryKeys";
import type { MemoryPageRef } from "../shared/navigation";
import { PromptLine, type PromptLineHandle, type PromptPlace } from "../shared/PromptLine";
import { SHELL_KEYS } from "../shared/shellKeys";
import { useDismissOnOutsideClick } from "../shared/useDismissOnOutsideClick";
import { ActivityWorking } from "./ActivityWorking";
import { ApprovalCard } from "../shared/ApprovalCard";
import type { ContactReplies } from "../people/useContactReplies";
import { PeopleActivity } from "../people/PeopleActivity";
import type { PeopleActivity as PeopleActivityState } from "../people/usePeopleActivity";
import type { PeopleOpenRequest } from "../people/People";
import { DelegatedApprovals } from "./DelegatedApprovals";
import { useZenScroll } from "./useZenScroll";
import { useZenProcess } from "./useZenProcess";
import { ZenText } from "./ZenText";
import { ThinkingMark, THINKING_MARK } from "./ThinkingMark";
import { WakingUp } from "./WakingUp";
import { ReceiptTimeline, RECEIPT_LAYOUT } from "./ReceiptTimeline";
import { receiptsForMoments, type RunReceipt } from "./runReceipts";
import { ZenDraftAttachment, ZenDraftPaste, ZenMedia } from "./ZenMedia";
import { longPaste, zenAttachment, zenDraftMessage, type ZenAttachment, type ZenPaste } from "./zenAttachments";
import { FeedbackNote, NoteMoment, zenFailure, zenNotice, type ZenNote } from "./ZenNotes";
import type { ChatErrorContext } from "../../../services/chat/domain/errorPresentation";
import {
  activityDuration,
  answerAttribution,
  answerHistorySnapshot,
  awaitingFirstMessage,
  countLabel,
  defaultPlace,
  momentsFromConversation,
  momentTime,
  memoryPagesForMoment,
  nextDayBoundary,
  ownerTimeZone,
  parsePromptInput,
  PLACE_REFERENCE_PREFIX,
  placeLabel,
  resolvePlace,
  receiptSummary,
  startsWriting,
  CLOUD_PLACE_ID,
  CLOUD_PLACE_LABEL,
  type Activity,
  type Moment,
  type Place,
} from "./zenModel";
import "./zen.css";
import "./chat-context.css";

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
  /** Ship's contact notices and the replies typed under them, owned above this keyed view; absent for a helper. */
  contactReplies?: ContactReplies;
  peopleActivity?: PeopleActivityState;
  /** Open a contact's conversation in People, for a message that arrived while here. */
  onPeopleActivity?: (request?: PeopleOpenRequest) => void;
  searchRequested?: boolean;
  onSearchRequestHandled?: () => void;
  activityRequest?: ActivityRequest;
  requestPrefill?: string | null;
  /** The founders' welcome card still stands over the chat, or its state is not known yet; Ship is not waking until it is dismissed. */
  welcomeOpen?: boolean;
};

const HISTORY_LIMIT = 400;
const EMPTY_COLLECTIONS: readonly LibraryCollection[] = [];
const EMPTY_EXPANDED: ReadonlySet<string> = new Set();
const RESOLVE_FRAME_MS = 60;
/** How long a message that arrived whole takes to settle out of glyph noise: brisk for a line, longer for a page, never a wait. */
function settleDuration(length: number): number {
  return Math.min(430, Math.max(250, length * 0.54));
}
/** How many of the loaded messages settle on first paint, and how far apart they start. */
const SETTLE_ON_LOAD = 12;
const SETTLE_STAGGER_MS = 6;
/** Keys Zen answers in browse mode. Together with the shell's, they are the keys that never start writing; y and n are claimed only while an approval is pending. */
const BROWSE_KEYS: ReadonlySet<string> = new Set(["j", "k", "g", "G", "o"]);
const CLAIMED_KEYS: ReadonlySet<string> = new Set([...BROWSE_KEYS, ...SHELL_KEYS]);
/* what each status-line failure was attempting, for causes the client cannot name */
const SHIP_UNREACHABLE: ChatErrorContext = { summary: "Could not reach your Ship.", action: "Check your connection, then reload the page." };
const ACTIVITY_UNAVAILABLE: ChatErrorContext = { summary: "Could not load the work behind this conversation.", action: "Reload the page to try again." };
const DECISION_FAILED: ChatErrorContext = { summary: "The decision did not go through.", action: "Try again in a moment." };

/** The element a key or paste would already edit, or null when it would reach nothing. */
function editableElement(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable ? target : null;
}

function reducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function placesFromTargets(targets: Awaited<ReturnType<typeof loadConsoleTargets>>): Place[] {
  return targets.map((target) => ({ id: target.deviceId, label: target.label || target.deviceId, online: target.online, kind: target.kind }));
}

/** When the moment was sent, read in the owner's zone. Always in the label row so nothing moves; the stylesheet reveals it on hover, focus or the browse cursor. */
const MomentTime = memo(function MomentTime({ timestamp, today, timeZone }: { timestamp: number; today: number; timeZone: string }) {
  const when = momentTime(timestamp, timeZone, today);
  return <time class="when" dateTime={new Date(timestamp).toISOString()} title={when.title}>{when.label}</time>;
});

function MomentCopyButton({ text }: { text: string }) {
  const [status, setStatus] = useState("");
  useEffect(() => { setStatus(""); }, [text]);
  return <div class="zen-message-actions">
    <button type="button" class="zen-copy-message" aria-label={status || "Copy message"} aria-live="polite" onClick={async () => {
      try {
        await navigator.clipboard.writeText(text);
        setStatus("copied");
      } catch {
        setStatus("couldn't copy");
      }
    }}>{status || "copy"}</button>
  </div>;
}

const ActivityLine = memo(function ActivityLine({
  activity,
  who,
  places,
  open,
  onToggle,
  onFleet,
}: {
  activity: Activity;
  who: string;
  places: readonly Place[];
  open: boolean;
  onToggle: (key: string) => void;
  onFleet: ZenProps["onFleet"];
}) {
  const label = activity.target === null ? "process working" : placeLabel(activity.target, places);
  const running = activity.calls.find((call) => !call.finished);
  const unavailable = activity.terminal?.status === "unavailable";
  const [now, setNow] = useState(Date.now);
  const active = useViewActive();
  const timing = !!activity.terminal && activity.live && !unavailable;
  useEffect(() => {
    if (!active || !timing) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, timing]);
  const head = activity.live && running ? (
    <>
      {!unavailable && <span class="pulse blink" />}
      {activity.you ? unavailable ? "you started a command on" : "you are using" : "using"} <span class="place">{label}</span>
      {unavailable && <span class="n"> · status unavailable</span>}
      {timing && activity.startedAt !== null && <span class="n"> · {Math.max(0, Math.floor((now - activity.startedAt) / 1000))}s</span>}
    </>
  ) : (
    <>
      {activity.you ? "you used" : "used"} <span class="place">{label}</span>{" "}
      <span class="n">
        · {countLabel(activity.calls.length, "command")}
        {activityDuration(activity) ? ` · ${activityDuration(activity)}` : ""}
        {activity.you ? " · no model" : ""}
        {activity.terminal?.status === "stopped" ? " · stopped" : activity.terminal?.status === "failed" ? " · failed" : ""}
      </span>
    </>
  );
  const state = unavailable ? "status unavailable"
    : activity.terminal?.status === "stopped" ? "stopped"
    : activity.terminal?.status === "failed" || activity.calls.some((call) => call.failed) ? "failed"
    : activity.live ? "running…" : "";
  return (
    <div class={`activity${open ? " is-open" : ""}${activity.you ? " is-you" : ""}`}>
      <div
        class="line"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={activity.you ? `Command on ${label}${state ? ` · ${state}` : ""}` : undefined}
        onClick={() => onToggle(activity.key)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onToggle(activity.key);
          }
        }}
      >
        <span class="tri">{open ? "▾" : "▸"}</span>
        <span class="activity-summary">{head}</span>
        {activity.you && <span class="activity-compact" aria-hidden="true">
          <span>$</span><span class="place" title={label}>{label}</span>
          {state && <span class={`activity-state${state === "failed" || unavailable ? " is-failed" : ""}`}>{state}</span>}
        </span>}
      </div>
      {open ? (
        <div class="detail">
          {activity.target !== null ? <button type="button" class="work-link" onClick={() => onFleet(`target:${activity.target}`)}>view {label}</button> : null}
          <ActivityWorking activity={activity} who={who} />
          {activity.terminal && <TerminalControls session={activity.terminal} />}
        </div>
      ) : null}
    </div>
  );
});

/** One line under a ship's message: what it did, in words; the run opens beneath in the order it happened. */
const Receipt = memo(function Receipt({ receipt, who, places, collections, open, onMemory, onFleet, expanded, onToggleDetail, waitingCallId }: {
  receipt: RunReceipt;
  who: string;
  places: readonly Place[];
  collections: readonly LibraryCollection[];
  open: boolean;
  onMemory: ZenProps["onMemory"];
  onFleet: ZenProps["onFleet"];
  expanded: ReadonlySet<string>;
  onToggleDetail: (key: string) => void;
  waitingCallId?: string;
}) {
  const moment = receipt.work;
  const live = moment.thinking;
  let summary = receiptSummary(moment, places, receipt.relatedCalls);
  if (waitingCallId) summary = [{ text: "waiting for your approval" }, ...summary.filter((part) => part.tone === "failed")];
  const running = live && !waitingCallId && (moment.timeline ?? []).some((event) => event.kind === "call" && !event.call.finished);
  const worked = moment.activities.filter((activity) => !activity.you);
  const pages = onMemory ? memoryPagesForMoment(moment, collections) : [];
  const replies = receipt.replies.filter((reply) => reply.attribution);
  const fallback = replies.some((reply) => reply.attribution?.fallbacks.length);
  const quiet = receipt.replies.length > 0 && !live && !waitingCallId && !fallback && !summary.some((part) => part.tone === "failed");
  return (
    <div class={`receipt${open ? " is-open" : ""}${live ? " is-live" : ""}${quiet ? " is-quiet" : ""}`}>
      <div class="line">
        <button type="button" class="receipt-toggle" aria-expanded={open} onClick={() => onToggleDetail(receipt.key)}>
          <span class="receipt-chevron" aria-hidden="true">›</span>
          {running ? <span class="pulse blink" /> : null}
          {summary.map((part, index) => part.tone ? <span key={index} class={part.tone === "place" ? "place" : "is-failed"}>{part.text}</span> : part.text)}
          {fallback ? <span class="is-failed"> · fallback used</span> : null}
        </button>
      </div>
      {open ? (
        <div class="detail">
          {RECEIPT_LAYOUT === "timeline" ? (
            <ReceiptTimeline moment={moment} who={who} places={places} relatedCalls={receipt.relatedCalls} onFleet={onFleet}
              scope={receipt.key} expanded={expanded} onToggle={onToggleDetail} waitingCallId={waitingCallId} />
          ) : (
            <>
              {worked.map((activity) => (
                <div key={activity.key} class="place-rail">
                  <div class="ph">{activity.target === null ? "working" : <>on {activity.target === "unknown target" ? placeLabel(activity.target, places) : (
                    <button type="button" class="work-link" onClick={() => onFleet(`target:${activity.target}`)}>{placeLabel(activity.target, places)}</button>
                  )}</>}</div>
                  <ActivityWorking activity={activity} who={who} />
                </div>
              ))}
              {moment.narration ? (
                <div class="place-rail">
                  <div class="ph">thought it through</div>
                  <div class="machine-rail narration">{moment.narration}</div>
                </div>
              ) : null}
            </>
          )}
          {pages.length > 0 ? (
            <div class="memory-references">from your memory: {pages.map((page, index) => (
              <span key={`${page.db}:${page.path}`}>
                {index > 0 ? ", " : ""}
                <button type="button" class="work-link" title={page.path} onClick={() => onMemory?.(page)}>{page.path === `${page.db}/index.md` ? "Overview" : libraryTitleFromPath(page.path)}</button>
              </span>
            ))}</div>
          ) : null}
          {replies.map((reply, index) => (
            <div key={reply.id} class="receipt-reply">
              {reply.attribution?.model ? <div class="receipt-meta" title={reply.text}>
                {receipt.replies.length > 1 ? <span>reply {receipt.replies.indexOf(reply) + 1}</span> : null}
                <span class="answer-model" title={reply.attribution.provider ?? undefined}>answered by {reply.attribution.model}</span>
              </div> : null}
              {reply.attribution?.fallbacks.length ? <div class="zen-model-fallback">
                {reply.attribution.fallbacks.map((fallback, fallbackIndex) => (
                  <span key={`${index}:${fallback.from}:${fallback.to}`} title={fallback.reason ?? undefined}>
                    {fallbackIndex ? " · " : "fallback: "}{fallback.from} → {fallback.to}
                  </span>
                ))}
                {reply.attribution.omittedFallbacks ? ` · ${reply.attribution.omittedFallbacks} earlier` : ""}
              </div> : null}
            </div>
          ))}
          {moment.processId ? <button type="button" class="work-link" onClick={() => onFleet(`proc:${moment.processId}`)}>view process</button> : null}
        </div>
      ) : null}
    </div>
  );
});

export function Zen({ onFleet: navigateFleet, onMemory, initialTarget, prefill, onPrefillUsed, pid: pidProp, onDraftChange, contactReplies, peopleActivity, onPeopleActivity, searchRequested, onSearchRequestHandled, activityRequest, requestPrefill, welcomeOpen = false }: ZenProps) {
  const active = useViewActive();
  const browserControl = useBrowserControl();
  const { client, connected } = useGateway();
  const nativeInput = useNativeInput();
  const speech = useNativeSpeech();
  const { snapshot } = useSession();
  const who = snapshot.username || "you";

  /* message times follow the owner's zone; `today` moves once at that zone's midnight so a clock label gains its date */
  const config = useConsoleConfig();
  const accounts = useConsoleAccounts();
  const viewer = accounts.data?.find((account) => account.relation === "self");

  const timeZone = ownerTimeZone(config.data, viewer?.uid);
  const [today, setToday] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => setToday(Date.now()), nextDayBoundary(today, timeZone) - Date.now());
    return () => window.clearTimeout(timer);
  }, [active, today, timeZone]);

  const [note, setNote] = useState<ZenNote | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const closeSearch = useCallback(() => setSearchOpen(false), []);
  useEffect(() => { if (!active) setSearchOpen(false); }, [active]);
  useEffect(() => {
    if (!active || !searchRequested) return;
    setSearchOpen(true);
    onSearchRequestHandled?.();
  }, [active, searchRequested, onSearchRequestHandled]);
  const reportShipError = useCallback((message: string) => setNote(zenFailure(message, SHIP_UNREACHABLE)), []);
  const pid = useZenProcess(pidProp, reportShipError);
  /* the conversation is what was actually said, both ways; the process transcript is what the ship did */
  const conversation = useChatConversation({ processId: pid ?? "", enabled: pid !== null });
  const outbox = useChatOutbox(conversation.acceptMessage);
  const processRuntime = useChatRuntime({ processId: pid ?? "", enabled: pid !== null, observe: true, historyLimit: HISTORY_LIMIT });
  const runtime = processRuntime.runtime;
  const [places, setPlaces] = useState<Place[]>([]);
  const [where, setWhere] = useState<string | null>(initialTarget ?? null);
  const [attachments, setAttachments] = useState<ZenAttachment[]>([]);
  const [context, setContext] = useState<ChatContext | null>(null);
  const [contextDirty, setContextDirty] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const addMenu = useRef<HTMLDivElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  useDismissOnOutsideClick(addOpen, () => [addMenu.current, addButton.current], () => setAddOpen(false));
  useLayoutEffect(() => {
    if (activityRequest) setContext({ kind: "activity", request: activityRequest });
  }, [activityRequest]);
  const [pastes, setPastes] = useState<ZenPaste[]>([]);
  const [hasDraft, setHasDraft] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const extras = attachments.length > 0 || pastes.length > 0;
  const dirty = hasDraft || contextDirty || extras || outbox.messages.length > 0 || (contactReplies?.dirty ?? false);
  useLayoutEffect(() => { onDraftChange?.(dirty); }, [dirty, onDraftChange]);
  useLayoutEffect(() => () => onDraftChange?.(false), [onDraftChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const { sessions, rows: terminalRows } = useTerminalSessions();
  const localRuns = useMemo(() => terminalRows.filter((run) => run.scope === (pidProp ?? "ship")), [terminalRows, pidProp]);
  const [openActivities, setOpenActivities] = useState<ReadonlySet<string>>(() => new Set());
  const [openNotes, setOpenNotes] = useState<ReadonlySet<string>>(() => new Set());
  /* browse mode: null while the prompt has focus, else the index of the focused moment (the TUI's browse cursor) */
  const [promptFocused, setPromptFocused] = useState(false);
  const firstGoKey = useRef<number | null>(null);
  /* the place picker: shown while the prompt holds only "@" and a prefix; filtered as you type */
  const [pickerQuery, setPickerQuery] = useState<string | null>(null);
  /* connecting a place from the selector, when the cloud is the only place; the dialog outlives a trip to Fleet and back */
  const [placesOpen, setPlacesOpen] = useState(false);
  const placesRef = useRef<HTMLDivElement>(null);
  const placeButtonRef = useRef<HTMLButtonElement>(null);
  useDismissOnOutsideClick(placesOpen, () => [placesRef.current, placeButtonRef.current], () => setPlacesOpen(false));
  useLayoutEffect(() => {
    if (!active) setPlacesOpen(false);
    else if (placesOpen) {
      const menu = placesRef.current;
      (menu?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]:enabled')
        ?? menu?.querySelector<HTMLButtonElement>("button:enabled"))?.focus({ preventScroll: true });
    }
  }, [active, placesOpen]);
  const [pickerIndex, setPickerIndex] = useState(0);
  const pickerPlaces = useMemo(() => {
    if (pickerQuery === null) return [];
    const all = [{ id: "gsv", label: CLOUD_PLACE_LABEL, online: true }, ...places.filter((place) => place.id !== "gsv" && place.online)];
    const needle = pickerQuery.toLowerCase();
    return all.filter((place) => !needle || place.id.toLowerCase().includes(needle) || place.label.toLowerCase().includes(needle)).slice(0, 8);
  }, [pickerQuery, places]);
  const onPromptInput = useCallback((value: string) => {
    setHasDraft(value !== "" && value.trim() !== "$");
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
  const pickerRef = useRef<HTMLDivElement>(null);
  const pickerOpen = pickerQuery !== null && pickerPlaces.length > 0;
  /* a press anywhere else closes the picker; the picker itself and the chip that opens it do not */
  useDismissOnOutsideClick(pickerOpen, () => [pickerRef.current, promptRef.current?.chip], () => setPickerQuery(null));
  const currentPlace = useMemo<PromptPlace>(() => {
    const id = where ?? CLOUD_PLACE_ID;
    if (id === CLOUD_PLACE_ID) return { id, label: CLOUD_PLACE_LABEL, online: true };
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
  const promptRef = useRef<PromptLineHandle>(null);
  const stageRequest = useCallback((text: string) => {
    // Release the modal's focus trap within the tap, before focusing the mobile composer.
    flushSync(() => setContext(null));
    const current = promptRef.current?.selection().value ?? "";
    promptRef.current?.setValue(current ? `${text}\n\n${current}` : text);
    setAddOpen(false);
    setPlacesOpen(false);
    promptRef.current?.focus();
  }, []);
  useLayoutEffect(() => {
    if (!active || !requestPrefill) return;
    stageRequest(requestPrefill);
    if (!prefill) onPrefillUsed?.();
  }, [active, requestPrefill, prefill, onPrefillUsed, stageRequest]);
  useLayoutEffect(() => {
    if (active && addOpen) addMenu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    if (!active) setAddOpen(false);
  }, [active, addOpen]);

  /* places, from the instrument's targets cache; WireSync keeps it current from the wire */
  const targetsQuery = useQuery({
    queryKey: INSTRUMENT_TARGETS_KEY,
    queryFn: () => loadConsoleTargets(client),
    enabled: connected,
  });
  const onFleet = useCallback<ZenProps["onFleet"]>((reference) => {
    const row = fleetReferenceRow(reference ?? null);
    const target = row?.startsWith("target:")
      ? targetsQuery.data?.find(target => target.deviceId === row.slice(7)) : undefined;
    if (browserControl.available && target?.kind === "browser" && target.instance && ["starting", "ready"].includes(target.instance.state)) {
      browserControl.open({ instanceId: target.instance.instanceId });
    } else navigateFleet(reference);
  }, [browserControl.available, browserControl.open, targetsQuery.data, navigateFleet]);
  useEffect(() => {
    if (!targetsQuery.data) return;
    const next = placesFromTargets(targetsQuery.data);
    setPlaces(next);
    setWhere((current) => current ?? defaultPlace());
  }, [targetsQuery.data]);

  /* history, then live signals reduced into the runtime state */
  const historyLoaded = Boolean(processRuntime.history.data) || processRuntime.history.isError;
  const answerHistory = useMemo(() => answerHistorySnapshot(processRuntime.history.data, pid), [pid, processRuntime.history.data]);
  /* both halves of the transcript, what was said and what was done, are shown together or not yet */
  const ready = historyLoaded && conversation.loaded;
  useEffect(() => {
    if (processRuntime.history.error) setNote(zenFailure(processRuntime.history.error.message, ACTIVITY_UNAVAILABLE));
  }, [processRuntime.history.error]);

  /* the run clock and the resolve animation */
  const streaming = runtime.rows.some((row) => row.streaming);
  /* a message that arrives whole settles out of noise on arrival; a streamed one already did, character by character */
  const [settling, setSettling] = useState<ReadonlyMap<string, number>>(() => new Map());

  /* moments: the runtime's, plus the commands run by hand */
  const { moments, receipts } = useMemo(() => {
    const fromRuntime: Moment[] = momentsFromConversation(conversation.rows, runtime.rows, runtime.activeRunId, pid ?? undefined)
      .map((moment) => ({ ...moment, attribution: answerAttribution(moment, answerHistory.entries, answerHistory.through) }));
    for (const outgoing of outbox.messages) {
      if (outgoing.draft.conversationId
        ? outgoing.draft.conversationId !== conversation.conversation?.id
        : outgoing.draft.pid !== pid) continue;
      const committed = fromRuntime.find((moment) => moment.id === `conversation:${outgoing.messageId}`);
      if (committed) {
        committed.outgoing = outgoing;
      } else {
        fromRuntime.push({
          id: `outgoing:${outgoing.id}`, role: "human", text: outgoing.draft.message,
          timestamp: outgoing.createdAt, processId: outgoing.draft.pid,
          runId: null, streaming: false, thinking: false, activities: [], narration: "", outgoing,
        });
      }
    }
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
              description: "run a command",
              summary: run.command,
              output: run.output,
              finished: terminalFinished(run),
              failed: run.status === "failed",
            },
          ],
          live: !terminalFinished(run),
          terminal: run,
          you: true,
          startedAt: run.startedAt,
          endedAt: run.endedAt,
        },
      ],
    }));
    const moments = [...fromRuntime, ...fromLocal].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    return { moments, receipts: receiptsForMoments(moments, runtime.activeRunId, pid) };
  }, [answerHistory, conversation.rows, conversation.conversation?.id, outbox.messages, localRuns, runtime.activeRunId, runtime.rows, pid]);

  /* a Ship that has never spoken: the owner's own chat, the welcome dismissed, all history loaded, with no words from Ship yet; what they read meanwhile is the waking line */
  const waking = ready && !pidProp && !welcomeOpen && !conversation.hasMore && !processRuntime.hasOlderHistory && awaitingFirstMessage(moments);

  /* the glyph thinking mark moves on the same clock as settling text; the dot keeps its own time in the stylesheet */
  const marking = THINKING_MARK === "glyphs" && moments.some((moment) => !moment.text && (moment.thinking || moment.streaming));
  const animating = streaming || settling.size > 0 || marking;
  useEffect(() => {
    if (!active || !animating || reducedMotion()) return undefined;
    const interval = window.setInterval(() => setTick((value) => value + 1), RESOLVE_FRAME_MS);
    return () => window.clearInterval(interval);
  }, [active, animating]);

  const loadOlder = useCallback(async () => {
    await Promise.all([conversation.loadOlder(), processRuntime.loadOlderHistory()]);
  }, [conversation.loadOlder, processRuntime.loadOlderHistory]);
  const scrolling = useZenScroll({ moments, ready, promptFocused,
    hasOlder: conversation.hasMore || processRuntime.hasOlderHistory,
    loadingOlder: conversation.loadingOlder || processRuntime.loadingOlderHistory, loadOlder });
  const { browse, selection, viewport: momentsRef, content: contentRef, pin } = scrolling;
  const [selectingText, setSelectingText] = useState(false);
  useEffect(() => {
    const transcript = momentsRef.current;
    if (!active || !transcript) return;
    const update = () => {
      const selected = document.getSelection();
      setSelectingText(Boolean(selected && !selected.isCollapsed
        && (transcript.contains(selected.anchorNode) || transcript.contains(selected.focusNode))));
    };
    update();
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, [active, ready, moments.length === 0, momentsRef]);
  const hasMemoryRead = useMemo(() => [...receipts.values()].some((receipt) => receipt.work.activities.some((activity) =>
    !activity.you && activity.target === "gsv" && activity.calls.some((call) =>
      call.syscall === "fs.read" && call.finished && !call.failed && call.filePath?.startsWith("/src/repos/"),
    ),
  )), [receipts]);
  const memoryCollections = useQuery({
    queryKey: [...INSTRUMENT_MEMORY_KEY, "collections"],
    queryFn: () => listLibraryCollections(client),
    enabled: connected && Boolean(onMemory) && hasMemoryRead,
  });

  const seenMomentsRef = useRef<Set<string> | null>(null);
  const streamedMomentsRef = useRef<Set<string>>(new Set());
  /* the committed message lands under a new id, so a reply that streamed is also known by its run */
  const streamedRunsRef = useRef<Set<string>>(new Set());
  /** Whether the reader watched this message arrive live, under its own id or its run's. */
  const streamed = useCallback((moment: Moment): boolean => moment.streaming
    || streamedMomentsRef.current.has(moment.id) || (moment.runId !== null && streamedRunsRef.current.has(moment.runId)), []);
  useLayoutEffect(() => {
    if (!active || !ready) return;
    for (const moment of moments) {
      if (!moment.streaming) continue;
      streamedMomentsRef.current.add(moment.id);
      if (moment.runId) streamedRunsRef.current.add(moment.runId);
    }
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
    const arrived = moments.filter((moment) => fresh.includes(moment.id) && !streamed(moment)).map((moment) => moment.id);
    if (arrived.length === 0 || reducedMotion()) return;
    const startedAt = Date.now();
    setSettling((current) => {
      const next = new Map(current);
      for (const id of arrived) next.set(id, startedAt);
      return next;
    });
  }, [active, moments, ready, streamed]);
  useEffect(() => {
    if (!active || settling.size === 0) return;
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
  }, [active, moments, settling, tick]);
  /* the first ready render happens before the cascade is set; nothing shows in it, so no frame ever holds the transcript unsettled */
  const cascadeUnset = ready && seenMomentsRef.current === null && !reducedMotion();

  const latest = moments[moments.length - 1];
  const pendingHil: ProcHilRequest | null = runtime.pendingHil;
  useLayoutEffect(() => {
    if (active && pendingHil) scrolling.follow();
  }, [active, pendingHil?.requestId, scrolling.follow]);

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
    setNote(accepted.length < files.length ? zenNotice("Each attachment must be 25 MiB or smaller.") : null);
    promptRef.current?.focus();
  }, []);
  /* a long paste waits beside the prompt as a chip; a command keeps its paste inline, since it runs as typed,
     whether the prompt already starts with one or the paste itself would */
  const foldPaste = useCallback((text: string) => {
    const selection = promptRef.current?.selection();
    const prospective = selection ? selection.value.slice(0, selection.start) + text : text;
    if (/^\s*[$!]/.test(prospective)) return false;
    const paste = longPaste(text);
    if (!paste) return false;
    setPastes((current) => [...current, paste]);
    promptRef.current?.focus();
    return true;
  }, []);
  const say = useCallback(
    (text: string) => {
      if (!pid) {
        setNote(zenNotice("Your Ship is still starting."));
        return false;
      }
      const accepted = outbox.send({
        pid, conversationId: conversation.conversation?.id,
        message: zenDraftMessage(text, pastes),
        media: [...attachments], selectedTarget: where ?? defaultPlace(),
      });
      if (!accepted) return false;
      if (!pidProp) speech?.typed();
      scrolling.follow();
      setAttachments([]);
      setPastes([]);
      return true;
    },
    [attachments, conversation.conversation?.id, outbox.send, pastes, pid, pidProp, speech, scrolling.follow, where],
  );

  const voiceScope = `${snapshot.url}:${snapshot.username}:${pid ?? ""}:${currentPlace.id}`;
  const voiceInput = useRef<NativeVoiceHandle>(null);
  const nativePanels = useRef<HTMLDivElement>(null);
  const voiceSurface = useRef<HTMLDivElement>(null);
  const [recordingVoice, setRecordingVoice] = useState(false);

  const runDirectly = useCallback(
    (command: string) => {
      try {
        const target = where ?? defaultPlace();
        const supportsSessions = places.find((place) => place.id === target)?.kind !== "browser";
        const id = sessions.start(command, target, pidProp ?? "ship", supportsSessions);
        scrolling.follow();
        setOpenActivities((current) => new Set([...current, id]));
        return true;
      } catch (error) {
        setNote(zenNotice(error instanceof Error ? error.message : "The command did not run."));
        return false;
      }
    },
    [sessions, places, where, pidProp, scrolling.follow],
  );

  const onSubmit = useCallback(
    (raw: string) => {
      if (!connected || !pid || outbox.sending) return false;
      setNote(null);
      if (raw) setInputHistory((current) => [...current.filter((entry) => entry !== raw), raw].slice(-50));
      setHistoryIndex(null);
      const intent = parsePromptInput(raw);
      if (!intent) return !raw.trim() && extras ? say("") : false;
      if (intent.kind === "switch") {
        const id = resolvePlace(intent.name, places);
        if (id) setWhere(id);
        else setNote(zenNotice(`No place called ${intent.name}.`));
        return true;
      }
      if (intent.kind === "run") {
        if (extras) { setNote(zenNotice("Remove attachments and pasted text before running a command, or send them to your Ship in plain words.")); return false; }
        return runDirectly(intent.command);
      }
      return say(intent.text);
    },
    [extras, connected, outbox.sending, pid, pidProp, places, runDirectly, say],
  );

  const onHistory = useCallback(
    (direction: -1 | 1) => {
      if (inputHistory.length === 0) return;
      const nextIndex = historyIndex === null ? (direction === -1 ? inputHistory.length - 1 : null) : Math.min(inputHistory.length - 1, Math.max(0, historyIndex + direction));
      setHistoryIndex(nextIndex);
      const empty = promptRef.current?.selection().value.startsWith("$") ? "$ " : "";
      promptRef.current?.setValue(nextIndex === null ? empty : inputHistory[nextIndex]);
    },
    [historyIndex, inputHistory],
  );

  /* approvals */
  const decide = useCallback(
    async (decision: "approve" | "deny", remember?: boolean) => {
      if (!pid || !pendingHil) return;
      try {
        const args: ProcHilArgs = { pid, requestId: pendingHil.requestId, decision };
        if (remember) args.remember = true;
        await decideChatHil(client, args);
      } catch (error) {
        setNote(zenFailure(error instanceof Error ? error.message : "", DECISION_FAILED));
      }
    },
    [client, pendingHil, pid],
  );

  useEffect(() => {
    if (!active || !prefill || !connected || !pid) return;
    const input = promptRef.current;
    if (!input || input.disabled) return;
    setWhere(initialTarget ?? null);
    setAttachments([]);
    setPastes([]);
    input.setValue(prefill);
    input.focus();
    onPrefillUsed?.();
  }, [active, prefill, initialTarget, onPrefillUsed, connected, pid]);

  const onPromptFocus = useCallback(
    (focused: boolean) => {
      setPromptFocused(focused);
      if (focused) setPlacesOpen(false);
    },
    [],
  );

  useLayoutEffect(() => {
    if (!active) { firstGoKey.current = null; return; }
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.target instanceof Element && event.target.closest(".fleet-dialog")) return;
      const editing = editableElement(event.target);
      const typing = editing !== null;
      if (!event.altKey && (event.key === "f" && (event.ctrlKey || event.metaKey) || event.key === "/" && !typing && !event.ctrlKey && !event.metaKey)) {
        event.preventDefault(); setSearchOpen(true); return;
      }
      if (editing && event.key === "Escape") {
        // Escape leaves the prompt even if the input's own handler did not run.
        event.preventDefault();
        editing.blur();
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
      const focusedReceipt = focused ? receipts.get(focused.id) : undefined;
      if (event.key === "o" && focused && (focusedReceipt || focused.activities.some((activity) => activity.you))) {
        event.preventDefault();
        scrolling.stopFollowing();
        const yours = focused.activities.filter((activity) => activity.you);
        toggleActivity(focusedReceipt ? focusedReceipt.key : yours[yours.length - 1].key);
        if (focusedReceipt && focusedReceipt.anchorId !== focused.id) scrolling.select(moments.findIndex((moment) => moment.id === focusedReceipt.anchorId));
        return;
      }
      if (browse !== null && (event.key === "j" || event.key === "k")) {
        event.preventDefault();
        scrolling.select(Math.max(0, Math.min(moments.length - 1, browse + (event.key === "j" ? 1 : -1))));
        return;
      }
      // Anything else printable starts writing: the prompt takes focus during keydown, so the keystroke itself lands in it.
      // A pending approval keeps the keys, and shortcut letters keep their meaning.
      if (pendingHil || !startsWriting(event, CLAIMED_KEYS)) return;
      const input = promptRef.current;
      if (input && !input.disabled) input.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, browse, decide, latest, moments, receipts, pendingHil, scrolling.page, scrolling.select, scrolling.stopFollowing, toggleActivity]);

  /* a paste outside the prompt lands in it too: files attach, text joins the draft */
  useEffect(() => {
    if (!active) return;
    const onPaste = (event: ClipboardEvent) => {
      if (event.defaultPrevented || editableElement(event.target) || pendingHil) return;
      const input = promptRef.current;
      if (!input || input.disabled) return;
      const files = Array.from(event.clipboardData?.files ?? []);
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (files.length === 0 && !text) return;
      event.preventDefault();
      if (files.length > 0) addFiles(files);
      else if (!foldPaste(text)) input.append(text);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [active, addFiles, foldPaste, pendingHil]);

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

  // Moving the browse cursor changes row decoration, not the message, receipt or attachment content.
  const messageBodies = useMemo(() => {
    if (!ready) return [];
    /** How much of a settling message is shown so far: the settled head plus the noisy tail sweeping to the end. */
    const settleProgress = (moment: Moment): number | null => {
      const startedAt = settling.get(moment.id);
      if (startedAt === undefined) return null;
      const progress = (Date.now() - startedAt) / settleDuration(moment.text.length);
      if (progress >= 1) return null;
      return Math.max(0, progress);
    };
    return moments.map((moment) => {
      if (moment.role === "note") return null;
      const receipt = receipts.get(moment.id);
      return <>
        {moment.role === "human" || moment.text || moment.media?.length || moment.streaming ? <div class="who">
          {moment.role === "human" ? who : "Ship"}
          {moment.outgoing && moment.outgoing.status !== "failed" ? (
            <span class="zen-send-status" role="status" aria-label={moment.outgoing.status === "uploading" ? "Uploading attachments" : "Sending message"}>
              <Spinner size={14} />
            </span>
          ) : null}
          {moment.timestamp !== null ? <MomentTime timestamp={moment.timestamp} today={today} timeZone={timeZone} /> : null}
        </div> : null}
        {moment.activities
          .filter((activity) => activity.you)
          .map((activity) => (
            <ActivityLine
              key={activity.key}
              activity={activity}
              who={who}
              places={places}
              open={openActivities.has(activity.key)}
              onToggle={toggleActivity}
              onFleet={onFleet}
            />
          ))}
        {receipt?.anchorId === moment.id ? (
          <Receipt
            receipt={receipt}
            who={who}
            places={places}
            collections={memoryCollections.data ?? EMPTY_COLLECTIONS}
            onMemory={onMemory}
            onFleet={onFleet}
            open={openActivities.has(receipt.key)}
            expanded={openActivities.has(receipt.key) ? openActivities : EMPTY_EXPANDED}
            onToggleDetail={toggleActivity}
            waitingCallId={pendingHil?.runId === receipt.work.runId && pendingHil.pid === receipt.work.processId
              && receipt.work.activities.some((activity) => activity.calls.some((call) => call.callId === pendingHil.callId)) ? pendingHil.callId : undefined}
          />
        ) : null}
        {moment.role === "human" ? (
          <ZenText text={moment.text} markdown={false} progress={settleProgress(moment)} tick={settling.has(moment.id) ? tick : 0} onFold={pin} />
        ) : moment.text ? (
          <ZenText text={moment.text} places={places} markdown progress={moment.streaming ? -1 : settleProgress(moment)} tick={moment.streaming || settling.has(moment.id) ? tick : 0}
            opened={streamed(moment)} onClick={onTextClick} onFold={pin} />
        ) : moment.thinking || moment.streaming ? (
          <div class="text">{waking ? <WakingUp /> : null}<ThinkingMark tick={tick} /></div>
        ) : null}
        {moment.media?.map((media, index) => <ZenMedia key={index} media={media} processId={moment.processId ?? pid ?? ""} />)}
        {moment.text && <MomentCopyButton text={moment.text} />}
        {moment.outgoing && !moment.media?.length && Boolean(moment.outgoing.draft.media?.length) ? (
          <ul class="zen-draft-attachments" aria-label="Message attachments">
            {moment.outgoing.draft.media?.map((attachment, index) => <ZenDraftAttachment key={index} attachment={attachment} />)}
          </ul>
        ) : null}
        {moment.outgoing?.status === "uploading" ? (
          <div class="zen-send-actions"><button type="button" onClick={() => outbox.cancelUpload(moment.outgoing!.id)}>cancel upload</button></div>
        ) : moment.outgoing?.status === "failed" ? (
          <div class="zen-send-actions">
            <span class="is-err" role="alert">{moment.outgoing.error}</span>
            <button type="button" disabled={!connected || outbox.sending} onClick={() => outbox.retry(moment.outgoing!)}>retry</button>
            <button type="button" onClick={() => outbox.discard(moment.outgoing!.id)}>dismiss</button>
          </div>
        ) : null}
      </>;
    });
  }, [ready, moments, who, today, timeZone, places, openActivities, toggleActivity, onFleet,
    receipts, memoryCollections.data, onMemory, pendingHil, settling, tick, onTextClick, pin, streamed,
    pid, connected, outbox.sending, outbox.cancelUpload, outbox.retry, outbox.discard, waking]);

  /* the status line */
  const selectorPlaces = useMemo(() => orderPlaces(targetsQuery.data ?? []), [targetsQuery.data]);
  /* the cloud is always listed; once places are known and it is alone, it is not a choice, so it reads as plain text and offers to connect a place */
  const cloudAlone = !!targetsQuery.data && !targetsQuery.isError && selectorPlaces.length === 1;

  const latestMessageIndex = useMemo(() => moments.reduce((latest, moment, index) =>
    moment.role === "human" || (moment.role === "ship" && (moment.text !== "" || moment.media?.length || moment.streaming)) ? index : latest, -1), [moments]);
  const historyFailure = conversation.historyError ? (
    <div class="zen-history-status is-err" role="alert">
      <span>Could not load your conversation: {conversation.historyError.message}</span>
      <button type="button" disabled={!connected || conversation.historyFetching} onClick={() => void conversation.retryHistory()}>retry</button>
    </div>
  ) : null;
  const helperEmpty = ready && moments.length === 0 && pid !== null && Boolean(pidProp) && pendingHil === null;

  return (
    <main class={`zen${!promptFocused ? " is-browse" : ""}${draggingFiles ? " is-file-drop" : ""}${selectingText ? " has-text-selection" : ""}`} aria-label="Chat"
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
        {helperEmpty ? (
          <div class="zen-empty"><p>This helper has no messages yet.</p></div>
        ) : !ready ? (
          <div class="zen-moments" ref={momentsRef} data-scroll-edge data-scroll-edge-bottom>
            <div class="zen-content" ref={contentRef}>{historyFailure}</div>
          </div>
        ) : (
          <div class="zen-moments" ref={momentsRef} data-scroll-edge data-scroll-edge-bottom>
            <div class={`zen-content${pendingHil ? " has-approval" : ""}`} ref={contentRef}>
              {historyFailure}
              {(conversation.loadingOlder || processRuntime.loadingOlderHistory) && <div class="zen-history-status"><LoadingState>loading earlier messages</LoadingState></div>}
              {(conversation.error || processRuntime.historyError) && <div class="zen-history-status is-err" role="alert">
                {conversation.error || processRuntime.historyError}
                <button type="button" onClick={scrolling.readOlder}>retry</button>
              </div>}
              {moments.map((moment, index) => {
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
                      focus={selection === index}
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
                  <div key={moment.id} data-index={index} data-moment-id={moment.id} class={`zen-moment ${moment.role === "human" ? "is-human" : "is-ship"}${!moment.text && !moment.media?.length && !moment.streaming ? " is-work" : ""}${pending ? " is-pending" : ""}${materialising ? " is-materialising" : ""}${index < latestMessageIndex ? " is-older" : ""}${selection === index ? " is-focus" : ""}`}>
                    {messageBodies[index]}
                  </div>
                );
              })}
              {waking && !moments.some((moment) => moment.role === "ship" && moment.thinking) ? (
                <div class="zen-moment is-ship"><div class="text"><WakingUp /></div></div>
              ) : null}
              {pendingHil ? (
                <div class="zen-moment is-approval">
                  <ApprovalCard
                    key={pendingHil.requestId}
                    request={pendingHil}
                    who={who}
                    place={placeLabel(pendingHil.target, places)}
                    onInspect={() => {
                      if (pid) onFleet({ kind: "approval", pid, requestId: pendingHil.requestId });
                    }}
                    onDecide={(decision, remember) => void decide(decision, remember)}
                  />
                </div>
              ) : null}
            </div>
          </div>
        )}
        {!helperEmpty && ready && scrolling.awayFromBottom && <button type="button" class="zen-jump-bottom"
          aria-label="Jump to latest message" onClick={scrolling.follow}>↓<span> latest</span></button>}
      </div>

      <div class="zen-bottom">
        {/* contact messages that landed while the person was here, owned by Instrument so a helper switch keeps them */}
        {/* a helper's view has no contact notices */}
        {/* a new contact notice sits under the transcript; keep it in view the way an approval is */}
        <div class="zen-context-bar" role="group" aria-label="Chat activity">
          {!pidProp && <ChatPlans account={viewer} onOpen={() => setContext({ kind: "activity", request: { tab: "ongoing" } })} />}
          {peopleActivity && contactReplies && onPeopleActivity && <PeopleActivity activity={peopleActivity} replies={contactReplies} account={viewer} onOpen={onPeopleActivity} />}
        </div>
        {!pidProp && <BrowserRequests />}
        {pid ? <DelegatedApprovals pid={pid} onFleet={onFleet} placeLabelFor={(target) => placeLabel(target, places)} /> : null}

        <div class="zen-composer">
          {pickerOpen ? (
            <div class="zen-picker" role="listbox" aria-label="Places" ref={pickerRef}>
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

          {extras && <ul class="zen-draft-attachments" aria-label="Attachments to send">
            {attachments.map((attachment) => <ZenDraftAttachment key={attachment.id} attachment={attachment}
              onRemove={() => setAttachments((current) => current.filter((file) => file.id !== attachment.id))} />)}
            {pastes.map((paste) => <ZenDraftPaste key={paste.id} paste={paste}
              onRemove={() => setPastes((current) => current.filter((entry) => entry.id !== paste.id))} />)}
          </ul>}
          {note && <div class="zen-feedback">
            <FeedbackNote note={note} />
          </div>}
          <div class="zen-compose-line" hidden={recordingVoice}>
            <input ref={fileInput} type="file" multiple hidden aria-label="Choose attachments" onChange={(event) => {
              addFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = "";
            }} />
            <PromptLine
              ref={promptRef}
              onFocusChange={onPromptFocus}
              onInput={(value) => { onPromptInput(value); voiceInput.current?.onInput(value); }}
              interceptSubmit={() => voiceInput.current?.interceptSubmit() ?? false}
              onKeyIntercept={onPromptKey}
              onPlace={openPicker}
              place={currentPlace}
              showPlace={false}
              dir="~"
              placeholder="Message your Ship"
              disabled={!pid || recordingVoice}
              onSubmit={onSubmit}
              allowEmpty={extras}
              onFiles={addFiles}
              onPasteText={foldPaste}
              onHistory={onHistory}
            />
            {(hasDraft || extras) && <button type="button" class="zen-submit"
              onPointerDown={(event) => { if (promptFocused) event.preventDefault(); }}
              disabled={!connected || !pid || outbox.sending || recordingVoice} onClick={() => promptRef.current?.submit()}>send</button>}
          </div>
          <div ref={voiceSurface} />
          {!currentPlace.online && <div class="zen-feedback" role="status">
            <button type="button" class="is-warn" onClick={() => onFleet(`target:${currentPlace.id}`)}>
              {currentPlace.label} is offline · view place
            </button>
          </div>}
          <div class="zen-compose-actions">
            <button ref={addButton} type="button" class="zen-attach" aria-label="Add to chat" title="Add to chat"
              aria-haspopup="menu" aria-expanded={addOpen} aria-controls="zen-add-menu"
              disabled={recordingVoice} onClick={() => { setPlacesOpen(false); setAddOpen((value) => !value); }}>+</button>
            <div ref={addMenu} id="zen-add-menu" class="zen-add-menu" role="menu" hidden={!addOpen} aria-label="Add to chat"
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Escape") { event.preventDefault(); setAddOpen(false); addButton.current?.focus(); }
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
                  const at = buttons.findIndex((button) => button === document.activeElement);
                  buttons[(at + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
                }
                if (event.key === "Tab") setAddOpen(false);
              }}>
              <div class="zen-add-section" role="group" aria-labelledby="zen-add-context-label">
                <div class="zen-add-heading" id="zen-add-context-label">add context</div>
                <button type="button" role="menuitem" class="is-file" onClick={() => { setAddOpen(false); fileInput.current?.click(); }}>attach a file <small>this device</small></button>
                <button type="button" role="menuitem" disabled={!viewer || (!canConfigure(viewer, "profile.resolve") && !canConfigure(viewer, "contact.list"))} onClick={() => { setAddOpen(false); setContext({ kind: "person" }); }}>find a person <small>@handle</small></button>
                <button type="button" role="menuitem" class="is-file" disabled={!viewer || !canConfigure(viewer, "fs.read")} onClick={() => { setAddOpen(false); setContext({ kind: "files" }); }}>reference a file <small>your places</small></button>
              </div>
              <div class="zen-add-section" role="group" aria-labelledby="zen-add-ship-label">
                <div class="zen-add-heading" id="zen-add-ship-label">ask Ship</div>
                <button type="button" role="menuitem" disabled={!viewer || !canConfigure(viewer, "conversation.send")} onClick={() => stageRequest("Help me create a routine.")}>create a routine</button>
                <button type="button" role="menuitem" disabled={!viewer || !canConfigure(viewer, "conversation.send")} onClick={() => stageRequest("Help me connect a computer to my Ship.")}>connect a computer</button>
                <button type="button" role="menuitem" disabled={!viewer || !canConfigure(viewer, "conversation.send")} onClick={() => stageRequest("Start a browser for me.")}>start a browser</button>
              </div>
            </div>
            <button ref={placeButtonRef} type="button" class="zen-place-trigger"
              aria-label={`Choose a place, currently ${currentPlace.label}`} aria-expanded={placesOpen} aria-controls="zen-places"
              onKeyDown={(event) => {
                if (event.key === "Escape" && placesOpen) { event.preventDefault(); event.stopPropagation(); setPlacesOpen(false); }
              }}
              onClick={() => { setPickerQuery(null); setPlacesOpen((open) => !open); }}>
              <span class={`zen-place-status${currentPlace.online ? " is-online" : ""}`} aria-hidden="true" />
              <span class="zen-place-label">{currentPlace.label}</span>
              <span class="zen-place-chevron" aria-hidden="true" />
            </button>
            <div class="zen-input-actions">
              {nativeInput ? <NativeVoiceControls ref={voiceInput} prompt={promptRef} panelHost={nativePanels}
                scope={voiceScope}
                enabled={active && connected && pid !== null && pendingHil === null && !searchOpen && !context && !addOpen}
                send={onSubmit} />
                : <BrowserVoiceControls ref={voiceInput} prompt={promptRef} client={client} pid={pid}
                  surfaceHost={voiceSurface} onActiveChange={setRecordingVoice}
                  scope={voiceScope}
                  enabled={active && connected && pid !== null && pendingHil === null && !searchOpen && !context && !addOpen && !outbox.sending} />}
            </div>
          </div>
          <span class="zen-connection-status" role="status">{connected ? "" : "Reconnecting..."}</span>
          <div ref={placesRef} id="zen-places" class="zen-place-section" hidden={!placesOpen}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape") { event.preventDefault(); setPlacesOpen(false); placeButtonRef.current?.focus(); }
            }}
            onBlur={(event) => {
              const next = event.relatedTarget;
              if (next !== placeButtonRef.current && (!(next instanceof Node) || !event.currentTarget.contains(next))) setPlacesOpen(false);
            }}>
            <ul class="zen-places" aria-label="Places and live browsers">
              {selectorPlaces.map((target) => {
                const label = target.id === CLOUD_PLACE_ID ? CLOUD_PLACE_LABEL : target.label;
                const viewBrowser = browserControl.available && target.kind === "browser" && target.instance && ["starting", "ready"].includes(target.instance.state);
                return (
                  <li key={target.id}>
                    <button type="button" class={`zen-place${cloudAlone ? " is-alone" : target.id === currentPlace.id ? " is-selected" : ""}`}
                      aria-label={viewBrowser ? `View ${label}` : target.online ? `Use ${label} for the next message or command` : `${label} is offline`}
                      aria-pressed={viewBrowser ? undefined : target.id === currentPlace.id}
                      disabled={!viewBrowser && !target.online}
                      onClick={() => { setPlacesOpen(false); if (viewBrowser) onFleet(`target:${target.id}`); else { setWhere(target.id); setPickerQuery(null); promptRef.current?.focus(); } }}>
                      <span class={`zen-place-status${target.online ? " is-online" : ""}`} aria-hidden="true" />
                      <span>{label}</span>
                      {viewBrowser && <span class="zen-browser-open" aria-hidden="true">↗</span>}
                    </button>
                    {cloudAlone && <button type="button" class="zen-connect-place" onClick={() => { setPlacesOpen(false); setContext({ kind: "connect" }); }}>+ connect place</button>}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </div>
      <div class="zen-input-panels" ref={nativePanels} />
      <ChatPanels context={context} active={active} account={viewer} targets={targetsQuery.data ?? []}
        ready={connected && !!targetsQuery.data && !targetsQuery.isError} onClose={() => setContext(null)} onDirty={setContextDirty}
        onConnected={(target) => { setWhere(target); setContext(null); promptRef.current?.focus(); }}
        onAsk={stageRequest} onFleet={(reference) => { setContext(null); onFleet(reference); }}
        onPeople={(request) => { setContext(null); onPeopleActivity?.(request); }} />
      {active && searchOpen && conversation.conversation && <ConversationSearch key={conversation.conversation.id}
        conversationId={conversation.conversation.id} timeZone={timeZone} onClose={closeSearch} />}
    </main>
  );
}
import { BrowserRequests, useBrowserControl } from "../browser/BrowserControl";
