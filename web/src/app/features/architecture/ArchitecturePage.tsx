import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ArchitectureInspector } from "./ArchitectureInspector";
import { ArchitectureMap } from "./ArchitectureMap";
import {
  ARCHITECTURE_FLOWS,
  ARCHITECTURE_SUBSYSTEMS,
  architectureSubsystem,
  searchArchitecture,
  type ArchitectureFlow,
  type ArchitectureFlowStep,
  type ArchitectureSearchResult,
  type ArchitectureSubsystemId,
} from "./architectureModel";
import "./ArchitecturePage.css";

function totalComponents(): number {
  return ARCHITECTURE_SUBSYSTEMS.reduce(
    (total, subsystem) => total + subsystem.components.length,
    0,
  );
}

type ArchitectureFlowConsoleProps = {
  activeFlow: ArchitectureFlow;
  activeStepIndex: number;
  onSelectFlow: (flowId: string) => void;
  onSelectStep: (stepIndex: number) => void;
};

function ArchitectureFlowConsole({
  activeFlow,
  activeStepIndex,
  onSelectFlow,
  onSelectStep,
}: ArchitectureFlowConsoleProps) {
  const step = activeFlow.steps[activeStepIndex];

  return (
    <section class="architecture-flow-console" aria-label="Guided architecture flow">
      <header>
        <div>
          <span>TRACE MODE</span>
          <select
            value={activeFlow.id}
            aria-label="Select an architecture flow"
            onChange={(event) => onSelectFlow(event.currentTarget.value)}
          >
            {ARCHITECTURE_FLOWS.map((flow) => <option key={flow.id} value={flow.id}>{flow.label}</option>)}
          </select>
        </div>
        <p>{activeFlow.summary}</p>
      </header>

      <div class="architecture-flow-current" aria-live="polite">
        <strong>{String(activeStepIndex + 1).padStart(2, "0")}</strong>
        <div>
          <span>{architectureSubsystem(step.subsystemId).shortLabel}</span>
          <h3>{step.label}</h3>
          <p>{step.detail}</p>
        </div>
        <nav aria-label="Flow step controls">
          <button
            type="button"
            disabled={activeStepIndex === 0}
            onClick={() => onSelectStep(activeStepIndex - 1)}
          >
            ← PREV
          </button>
          <button
            type="button"
            disabled={activeStepIndex === activeFlow.steps.length - 1}
            onClick={() => onSelectStep(activeStepIndex + 1)}
          >
            NEXT →
          </button>
        </nav>
      </div>

      <div class="architecture-flow-track" role="list" aria-label={`${activeFlow.label} steps`}>
        {activeFlow.steps.map((candidate, index) => (
          <button
            key={`${candidate.subsystemId}:${candidate.componentId ?? "root"}:${index}`}
            type="button"
            class={index === activeStepIndex ? "is-active" : index < activeStepIndex ? "is-complete" : ""}
            aria-current={index === activeStepIndex ? "step" : undefined}
            onClick={() => onSelectStep(index)}
          >
            <i />
            <span>{String(index + 1).padStart(2, "0")}</span>
            <small>{architectureSubsystem(candidate.subsystemId).shortLabel}</small>
          </button>
        ))}
      </div>
    </section>
  );
}

type ArchitectureSearchProps = {
  query: string;
  results: readonly ArchitectureSearchResult[];
  onQueryChange: (query: string) => void;
  onSelectResult: (result: ArchitectureSearchResult) => void;
};

function ArchitectureSearch({
  query,
  results,
  onQueryChange,
  onSelectResult,
}: ArchitectureSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const typing = target?.matches("input, textarea, select, [contenteditable='true']") === true;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
        return;
      }
      if (!typing && event.key === "/") {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  return (
    <div class="architecture-search">
      <label for="architecture-search-input">SEARCH MAP</label>
      <div>
        <span aria-hidden="true">/</span>
        <input
          id="architecture-search-input"
          ref={inputRef}
          type="search"
          value={query}
          placeholder="process, cancellation, path…"
          autocomplete="off"
          onInput={(event) => onQueryChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              onQueryChange("");
            }
          }}
        />
        {query ? (
          <button type="button" aria-label="Clear architecture search" onClick={() => onQueryChange("")}>×</button>
        ) : <kbd>⌘K</kbd>}
      </div>
      {query ? (
        <div class="architecture-search-results" role="listbox" aria-label="Architecture search results">
          {results.length > 0 ? results.map((result) => (
            <button
              key={`${result.subsystemId}:${result.componentId ?? "root"}`}
              type="button"
              role="option"
              aria-selected="false"
              onClick={() => onSelectResult(result)}
            >
              <span>{architectureSubsystem(result.subsystemId).shortLabel}</span>
              <strong>{result.label}</strong>
              <code>{result.path}</code>
            </button>
          )) : (
            <p>NO MATCH IN ARCHITECTURE INDEX</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function stepSelection(step: ArchitectureFlowStep): {
  subsystemId: ArchitectureSubsystemId;
  componentId: string | null;
} {
  return {
    subsystemId: step.subsystemId,
    componentId: step.componentId ?? null,
  };
}

export function ArchitecturePage() {
  const initialFlowStep = ARCHITECTURE_FLOWS[0].steps[0];
  const [selectedSubsystemId, setSelectedSubsystemId] = useState<ArchitectureSubsystemId>(initialFlowStep.subsystemId);
  const [selectedComponentId, setSelectedComponentId] = useState<string | null>(null);
  const [activeFlowId, setActiveFlowId] = useState<string>(ARCHITECTURE_FLOWS[0].id);
  const [activeFlowStep, setActiveFlowStep] = useState(0);
  const [query, setQuery] = useState("");

  const activeFlow = ARCHITECTURE_FLOWS.find((flow) => flow.id === activeFlowId) ?? ARCHITECTURE_FLOWS[0];
  const searchResults = useMemo(() => searchArchitecture(query), [query]);
  const matchedSubsystems = query.trim()
    ? new Set(searchResults.map((result) => result.subsystemId))
    : null;

  const selectSubsystem = (id: ArchitectureSubsystemId): void => {
    setSelectedSubsystemId(id);
    setSelectedComponentId(null);
  };

  const selectSearchResult = (result: ArchitectureSearchResult): void => {
    setSelectedSubsystemId(result.subsystemId);
    setSelectedComponentId(result.componentId ?? null);
    setQuery("");
  };

  const selectFlowStep = (index: number, flow: ArchitectureFlow = activeFlow): void => {
    const nextIndex = Math.min(flow.steps.length - 1, Math.max(0, index));
    const selection = stepSelection(flow.steps[nextIndex]);
    setActiveFlowStep(nextIndex);
    setSelectedSubsystemId(selection.subsystemId);
    setSelectedComponentId(selection.componentId);
  };

  const selectFlow = (flowId: string): void => {
    const flow = ARCHITECTURE_FLOWS.find((candidate) => candidate.id === flowId);
    if (!flow) {
      return;
    }
    setActiveFlowId(flow.id);
    selectFlowStep(0, flow);
  };

  return (
    <div class="architecture-page">
      <header class="architecture-command-bar">
        <div class="architecture-command-title">
          <span>SYSTEM MAP // READ-ONLY</span>
          <h1>GSV ARCHITECTURE</h1>
          <p>Navigate the source as a system: select a tower, inspect its boundary, or trace a request end to end.</p>
        </div>
        <div class="architecture-command-stats" aria-label="Architecture model size">
          <span><strong>{ARCHITECTURE_SUBSYSTEMS.length}</strong> SUBSYSTEMS</span>
          <span><strong>{totalComponents()}</strong> COMPONENTS</span>
          <span><strong>{ARCHITECTURE_FLOWS.length}</strong> GUIDED FLOWS</span>
        </div>
        <ArchitectureSearch
          query={query}
          results={searchResults}
          onQueryChange={setQuery}
          onSelectResult={selectSearchResult}
        />
      </header>

      <div class="architecture-workspace">
        <div class="architecture-map-column">
          <ArchitectureMap
            activeFlow={activeFlow}
            activeFlowStep={activeFlowStep}
            matchedSubsystems={matchedSubsystems}
            selectedSubsystemId={selectedSubsystemId}
            onSelectSubsystem={selectSubsystem}
          />
          <ArchitectureFlowConsole
            activeFlow={activeFlow}
            activeStepIndex={activeFlowStep}
            onSelectFlow={selectFlow}
            onSelectStep={selectFlowStep}
          />
        </div>

        <ArchitectureInspector
          selectedSubsystemId={selectedSubsystemId}
          selectedComponentId={selectedComponentId}
          onSelectSubsystem={selectSubsystem}
          onSelectComponent={setSelectedComponentId}
        />
      </div>
    </div>
  );
}
