import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { useQuery, useQueryClient } from "@tanstack/preact-query";
import type { KnowledgeContext } from "@humansandmachines/gsv/protocol";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { loadConsoleProcesses } from "../../../services/system/consoleService";
import { chooseWorkspace, loadKnowledgeContext, workspaceSources, type WorkspaceComposition, type WorkspaceObservation, type WorkspaceSource } from "../../../services/workspace/workspaceService";
import { INSTRUMENT_MEMORY_KEY, INSTRUMENT_PROCESSES_KEY } from "../wire/queryKeys";
import type { MemoryPageRef } from "../shared/navigation";
import type { FleetReference } from "../fleet/fleetModel";
import { ProcessInspector } from "../fleet/Fleet";
import { FileReader } from "../fleet/FileReader";
import { MemoryArticle } from "../memory/MemoryArticle";
import { ZenMedia } from "../zen/ZenMedia";
import { ZenText } from "../zen/ZenText";
import "./workspace.css";

type Props = {
  enabled: boolean;
  observation: WorkspaceObservation | null;
  draftActive: boolean;
  children: (conversationVisible: boolean) => ComponentChildren;
  onMemory: (page: MemoryPageRef) => void;
  onFleet: (reference: FleetReference) => void;
  onShip: () => void;
  onProcess: (pid: string) => void;
};

const INITIAL: WorkspaceComposition = { layout: "focus", sources: ["conversation"] };

export function Workspace({ enabled, observation, draftActive, children, onMemory, onFleet, onShip, onProcess }: Props) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const [knowledge, setKnowledge] = useState<KnowledgeContext | null>(null);
  const [phase, setPhase] = useState("");
  const [error, setError] = useState("");
  const [paused, setPaused] = useState(false);
  const [composition, setComposition] = useState<WorkspaceComposition>(INITIAL);
  const [pinned, setPinned] = useState<WorkspaceSource[]>([]);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [retry, setRetry] = useState(0);
  const selectionEpoch = useRef(0);
  const selectionRequest = useRef<AbortController | null>(null);
  const takeControl = () => { selectionEpoch.current += 1; selectionRequest.current?.abort(); };
  const latest = useRef(observation);
  latest.current = observation;
  const currentComposition = useRef(composition);
  currentComposition.current = composition;
  const processes = useQuery({ queryKey: INSTRUMENT_PROCESSES_KEY, queryFn: () => loadConsoleProcesses(client), enabled: enabled && connected });
  const messageKey = observation ? `${observation.conversationId}:${observation.sequence}` : "";

  useEffect(() => {
    setDismissed([]);
    if (!enabled) { setComposition(INITIAL); setKnowledge(null); setPinned([]); }
  }, [enabled, messageKey]);

  useEffect(() => {
    const source = latest.current;
    if (!enabled || !connected || !source) return;
    const controller = new AbortController();
    setPhase("Finding connections");
    setError("");
    setKnowledge(null);
    void (async () => {
      try {
        const found = await loadKnowledgeContext(client, source, false, controller.signal);
        if (controller.signal.aborted) return;
        setKnowledge(found);
        if (!found.enriched && found.mentions.some((mention) => mention.status === "pending")) {
          setPhase("Adding knowledge notes");
          const enriched = await loadKnowledgeContext(client, source, true, controller.signal);
          if (controller.signal.aborted) return;
          setKnowledge(enriched);
          void cache.invalidateQueries({ queryKey: INSTRUMENT_MEMORY_KEY });
        }
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Knowledge context is unavailable");
      } finally {
        if (!controller.signal.aborted) setPhase("");
      }
    })();
    return () => controller.abort();
  }, [cache, client, connected, enabled, messageKey, retry]);

  const sources = useMemo(() => {
    const available = workspaceSources(observation, knowledge, processes.data ?? []);
    const byId = new Map([...pinned, ...available].map((source) => [source.id, source]));
    return [...byId.values()].filter((source) => !dismissed.includes(source.id));
  }, [observation, knowledge, processes.data, pinned, dismissed]);
  const sourceSignature = JSON.stringify(sources.map((source) => ({ id: source.id,
    detail: source.kind === "process" ? `${source.process.state}:${source.process.activeRunId}` : source.kind === "memory" ? source.excerpt : "" })));
  const latestSources = useRef(sources);
  latestSources.current = sources;
  const selectionKey = JSON.stringify([enabled, connected, paused, draftActive, messageKey, sourceSignature]);
  const liveSelectionKey = useRef(selectionKey);
  liveSelectionKey.current = selectionKey;

  useEffect(() => {
    const source = latest.current;
    if (!enabled || !connected || paused || draftActive || !source) return;
    const controller = new AbortController();
    selectionRequest.current = controller;
    const epoch = selectionEpoch.current;
    const contextKey = liveSelectionKey.current;
    const timer = window.setTimeout(() => {
      void chooseWorkspace(client, latestSources.current, source, pinned.map((value) => value.id), currentComposition.current, controller.signal).then((next) => {
        if (controller.signal.aborted || epoch !== selectionEpoch.current || contextKey !== liveSelectionKey.current) return;
        const focused = document.activeElement;
        if (focused instanceof HTMLElement && (focused.matches("input, textarea, select") || focused.isContentEditable)) return;
        if (window.getSelection()?.toString()) return;
        setComposition(next);
      }).catch((failure) => {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Workspace selection is unavailable");
      });
    }, 450);
    return () => { window.clearTimeout(timer); controller.abort(); if (selectionRequest.current === controller) selectionRequest.current = null; };
  }, [client, connected, enabled, paused, draftActive, messageKey, sourceSignature, pinned, retry]);

  const available = new Map(sources.map((source) => [source.id, source]));
  const selected = composition.sources.filter((id) => available.has(id));
  if (draftActive && !selected.includes("conversation")) selected.unshift("conversation");
  if (!selected.length) selected.push("conversation");
  const conversationVisible = !enabled || selected.includes("conversation");
  const layout = selected.length === 1 ? "focus" : composition.layout === "focus" ? "split" : composition.layout;
  const dismiss = (id: string) => {
    takeControl();
    setDismissed((current) => [...current, id]);
    setPinned((current) => current.filter((source) => source.id !== id));
    setComposition((current) => ({ ...current, sources: current.sources.filter((source) => source !== id) }));
  };
  const pin = (source: WorkspaceSource) => {
    takeControl();
    setPinned((current) => current.some((item) => item.id === source.id)
      ? current.filter((item) => item.id !== source.id) : [...current, source]);
  };
  const focus = (id: string) => {
    takeControl();
    setPaused(true);
    setDismissed((current) => current.filter((source) => source !== id));
    setComposition({ layout: "focus", sources: [id] });
  };

  return <section class={`workspace${enabled ? " is-enabled" : ""}`} aria-label={enabled ? "Workspace" : undefined}>
    {enabled && <>
      <div class="workspace-controls">
        <span class="workspace-label">workspace</span>
        <button type="button" aria-pressed={!paused} onClick={() => { takeControl(); setPaused((current) => !current); }}>{paused ? "resume composition" : "pause composition"}</button>
        <button type="button" onClick={() => focus("conversation")}>conversation</button>
        <button type="button" onClick={onShip}>return to Ship</button>
        <label class="workspace-add">open <select aria-label="Open a workspace source" value="" onChange={(event) => focus(event.currentTarget.value)}>
          <option value="" disabled>source…</option>
          {sources.map((source) => <option key={source.id} value={source.id}>{source.title}</option>)}
        </select></label>
      </div>
      <div class="workspace-context" aria-live="polite">
        {phase && <span class="workspace-status">{phase}</span>}
        {knowledge?.mentions.map((mention) => mention.path
          ? <button key={mention.id} type="button" title={`${mention.kind} · ${mention.status}`} onClick={() => focus(`memory:${knowledge.repo}:${mention.path}`)}>{mention.text}</button>
          : <span key={mention.id} class="workspace-pending" title={mention.status === "pending" ? "Adding a knowledge note" : "Needs more context"}>{mention.text}</span>)}
        {!phase && !knowledge?.mentions.length && !error && <span class="workspace-status">Context follows committed messages.</span>}
        {error && <span class="workspace-error" role="alert">{error} <button type="button" onClick={() => setRetry((value) => value + 1)}>retry</button></span>}
      </div>
    </>}
    <div class={`workspace-grid is-${layout}`} style={{ "--workspace-count": selected.length, "--workspace-support": Math.max(1, selected.length - 1) }}>
      <div class={`workspace-main${selected[0] === "conversation" ? " is-primary" : ""}`} hidden={!conversationVisible} style={{ order: selected.indexOf("conversation") }}>
        {enabled && <PaneHeader title="Conversation" pinned={pinned.some((source) => source.id === "conversation")} onPin={() => pin({ id: "conversation", kind: "conversation", title: "Conversation" })} onFocus={() => focus("conversation")} />}
        <div class="workspace-conversation">{children(conversationVisible)}</div>
      </div>
      {enabled && selected.filter((id) => id !== "conversation").map((id) => {
        const source = available.get(id);
        if (!source) return null;
        return <section key={id} class={`workspace-pane${selected[0] === id ? " is-primary" : ""}`} style={{ order: selected.indexOf(id) }} aria-label={source.title} tabIndex={0}>
          <PaneHeader title={source.title} pinned={pinned.some((item) => item.id === id)} onPin={() => pin(source)} onFocus={() => focus(id)} onClose={() => dismiss(id)} />
          <div class="workspace-pane-body"><WorkspacePane source={source} onMemory={onMemory} onFleet={onFleet} onProcess={onProcess} onClose={() => dismiss(id)} /></div>
        </section>;
      })}
    </div>
  </section>;
}

function PaneHeader({ title, pinned, onPin, onFocus, onClose }: { title: string; pinned: boolean; onPin: () => void; onFocus: () => void; onClose?: () => void }) {
  return <header class="workspace-pane-head"><button type="button" class="workspace-pane-title" onClick={onFocus}>{title}</button>
    <button type="button" aria-pressed={pinned} onClick={onPin}>{pinned ? "unpin" : "pin"}</button>
    {onClose && <button type="button" aria-label={`Close ${title}`} onClick={onClose}>close</button>}
  </header>;
}

function WorkspacePane({ source, onMemory, onFleet, onProcess, onClose }: { source: WorkspaceSource; onMemory: Props["onMemory"]; onFleet: Props["onFleet"]; onProcess: Props["onProcess"]; onClose: () => void }) {
  const { client } = useGateway();
  if (source.kind === "memory") return <KnowledgePane source={source} onMemory={onMemory} />;
  if (source.kind === "file") return <FileReader file={{ target: source.target, path: source.path, name: source.title }} onClose={onClose} onDirtyChange={() => {}} />;
  if (source.kind === "media") return <ZenMedia media={source.media} processId={source.pid} />;
  if (source.kind === "process") return <><ProcessInspector client={client} process={source.process} model={null} cost={null} responsibilities={null} canEditAi={false} now={Date.now()} lines={[]} placeLabelFor={(value) => value} onZen={() => onProcess(source.process.pid)} />
    <button type="button" onClick={() => onFleet(`proc:${source.process.pid}`)}>inspect in Fleet</button></>;
  if (source.kind === "message") return <><ZenText text={source.row.text} markdown={source.row.role !== "user"} progress={null} tick={0} />
    {source.row.media?.map((media, index) => <ZenMedia key={index} media={media} processId={source.pid} />)}</>;
  return null;
}

function KnowledgePane({ source, onMemory }: { source: Extract<WorkspaceSource, { kind: "memory" }>; onMemory: Props["onMemory"] }) {
  const { client, connected } = useGateway();
  const page = useQuery({ queryKey: ["workspace", "page", source.repo, source.path, source.excerpt], enabled: connected,
    queryFn: async () => {
      const value = await client.call("repo.read", { repo: source.repo, path: source.path });
      if (value.kind !== "file" || value.content === null || value.isBinary) throw new Error("This knowledge page is not readable");
      return value.content;
    } });
  const path = `personal/${source.path}`;
  return <>{page.error && <p role="alert">Could not read this page.</p>}
    <MemoryArticle db="personal" fragment="" note={{ path, title: source.title, markdown: page.data ?? source.excerpt ?? "Loading…" }} onOpen={onMemory} />
    <button type="button" class="workspace-open-memory" onClick={() => onMemory({ db: "personal", path })}>open in Memory</button>
  </>;
}
