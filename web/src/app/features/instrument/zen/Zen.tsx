import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import type { ProcHilRequest } from "@humansandmachines/gsv/protocol";
import { AsciiGalaxyScan } from "../../../components/ui/AsciiGalaxyScan";
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
  addOptimisticUserMessage,
  applyChatSignal,
  chatRuntimeStateFromHistory,
  emptyChatRuntimeState,
  type ChatRuntimeState,
} from "../../chat/domain/transcript";
import { loadConsoleTargets } from "../../gsv-console/backend/consoleService";
import { executeTerminalCommand } from "../../terminal/backend/terminalService";
import type { FleetRow } from "../Instrument";
import { renderMarkdownHtml, escapeHtml } from "../shared/markdown";
import { PromptLine } from "../shared/PromptLine";
import { Wordmark } from "../shared/Wordmark";
import {
  activityDuration,
  countLabel,
  defaultPlace,
  formatSeconds,
  isStringValue,
  linkPlaceReferences,
  momentsFromRows,
  parsePromptInput,
  PLACE_REFERENCE_PREFIX,
  placeLabel,
  placesUsed,
  resolvePlace,
  resolveTail,
  trimOutput,
  type Activity,
  type Moment,
  type Place,
} from "./zenModel";
import "./zen.css";

export type ZenProps = {
  /** Step back to Fleet, optionally landing on a row (a place mentioned in a response, for instance). */
  onFleet: (row?: FleetRow) => void;
  /** Open the first day: the places manifest with empty rows. */
  onFirstDay: () => void;
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

const HISTORY_LIMIT = 80;
const RESOLVE_FRAME_MS = 60;

function reducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function placesFromTargets(targets: Awaited<ReturnType<typeof loadConsoleTargets>>): Place[] {
  return targets.map((target) => ({ id: target.deviceId, label: target.label || target.deviceId, online: target.online }));
}

function railHtml(activity: Activity, who: string, places: readonly Place[]): string {
  const where = escapeHtml(activity.target);
  return activity.calls
    .map((call) => {
      const head = `<span class="cmd"><span class="who">${escapeHtml(who)}</span>@<span class="where">${where}</span> <span class="dir">${escapeHtml(placeLabel(activity.target, places))}</span> $ ${escapeHtml(call.syscall)} ${escapeHtml(call.summary)}</span>`;
      const body = call.output ? `\n${escapeHtml(call.output)}` : call.finished ? "" : `\n<span class="meta">running…</span>`;
      const failed = call.failed ? `\n<span class="err">failed</span>` : "";
      return `${head}${body}${failed}`;
    })
    .join("\n\n");
}

function ActivityLine({
  activity,
  places,
  who,
  open,
  onToggle,
}: {
  activity: Activity;
  places: readonly Place[];
  who: string;
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
        <div class="machine-rail" dangerouslySetInnerHTML={{ __html: railHtml(activity, who, places) }} />
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

export function Zen({ onFleet, onFirstDay }: ZenProps) {
  const { client, connected } = useGateway();
  const { snapshot } = useSession();
  const who = snapshot.username || "you";

  const [pid, setPid] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<ChatRuntimeState>(() => emptyChatRuntimeState());
  const runtimeRef = useRef(runtime);
  const [places, setPlaces] = useState<Place[]>([]);
  const [where, setWhere] = useState<string | null>(null);
  const [localRuns, setLocalRuns] = useState<LocalRun[]>([]);
  const [openActivities, setOpenActivities] = useState<ReadonlySet<string>>(() => new Set());
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
  }, [client, connected]);

  /* places, refreshed whenever a target's status changes */
  useEffect(() => {
    if (!connected) return undefined;
    let cancelled = false;
    const load = () => {
      void loadConsoleTargets(client)
        .then((targets) => {
          if (cancelled) return;
          const next = placesFromTargets(targets);
          setPlaces(next);
          setWhere((current) => current ?? defaultPlace(next));
        })
        .catch(() => undefined);
    };
    load();
    const unsubscribe = client.onSignal((signal) => {
      if (signal === "target.status") load();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client, connected]);

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
  useEffect(() => {
    if (!streaming || reducedMotion()) return undefined;
    const interval = window.setInterval(() => setTick((value) => value + 1), RESOLVE_FRAME_MS);
    return () => window.clearInterval(interval);
  }, [streaming]);

  /* moments: the runtime's, plus the commands run by hand */
  const moments = useMemo(() => {
    const fromRuntime = momentsFromRows(runtime.rows, runtime.activeRunId);
    const fromLocal: Moment[] = localRuns.map((run) => ({
      id: run.id,
      role: "ship",
      text: "",
      streaming: false,
      thinking: false,
      runId: null,
      timestamp: run.startedAt,
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
  }, [localRuns, runtime.activeRunId, runtime.rows]);

  useEffect(() => {
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
      const optimistic = addOptimisticUserMessage(runtimeRef.current, text, []);
      runtimeRef.current = optimistic;
      setRuntime(optimistic);
      try {
        await sendChatMessage(client, { pid, message: text });
      } catch (error) {
        setNote(error instanceof Error ? error.message : "The message did not go through.");
      }
    },
    [client, pid],
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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      const typing = target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (pendingHil && (event.key === "y" || event.key === "n")) {
        event.preventDefault();
        void decide(event.key === "y" ? "approve" : "deny");
        return;
      }
      if (typing) return;
      if (event.key === "o" && latest && latest.activities.length > 0) {
        event.preventDefault();
        toggleActivity(latest.activities[latest.activities.length - 1].key);
        return;
      }
      if (event.key.length === 1 && event.key !== "z" && event.key !== "n") {
        promptRef.current?.querySelector("input")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [decide, latest, pendingHil, toggleActivity]);

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
  }, [connected, lastRun, latest, localRuns, now, pendingHil, pid, places, runtime.context, thinking, where]);

  const onlinePlaces = places.filter((place) => place.online);
  const empty = moments.length === 0 && pid !== null;

  return (
    <main class="zen" aria-label="Zen">
      <div class="instrument-top">
        <Wordmark />
        <span>
          ship ·{" "}
          <span class={connected ? "is-on" : "is-err"} style={connected ? "color: var(--online)" : "color: var(--error)"}>
            {connected ? `${countLabel(onlinePlaces.length + 1, "place")} reachable` : "offline"}
          </span>
        </span>
        <span class="keys">
          <button type="button" onClick={() => onFleet()}>
            <kbd>z</kbd>fleet
          </button>
          <span>
            <kbd>o</kbd>show the run
          </span>
          <span>
            <kbd>$</kbd>run it yourself
          </span>
          <button type="button" onClick={onFirstDay}>
            <kbd>n</kbd>first day
          </button>
        </span>
      </div>

      <div class="zen-body">
        <div class="zen-timeline" aria-hidden="true">
          {moments.map((moment, index) => (
            <i key={moment.id} class={`${moment.role === "human" ? "is-human" : ""}${index === moments.length - 1 ? " is-here" : ""}`} />
          ))}
        </div>
        {empty ? (
          <div class="zen-empty">
            <div class="zen-galaxy">
              <AsciiGalaxyScan showNebula={false} showStars={false} showTexture cols={150} rows={48} particleCount={2600} label="Your ship forming" />
            </div>
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
              return (
                <div key={moment.id} class={`zen-moment ${moment.role === "human" ? "is-human" : "is-ship"}${isLatest ? "" : " is-older"}`}>
                  <div class="who">{moment.role === "human" ? who : "ship"}</div>
                  {moment.activities.map((activity) => (
                    <ActivityLine
                      key={activity.key}
                      activity={activity}
                      places={places}
                      who={who}
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
                  ) : moment.text ? (
                    <div class="text" onClick={onTextClick} dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(linkPlaceReferences(moment.text, places)) }} />
                  ) : moment.thinking ? (
                    <div class="text">
                      <span class="zen-caret blink" />
                    </div>
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
          {thinking ? (
            <span class="zen-think-form" aria-hidden="true">
              <AsciiGalaxyScan text="" showNebula={false} showStars={false} cols={44} rows={12} particleCount={260} fontSize={6} label="Thinking" />
            </span>
          ) : null}
          {status.map((part, index) => (
            <span key={index} class={part.tone}>
              {part.text}
            </span>
          ))}
          {note ? <span class="is-err">{note}</span> : null}
        </div>
        <div ref={promptRef}>
          <PromptLine
            who={who}
            where={where ?? "gsv"}
            dir="~"
            placeholder={pendingHil ? "answer the approval first" : "ask, or start with $ to run a command"}
            disabled={!connected || !pid}
            onSubmit={onSubmit}
            onHistory={onHistory}
            autoFocus
          />
        </div>
        <div class="prompt-hint">
          <b>enter</b> send · <b>$ ls</b> runs on {placeLabel(where ?? "gsv", places)} with no model in the loop · <b>@name</b> moves the prompt · click a <b>used …</b> line for the raw run
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
