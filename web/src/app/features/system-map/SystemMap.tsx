import type { JSX } from "preact";
import type { Dispatch, StateUpdater } from "preact/hooks";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  projectSystemMapPoint,
  renderSystemMapCanvas,
  type SystemMapCanvasCamera,
} from "./systemMapCanvas";
import "./systemMap.css";

type SystemMapNodeKind = "root" | "category" | "object" | "app";
type SystemMapStatus = "online" | "offline" | "warning" | "busy" | "neutral";
type SystemMapSelection = "root" | "machines" | "messengers" | "integrations" | null;

type SystemMapNode = {
  id: string;
  label: string;
  kind: SystemMapNodeKind;
  icon: "ship" | "machine" | "messenger" | "integration" | "plus";
  x: number;
  y: number;
  status?: SystemMapStatus;
  note?: string;
};

type SystemMapApp = {
  id: string;
  label: string;
};

type SystemMapLink = {
  id: string;
  from: Pick<SystemMapNode, "x" | "y">;
  to: Pick<SystemMapNode, "x" | "y">;
};

type ViewportSize = {
  width: number;
  height: number;
};

type MapDragState = {
  pointerId: number;
  startX: number;
  startY: number;
  startCamera: SystemMapCanvasCamera;
  moved: boolean;
};

const INITIAL_CAMERA: SystemMapCanvasCamera = {
  x: 50,
  y: 50,
  zoom: 1,
};

const ROOT_NODE: SystemMapNode = {
  id: "root",
  label: "GSV",
  kind: "root",
  icon: "ship",
  x: 10,
  y: 82,
};

const CATEGORY_NODES: SystemMapNode[] = [
  {
    id: "machines",
    label: "Machines",
    kind: "category",
    icon: "machine",
    x: 36,
    y: 18,
  },
  {
    id: "messengers",
    label: "Messengers",
    kind: "category",
    icon: "messenger",
    x: 70,
    y: 26,
  },
  {
    id: "integrations",
    label: "Integrations",
    kind: "category",
    icon: "integration",
    x: 82,
    y: 62,
  },
];

const DETAIL_NODES: Record<Exclude<SystemMapSelection, "root" | null>, SystemMapNode[]> = {
  machines: [
    {
      id: "machine-main",
      label: "<hank-main>",
      kind: "object",
      icon: "machine",
      status: "online",
      x: 21,
      y: 22,
    },
    {
      id: "machine-linux",
      label: "<hank-linux>",
      kind: "object",
      icon: "machine",
      status: "neutral",
      x: 32,
      y: 14,
    },
    {
      id: "machine-add",
      label: "Add new",
      kind: "object",
      icon: "plus",
      x: 43,
      y: 23,
    },
  ],
  messengers: [
    {
      id: "messenger-whatsapp",
      label: "Whatsapp",
      kind: "object",
      icon: "messenger",
      status: "online",
      x: 59,
      y: 18,
    },
    {
      id: "messenger-telegram",
      label: "Telegram",
      kind: "object",
      icon: "messenger",
      status: "offline",
      note: "Offline",
      x: 73,
      y: 27,
    },
    {
      id: "messenger-discord",
      label: "Discord",
      kind: "object",
      icon: "messenger",
      status: "neutral",
      note: "Not configured",
      x: 69,
      y: 48,
    },
  ],
  integrations: [
    {
      id: "integration-github",
      label: "GitHub",
      kind: "object",
      icon: "integration",
      status: "online",
      x: 71,
      y: 54,
    },
    {
      id: "integration-email",
      label: "Email",
      kind: "object",
      icon: "integration",
      status: "warning",
      note: "Review auth",
      x: 88,
      y: 50,
    },
  ],
};

const APP_NODES: SystemMapApp[] = [
  {
    id: "apps",
    label: "Applications",
  },
  {
    id: "files",
    label: "Files",
  },
  {
    id: "terminal",
    label: "Terminal",
  },
  {
    id: "settings",
    label: "Settings",
  },
];

function baseLinks(): SystemMapLink[] {
  return CATEGORY_NODES.map((node) => ({
    id: `root-${node.id}`,
    from: ROOT_NODE,
    to: node,
  }));
}

function detailLinks(selection: SystemMapSelection): SystemMapLink[] {
  if (!selection || selection === "root") {
    return [];
  }

  const category = CATEGORY_NODES.find((node) => node.id === selection);
  if (!category) {
    return [];
  }

  return DETAIL_NODES[selection].map((node) => ({
    id: `${selection}-${node.id}`,
    from: category,
    to: node,
  }));
}

function MapNode({
  node,
  selected,
  position,
  onSelect,
}: {
  node: SystemMapNode;
  selected: boolean;
  position: { x: number; y: number };
  onSelect: (node: SystemMapNode) => void;
}) {
  return (
    <button
      type="button"
      class={`system-map-node system-map-node-${node.kind}${selected ? " is-selected" : ""}`}
      data-node-id={node.id}
      data-status={node.status ?? "none"}
      style={{ left: `${position.x}px`, top: `${position.y}px` }}
      aria-label={node.note ? `${node.label}: ${node.note}` : node.label}
      aria-pressed={selected}
      onClick={() => onSelect(node)}
    >
      <span class="system-map-hit-label">{node.label}</span>
    </button>
  );
}

function useSystemMapRaster(
  canvasRef: { current: HTMLCanvasElement | null },
  nodes: SystemMapNode[],
  links: SystemMapLink[],
  canvasSelection: string,
  camera: SystemMapCanvasCamera,
  setViewportSize: Dispatch<StateUpdater<ViewportSize>>,
): void {
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");

    if (!canvas || !context) {
      return undefined;
    }

    let frame = 0;
    let observer: ResizeObserver | undefined;

    const paint = (): void => {
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(420, Math.round(rect.width));
      const height = Math.max(300, Math.round(rect.height));
      const cssWidth = Math.round(rect.width);
      const cssHeight = Math.round(rect.height);

      setViewportSize((current) => (
        current.width === cssWidth && current.height === cssHeight
          ? current
          : { width: cssWidth, height: cssHeight }
      ));

      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      renderSystemMapCanvas(context, width, height, {
        nodes,
        links,
        selection: canvasSelection,
        camera,
        time: 0,
      });
    };

    const schedulePaint = (): void => {
      if (frame) {
        window.cancelAnimationFrame(frame);
      }

      frame = window.requestAnimationFrame(() => {
        paint();
        frame = 0;
      });
    };

    if ("ResizeObserver" in window) {
      observer = new ResizeObserver(schedulePaint);
      observer.observe(canvas);
    }

    schedulePaint();

    return () => {
      observer?.disconnect();

      if (frame) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [camera, canvasRef, canvasSelection, links, nodes, setViewportSize]);
}

function clampCamera(camera: SystemMapCanvasCamera): SystemMapCanvasCamera {
  return {
    x: Math.max(-20, Math.min(120, camera.x)),
    y: Math.max(-20, Math.min(120, camera.y)),
    zoom: Math.max(0.65, Math.min(2.6, camera.zoom)),
  };
}

function AssistantPanel({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <section class={`system-assistant${open ? " is-open" : ""}`} aria-label="Assistant">
      <button type="button" class="system-assistant-summary" onClick={onToggle} aria-expanded={open}>
        <span class="system-assistant-copy">
          <strong>Xanadu</strong>
          <small>NEMOTRON 3 / 2 tasks running</small>
        </span>
      </button>
      <div class="system-assistant-panel" hidden={!open}>
        <header class="system-assistant-header">
          <div>
            <strong>Xanadu</strong>
            <p>NEMOTRON 3 / reasoning low</p>
            <em>creating crew member</em>
          </div>
          <button type="button" onClick={onToggle} aria-label="Collapse assistant">Close</button>
        </header>
        <div class="system-assistant-meters" aria-label="Assistant status">
          <span><strong>context</strong><em>50%</em></span>
          <span><strong>signal</strong><em>nominal</em></span>
          <span><strong>cost</strong><em>0.04$</em></span>
        </div>
        <div class="system-assistant-feed" aria-live="polite">
          <p><span>SYS</span> ready to work with the selected system context.</p>
          <p><span>TASK</span> creating crew member / updating contacts</p>
        </div>
        <form class="system-assistant-composer" onSubmit={(event) => event.preventDefault()}>
          <button type="button" aria-label="Attach file">+</button>
          <input type="text" aria-label="Message Xanadu" />
          <button type="button" aria-label="Send message">Send</button>
        </form>
      </div>
    </section>
  );
}

export function SystemMap() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<MapDragState | null>(null);
  const ignoreNextClickRef = useRef(false);
  const [selection, setSelection] = useState<SystemMapSelection>(null);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [camera, setCamera] = useState<SystemMapCanvasCamera>(INITIAL_CAMERA);
  const [viewportSize, setViewportSize] = useState<ViewportSize>({ width: 0, height: 0 });
  const [dragging, setDragging] = useState(false);
  const links = useMemo(() => [...baseLinks(), ...detailLinks(selection)], [selection]);
  const detailNodes = useMemo(
    () => selection && selection !== "root" ? DETAIL_NODES[selection] : [],
    [selection],
  );
  const mapNodes = useMemo(
    () => [ROOT_NODE, ...CATEGORY_NODES, ...detailNodes],
    [detailNodes],
  );
  const activeNode = useMemo(
    () => mapNodes.find((node) => node.id === activeNodeId) ?? null,
    [activeNodeId, mapNodes],
  );
  const canvasSelection = activeNodeId ?? selection ?? "overview";
  const selectionLabel = activeNode
    ? activeNode.label.toUpperCase()
    : selection
      ? selection.toUpperCase()
      : "SYSTEM";

  useSystemMapRaster(canvasRef, mapNodes, links, canvasSelection, camera, setViewportSize);

  const nodePositions = useMemo(() => {
    const positions = new Map<string, { x: number; y: number }>();

    if (viewportSize.width === 0 || viewportSize.height === 0) {
      return positions;
    }

    mapNodes.forEach((node) => {
      const [x, y] = projectSystemMapPoint(node, viewportSize.width, viewportSize.height, camera);
      positions.set(node.id, { x, y });
    });

    return positions;
  }, [camera, mapNodes, viewportSize]);

  const handlePointerDown = useCallback((event: JSX.TargetedPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || viewportSize.width === 0 || viewportSize.height === 0) {
      return;
    }

    if (event.target instanceof Element && event.target.closest(".system-map-node")) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startCamera: camera,
      moved: false,
    };
    setDragging(true);
  }, [camera, viewportSize]);

  const handlePointerMove = useCallback((event: JSX.TargetedPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;

    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;

    if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
      drag.moved = true;
    }

    setCamera(clampCamera({
      x: drag.startCamera.x - (deltaX * 100) / (viewportSize.width * drag.startCamera.zoom),
      y: drag.startCamera.y - (deltaY * 100) / (viewportSize.height * drag.startCamera.zoom),
      zoom: drag.startCamera.zoom,
    }));
  }, [viewportSize]);

  const handlePointerUp = useCallback((event: JSX.TargetedPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;

    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    if (drag.moved) {
      ignoreNextClickRef.current = true;
      window.setTimeout(() => {
        ignoreNextClickRef.current = false;
      }, 0);
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    dragRef.current = null;
    setDragging(false);
  }, []);

  const handleWheel = useCallback((event: JSX.TargetedWheelEvent<HTMLDivElement>): void => {
    if (viewportSize.width === 0 || viewportSize.height === 0) {
      return;
    }

    event.preventDefault();

    const rect = event.currentTarget.getBoundingClientRect();
    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;
    const localX = (screenX / viewportSize.width) * 100 - 50;
    const localY = (screenY / viewportSize.height) * 100 - 50;

    setCamera((current) => {
      const nextZoom = Math.max(0.65, Math.min(2.6, current.zoom * Math.exp(-event.deltaY * 0.0012)));
      const worldX = current.x + localX / current.zoom;
      const worldY = current.y + localY / current.zoom;

      return clampCamera({
        x: worldX - localX / nextZoom,
        y: worldY - localY / nextZoom,
        zoom: nextZoom,
      });
    });
  }, [viewportSize]);

  const selectNode = (node: SystemMapNode): void => {
    if (ignoreNextClickRef.current) {
      return;
    }

    setActiveNodeId(node.id);

    if (node.id === "root") {
      setSelection((current) => current === "root" ? null : "root");
      return;
    }

    if (node.kind === "category") {
      setSelection((current) => current === node.id ? null : node.id as SystemMapSelection);
    }
  };

  return (
    <section class={`system-map${assistantOpen ? " is-assistant-open" : ""}${dragging ? " is-dragging" : ""}`} data-selection={selection ?? "overview"} aria-label="System map">
      <div class="system-map-backdrop" aria-hidden="true" />
      <div class="system-map-hud system-map-hud-primary" aria-hidden="true">
        <strong>GSV SYSTEM MAP</strong>
        <span>{selectionLabel}</span>
        <small>link 07 / active scan</small>
      </div>
      <div class="system-map-hud system-map-hud-secondary" aria-hidden="true">
        <span>nodes {CATEGORY_NODES.length + detailNodes.length + 1}</span>
        <span>runtime native</span>
      </div>
      <div
        class="system-map-canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onWheel={handleWheel}
      >
        <canvas ref={canvasRef} class="system-map-raster" aria-hidden="true" />
        <div class="system-map-hit-layer">
          <MapNode
            node={ROOT_NODE}
            selected={activeNodeId === ROOT_NODE.id}
            position={nodePositions.get(ROOT_NODE.id) ?? { x: 0, y: 0 }}
            onSelect={selectNode}
          />
          {CATEGORY_NODES.map((node) => (
            <MapNode
              key={node.id}
              node={node}
              selected={activeNodeId === node.id}
              position={nodePositions.get(node.id) ?? { x: 0, y: 0 }}
              onSelect={selectNode}
            />
          ))}
          {detailNodes.map((node) => (
            <MapNode
              key={node.id}
              node={node}
              selected={activeNodeId === node.id}
              position={nodePositions.get(node.id) ?? { x: 0, y: 0 }}
              onSelect={selectNode}
            />
          ))}
        </div>
      </div>
      <div class="system-map-app-shelf" hidden={selection !== "root"}>
        {APP_NODES.map((node) => (
          <button type="button" class="system-map-app" key={node.id}>
            {node.label}
          </button>
        ))}
      </div>
      <AssistantPanel open={assistantOpen} onToggle={() => setAssistantOpen((open) => !open)} />
    </section>
  );
}
