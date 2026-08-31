import {
  ARCHITECTURE_EDGES,
  ARCHITECTURE_SOURCE_GUIDES,
  architectureComponent,
  architectureSubsystem,
  type ArchitectureSubsystemId,
} from "./architectureModel";

type ArchitectureInspectorProps = {
  selectedComponentId: string | null;
  selectedSubsystemId: ArchitectureSubsystemId;
  onSelectComponent: (componentId: string | null) => void;
  onSelectSubsystem: (subsystemId: ArchitectureSubsystemId) => void;
};

export function ArchitectureInspector({
  selectedComponentId,
  selectedSubsystemId,
  onSelectComponent,
  onSelectSubsystem,
}: ArchitectureInspectorProps) {
  const subsystem = architectureSubsystem(selectedSubsystemId);
  const component = architectureComponent(selectedSubsystemId, selectedComponentId);
  const connections = ARCHITECTURE_EDGES.filter(
    (edge) => edge.from === selectedSubsystemId || edge.to === selectedSubsystemId,
  );

  return (
    <aside class="architecture-inspector" aria-label={`${subsystem.label} architecture inspector`}>
      <header class="architecture-inspector-head">
        <div>
          <span>{subsystem.category.toUpperCase()} SUBSYSTEM</span>
          <h2>{subsystem.label}</h2>
        </div>
        <strong>{String(subsystem.components.length).padStart(2, "0")}</strong>
      </header>

      <div class="architecture-inspector-scroll">
        <button
          type="button"
          class="architecture-source-root"
          onClick={() => onSelectComponent(null)}
          aria-pressed={component === null}
        >
          <span>ROOT</span>
          <code>gsv:/{subsystem.sourceRoot}</code>
        </button>

        {component ? (
          <section class="architecture-component-detail">
            <div class="architecture-inspector-section-title">
              <span>SELECTED COMPONENT</span>
              <i />
            </div>
            <h3>{component.label}</h3>
            <p>{component.summary}</p>
            <ol>
              {component.mechanics.map((mechanic) => <li key={mechanic}>{mechanic}</li>)}
            </ol>
            <div class="architecture-path-list" aria-label="Component source paths">
              {component.paths.map((path) => <code key={path}>{path}</code>)}
            </div>
          </section>
        ) : (
          <section class="architecture-subsystem-detail">
            <p class="architecture-inspector-summary">{subsystem.summary}</p>
            <div class="architecture-inspector-section-title">
              <span>OWNS</span>
              <i />
            </div>
            <ul class="architecture-owns-list">
              {subsystem.owns.map((responsibility) => <li key={responsibility}>{responsibility}</li>)}
            </ul>
            <div class="architecture-boundary is-boundary">
              <span>BOUNDARY</span>
              <p>{subsystem.boundary}</p>
            </div>
            <div class="architecture-boundary is-invariant">
              <span>INVARIANT</span>
              <p>{subsystem.invariant}</p>
            </div>
          </section>
        )}

        <section class="architecture-component-index">
          <div class="architecture-inspector-section-title">
            <span>COMPONENT INDEX</span>
            <i />
          </div>
          <div role="list">
            {subsystem.components.map((candidate, index) => (
              <button
                key={candidate.id}
                type="button"
                class={candidate.id === selectedComponentId ? "is-active" : ""}
                aria-pressed={candidate.id === selectedComponentId}
                onClick={() => onSelectComponent(candidate.id)}
              >
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{candidate.label}</strong>
                <small>{candidate.paths[0]}</small>
              </button>
            ))}
          </div>
        </section>

        <section class="architecture-connections">
          <div class="architecture-inspector-section-title">
            <span>CONNECTED ROUTES</span>
            <i />
          </div>
          <div role="list">
            {connections.map((edge) => {
              const outbound = edge.from === selectedSubsystemId;
              const peerId = outbound ? edge.to : edge.from;
              const peer = architectureSubsystem(peerId);
              return (
                <button key={edge.id} type="button" onClick={() => onSelectSubsystem(peerId)}>
                  <span>{outbound ? "OUT" : "IN"}</span>
                  <strong>{peer.shortLabel}</strong>
                  <small>{edge.label}</small>
                </button>
              );
            })}
          </div>
        </section>

        <details class="architecture-source-guides">
          <summary>SOURCE GUIDES · {ARCHITECTURE_SOURCE_GUIDES.length}</summary>
          <div>
            {ARCHITECTURE_SOURCE_GUIDES.map((path) => <code key={path}>{path}</code>)}
          </div>
        </details>
      </div>
    </aside>
  );
}
