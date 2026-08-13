import DOMPurify from "dompurify";
import { parse as parseMarkdown } from "marked";
import type { JSX } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { useGateway } from "../../services/gateway/GatewayProvider";
import {
  useAbortChatProcess,
  useChatProcessList,
  useChatRuntime,
  useDecideChatHil,
  useSendChatMessage,
  useSpawnChatProcess,
} from "../chat/hooks";
import { useTerminalCommandMutation } from "../terminal/hooks/useTerminalQueries";
import { textApprovalCopy } from "./approval";
import { TextClientMedia } from "./components/TextClientMedia";
import {
  ApprovalPanel,
  MomentRail,
  PresenceLane,
  TerminalCanvas,
  type TerminalLine,
} from "./components";
import {
  chooseLatestInteractiveProcess,
  projectTextMoments,
  type TextMoment,
} from "./model";
import { createTextClientSounds } from "./sound";
import { useFittedText } from "./useFittedText";
import "./textClient.css";

type TextClientShellProps = {
  username: string;
  onLock: () => void;
};

type SurfaceMode = "conversation" | "terminal";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function roleLabel(role: TextMoment["role"]): string {
  if (role === "assistant") return "Intelligence";
  if (role === "user") return "You";
  return "System";
}

function momentDetail(moment: TextMoment): string {
  const compact = moment.text.replace(/\s+/g, " ").trim();
  return compact ? compact.slice(0, 48) : moment.media.length > 0 ? "Attachment" : "Empty";
}

function presenceMotionForCategory(category: string | undefined) {
  if (category === "searching-files") return "search" as const;
  if (category === "reading-files") return "read" as const;
  if (category === "writing-files" || category === "editing-files" || category === "deleting-files") return "mutate" as const;
  if (category === "running-commands" || category === "running-code" || category === "using-tools") return "execute" as const;
  return "thinking" as const;
}

function RichText({ text }: { text: string }) {
  const html = useMemo(() => {
    try {
      return String(DOMPurify.sanitize(parseMarkdown(text, { async: false, breaks: true, gfm: true })));
    } catch {
      return "";
    }
  }, [text]);
  return html ? <div class="text-client-rich" dangerouslySetInnerHTML={{ __html: html }} /> : <>{text}</>;
}

function MomentBody({ moment, processId }: { moment: TextMoment; processId: string }) {
  const fit = useFittedText<HTMLDivElement>(moment.text, { locked: moment.role === "assistant" });
  return (
    <div
      ref={fit.containerRef}
      class={`text-client-moment-viewport${fit.scrolls ? " is-scrollable" : ""}`}
    >
      <article
        class={`text-client-moment-body is-${moment.role}${moment.error ? " is-error" : ""}`}
        aria-label={`${roleLabel(moment.role)} message`}
        aria-busy={moment.streaming}
        style={{ fontFamily: fit.fontFamily, fontSize: `${fit.fontSize}px`, lineHeight: `${fit.lineHeight}px` }}
      >
        {moment.role === "assistant" && !moment.streaming ? <RichText text={moment.text} /> : moment.text}
        <TextClientMedia items={moment.media} momentKey={moment.key} processId={processId} />
        {moment.completedWork.length > 0 ? (
          <div class="text-client-work-record" aria-label="Work completed">
            {moment.completedWork.map((entry) => <span key={entry.key}>{entry.text}</span>)}
          </div>
        ) : null}
      </article>
    </div>
  );
}

function commandId(prefix: string): string {
  return `${prefix}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
}

export function TextClientShell({ username, onLock }: TextClientShellProps) {
  const { connected } = useGateway();
  const processList = useChatProcessList();
  const spawn = useSpawnChatProcess();
  const send = useSendChatMessage();
  const abort = useAbortChatProcess();
  const decideHil = useDecideChatHil();
  const terminalCommand = useTerminalCommandMutation();
  const [processId, setProcessId] = useState("");
  const [spawnAttempted, setSpawnAttempted] = useState(false);
  const [mode, setMode] = useState<SurfaceMode>("conversation");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [followingLatest, setFollowingLatest] = useState(true);
  const [draft, setDraft] = useState("");
  const [draftVisible, setDraftVisible] = useState(false);
  const [notice, setNotice] = useState("");
  const [terminalDraft, setTerminalDraft] = useState("");
  const [terminalLines, setTerminalLines] = useState<TerminalLine[]>([]);
  const [edgeIntent, setEdgeIntent] = useState<{ direction: -1 | 1; progress: number } | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const wheelGestureRef = useRef({ amount: 0, direction: 0, lastAt: 0, latched: false });
  const edgeIntentTimerRef = useRef<number | null>(null);
  const sounds = useMemo(() => createTextClientSounds(), []);

  const runtime = useChatRuntime({ enabled: Boolean(processId), processId });
  const projection = useMemo(() => projectTextMoments(runtime.runtime), [runtime.runtime]);
  const moments = projection.moments;
  const selectedIndex = Math.max(0, moments.findIndex((moment) => moment.key === selectedKey));
  const selected = moments[selectedIndex] ?? null;

  useEffect(() => {
    if (processId || !processList.data) return;
    const existing = chooseLatestInteractiveProcess(processList.data);
    if (existing) {
      setProcessId(existing.pid);
      return;
    }
    if (!spawnAttempted && connected) {
      setSpawnAttempted(true);
      spawn.mutate({ interactive: true }, {
        onSuccess: (result) => setProcessId(result.pid),
        onError: (error) => setNotice(errorMessage(error, "Could not start a conversation.")),
      });
    }
  }, [connected, processId, processList.data, spawn, spawnAttempted]);

  useEffect(() => {
    if (moments.length === 0) {
      setSelectedKey(null);
      return;
    }
    if (followingLatest || !selectedKey || !moments.some((moment) => moment.key === selectedKey)) {
      setSelectedKey(moments[moments.length - 1].key);
    }
  }, [followingLatest, moments, selectedKey]);

  useEffect(() => () => sounds.dispose(), [sounds]);

  const selectMoment = useCallback((key: string) => {
    if (key !== selectedKey) sounds.play("select");
    setSelectedKey(key);
    setFollowingLatest(key === moments[moments.length - 1]?.key);
    setDraftVisible(false);
  }, [moments, selectedKey, sounds]);

  const moveMoment = useCallback((direction: -1 | 1) => {
    if (moments.length === 0) return;
    const next = Math.max(0, Math.min(moments.length - 1, selectedIndex + direction));
    selectMoment(moments[next].key);
  }, [moments, selectMoment, selectedIndex]);

  const clearEdgeIntent = useCallback(() => {
    if (edgeIntentTimerRef.current !== null) {
      window.clearTimeout(edgeIntentTimerRef.current);
      edgeIntentTimerRef.current = null;
    }
    setEdgeIntent(null);
  }, []);

  useEffect(() => () => {
    if (edgeIntentTimerRef.current !== null) {
      window.clearTimeout(edgeIntentTimerRef.current);
    }
  }, []);

  const revealDraft = useCallback(() => {
    if (mode !== "conversation" || runtime.runtime.pendingHil) return;
    setDraftVisible(true);
    requestAnimationFrame(() => composerRef.current?.focus());
  }, [mode, runtime.runtime.pendingHil]);

  const submitDraft = useCallback(async () => {
    const message = draft.trim();
    if (!message || send.isPending || spawn.isPending) return;
    let pid = processId;
    try {
      if (!pid) {
        const result = await spawn.mutateAsync({ interactive: true });
        pid = result.pid;
        setProcessId(pid);
      }
      runtime.appendOptimisticUserMessage(message);
      sounds.play("send");
      setDraft("");
      setDraftVisible(false);
      setFollowingLatest(true);
      await send.mutateAsync({ pid, message });
      setNotice("");
    } catch (error) {
      setDraft(message);
      setDraftVisible(true);
      setNotice(errorMessage(error, "Your message could not be sent."));
    }
  }, [draft, processId, runtime, send, sounds, spawn]);

  const updateDraft = useCallback((value: string) => {
    setDraft((current) => {
      sounds.playTextChange(current, value);
      return value;
    });
  }, [sounds]);

  const updateTerminalDraft = useCallback((value: string) => {
    setTerminalDraft((current) => {
      sounds.playTextChange(current, value);
      return value;
    });
  }, [sounds]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typingTarget = target?.matches("input, textarea, select, button, a, [role=button], [contenteditable=true]");
      if ((event.metaKey || event.ctrlKey) && event.key === "`") {
        event.preventDefault();
        sounds.play("select");
        setMode((current) => current === "conversation" ? "terminal" : "conversation");
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === ".") {
        event.preventDefault();
        if (processId && (runtime.runtime.activeRunId || runtime.runtime.runState === "running")) {
          sounds.play("stop");
          abort.mutate({ pid: processId, ...(runtime.runtime.activeRunId ? { runId: runtime.runtime.activeRunId } : {}) });
        }
        return;
      }
      if (typingTarget || event.isComposing || mode !== "conversation") return;
      if (event.altKey && event.key === "ArrowUp") {
        event.preventDefault();
        moveMoment(-1);
      } else if (event.altKey && event.key === "ArrowDown") {
        event.preventDefault();
        moveMoment(1);
      } else if (event.key === "Escape") {
        setDraftVisible(false);
      } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        setDraft((current) => {
          const next = `${current}${event.key}`;
          sounds.playTextChange(current, next);
          return next;
        });
        revealDraft();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [abort, mode, moveMoment, processId, revealDraft, runtime.runtime.activeRunId, sounds]);

  const onCanvasWheel = (event: JSX.TargetedWheelEvent<HTMLDivElement>) => {
    if (draftVisible || mode !== "conversation") return;
    if (Math.abs(event.deltaY) < 0.5 || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    const scrollable = event.target instanceof Element ? event.target.closest(".text-client-moment-viewport") : null;
    const longMoment = scrollable instanceof HTMLElement && scrollable.scrollHeight > scrollable.clientHeight + 1;
    if (longMoment) {
      const atTop = scrollable.scrollTop <= 0;
      const atBottom = scrollable.scrollTop + scrollable.clientHeight >= scrollable.scrollHeight - 1;
      if ((event.deltaY < 0 && !atTop) || (event.deltaY > 0 && !atBottom)) return;
    }
    const now = performance.now();
    const vertical = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaY;
    const direction = Math.sign(vertical);
    const gesture = wheelGestureRef.current;
    if (now - gesture.lastAt > 180 || direction !== gesture.direction) {
      gesture.amount = 0;
      gesture.latched = false;
      clearEdgeIntent();
    }
    gesture.lastAt = now;
    gesture.direction = direction;
    if (gesture.latched) return;
    gesture.amount += vertical;
    event.preventDefault();
    if (longMoment) {
      const progress = Math.min(1, Math.abs(gesture.amount) / 144);
      setEdgeIntent({ direction: direction > 0 ? 1 : -1, progress });
      if (edgeIntentTimerRef.current !== null) window.clearTimeout(edgeIntentTimerRef.current);
      edgeIntentTimerRef.current = window.setTimeout(clearEdgeIntent, 240);
      if (progress < 1) return;
    }
    gesture.latched = true;
    clearEdgeIntent();
    moveMoment(direction > 0 ? 1 : -1);
  };

  const onRailWheel = (event: JSX.TargetedWheelEvent<HTMLElement>) => {
    if (Math.abs(event.deltaY) < 1) return;
    event.preventDefault();
    moveMoment(event.deltaY > 0 ? 1 : -1);
  };

  const submitTerminal = async () => {
    const input = terminalDraft.trim();
    if (!input || terminalCommand.isPending) return;
    const prompt = `${username || "user"}@gsv $`;
    setTerminalLines((lines) => [...lines, { id: commandId("command"), kind: "command", prompt, text: input }]);
    sounds.play("send");
    setTerminalDraft("");
    try {
      const result = await terminalCommand.mutateAsync({ input, target: "gsv" });
      const additions: TerminalLine[] = [];
      if (result.stdout) additions.push({ id: commandId("stdout"), kind: "output", text: result.stdout });
      if (result.stderr) additions.push({ id: commandId("stderr"), kind: "error", text: result.stderr });
      setTerminalLines((lines) => [...lines, ...additions]);
    } catch (error) {
      setTerminalLines((lines) => [...lines, { id: commandId("error"), kind: "error", text: errorMessage(error, "Command failed.") }]);
    }
  };

  const startNewConversation = () => {
    if (spawn.isPending) return;
    spawn.mutate({ interactive: true }, {
      onSuccess: (result) => {
        setProcessId(result.pid);
        setSelectedKey(null);
        setFollowingLatest(true);
        setDraft("");
        setDraftVisible(true);
        setNotice("");
        requestAnimationFrame(() => composerRef.current?.focus());
      },
      onError: (error) => setNotice(errorMessage(error, "Could not start a new conversation.")),
    });
  };

  const pendingHil = runtime.runtime.pendingHil;
  const approvalCopy = pendingHil ? textApprovalCopy(pendingHil) : null;
  const active = runtime.runtime.runState === "running" || projection.activityLines.length > 0;
  const presenceLines = notice
    ? [notice]
    : projection.activityLines.length > 0
      ? projection.activityLines.map((line) => line.text)
      : !connected
        ? ["Reconnecting…"]
        : active
          ? ["Thinking…"]
          : [];
  const presenceMotion = (() => {
    if (!active) return "none" as const;
    return presenceMotionForCategory(projection.activityLines[0]?.category);
  })();
  const presenceMotions = notice
    ? ["none" as const]
    : projection.activityLines.length > 0
      ? projection.activityLines.map((line) => presenceMotionForCategory(line.category))
      : [presenceMotion];

  return (
    <main class={`text-client-shell is-${mode}`}>
      {mode === "terminal" ? (
        <TerminalCanvas
          lines={terminalLines}
          value={terminalDraft}
          onValueChange={updateTerminalDraft}
          onSubmit={() => void submitTerminal()}
          prompt={`${username || "user"}@gsv $`}
          busy={terminalCommand.isPending}
          disabled={!connected}
          autoFocus
        />
      ) : (
        <div class="text-client-conversation">
          <MomentRail
            items={[
              ...moments.map((moment, index) => ({
                id: moment.key,
                label: `${index + 1} · ${roleLabel(moment.role)}`,
                detail: momentDetail(moment),
                role: moment.role,
                state: moment.error ? "error" as const : moment.streaming ? "streaming" as const : "complete" as const,
              })),
              ...(pendingHil ? [{ id: "approval", label: "Approval", role: "assistant" as const, state: "approval" as const }] : []),
              ...(draftVisible || draft.length > 0 ? [{ id: "draft", label: "Draft", role: "user" as const, state: "draft" as const }] : []),
            ]}
            currentId={pendingHil ? "approval" : draftVisible ? "draft" : selected?.key ?? null}
            onSelect={(key) => {
              if (key === "draft") revealDraft();
              else if (key !== "approval") selectMoment(key);
            }}
            onWheel={onRailWheel}
          />
          <section class="text-client-stage" onWheel={onCanvasWheel}>
            {presenceLines.length > 0 ? (
              <PresenceLane
                primary={presenceLines[0]}
                lines={presenceLines}
                lineMotions={presenceMotions}
                secondary={active && processId ? "CTRL / CMD + . TO STOP" : undefined}
                activity={notice ? "waiting" : active ? "active" : "waiting"}
                motion={presenceMotion}
              />
            ) : null}
            <div class="text-client-canvas">
              {pendingHil && approvalCopy ? (
                <ApprovalPanel
                  action={approvalCopy.action}
                  target={pendingHil.target}
                  detail={approvalCopy.detail}
                  busy={decideHil.isPending}
                  onAllowOnce={() => { sounds.play("send"); decideHil.mutate({ pid: processId, requestId: pendingHil.requestId, decision: "approve" }); }}
                  onAlwaysAllow={() => { sounds.play("send"); decideHil.mutate({ pid: processId, requestId: pendingHil.requestId, decision: "approve", remember: true }); }}
                  onDeny={() => { sounds.play("stop"); decideHil.mutate({ pid: processId, requestId: pendingHil.requestId, decision: "deny" }); }}
                />
              ) : draftVisible ? (
                <form class="text-client-draft" onSubmit={(event) => { event.preventDefault(); void submitDraft(); }}>
                  <textarea
                    ref={composerRef}
                    value={draft}
                    aria-label="Message"
                    placeholder="What are you thinking?"
                    disabled={send.isPending}
                    onInput={(event) => updateDraft(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") { event.preventDefault(); setDraftVisible(false); }
                      if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.isComposing) {
                        event.preventDefault();
                        void submitDraft();
                      }
                    }}
                  />
                  <div><span>Escape keeps this draft</span><button type="submit" disabled={!draft.trim() || send.isPending}>{send.isPending ? "Sending" : "Send"}</button></div>
                </form>
              ) : selected ? (
                <MomentBody key={selected.key} moment={selected} processId={processId} />
              ) : (
                <button type="button" class="text-client-empty" onClick={revealDraft} disabled={spawn.isPending}>
                  {spawn.isPending || processList.isLoading ? "Preparing your conversation…" : "Start typing"}
                </button>
              )}
            </div>
            {edgeIntent ? (
              <div class={`text-client-edge-intent is-${edgeIntent.direction < 0 ? "previous" : "next"}`} aria-hidden="true">
                <span>{edgeIntent.direction < 0 ? "↑  KEEP SCROLLING FOR PREVIOUS" : "KEEP SCROLLING FOR NEXT  ↓"}</span>
                <i><i style={{ transform: `scaleX(${edgeIntent.progress})` }} /></i>
              </div>
            ) : null}
            {!draftVisible && !pendingHil && presenceLines.length === 0 ? (
              <p class="text-client-hint">TYPE ANYWHERE · ENTER SENDS · SHIFT ENTER NEW LINE · SCROLL HISTORY</p>
            ) : null}
          </section>
        </div>
      )}
      <div class="text-client-quiet-actions">
        {mode === "conversation" ? <button type="button" disabled={spawn.isPending} onClick={startNewConversation}>NEW</button> : null}
        <button type="button" onClick={onLock}>LOCK</button>
      </div>
      <button
        type="button"
        class="text-client-mode-toggle"
        onClick={() => { sounds.play("select"); setMode(mode === "conversation" ? "terminal" : "conversation"); }}
      >
        {mode === "conversation" ? "TERMINAL" : "CONVERSATION"}
      </button>
    </main>
  );
}
