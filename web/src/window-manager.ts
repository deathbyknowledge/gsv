import type { AppManifest } from "./apps";
import { queuePendingAppOpen, type OpenAppRequest } from "./app-link";
import type { AppInstance, AppRuntimeContext, AppRuntimeRegistry } from "./app-runtime";

type WindowMode = "normal" | "minimized" | "maximized";
type ResizeDirection = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
type SnapTarget = "left" | "right" | "maximize" | null;
type LifecyclePhase = "mount" | "suspend" | "resume" | "terminate";

type PersistedWindow = {
  appId: string;
  route?: string;
  title?: string;
  mode: WindowMode;
  lastVisibleMode: Exclude<WindowMode, "minimized">;
  x: number;
  y: number;
  width: number;
  height: number;
  restoreX: number;
  restoreY: number;
  restoreWidth: number;
  restoreHeight: number;
  zIndex: number;
};

type PersistedLayout = {
  version: 1;
  activeAppId: string | null;
  windows: PersistedWindow[];
};

type AppRuntimeState = {
  instance: AppInstance;
  suspended: boolean;
  crashed: boolean;
};

type WindowRecord = {
  windowId: string;
  app: AppManifest;
  route: string;
  title: string;
  badge: string | null;
  dirty: boolean;
  mode: WindowMode;
  lastVisibleMode: Exclude<WindowMode, "minimized">;
  x: number;
  y: number;
  width: number;
  height: number;
  restoreX: number;
  restoreY: number;
  restoreWidth: number;
  restoreHeight: number;
  zIndex: number;
  node: HTMLElement;
  dragHandleNode: HTMLElement;
  contentNode: HTMLElement;
  runtime: AppRuntimeState | null;
};

type DragState = {
  windowId: string;
  pointerId: number;
  offsetX: number;
  offsetY: number;
  snapTarget: SnapTarget;
};

type ResizeState = {
  windowId: string;
  pointerId: number;
  direction: ResizeDirection;
  handleNode: HTMLElement;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
};

export type WindowSummary = {
  windowId: string;
  appId: string;
  title: string;
  appName: string;
  route: string;
  mode: WindowMode;
  active: boolean;
  badge: string | null;
  dirty: boolean;
  zIndex: number;
};

export type WindowManager = {
  openApp: (app: AppManifest, route?: string, options?: { pendingAppOpenRequest?: OpenAppRequest | null; forceRestart?: boolean; forceNew?: boolean }) => string;
  openAppById: (appId: string, route?: string, options?: { forceRestart?: boolean; forceNew?: boolean }) => string | null;
  focusWindow: (windowId: string) => void;
  restoreWindow: (windowId: string) => void;
  minimizeWindow: (windowId: string) => void;
  maximizeWindow: (windowId: string) => void;
  closeWindow: (windowId: string) => void;
  setAppRegistry: (apps: readonly AppManifest[]) => void;
  setWindowTitle: (windowId: string, title: string | null) => void;
  setWindowBadge: (windowId: string, badge: string | null) => void;
  setWindowDirty: (windowId: string, dirty: boolean) => void;
  listApps: () => AppManifest[];
  listWindows: () => WindowSummary[];
  subscribe: (listener: (summaries: WindowSummary[]) => void) => () => void;
  destroy: () => void;
};

type WindowManagerOptions = {
  layerNode: HTMLElement;
  appRegistry: readonly AppManifest[];
  appRuntime: AppRuntimeRegistry;
};

const WINDOW_MARGIN = 8;
const MIN_WINDOW_WIDTH = 320;
const MIN_WINDOW_HEIGHT = 240;
const WINDOW_START_X = 96;
const WINDOW_START_Y = 92;
const WINDOW_OFFSET_X = 28;
const WINDOW_OFFSET_Y = 22;
const WINDOW_STAGGER_STEPS = 8;
const SNAP_THRESHOLD = 30;
const LAYOUT_STORAGE_KEY = "gsv.desktop.layout.v1";

const blockSelection = (event: Event): void => {
  event.preventDefault();
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return typeof value === "object" && value !== null && "then" in value;
}

function formatRuntimeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown runtime error";
  }
}

function createWindowNode(app: AppManifest, route: string): HTMLElement {
  const container = document.createElement("section");
  container.className = "mock-window managed-window";
  container.setAttribute("role", "dialog");
  container.setAttribute("aria-label", app.name);

  container.innerHTML = `
    <div class="window-titlebar" data-window-drag-handle>
      <div class="window-controls">
        <button type="button" class="dot red" data-window-action="close" aria-label="Close window"></button>
        <button type="button" class="dot amber" data-window-action="minimize" aria-label="Minimize window"></button>
        <button type="button" class="dot green" data-window-action="maximize" aria-label="Maximize or restore window"></button>
      </div>
      <span class="window-title">
        <span data-window-title>${escapeHtml(app.name)}</span>
        <span class="window-dirty-dot" data-window-dirty hidden aria-label="Unsaved changes"></span>
      </span>
      <span class="window-chrome-meta">
        <span class="window-badge" data-window-badge hidden></span>
        <span class="window-meta" data-window-route>${escapeHtml(route)}</span>
      </span>
    </div>

    <div class="window-content" data-window-content></div>

    <div class="window-resize-handle handle-n" data-window-resize="n"></div>
    <div class="window-resize-handle handle-s" data-window-resize="s"></div>
    <div class="window-resize-handle handle-e" data-window-resize="e"></div>
    <div class="window-resize-handle handle-w" data-window-resize="w"></div>
    <div class="window-resize-handle handle-ne" data-window-resize="ne"></div>
    <div class="window-resize-handle handle-nw" data-window-resize="nw"></div>
    <div class="window-resize-handle handle-se" data-window-resize="se"></div>
    <div class="window-resize-handle handle-sw" data-window-resize="sw"></div>
  `;

  return container;
}

function readPersistedLayout(): PersistedLayout | null {
  try {
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<PersistedLayout>;
    if (parsed.version !== 1 || !Array.isArray(parsed.windows)) {
      return null;
    }

    const windows = parsed.windows.filter((item): item is PersistedWindow => {
      return (
        typeof item?.appId === "string" &&
        (item.mode === "normal" || item.mode === "minimized" || item.mode === "maximized") &&
        (item.lastVisibleMode === "normal" || item.lastVisibleMode === "maximized") &&
        typeof item.x === "number" &&
        typeof item.y === "number" &&
        typeof item.width === "number" &&
        typeof item.height === "number" &&
        typeof item.restoreX === "number" &&
        typeof item.restoreY === "number" &&
        typeof item.restoreWidth === "number" &&
        typeof item.restoreHeight === "number" &&
        typeof item.zIndex === "number"
      );
    });

    return {
      version: 1,
      activeAppId: typeof parsed.activeAppId === "string" ? parsed.activeAppId : null,
      windows,
    };
  } catch {
    return null;
  }
}

function writePersistedLayout(layout: PersistedLayout): void {
  try {
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Ignore storage failures and keep runtime behavior.
  }
}

function normalizeChromeText(value: string | null, maxLength = 80): string | null {
  const normalized = value?.trim() ?? "";
  if (!normalized) {
    return null;
  }
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

export function createWindowManager({ layerNode, appRegistry, appRuntime }: WindowManagerOptions): WindowManager {
  const windows = new Map<string, WindowRecord>();
  let appById = new Map(appRegistry.map((app) => [app.id, app]));
  const listeners = new Set<(summaries: WindowSummary[]) => void>();
  const pendingPersistedLayout = readPersistedLayout();

  const snapOverlayNode = document.createElement("div");
  snapOverlayNode.className = "window-snap-overlay";
  snapOverlayNode.hidden = true;
  layerNode.appendChild(snapOverlayNode);

  let dragState: DragState | null = null;
  let resizeState: ResizeState | null = null;
  let activeWindowId: string | null = null;
  let sequence = 0;
  let openCounter = 0;
  let zCounter = 100;
  let restoredPersistedLayout = false;

  const workspaceBounds = () => {
    const rect = layerNode.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      width: Math.max(rect.width, MIN_WINDOW_WIDTH + WINDOW_MARGIN * 2),
      height: Math.max(rect.height, MIN_WINDOW_HEIGHT + WINDOW_MARGIN * 2),
    };
  };

  const fitSizeToWorkspace = (app: AppManifest, width: number, height: number) => {
    const bounds = workspaceBounds();
    const maxWidth = Math.max(bounds.width - WINDOW_MARGIN * 2, 200);
    const maxHeight = Math.max(bounds.height - WINDOW_MARGIN * 2, 180);
    const minWidth = Math.min(Math.max(app.windowDefaults.minWidth, MIN_WINDOW_WIDTH), maxWidth);
    const minHeight = Math.min(Math.max(app.windowDefaults.minHeight, MIN_WINDOW_HEIGHT), maxHeight);

    return {
      width: Math.min(Math.max(width, minWidth), maxWidth),
      height: Math.min(Math.max(height, minHeight), maxHeight),
    };
  };

  const minSizeForWorkspace = (app: AppManifest) => {
    const bounds = workspaceBounds();
    const maxWidth = Math.max(bounds.width - WINDOW_MARGIN * 2, 200);
    const maxHeight = Math.max(bounds.height - WINDOW_MARGIN * 2, 180);
    return {
      width: Math.min(Math.max(app.windowDefaults.minWidth, MIN_WINDOW_WIDTH), maxWidth),
      height: Math.min(Math.max(app.windowDefaults.minHeight, MIN_WINDOW_HEIGHT), maxHeight),
    };
  };

  const clampNormalPosition = (record: WindowRecord): void => {
    const bounds = workspaceBounds();
    const maxX = Math.max(bounds.width - record.width - WINDOW_MARGIN, WINDOW_MARGIN);
    const maxY = Math.max(bounds.height - record.height - WINDOW_MARGIN, WINDOW_MARGIN);

    record.x = clamp(record.x, WINDOW_MARGIN, maxX);
    record.y = clamp(record.y, WINDOW_MARGIN, maxY);
  };

  const applyWindowChrome = (record: WindowRecord): void => {
    const titleNode = record.node.querySelector<HTMLElement>("[data-window-title]");
    const dirtyNode = record.node.querySelector<HTMLElement>("[data-window-dirty]");
    const badgeNode = record.node.querySelector<HTMLElement>("[data-window-badge]");
    const routeNode = record.node.querySelector<HTMLElement>("[data-window-route]");

    if (titleNode) {
      titleNode.textContent = record.title;
    }
    if (dirtyNode) {
      dirtyNode.hidden = !record.dirty;
    }
    if (badgeNode) {
      badgeNode.hidden = !record.badge;
      badgeNode.textContent = record.badge ?? "";
    }
    if (routeNode) {
      routeNode.textContent = record.route;
    }

    record.node.classList.toggle("is-dirty", record.dirty);
    record.node.classList.toggle("has-badge", !!record.badge);
    record.node.setAttribute("aria-label", record.title === record.app.name ? record.app.name : `${record.title} - ${record.app.name}`);
  };

  const applyWindowFrame = (record: WindowRecord): void => {
    applyWindowChrome(record);
    record.node.style.zIndex = String(record.zIndex);
    record.node.classList.toggle("is-active", activeWindowId === record.windowId);

    if (record.mode === "minimized") {
      record.node.hidden = true;
      record.node.style.display = "none";
      return;
    }

    record.node.hidden = false;
    record.node.style.display = "flex";

    if (record.mode === "maximized") {
      const bounds = workspaceBounds();
      record.node.classList.add("is-maximized");
      record.node.style.width = `${bounds.width}px`;
      record.node.style.height = `${bounds.height}px`;
      record.node.style.transform = "translate3d(0px, 0px, 0)";
      return;
    }

    record.node.classList.remove("is-maximized");
    const fitted = fitSizeToWorkspace(record.app, record.width, record.height);
    record.width = fitted.width;
    record.height = fitted.height;
    clampNormalPosition(record);
    record.node.style.width = `${record.width}px`;
    record.node.style.height = `${record.height}px`;
    record.node.style.transform = `translate3d(${record.x}px, ${record.y}px, 0)`;
  };

  const buildSummaries = (): WindowSummary[] => {
    return [...windows.values()]
      .sort((left, right) => left.zIndex - right.zIndex)
      .map((record) => ({
        windowId: record.windowId,
        appId: record.app.id,
        title: record.title,
        appName: record.app.name,
        route: record.route,
        mode: record.mode,
        active: activeWindowId === record.windowId,
        badge: record.badge,
        dirty: record.dirty,
        zIndex: record.zIndex,
      }));
  };

  const persistLayout = (): void => {
    const ordered = [...windows.values()].sort((left, right) => left.zIndex - right.zIndex);
    const activeAppId = activeWindowId ? windows.get(activeWindowId)?.app.id ?? null : null;

    const layout: PersistedLayout = {
      version: 1,
      activeAppId,
      windows: ordered.map((record) => ({
        appId: record.app.id,
        route: record.route,
        title: record.title === record.app.name ? undefined : record.title,
        mode: record.mode,
        lastVisibleMode: record.lastVisibleMode,
        x: record.x,
        y: record.y,
        width: record.width,
        height: record.height,
        restoreX: record.restoreX,
        restoreY: record.restoreY,
        restoreWidth: record.restoreWidth,
        restoreHeight: record.restoreHeight,
        zIndex: record.zIndex,
      })),
    };

    writePersistedLayout(layout);
  };

  const emit = (): void => {
    const summaries = buildSummaries();
    persistLayout();

    for (const listener of listeners) {
      listener(summaries);
    }
  };

  const repaintAll = (): void => {
    for (const record of windows.values()) {
      applyWindowFrame(record);
    }
  };

  const hideSnapOverlay = (): void => {
    snapOverlayNode.hidden = true;
    snapOverlayNode.removeAttribute("data-snap-target");
  };

  const showSnapOverlay = (target: Exclude<SnapTarget, null>): void => {
    const bounds = workspaceBounds();

    let x = 0;
    let y = 0;
    let width = bounds.width;
    let height = bounds.height;

    if (target === "left") {
      width = Math.floor(bounds.width / 2);
    } else if (target === "right") {
      width = Math.floor(bounds.width / 2);
      x = bounds.width - width;
    }

    snapOverlayNode.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    snapOverlayNode.style.width = `${width}px`;
    snapOverlayNode.style.height = `${height}px`;
    snapOverlayNode.dataset.snapTarget = target;
    snapOverlayNode.hidden = false;
  };

  const detectSnapTarget = (clientX: number, clientY: number): SnapTarget => {
    const bounds = workspaceBounds();
    const leftEdge = bounds.left;
    const rightEdge = bounds.left + bounds.width;
    const topEdge = bounds.top;

    if (clientY <= topEdge + SNAP_THRESHOLD) {
      return "maximize";
    }

    if (clientX <= leftEdge + SNAP_THRESHOLD) {
      return "left";
    }

    if (clientX >= rightEdge - SNAP_THRESHOLD) {
      return "right";
    }

    return null;
  };

  const stopResizing = (): void => {
    if (!resizeState) {
      return;
    }

    const record = windows.get(resizeState.windowId);
    if (record && resizeState.handleNode.hasPointerCapture(resizeState.pointerId)) {
      resizeState.handleNode.releasePointerCapture(resizeState.pointerId);
      record.node.classList.remove("resizing");
    }

    resizeState = null;
    document.body.classList.remove("is-dragging-window");
    document.removeEventListener("selectstart", blockSelection);
    window.removeEventListener("dragstart", blockSelection);
  };

  const stopDragging = (): void => {
    if (!dragState) {
      return;
    }

    const record = windows.get(dragState.windowId);
    if (record && record.dragHandleNode.hasPointerCapture(dragState.pointerId)) {
      record.dragHandleNode.releasePointerCapture(dragState.pointerId);
      record.node.classList.remove("dragging");
    }

    dragState = null;
    hideSnapOverlay();
    document.body.classList.remove("is-dragging-window");
    document.removeEventListener("selectstart", blockSelection);
    window.removeEventListener("dragstart", blockSelection);
  };

  const chooseNextActiveWindow = (): void => {
    const candidates = [...windows.values()]
      .filter((record) => record.mode !== "minimized")
      .sort((left, right) => right.zIndex - left.zIndex);

    activeWindowId = candidates[0]?.windowId ?? null;
    repaintAll();
    emit();
  };

  const isCurrentRuntime = (record: WindowRecord, runtime: AppRuntimeState): boolean => {
    return record.runtime === runtime && windows.has(record.windowId);
  };

  const renderCrashFallback = (record: WindowRecord, phase: LifecyclePhase, error: unknown): void => {
    const message = escapeHtml(formatRuntimeError(error));
    record.contentNode.innerHTML = `
      <section class="runtime-crash">
        <p class="eyebrow">App runtime fault</p>
        <h1>${escapeHtml(record.app.name)} crashed</h1>
        <p>The app failed during <code>${phase}</code>.</p>
        <p class="runtime-crash-detail">${message}</p>
        <div class="runtime-crash-actions">
          <button type="button" class="runtime-btn" data-runtime-action="restart">Restart app</button>
          <button type="button" class="runtime-btn" data-runtime-action="close">Close window</button>
        </div>
      </section>
    `;
  };

  const invokeLifecycle = (
    record: WindowRecord,
    runtime: AppRuntimeState,
    phase: LifecyclePhase,
    callback: () => void | Promise<void>,
    onSuccess?: () => void,
  ): void => {
    try {
      const result = callback();
      if (isPromiseLike(result)) {
        void result
          .then(() => {
            if (!isCurrentRuntime(record, runtime)) {
              return;
            }
            onSuccess?.();
          })
          .catch((error) => {
            if (!isCurrentRuntime(record, runtime)) {
              return;
            }
            runtime.crashed = true;
            runtime.suspended = false;
            renderCrashFallback(record, phase, error);
          });
      } else {
        onSuccess?.();
      }
    } catch (error) {
      if (!isCurrentRuntime(record, runtime)) {
        return;
      }
      runtime.crashed = true;
      runtime.suspended = false;
      renderCrashFallback(record, phase, error);
    }
  };

  const detachRuntime = (record: WindowRecord): void => {
    const runtime = record.runtime;
    if (!runtime) {
      return;
    }

    record.runtime = null;

    if (!runtime.instance.terminate) {
      return;
    }

    try {
      const result = runtime.instance.terminate();
      if (isPromiseLike(result)) {
        void result.catch(() => {
          // Ignore terminate errors during teardown.
        });
      }
    } catch {
      // Ignore terminate errors during teardown.
    }
  };

  const attachRuntime = (record: WindowRecord): void => {
    detachRuntime(record);

    const runtime: AppRuntimeState = {
      instance: appRuntime.createInstance(record.app),
      suspended: false,
      crashed: false,
    };

    record.runtime = runtime;
    record.contentNode.innerHTML = "";

    const context: AppRuntimeContext = {
      windowId: record.windowId,
      manifest: record.app,
      route: record.route,
      requestFocus: () => focusWindow(record.windowId),
      setTitle: (title) => setWindowTitle(record.windowId, title),
      setBadge: (badge) => setWindowBadge(record.windowId, badge),
      setDirty: (dirty) => setWindowDirty(record.windowId, dirty),
      requestNewWindow: (route) => openApp(record.app, route ?? record.route, { forceNew: true }),
    };

    invokeLifecycle(
      record,
      runtime,
      "mount",
      () => runtime.instance.mount(record.contentNode, context),
      () => {
        runtime.suspended = false;
      },
    );
  };

  const suspendRuntime = (record: WindowRecord): void => {
    const runtime = record.runtime;
    if (!runtime || runtime.crashed || runtime.suspended) {
      return;
    }

    if (!runtime.instance.suspend) {
      runtime.suspended = true;
      return;
    }

    invokeLifecycle(
      record,
      runtime,
      "suspend",
      () => runtime.instance.suspend?.(),
      () => {
        runtime.suspended = true;
      },
    );
  };

  const resumeRuntime = (record: WindowRecord): void => {
    const runtime = record.runtime;
    if (!runtime) {
      attachRuntime(record);
      return;
    }

    if (runtime.crashed || !runtime.suspended) {
      return;
    }

    if (!runtime.instance.resume) {
      runtime.suspended = false;
      return;
    }

    invokeLifecycle(
      record,
      runtime,
      "resume",
      () => runtime.instance.resume?.(),
      () => {
        runtime.suspended = false;
      },
    );
  };

  const restartRuntime = (record: WindowRecord): void => {
    attachRuntime(record);
    if (record.mode === "minimized") {
      suspendRuntime(record);
    }
  };

  const focusWindow = (windowId: string): void => {
    const record = windows.get(windowId);
    if (!record || record.mode === "minimized") {
      return;
    }

    activeWindowId = windowId;
    record.zIndex = ++zCounter;
    repaintAll();
    emit();
  };

  const closeWindow = (windowId: string): void => {
    const record = windows.get(windowId);
    if (!record) {
      return;
    }

    if (dragState?.windowId === windowId) {
      stopDragging();
    }

    if (resizeState?.windowId === windowId) {
      stopResizing();
    }

    detachRuntime(record);
    record.node.remove();
    windows.delete(windowId);

    if (activeWindowId === windowId) {
      chooseNextActiveWindow();
      return;
    }

    repaintAll();
    emit();
  };

  const maximizeWindow = (windowId: string): void => {
    const record = windows.get(windowId);
    if (!record || record.mode === "minimized") {
      return;
    }

    if (record.mode === "maximized") {
      record.mode = "normal";
      record.x = record.restoreX;
      record.y = record.restoreY;
      record.width = record.restoreWidth;
      record.height = record.restoreHeight;
      record.lastVisibleMode = "normal";
    } else {
      record.restoreX = record.x;
      record.restoreY = record.y;
      record.restoreWidth = record.width;
      record.restoreHeight = record.height;
      record.mode = "maximized";
      record.lastVisibleMode = "maximized";
    }

    focusWindow(windowId);
  };

  const minimizeWindow = (windowId: string): void => {
    const record = windows.get(windowId);
    if (!record || record.mode === "minimized") {
      return;
    }

    record.lastVisibleMode = record.mode === "maximized" ? "maximized" : "normal";
    record.mode = "minimized";
    suspendRuntime(record);

    if (activeWindowId === windowId) {
      activeWindowId = null;
      chooseNextActiveWindow();
      return;
    }

    repaintAll();
    emit();
  };

  const restoreWindow = (windowId: string): void => {
    const record = windows.get(windowId);
    if (!record || record.mode !== "minimized") {
      return;
    }

    record.mode = record.lastVisibleMode;
    resumeRuntime(record);
    focusWindow(windowId);
  };

  const setWindowTitle = (windowId: string, title: string | null): void => {
    const record = windows.get(windowId);
    if (!record) {
      return;
    }

    record.title = normalizeChromeText(title) ?? record.app.name;
    applyWindowChrome(record);
    emit();
  };

  const setWindowBadge = (windowId: string, badge: string | null): void => {
    const record = windows.get(windowId);
    if (!record) {
      return;
    }

    record.badge = normalizeChromeText(badge, 16);
    applyWindowChrome(record);
    emit();
  };

  const setWindowDirty = (windowId: string, dirty: boolean): void => {
    const record = windows.get(windowId);
    if (!record) {
      return;
    }

    record.dirty = dirty;
    applyWindowChrome(record);
    emit();
  };

  const applySnap = (windowId: string, target: Exclude<SnapTarget, null>): void => {
    if (target === "maximize") {
      maximizeWindow(windowId);
      return;
    }

    const record = windows.get(windowId);
    if (!record || record.mode === "minimized") {
      return;
    }

    const bounds = workspaceBounds();
    const halfWidth = Math.floor(bounds.width / 2);

    record.mode = "normal";
    record.lastVisibleMode = "normal";
    record.y = 0;
    record.height = bounds.height;
    record.width = halfWidth;

    if (target === "left") {
      record.x = 0;
    } else {
      record.x = bounds.width - halfWidth;
    }

    focusWindow(windowId);
  };

  const onWindowAction = (windowId: string, action: string): void => {
    if (dragState?.windowId === windowId) {
      stopDragging();
    }
    if (resizeState?.windowId === windowId) {
      stopResizing();
    }

    switch (action) {
      case "close":
        closeWindow(windowId);
        break;
      case "minimize":
        minimizeWindow(windowId);
        break;
      case "maximize":
        maximizeWindow(windowId);
        break;
      default:
        break;
    }
  };

  const onRuntimeAction = (windowId: string, action: string): void => {
    const record = windows.get(windowId);
    if (!record) {
      return;
    }

    switch (action) {
      case "restart":
        restartRuntime(record);
        break;
      case "close":
        closeWindow(windowId);
        break;
      default:
        break;
    }
  };

  const beginResize = (record: WindowRecord, handleNode: HTMLElement, direction: ResizeDirection, event: PointerEvent): void => {
    if (record.mode !== "normal") {
      return;
    }

    event.preventDefault();
    focusWindow(record.windowId);

    resizeState = {
      windowId: record.windowId,
      pointerId: event.pointerId,
      direction,
      handleNode,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: record.x,
      startY: record.y,
      startWidth: record.width,
      startHeight: record.height,
    };

    record.node.classList.add("resizing");
    handleNode.setPointerCapture(event.pointerId);
    document.body.classList.add("is-dragging-window");
    document.addEventListener("selectstart", blockSelection);
    window.addEventListener("dragstart", blockSelection);
  };

  const attachWindowListeners = (record: WindowRecord): void => {
    record.node.addEventListener("pointerdown", () => {
      focusWindow(record.windowId);
    });

    record.node.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const actionNode = target.closest<HTMLElement>("[data-window-action]");
      if (actionNode) {
        event.stopPropagation();
        const action = actionNode.dataset.windowAction;
        if (action) {
          onWindowAction(record.windowId, action);
        }
        return;
      }

      const runtimeActionNode = target.closest<HTMLElement>("[data-runtime-action]");
      if (!runtimeActionNode) {
        return;
      }

      event.stopPropagation();
      const action = runtimeActionNode.dataset.runtimeAction;
      if (!action) {
        return;
      }

      onRuntimeAction(record.windowId, action);
    });

    record.node.addEventListener("pointerdown", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      const actionNode = target.closest<HTMLElement>("[data-window-action]");
      if (!actionNode) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (dragState?.windowId === record.windowId) {
        stopDragging();
      }
      if (resizeState?.windowId === record.windowId) {
        stopResizing();
      }
      focusWindow(record.windowId);
    });

    record.dragHandleNode.addEventListener("pointerdown", (event) => {
      if (record.mode !== "normal") {
        return;
      }

      if (event.button !== 0) {
        return;
      }

      const target = event.target;
      if (target instanceof HTMLElement && target.closest(".window-controls")) {
        return;
      }

      event.preventDefault();
      focusWindow(record.windowId);

      dragState = {
        windowId: record.windowId,
        pointerId: event.pointerId,
        offsetX: event.clientX - record.x,
        offsetY: event.clientY - record.y,
        snapTarget: null,
      };

      record.node.classList.add("dragging");
      record.dragHandleNode.setPointerCapture(event.pointerId);
      document.body.classList.add("is-dragging-window");
      document.addEventListener("selectstart", blockSelection);
      window.addEventListener("dragstart", blockSelection);
    });

    record.dragHandleNode.addEventListener("dblclick", (event) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest(".window-controls")) {
        return;
      }
      event.preventDefault();
      maximizeWindow(record.windowId);
    });

    const resizeHandles = Array.from(record.node.querySelectorAll<HTMLElement>("[data-window-resize]"));
    for (const handleNode of resizeHandles) {
      handleNode.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) {
          return;
        }

        const direction = handleNode.dataset.windowResize;
        if (!direction) {
          return;
        }

        beginResize(record, handleNode, direction as ResizeDirection, event);
      });
    }
  };

  const createRecord = (app: AppManifest, persisted?: PersistedWindow, route?: string): WindowRecord => {
    const resolvedRoute = route ?? persisted?.route ?? app.entrypoint.route;
    const node = createWindowNode(app, resolvedRoute);
    const dragHandleNode = node.querySelector<HTMLElement>("[data-window-drag-handle]");
    const contentNode = node.querySelector<HTMLElement>("[data-window-content]");

    if (!dragHandleNode || !contentNode) {
      throw new Error("Window markup is incomplete");
    }

    const stagger = openCounter % WINDOW_STAGGER_STEPS;
    openCounter += 1;

    const baseWidth = persisted?.width ?? app.windowDefaults.width;
    const baseHeight = persisted?.height ?? app.windowDefaults.height;
    const fitted = fitSizeToWorkspace(app, baseWidth, baseHeight);
    const fittedRestore = persisted
      ? fitSizeToWorkspace(app, persisted.restoreWidth, persisted.restoreHeight)
      : fitted;

    const record: WindowRecord = {
      windowId: `win-${++sequence}`,
      app,
      route: resolvedRoute,
      title: normalizeChromeText(persisted?.title ?? null) ?? app.name,
      badge: null,
      dirty: false,
      mode: persisted?.mode ?? "normal",
      lastVisibleMode: persisted?.lastVisibleMode ?? "normal",
      x: persisted?.x ?? WINDOW_START_X + stagger * WINDOW_OFFSET_X,
      y: persisted?.y ?? WINDOW_START_Y + stagger * WINDOW_OFFSET_Y,
      width: fitted.width,
      height: fitted.height,
      restoreX: persisted?.restoreX ?? WINDOW_START_X,
      restoreY: persisted?.restoreY ?? WINDOW_START_Y,
      restoreWidth: fittedRestore.width,
      restoreHeight: fittedRestore.height,
      zIndex: persisted?.zIndex ?? ++zCounter,
      node,
      dragHandleNode,
      contentNode,
      runtime: null,
    };

    if (!persisted) {
      record.restoreX = record.x;
      record.restoreY = record.y;
    }

    return record;
  };

  const restorePersistedLayout = (): void => {
    if (restoredPersistedLayout || !pendingPersistedLayout || appById.size === 0) {
      return;
    }
    restoredPersistedLayout = true;

    const orderedWindows = [...pendingPersistedLayout.windows].sort((left, right) => left.zIndex - right.zIndex);
    for (const snapshot of orderedWindows) {
      const app = appById.get(snapshot.appId);
      if (!app) {
        continue;
      }

      const record = createRecord(app, snapshot);
      attachWindowListeners(record);
      windows.set(record.windowId, record);
      layerNode.appendChild(record.node);
      zCounter = Math.max(zCounter, record.zIndex);
    }

    if (pendingPersistedLayout.activeAppId) {
      const activeRecord = [...windows.values()]
        .filter((record) => record.app.id === pendingPersistedLayout.activeAppId && record.mode !== "minimized")
        .sort((left, right) => right.zIndex - left.zIndex)[0];
      activeWindowId = activeRecord?.windowId ?? activeWindowId;
    }

    if (!activeWindowId) {
      const visibleTop = [...windows.values()]
        .filter((record) => record.mode !== "minimized")
        .sort((left, right) => right.zIndex - left.zIndex)[0];
      activeWindowId = visibleTop?.windowId ?? null;
    }

    for (const record of windows.values()) {
      if (record.mode !== "minimized") {
        attachRuntime(record);
      }
    }

    repaintAll();
  };

  const setAppRegistry = (apps: readonly AppManifest[]): void => {
    const shouldDeferEmptyRegistry = apps.length === 0 && windows.size === 0 && !!pendingPersistedLayout && !restoredPersistedLayout;
    appById = new Map(apps.map((app) => [app.id, app]));

    for (const record of windows.values()) {
      const nextApp = appById.get(record.app.id);
      if (!nextApp) {
        continue;
      }
      const titleWasDefault = record.title === record.app.name;
      record.app = nextApp;
      if (titleWasDefault) {
        record.title = nextApp.name;
      }
      applyWindowChrome(record);
    }

    restorePersistedLayout();
    repaintAll();
    if (shouldDeferEmptyRegistry) {
      return;
    }
    emit();
  };

  const findReusableWindow = (app: AppManifest, route?: string): WindowRecord | null => {
    const candidates = [...windows.values()]
      .filter((record) => record.app.id === app.id)
      .sort((left, right) => right.zIndex - left.zIndex);

    if (route) {
      return candidates.find((record) => record.route === route) ?? null;
    }

    return candidates[0] ?? null;
  };

  const openApp = (app: AppManifest, route?: string, options?: { pendingAppOpenRequest?: OpenAppRequest | null; forceRestart?: boolean; forceNew?: boolean }): string => {
    const requestedRoute = route ?? app.entrypoint.route;
    const existing = options?.forceNew ? null : findReusableWindow(app, route);
    if (existing) {
      if (options?.pendingAppOpenRequest) {
        queuePendingAppOpen(existing.windowId, options.pendingAppOpenRequest);
      }
      if (options?.forceRestart) {
        restartRuntime(existing);
      }
      if (existing.mode === "minimized") {
        restoreWindow(existing.windowId);
      } else {
        focusWindow(existing.windowId);
      }
      return existing.windowId;
    }

    const record = createRecord(app, undefined, requestedRoute);
    attachWindowListeners(record);
    windows.set(record.windowId, record);
    layerNode.appendChild(record.node);

    if (options?.pendingAppOpenRequest) {
      queuePendingAppOpen(record.windowId, options.pendingAppOpenRequest);
    }
    attachRuntime(record);
    activeWindowId = record.windowId;
    repaintAll();
    emit();

    return record.windowId;
  };

  const openAppById = (
    appId: string,
    route?: string,
    options?: { forceRestart?: boolean; forceNew?: boolean },
  ): string | null => {
    const app = appById.get(appId);
    if (!app) {
      return null;
    }
    return openApp(app, route, options);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (resizeState) {
      if (resizeState.pointerId !== event.pointerId) {
        return;
      }

      const record = windows.get(resizeState.windowId);
      if (!record || record.mode !== "normal") {
        stopResizing();
        return;
      }

      event.preventDefault();

      const bounds = workspaceBounds();
      const minSize = minSizeForWorkspace(record.app);
      const startRight = resizeState.startX + resizeState.startWidth;
      const startBottom = resizeState.startY + resizeState.startHeight;
      const deltaX = event.clientX - resizeState.startClientX;
      const deltaY = event.clientY - resizeState.startClientY;

      let nextX = resizeState.startX;
      let nextY = resizeState.startY;
      let nextWidth = resizeState.startWidth;
      let nextHeight = resizeState.startHeight;

      if (resizeState.direction.includes("w")) {
        const maxX = startRight - minSize.width;
        nextX = clamp(resizeState.startX + deltaX, WINDOW_MARGIN, maxX);
        nextWidth = startRight - nextX;
      } else if (resizeState.direction.includes("e")) {
        const maxWidth = Math.max(bounds.width - WINDOW_MARGIN - resizeState.startX, minSize.width);
        nextWidth = clamp(resizeState.startWidth + deltaX, minSize.width, maxWidth);
      }

      if (resizeState.direction.includes("n")) {
        const maxY = startBottom - minSize.height;
        nextY = clamp(resizeState.startY + deltaY, WINDOW_MARGIN, maxY);
        nextHeight = startBottom - nextY;
      } else if (resizeState.direction.includes("s")) {
        const maxHeight = Math.max(bounds.height - WINDOW_MARGIN - resizeState.startY, minSize.height);
        nextHeight = clamp(resizeState.startHeight + deltaY, minSize.height, maxHeight);
      }

      record.x = nextX;
      record.y = nextY;
      record.width = nextWidth;
      record.height = nextHeight;
      applyWindowFrame(record);
      return;
    }

    if (!dragState) {
      return;
    }

    const record = windows.get(dragState.windowId);
    if (!record || record.mode !== "normal") {
      stopDragging();
      return;
    }

    if (dragState.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    record.x = event.clientX - dragState.offsetX;
    record.y = event.clientY - dragState.offsetY;
    applyWindowFrame(record);

    const target = detectSnapTarget(event.clientX, event.clientY);
    dragState.snapTarget = target;

    if (target) {
      showSnapOverlay(target);
    } else {
      hideSnapOverlay();
    }
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (resizeState && resizeState.pointerId === event.pointerId) {
      stopResizing();
      emit();
      return;
    }

    if (dragState && dragState.pointerId === event.pointerId) {
      const snapTarget = dragState.snapTarget;
      const windowId = dragState.windowId;
      stopDragging();

      if (snapTarget) {
        applySnap(windowId, snapTarget);
      } else {
        emit();
      }
    }
  };

  const onPointerCancel = (): void => {
    if (resizeState) {
      stopResizing();
      emit();
    }

    if (dragState) {
      stopDragging();
      emit();
    }
  };

  const onWindowBlur = (): void => {
    if (resizeState) {
      stopResizing();
      emit();
    }

    if (dragState) {
      stopDragging();
      emit();
    }
  };

  const onWindowResize = (): void => {
    repaintAll();
    emit();
  };

  const cycleWindow = (direction: 1 | -1): void => {
    const candidates = [...windows.values()]
      .filter((record) => record.mode !== "minimized")
      .sort((left, right) => left.zIndex - right.zIndex);
    if (candidates.length === 0) {
      return;
    }

    const activeIndex = candidates.findIndex((record) => record.windowId === activeWindowId);
    const fallbackIndex = direction === 1 ? 0 : candidates.length - 1;
    const nextIndex = activeIndex < 0
      ? fallbackIndex
      : (activeIndex + direction + candidates.length) % candidates.length;
    focusWindow(candidates[nextIndex].windowId);
  };

  const isEditableTarget = (target: EventTarget | null): boolean => {
    if (!(target instanceof HTMLElement)) {
      return false;
    }
    return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
  };

  const onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) {
      return;
    }

    if (event.altKey && event.key === "Tab") {
      event.preventDefault();
      cycleWindow(event.shiftKey ? -1 : 1);
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key === "`") {
      event.preventDefault();
      cycleWindow(event.shiftKey ? -1 : 1);
      return;
    }

    if (!activeWindowId || isEditableTarget(event.target)) {
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "w") {
      event.preventDefault();
      closeWindow(activeWindowId);
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "m") {
      event.preventDefault();
      minimizeWindow(activeWindowId);
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      maximizeWindow(activeWindowId);
    }
  };

  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerCancel);
  window.addEventListener("blur", onWindowBlur);
  window.addEventListener("resize", onWindowResize);
  document.addEventListener("keydown", onDocumentKeyDown);

  restorePersistedLayout();

  return {
    openApp,
    openAppById,
    focusWindow,
    restoreWindow,
    minimizeWindow,
    maximizeWindow,
    closeWindow,
    setAppRegistry,
    setWindowTitle,
    setWindowBadge,
    setWindowDirty,
    listApps: () => [...appById.values()],
    listWindows: buildSummaries,
    subscribe: (listener) => {
      listeners.add(listener);
      listener(buildSummaries());

      return () => {
        listeners.delete(listener);
      };
    },
    destroy: () => {
      stopDragging();
      stopResizing();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("blur", onWindowBlur);
      window.removeEventListener("resize", onWindowResize);
      document.removeEventListener("keydown", onDocumentKeyDown);

      for (const record of windows.values()) {
        detachRuntime(record);
        record.node.remove();
      }

      snapOverlayNode.remove();
      windows.clear();
      listeners.clear();
      activeWindowId = null;
    },
  };
}
