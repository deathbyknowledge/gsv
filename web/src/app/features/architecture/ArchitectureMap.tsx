import type { JSX } from "preact";
import { useMemo, useRef, useState } from "preact/hooks";
import {
  ARCHITECTURE_EDGES,
  ARCHITECTURE_SUBSYSTEMS,
  type ArchitectureCategory,
  type ArchitectureFlow,
  type ArchitectureSubsystemId,
} from "./architectureModel";

type ArchitectureMapProps = {
  activeFlow: ArchitectureFlow;
  activeFlowStep: number;
  matchedSubsystems: ReadonlySet<ArchitectureSubsystemId> | null;
  selectedSubsystemId: ArchitectureSubsystemId;
  onSelectSubsystem: (id: ArchitectureSubsystemId) => void;
};

type NodeStyle = JSX.CSSProperties & {
  "--architecture-node-color": string;
  "--architecture-node-depth": string;
  "--architecture-node-height": string;
  "--architecture-node-size": string;
};

const CATEGORY_COLORS: Record<ArchitectureCategory, string> = {
  edge: "#63ddff",
  control: "#c4a7ff",
  execution: "#ffd264",
  record: "#64f0c2",
  contract: "#8faeff",
  target: "#73e6a8",
  provider: "#ff91c8",
  client: "#b9b4ff",
  service: "#ffb36b",
  transport: "#ff8b8b",
  storage: "#77e3d4",
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function connectedPair(left: ArchitectureSubsystemId, right: ArchitectureSubsystemId): string {
  return [left, right].sort().join(":");
}

export function ArchitectureMap({
  activeFlow,
  activeFlowStep,
  matchedSubsystems,
  selectedSubsystemId,
  onSelectSubsystem,
}: ArchitectureMapProps) {
  const [rotation, setRotation] = useState(-32);
  const [tilt, setTilt] = useState(57);
  const [zoom, setZoom] = useState(0.92);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    rotation: number;
    tilt: number;
  } | null>(null);

  const flowSubsystems = useMemo(
    () => new Set(activeFlow.steps.map((step) => step.subsystemId)),
    [activeFlow],
  );
  const activeSubsystemId = activeFlow.steps[activeFlowStep]?.subsystemId ?? null;
  const flowPairs = useMemo(() => {
    const pairs = new Set<string>();
    for (let index = 1; index < activeFlow.steps.length; index += 1) {
      pairs.add(connectedPair(
        activeFlow.steps[index - 1].subsystemId,
        activeFlow.steps[index].subsystemId,
      ));
    }
    return pairs;
  }, [activeFlow]);
  const activePair = activeFlowStep > 0
    ? connectedPair(
        activeFlow.steps[activeFlowStep - 1].subsystemId,
        activeFlow.steps[activeFlowStep].subsystemId,
      )
    : null;

  const resetCamera = (): void => {
    setRotation(-32);
    setTilt(57);
    setZoom(0.92);
  };

  const handlePointerDown = (event: JSX.TargetedPointerEvent<HTMLDivElement>): void => {
    if ((event.target as HTMLElement).closest("button")) {
      return;
    }
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      rotation,
      tilt,
    };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: JSX.TargetedPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    setRotation(drag.rotation + (event.clientX - drag.startX) * 0.22);
    setTilt(clamp(drag.tilt - (event.clientY - drag.startY) * 0.16, 38, 72));
  };

  const endPointerDrag = (event: JSX.TargetedPointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) {
      return;
    }
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleWheel = (event: JSX.TargetedWheelEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setZoom((current) => clamp(current - event.deltaY * 0.0008, 0.62, 1.35));
  };

  return (
    <section class="architecture-map-panel" aria-label="Interactive GSV subsystem map">
      <header class="architecture-map-hud">
        <div>
          <span>GSV://SOURCE/TOPOLOGY</span>
          <strong>{ARCHITECTURE_SUBSYSTEMS.length} SUBSYSTEMS · {ARCHITECTURE_EDGES.length} ROUTES</strong>
        </div>
        <p>DRAG TO ORBIT · SCROLL TO ZOOM</p>
      </header>

      <div
        class={`architecture-map-viewport${dragging ? " is-dragging" : ""}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endPointerDrag}
        onPointerCancel={endPointerDrag}
        onLostPointerCapture={() => {
          dragRef.current = null;
          setDragging(false);
        }}
        onWheel={handleWheel}
      >
        <div class="architecture-map-stars" aria-hidden="true" />
        <div class="architecture-map-scan" aria-hidden="true" />
        <div
          class="architecture-map-world"
          style={{ transform: `rotateX(${tilt}deg) rotateZ(${rotation}deg) scale(${zoom})` }}
        >
          <div class="architecture-map-grid" aria-hidden="true" />
          <svg
            class="architecture-map-routes"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <defs>
              <filter id="architecture-route-glow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="0.38" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            {ARCHITECTURE_EDGES.map((edge) => {
              const from = ARCHITECTURE_SUBSYSTEMS.find((subsystem) => subsystem.id === edge.from)!;
              const to = ARCHITECTURE_SUBSYSTEMS.find((subsystem) => subsystem.id === edge.to)!;
              const pair = connectedPair(edge.from, edge.to);
              const inFlow = flowPairs.has(pair);
              const isActive = activePair === pair;
              return (
                <line
                  key={edge.id}
                  class={`architecture-map-route is-${edge.kind}${inFlow ? " is-flow" : ""}${isActive ? " is-active" : ""}`}
                  x1={from.position.x}
                  y1={from.position.y}
                  x2={to.position.x}
                  y2={to.position.y}
                />
              );
            })}
          </svg>

          {ARCHITECTURE_SUBSYSTEMS.map((subsystem, index) => {
            const selected = subsystem.id === selectedSubsystemId;
            const active = subsystem.id === activeSubsystemId;
            const inFlow = flowSubsystems.has(subsystem.id);
            const matched = matchedSubsystems === null || matchedSubsystems.has(subsystem.id);
            const size = clamp(60 + subsystem.components.length * 4, 68, 92);
            const style: NodeStyle = {
              left: `${subsystem.position.x}%`,
              top: `${subsystem.position.y}%`,
              "--architecture-node-color": CATEGORY_COLORS[subsystem.category],
              "--architecture-node-depth": `${Math.round(size * 0.62)}px`,
              "--architecture-node-height": `${subsystem.position.height}px`,
              "--architecture-node-size": `${size}px`,
            };
            return (
              <button
                key={subsystem.id}
                type="button"
                class={`architecture-map-node${selected ? " is-selected" : ""}${active ? " is-active" : ""}${inFlow ? " is-flow" : ""}${matched ? "" : " is-search-dimmed"}`}
                style={style}
                aria-pressed={selected}
                aria-label={`${subsystem.label}, ${subsystem.components.length} components, ${subsystem.sourceRoot}`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => onSelectSubsystem(subsystem.id)}
              >
                <span class="architecture-map-node-shadow" aria-hidden="true" />
                <span class="architecture-map-node-block" aria-hidden="true">
                  <i>{String(index + 1).padStart(2, "0")}</i>
                </span>
                <span
                  class="architecture-map-node-label"
                  style={{
                    transform: `translate(-50%, -100%) translateZ(${subsystem.position.height + 18}px) rotateZ(${-rotation}deg) rotateX(${-tilt}deg)`,
                  }}
                >
                  <strong>{subsystem.shortLabel}</strong>
                  <small>{subsystem.sourceRoot}</small>
                  <em>{subsystem.components.length} COMPONENTS</em>
                </span>
                <span class="architecture-map-node-pulse" aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </div>

      <div class="architecture-map-controls" aria-label="Map view controls">
        <button type="button" onClick={() => setRotation((value) => value - 12)} aria-label="Rotate map left">↶</button>
        <button type="button" onClick={() => setRotation((value) => value + 12)} aria-label="Rotate map right">↷</button>
        <button type="button" onClick={() => setTilt((value) => clamp(value - 6, 38, 72))} aria-label="Lower map tilt">−°</button>
        <button type="button" onClick={() => setTilt((value) => clamp(value + 6, 38, 72))} aria-label="Raise map tilt">+°</button>
        <button type="button" onClick={() => setZoom((value) => clamp(value - 0.1, 0.62, 1.35))} aria-label="Zoom out">−</button>
        <button type="button" onClick={() => setZoom((value) => clamp(value + 0.1, 0.62, 1.35))} aria-label="Zoom in">+</button>
        <button type="button" class="architecture-map-reset" onClick={resetCamera}>RESET VIEW</button>
      </div>

      <div class="architecture-map-legend" aria-label="Subsystem category legend">
        {(["edge", "control", "execution", "record", "contract", "target", "provider", "client", "service", "transport", "storage"] as const).map((category) => (
          <span key={category} style={{ "--architecture-legend-color": CATEGORY_COLORS[category] } as JSX.CSSProperties}>
            {category}
          </span>
        ))}
      </div>
    </section>
  );
}
