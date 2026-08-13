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
import { ChatMediaAttachment } from "../chat/components/ChatMediaAttachment";
import { useTerminalCommandMutation } from "../terminal/hooks/useTerminalQueries";
import { textApprovalCopy } from "./approval";
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
        {moment.media.length > 0 ? (
          <div class="text-client-media">
            {moment.media.map((media, index) => (
              <ChatMediaAttachment key={`${moment.key}:media:${index}`} media={media} processId={processId} />
            ))}
          </div>
        ) : null}
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
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const wheelGestureRef = useRef({ amount: 0, direction: 0, lastAt: 0, latched: false });

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

  const selectMoment = useCallback((key: string) => {
    setSelectedKey(key);
    setFollowingLatest(key === moments[moments.length - 1]?.key);
    setDraftVisible(false);
  }, [moments]);

  const moveMoment = useCallback((direction: -1 | 1) => {
    if (moments.length === 0) return;
    const next = Math.max(0, Math.min(moments.length - 1, selectedIndex + direction));
    selectMoment(moments[next].key);
  }, [moments, selectMoment, selectedIndex]);

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
  }, [draft, processId, runtime, send, spawn]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typingTarget = target?.matches("input, textarea, select, button, a, [role=button], [contenteditable=true]");
      if ((event.metaKey || event.ctrlKey) && event.key === "`") {
        event.preventDefault();
        setMode((current) => current === "conversation" ? "terminal" : "conversation");
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === ".") {
        event.preventDefault();
        if (processId) abort.mutate({ pid: processId, ...(runtime.runtime.activeRunId ? { runId: runtime.runtime.activeRunId } : {}) });
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
        setDraft((current) => `${current}${event.key}`);
        revealDraft();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [abort, mode, moveMoment, processId, revealDraft, runtime.runtime.activeRunId]);

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
    }
    gesture.lastAt = now;
    gesture.direction = direction;
    if (gesture.latched) return;
    gesture.amount += vertical;
    if (longMoment && Math.abs(gesture.amount) < 48) return;
    event.preventDefault();
    gesture.latched = true;
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
      : [connected ? active ? "Thinking…" : "Ready" : "Reconnecting…"];
  const presenceMotion = (() => {
    const category = projection.activityLines[0]?.category;
    if (!active) return "none" as const;
    if (category === "searching-files") return "search" as const;
    if (category === "reading-files") return "read" as const;
    if (category === "writing-files" || category === "editing-files" || category === "deleting-files") return "mutate" as const;
    if (category === "running-commands" || category === "running-code" || category === "using-tools") return "execute" as const;
    return "thinking" as const;
  })();

  return (
    <main class={`text-client-shell is-${mode}`}>
      <header class="text-client-topbar">
        <button type="button" class="text-client-brand" onClick={() => setMode("conversation")}>GSV</button>
        <div class="text-client-topbar-actions">
          <button type="button" onClick={() => setMode(mode === "conversation" ? "terminal" : "conversation")}>
            {mode === "conversation" ? "Terminal" : "Conversation"}
          </button>
          {mode === "conversation" ? <button type="button" onClick={revealDraft}>Write</button> : null}
          {mode === "conversation" ? <button type="button" disabled={spawn.isPending} onClick={startNewConversation}>New</button> : null}
          <a href="/console">Console</a>
          <button type="button" onClick={onLock}>Lock</button>
        </div>
      </header>

      {mode === "terminal" ? (
        <TerminalCanvas
          lines={terminalLines}
          value={terminalDraft}
          onValueChange={setTerminalDraft}
          onSubmit={() => void submitTerminal()}
          prompt={`${username || "user"}@gsv $`}
          busy={terminalCommand.isPending}
          disabled={!connected}
          autoFocus
        />
      ) : (
        <div class="text-client-conversation">
          <MomentRail
            items={moments.map((moment, index) => ({ id: moment.key, label: `${index + 1} · ${roleLabel(moment.role)}`, detail: momentDetail(moment) }))}
            currentId={draftVisible ? null : selected?.key ?? null}
            onSelect={selectMoment}
            onWheel={onRailWheel}
          />
          <section class="text-client-stage" onWheel={onCanvasWheel}>
            <PresenceLane
              primary={presenceLines[0]}
              lines={presenceLines}
              secondary={active && processId ? "Ctrl/Cmd+. to stop" : undefined}
              activity={notice ? "waiting" : active ? "active" : connected ? "idle" : "waiting"}
              motion={presenceMotion}
            />
            <div class="text-client-canvas">
              {pendingHil && approvalCopy ? (
                <ApprovalPanel
                  action={approvalCopy.action}
                  target={pendingHil.target}
                  detail={approvalCopy.detail}
                  busy={decideHil.isPending}
                  onAllowOnce={() => decideHil.mutate({ pid: processId, requestId: pendingHil.requestId, decision: "approve" })}
                  onAlwaysAllow={() => decideHil.mutate({ pid: processId, requestId: pendingHil.requestId, decision: "approve", remember: true })}
                  onDeny={() => decideHil.mutate({ pid: processId, requestId: pendingHil.requestId, decision: "deny" })}
                />
              ) : draftVisible ? (
                <form class="text-client-draft" onSubmit={(event) => { event.preventDefault(); void submitDraft(); }}>
                  <textarea
                    ref={composerRef}
                    value={draft}
                    aria-label="Message"
                    placeholder="What are you thinking?"
                    disabled={send.isPending}
                    onInput={(event) => setDraft(event.currentTarget.value)}
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
          </section>
        </div>
      )}
    </main>
  );
}
