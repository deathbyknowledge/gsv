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
  icon: "ship" | "machine" | "messenger" | "integration" | "app" | "files" | "terminal" | "settings" | "plus";
  x: number;
  y: number;
  status?: SystemMapStatus;
  note?: string;
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

const APP_NODES: SystemMapNode[] = [
  {
    id: "apps",
    label: "Applications",
    kind: "app",
    icon: "app",
    x: 0,
    y: 0,
  },
  {
    id: "files",
    label: "Files",
    kind: "app",
    icon: "files",
    x: 0,
    y: 0,
  },
  {
    id: "terminal",
    label: "Terminal",
    kind: "app",
    icon: "terminal",
    x: 0,
    y: 0,
  },
  {
    id: "settings",
    label: "Settings",
    kind: "app",
    icon: "settings",
    x: 0,
    y: 0,
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

function Icon({ icon }: { icon: SystemMapNode["icon"] }) {
  if (icon === "ship") {
    return (
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <path d="M24 4 16 14v17h16V14L24 4Zm-4 12h8v11h-8V16Z" />
        <path d="M13 28 5 37v7h13V31l-5-3Zm22 0-5 3v13h13v-7l-8-9ZM20 36h8v8h-8v-8Z" />
      </svg>
    );
  }

  if (icon === "machine") {
    return (
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <path d="M11 10c0-3 2-5 5-5h16c3 0 5 2 5 5v13H11V10Zm0 18h26v10H11V28Zm6 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm15 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z" />
      </svg>
    );
  }

  if (icon === "messenger") {
    return (
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <path d="M10 8h28c3 0 5 2 5 5v17c0 3-2 5-5 5H24l-11 8v-8h-3c-3 0-5-2-5-5V13c0-3 2-5 5-5Z" />
      </svg>
    );
  }

  if (icon === "integration") {
    return (
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <path d="M18 31a9 9 0 0 1 0-13l5-5a9 9 0 0 1 13 13l-3 3-5-5 3-3a2 2 0 0 0-3-3l-5 5a2 2 0 0 0 0 3l1 1-5 5-1-1Z" />
        <path d="M12 35a9 9 0 0 1 0-13l3-3 5 5-3 3a2 2 0 0 0 3 3l5-5a2 2 0 0 0 0-3l-1-1 5-5 1 1a9 9 0 0 1 0 13l-5 5a9 9 0 0 1-13 0Z" />
      </svg>
    );
  }

  if (icon === "files") {
    return (
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <path d="M6 14c0-3 2-5 5-5h11l4 5h11c3 0 5 2 5 5v18c0 3-2 5-5 5H11c-3 0-5-2-5-5V14Z" />
      </svg>
    );
  }

  if (icon === "terminal") {
    return (
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <path d="M8 8h32c2 0 4 2 4 4v24c0 2-2 4-4 4H8c-2 0-4-2-4-4V12c0-2 2-4 4-4Zm5 10 6 6-6 6 3 3 9-9-9-9-3 3Zm15 11v4h10v-4H28Z" />
      </svg>
    );
  }

  if (icon === "settings") {
    return (
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <path d="m27 4 2 6 6 2 5-3 4 7-5 4 1 4-1 4 5 4-4 7-5-3-6 2-2 6h-8l-2-6-6-2-5 3-4-7 5-4-1-4 1-4-5-4 4-7 5 3 6-2 2-6h8Zm-4 15a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z" />
      </svg>
    );
  }

  if (icon === "plus") {
    return (
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <path d="M20 6h8v14h14v8H28v14h-8V28H6v-8h14V6Z" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <path d="m24 4 5 14h15l-12 9 5 15-13-9-13 9 5-15-12-9h15l5-14Z" />
    </svg>
  );
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
        <span class="system-assistant-avatar" aria-hidden="true">
          <Icon icon="app" />
        </span>
        <span class="system-assistant-copy">
          <strong>Xanadu</strong>
          <small>NEMOTRON 3 / 2 tasks running</small>
        </span>
        <span class="system-assistant-signal" aria-hidden="true">LINK</span>
      </button>
      <div class="system-assistant-panel" hidden={!open}>
        <header class="system-assistant-header">
          <span class="system-assistant-avatar" aria-hidden="true">
            <Icon icon="app" />
          </span>
          <div>
            <strong>Xanadu</strong>
            <p>NEMOTRON 3 / reasoning low</p>
            <em>creating crew member</em>
          </div>
          <button type="button" onClick={onToggle} aria-label="Collapse assistant">MIN</button>
        </header>
        <div class="system-assistant-meters" aria-label="Assistant status">
          <span>context 50%</span>
          <span>signal nominal</span>
          <span>cost 0.04$</span>
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
            <span class="system-map-icon">
              <Icon icon={node.icon} />
            </span>
            <span>{node.label}</span>
          </button>
        ))}
      </div>
      <AssistantPanel open={assistantOpen} onToggle={() => setAssistantOpen((open) => !open)} />
    </section>
  );
}
