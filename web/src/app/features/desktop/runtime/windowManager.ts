import type { AppManifest } from "../../../../apps";
import { queuePendingAppOpen, type OpenAppRequest } from "../../../../app-link";
import type { AppInstance, AppRuntimeContext, AppRuntimeRegistry } from "./appRuntime";
import {
  readPersistedDesktopLayout,
  selectRestoredActiveWindowId,
  serializeDesktopLayout,
  writePersistedDesktopLayout,
  type DesktopVisibleWindowMode,
  type DesktopWindowMode,
  type PersistedDesktopWindow,
  type SerializableDesktopWindow,
} from "../domain/windowLayout";
import {
  reduceDesktopWindowState,
  type DesktopWindowState,
  type DesktopWindowStateAction,
  type DesktopWindowStateRecord,
} from "../domain/windowState";
import {
  detectWindowSnapTarget,
  fitWindowSizeToWorkspace,
  minimumWindowSizeForWorkspace,
  normalizeWorkspaceBounds,
  resizeWindowRect,
  snapOverlayRect,
  clampWindowPositionToWorkspace,
  type DesktopResizeDirection,
  type DesktopWorkspaceBounds,
} from "../domain/windowGeometry";
import { mountPreviewWindow, type PreviewWindowContent } from "./previewWindow";

type WindowMode = DesktopWindowMode;
type ResizeDirection = DesktopResizeDirection;
type SnapTarget = "left" | "right" | "maximize" | null;
type LifecyclePhase = "mount" | "suspend" | "resume" | "terminate";
type PersistedWindow = PersistedDesktopWindow;

type AppRuntimeState = {
  instance: AppInstance;
  suspended: boolean;
  crashed: boolean;
};

type PreviewRuntimeState = {
  dispose: () => void;
};

type WindowRecord = {
  windowId: string;
  app: AppManifest;
  route: string;
  title: string;
  badge: string | null;
  dirty: boolean;
  mode: WindowMode;
  lastVisibleMode: DesktopVisibleWindowMode;
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
  preview: PreviewRuntimeState | null;
  persist: boolean;
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

export type WindowDomBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type WindowDomNodeSnapshot = {
  tag: string;
  selector: string;
  id: string | null;
  className: string | null;
  role: string | null;
  name: string | null;
  text: string | null;
  bounds: WindowDomBounds;
  attributes: Record<string, string>;
  children: WindowDomNodeSnapshot[];
};

export type WindowDomSnapshot = {
  window: WindowSummary;
  url: string;
  selector: string;
  root: WindowDomNodeSnapshot;
};

export type WindowDomQueryMatch = {
  index: number;
  tag: string;
  selector: string;
  id: string | null;
  className: string | null;
  role: string | null;
  name: string | null;
  text: string | null;
  bounds: WindowDomBounds;
  attributes: Record<string, string>;
};

export type WindowDomInputResult = WindowDomQueryMatch & {
  previousValue: string | null;
  value: string;
};

export type WindowJsRunResult = {
  result: unknown;
};

export type WindowManager = {
  openApp: (app: AppManifest, route?: string, options?: { pendingAppOpenRequest?: OpenAppRequest | null; forceRestart?: boolean; forceNew?: boolean }) => string;
  openAppById: (appId: string, route?: string, options?: { forceRestart?: boolean; forceNew?: boolean }) => string | null;
  openPreview: (preview: PreviewWindowContent) => string;
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
  snapshotWindowDom: (windowId: string, selector?: string | null) => WindowDomSnapshot | null;
  queryWindowDom: (windowId: string, selector: string) => WindowDomQueryMatch[] | null;
  clickWindowDom: (windowId: string, selector: string, index?: number) => WindowDomQueryMatch | null;
  clickWindowPoint: (windowId: string, x: number, y: number) => WindowDomQueryMatch | null;
  focusWindowDom: (windowId: string, selector: string, index?: number) => WindowDomQueryMatch | null;
  inputWindowDom: (windowId: string, selector: string, value: string, index?: number) => WindowDomInputResult | null;
  runWindowJavaScript: (windowId: string, source: string) => Promise<WindowJsRunResult | null>;
  subscribe: (listener: (summaries: WindowSummary[]) => void) => () => void;
  destroy: () => void;
};

type WindowManagerOptions = {
  layerNode: HTMLElement;
  appRegistry: readonly AppManifest[];
  appRuntime: AppRuntimeRegistry;
};

const WINDOW_START_X = 96;
const WINDOW_START_Y = 92;
const WINDOW_OFFSET_X = 28;
const WINDOW_OFFSET_Y = 22;
const WINDOW_STAGGER_STEPS = 8;
const PREVIEW_APP: AppManifest = {
  id: "preview",
  name: "Preview",
  description: "Transient file and blob preview window.",
  icon: { kind: "fallback", label: "PV" },
  entrypoint: { kind: "web", route: "/internal/preview" },
  permissions: [],
  syscalls: [],
  windowDefaults: {
    width: 980,
    height: 720,
    minWidth: 360,
    minHeight: 280,
  },
};

const blockSelection = (event: Event): void => {
  event.preventDefault();
};

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

function normalizeChromeText(value: string | null, maxLength = 80): string | null {
  const normalized = value?.trim() ?? "";
  if (!normalized) {
    return null;
  }
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

function summarizeWindowRecord(record: WindowRecord, activeWindowId: string | null): WindowSummary {
  return {
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
  };
}

function toSerializableDesktopWindow(record: WindowRecord): SerializableDesktopWindow {
  return {
    windowId: record.windowId,
    appId: record.app.id,
    appName: record.app.name,
    route: record.route,
    title: record.title,
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
    persist: record.persist,
  };
}

function toDesktopWindowStateRecord(record: WindowRecord): DesktopWindowStateRecord {
  return {
    windowId: record.windowId,
    title: record.title,
    badge: record.badge,
    dirty: record.dirty,
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
  };
}

function applyDesktopWindowStateRecord(
  record: WindowRecord,
  stateRecord: DesktopWindowStateRecord,
): void {
  record.title = stateRecord.title;
  record.badge = stateRecord.badge;
  record.dirty = stateRecord.dirty;
  record.mode = stateRecord.mode;
  record.lastVisibleMode = stateRecord.lastVisibleMode;
  record.x = stateRecord.x;
  record.y = stateRecord.y;
  record.width = stateRecord.width;
  record.height = stateRecord.height;
  record.restoreX = stateRecord.restoreX;
  record.restoreY = stateRecord.restoreY;
  record.restoreWidth = stateRecord.restoreWidth;
  record.restoreHeight = stateRecord.restoreHeight;
  record.zIndex = stateRecord.zIndex;
}

function serializeBounds(rect: DOMRect): WindowDomBounds {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function meaningfulText(element: Element, maxLength = 240): string | null {
  const text = "innerText" in element
    ? String((element as HTMLElement).innerText ?? "")
    : element.textContent ?? "";
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}

function domAttributes(element: Element): Record<string, string> {
  const allowed = new Set([
    "aria-label",
    "aria-labelledby",
    "aria-describedby",
    "alt",
    "class",
    "data-action",
    "data-testid",
    "href",
    "id",
    "name",
    "placeholder",
    "role",
    "title",
    "type",
    "value",
  ]);
  const result: Record<string, string> = {};
  for (const attr of Array.from(element.attributes)) {
    if (allowed.has(attr.name) || attr.name.startsWith("data-")) {
      result[attr.name] = attr.value.slice(0, 300);
    }
  }
  return result;
}

function cssPath(element: Element): string {
  const segments: string[] = [];
  let current: Element | null = element;
  while (current && current.nodeType === Node.ELEMENT_NODE && segments.length < 6) {
    const id = current.id ? `#${cssEscape(current.id)}` : "";
    if (id) {
      segments.unshift(`${current.tagName.toLowerCase()}${id}`);
      break;
    }
    const currentTag = current.tagName;
    const parent: Element | null = current.parentElement;
    const siblings = parent
      ? Array.from(parent.children).filter((child) => child.tagName === currentTag)
      : [];
    const nth = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : "";
    segments.unshift(`${current.tagName.toLowerCase()}${nth}`);
    current = parent;
  }
  return segments.join(" > ");
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
}

function accessibleName(element: Element): string | null {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const root = element.getRootNode();
    const documentRoot = root as { getElementById?: (id: string) => Element | null };
    const text = labelledBy
      .split(/\s+/)
      .map((id) => documentRoot.getElementById?.(id)?.textContent ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) {
      return text.slice(0, 240);
    }
  }
  return element.getAttribute("aria-label")
    ?? element.getAttribute("title")
    ?? element.getAttribute("alt")
    ?? null;
}

function toDomQueryMatch(element: Element, index: number): WindowDomQueryMatch {
  return {
    index,
    tag: element.tagName.toLowerCase(),
    selector: cssPath(element),
    id: element.id || null,
    className: element.getAttribute("class"),
    role: element.getAttribute("role"),
    name: accessibleName(element),
    text: meaningfulText(element),
    bounds: serializeBounds(element.getBoundingClientRect()),
    attributes: domAttributes(element),
  };
}

function snapshotElement(element: Element, depth = 0): WindowDomNodeSnapshot {
  const children = depth >= 4
    ? []
    : Array.from(element.children)
      .filter((child) => !["script", "style", "template"].includes(child.tagName.toLowerCase()))
      .slice(0, 40)
      .map((child) => snapshotElement(child, depth + 1));
  return {
    tag: element.tagName.toLowerCase(),
    selector: cssPath(element),
    id: element.id || null,
    className: element.getAttribute("class"),
    role: element.getAttribute("role"),
    name: accessibleName(element),
    text: meaningfulText(element),
    bounds: serializeBounds(element.getBoundingClientRect()),
    attributes: domAttributes(element),
    children,
  };
}

function focusDomElement(element: Element): void {
  if ("scrollIntoView" in element && typeof element.scrollIntoView === "function") {
    element.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
  }
  if ("focus" in element && typeof element.focus === "function") {
    element.focus();
  }
}

function setDomElementInputValue(element: Element, value: string): { previousValue: string | null; value: string } | null {
  const view = element.ownerDocument.defaultView ?? window;
  const elementWindow = view as Window & {
    HTMLInputElement?: typeof HTMLInputElement;
    HTMLTextAreaElement?: typeof HTMLTextAreaElement;
    HTMLSelectElement?: typeof HTMLSelectElement;
    HTMLElement?: typeof HTMLElement;
    InputEvent?: typeof InputEvent;
    Event?: typeof Event;
  };
  const InputCtor = elementWindow.HTMLInputElement ?? HTMLInputElement;
  const TextareaCtor = elementWindow.HTMLTextAreaElement ?? HTMLTextAreaElement;
  const SelectCtor = elementWindow.HTMLSelectElement ?? HTMLSelectElement;
  const HTMLElementCtor = elementWindow.HTMLElement ?? HTMLElement;
  const InputEventCtor = elementWindow.InputEvent ?? InputEvent;
  const EventCtor = elementWindow.Event ?? Event;

  if (element instanceof InputCtor || element instanceof TextareaCtor || element instanceof SelectCtor) {
    const control = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    const previousValue = control.value;
    setNativeElementValue(control, value);
    control.dispatchEvent(new InputEventCtor("input", { bubbles: true, inputType: "insertText", data: value }));
    control.dispatchEvent(new EventCtor("change", { bubbles: true }));
    return { previousValue, value: control.value };
  }

  if (element instanceof HTMLElementCtor && element.isContentEditable) {
    const previousValue = element.textContent ?? "";
    element.textContent = value;
    element.dispatchEvent(new InputEventCtor("input", { bubbles: true, inputType: "insertText", data: value }));
    return { previousValue, value: element.textContent ?? "" };
  }

  return null;
}

function setNativeElementValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const prototype = Object.getPrototypeOf(element) as object | null;
  const descriptor = prototype ? Object.getOwnPropertyDescriptor(prototype, "value") : null;
  if (descriptor?.set) {
    descriptor.set.call(element, value);
    return;
  }
  element.value = value;
}

function dispatchDomClick(target: Element, point?: { x: number; y: number }): void {
  focusDomElement(target);

  const view = target.ownerDocument.defaultView ?? window;
  const eventWindow = view as Window & { PointerEvent?: typeof PointerEvent; MouseEvent?: typeof MouseEvent };
  const eventInit = {
    bubbles: true,
    cancelable: true,
    view,
    clientX: point?.x ?? 0,
    clientY: point?.y ?? 0,
  };
  const PointerCtor = eventWindow.PointerEvent;
  if (PointerCtor) {
    target.dispatchEvent(new PointerCtor("pointerdown", eventInit));
    target.dispatchEvent(new PointerCtor("pointerup", eventInit));
  }
  if ("click" in target && typeof target.click === "function") {
    target.click();
  } else {
    const MouseCtor = eventWindow.MouseEvent ?? MouseEvent;
    target.dispatchEvent(new MouseCtor("click", eventInit));
  }
}

function serializeJsResult(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value ?? null;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => serializeJsResult(item));
  }
  if (isElementLike(value)) {
    return toDomQueryMatch(value, 0);
  }
  if (isNodeLike(value)) {
    return {
      nodeType: value.nodeType,
      nodeName: value.nodeName,
      text: value.textContent?.replace(/\s+/g, " ").trim().slice(0, 500) ?? null,
    };
  }
  if (isArrayLikeCollection(value)) {
    return Array.from(value)
      .slice(0, 50)
      .map((item) => serializeJsResult(item));
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function isElementLike(value: unknown): value is Element {
  return typeof value === "object"
    && value !== null
    && "nodeType" in value
    && (value as { nodeType: unknown }).nodeType === Node.ELEMENT_NODE
    && "tagName" in value;
}

function isNodeLike(value: unknown): value is Node {
  return typeof value === "object"
    && value !== null
    && "nodeType" in value
    && typeof (value as { nodeType: unknown }).nodeType === "number"
    && "nodeName" in value;
}

function isArrayLikeCollection(value: unknown): value is ArrayLike<unknown> {
  return typeof value === "object"
    && value !== null
    && "length" in value
    && typeof (value as { length: unknown }).length === "number"
    && "item" in value
    && typeof (value as { item: unknown }).item === "function";
}

function jsExecutionBody(source: string): string {
  const trimmed = source.trim();
  if (!trimmed) {
    return "return null;";
  }

  if (
    trimmed.includes(";")
    || trimmed.includes("\n")
    || /^(return|throw|let|const|var|if|for|while|switch|try|class|function)\b/.test(trimmed)
  ) {
    return trimmed;
  }

  return `return (${trimmed});`;
}

export function createWindowManager({ layerNode, appRegistry, appRuntime }: WindowManagerOptions): WindowManager {
  const windows = new Map<string, WindowRecord>();
  let appById = new Map(appRegistry.map((app) => [app.id, app]));
  const listeners = new Set<(summaries: WindowSummary[]) => void>();
  const pendingPersistedLayout = readPersistedDesktopLayout();

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

  const snapshotWindowState = (): DesktopWindowState => ({
    activeWindowId,
    zCounter,
    windows: [...windows.values()].map(toDesktopWindowStateRecord),
  });

  const applyWindowState = (state: DesktopWindowState): void => {
    activeWindowId = state.activeWindowId;
    zCounter = state.zCounter;

    for (const stateRecord of state.windows) {
      const record = windows.get(stateRecord.windowId);
      if (record) {
        applyDesktopWindowStateRecord(record, stateRecord);
      }
    }
  };

  const dispatchWindowState = (action: DesktopWindowStateAction): boolean => {
    const currentState = snapshotWindowState();
    const nextState = reduceDesktopWindowState(currentState, action);
    if (nextState === currentState) {
      return false;
    }
    applyWindowState(nextState);
    return true;
  };

  const workspaceBounds = (): DesktopWorkspaceBounds => {
    const rect = layerNode.getBoundingClientRect();
    return normalizeWorkspaceBounds(rect);
  };

  const clampNormalPosition = (record: WindowRecord): void => {
    const nextPosition = clampWindowPositionToWorkspace(workspaceBounds(), record);
    record.x = nextPosition.x;
    record.y = nextPosition.y;
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
    const fitted = fitWindowSizeToWorkspace(
      record.app.windowDefaults,
      workspaceBounds(),
      record,
    );
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
      .map((record) => summarizeWindowRecord(record, activeWindowId));
  };

  const persistLayout = (): void => {
    const layout = serializeDesktopLayout(
      [...windows.values()].map(toSerializableDesktopWindow),
      activeWindowId,
    );
    writePersistedDesktopLayout(layout);
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
    const { x, y, width, height } = snapOverlayRect(workspaceBounds(), target);

    snapOverlayNode.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    snapOverlayNode.style.width = `${width}px`;
    snapOverlayNode.style.height = `${height}px`;
    snapOverlayNode.dataset.snapTarget = target;
    snapOverlayNode.hidden = false;
  };

  const detectSnapTarget = (clientX: number, clientY: number): SnapTarget => {
    return detectWindowSnapTarget(workspaceBounds(), clientX, clientY);
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
    const preview = record.preview;
    if (preview) {
      record.preview = null;
      try {
        preview.dispose();
      } catch {
        // Ignore preview teardown errors during window disposal.
      }
    }

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

    dispatchWindowState({ type: "focus", windowId });
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

    const nextState = reduceDesktopWindowState(snapshotWindowState(), {
      type: "close",
      windowId,
    });

    detachRuntime(record);
    record.node.remove();
    windows.delete(windowId);
    applyWindowState(nextState);
    repaintAll();
    emit();
  };

  const maximizeWindow = (windowId: string): void => {
    const record = windows.get(windowId);
    if (!record || record.mode === "minimized") {
      return;
    }

    dispatchWindowState({ type: "maximize", windowId });
    repaintAll();
    emit();
  };

  const minimizeWindow = (windowId: string): void => {
    const record = windows.get(windowId);
    if (!record || record.mode === "minimized") {
      return;
    }

    dispatchWindowState({ type: "minimize", windowId });
    suspendRuntime(record);
    repaintAll();
    emit();
  };

  const restoreWindow = (windowId: string): void => {
    const record = windows.get(windowId);
    if (!record || record.mode !== "minimized") {
      return;
    }

    dispatchWindowState({ type: "restore", windowId });
    resumeRuntime(record);
    repaintAll();
    emit();
  };

  const setWindowTitle = (windowId: string, title: string | null): void => {
    const record = windows.get(windowId);
    if (!record) {
      return;
    }

    dispatchWindowState({
      type: "set-chrome",
      windowId,
      title: normalizeChromeText(title) ?? record.app.name,
    });
    applyWindowChrome(record);
    emit();
  };

  const setWindowBadge = (windowId: string, badge: string | null): void => {
    const record = windows.get(windowId);
    if (!record) {
      return;
    }

    dispatchWindowState({
      type: "set-chrome",
      windowId,
      badge: normalizeChromeText(badge, 16),
    });
    applyWindowChrome(record);
    emit();
  };

  const setWindowDirty = (windowId: string, dirty: boolean): void => {
    const record = windows.get(windowId);
    if (!record) {
      return;
    }

    dispatchWindowState({
      type: "set-chrome",
      windowId,
      dirty,
    });
    applyWindowChrome(record);
    emit();
  };

  const applySnap = (windowId: string, target: Exclude<SnapTarget, null>): void => {
    const record = windows.get(windowId);
    if (!record || record.mode === "minimized") {
      return;
    }

    const bounds = workspaceBounds();
    dispatchWindowState({
      type: "snap",
      windowId,
      target,
      workspaceWidth: bounds.width,
      workspaceHeight: bounds.height,
    });
    repaintAll();
    emit();
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
    const fitted = fitWindowSizeToWorkspace(
      app.windowDefaults,
      workspaceBounds(),
      { width: baseWidth, height: baseHeight },
    );
    const fittedRestore = persisted
      ? fitWindowSizeToWorkspace(
        app.windowDefaults,
        workspaceBounds(),
        { width: persisted.restoreWidth, height: persisted.restoreHeight },
      )
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
      preview: null,
      persist: true,
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

    activeWindowId = selectRestoredActiveWindowId(
      [...windows.values()].map((record) => ({
        windowId: record.windowId,
        appId: record.app.id,
        mode: record.mode,
        zIndex: record.zIndex,
      })),
      pendingPersistedLayout.activeAppId,
      activeWindowId,
    );

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

  const openPreview = (preview: PreviewWindowContent): string => {
    const route = `preview:${preview.sourceLabel}`;
    const record = createRecord(PREVIEW_APP, undefined, route);
    record.title = normalizeChromeText(preview.title) ?? PREVIEW_APP.name;
    record.persist = false;
    record.preview = {
      dispose: mountPreviewWindow(record.contentNode, preview),
    };
    attachWindowListeners(record);
    windows.set(record.windowId, record);
    layerNode.appendChild(record.node);

    activeWindowId = record.windowId;
    repaintAll();
    emit();

    return record.windowId;
  };

  const automationContext = (windowId: string): {
    record: WindowRecord;
    root: Element;
    document: Document;
    window: Window;
  } | null => {
    const record = windows.get(windowId);
    if (!record) {
      return null;
    }

    if (record.mode === "minimized") {
      restoreWindow(windowId);
    } else {
      focusWindow(windowId);
    }

    const iframe = record.contentNode.querySelector<HTMLIFrameElement>("iframe");
    if (!iframe) {
      return {
        record,
        root: record.contentNode,
        document: record.contentNode.ownerDocument,
        window,
      };
    }

    try {
      const frameDocument = iframe.contentDocument;
      const frameWindow = iframe.contentWindow;
      const root = frameDocument?.body ?? frameDocument?.documentElement ?? null;
      if (!frameDocument || !frameWindow || !root) {
        return null;
      }
      return {
        record,
        root,
        document: frameDocument,
        window: frameWindow,
      };
    } catch {
      return null;
    }
  };

  const queryAutomationElements = (root: Element, selector: string): Element[] => {
    const trimmed = selector.trim();
    if (!trimmed) {
      return [];
    }
    const matches = root.matches(trimmed) ? [root] : [];
    matches.push(...Array.from(root.querySelectorAll(trimmed)));
    return matches;
  };

  const snapshotWindowDom = (windowId: string, selector?: string | null): WindowDomSnapshot | null => {
    const context = automationContext(windowId);
    if (!context) {
      return null;
    }

    const trimmedSelector = selector?.trim() || null;
    const root = trimmedSelector
      ? queryAutomationElements(context.root, trimmedSelector)[0] ?? null
      : context.root;
    if (!root) {
      return null;
    }

    return {
      window: summarizeWindowRecord(context.record, activeWindowId),
      url: context.document.location.href,
      selector: trimmedSelector ?? "root",
      root: snapshotElement(root),
    };
  };

  const queryWindowDom = (windowId: string, selector: string): WindowDomQueryMatch[] | null => {
    const context = automationContext(windowId);
    if (!context) {
      return null;
    }
    return queryAutomationElements(context.root, selector)
      .slice(0, 100)
      .map((element, index) => toDomQueryMatch(element, index));
  };

  const clickWindowDom = (windowId: string, selector: string, index = 0): WindowDomQueryMatch | null => {
    const context = automationContext(windowId);
    if (!context) {
      return null;
    }

    const elements = queryAutomationElements(context.root, selector);
    const target = elements[Math.max(0, Math.floor(index))] ?? null;
    if (!target) {
      return null;
    }

    dispatchDomClick(target);
    return toDomQueryMatch(target, elements.indexOf(target));
  };

  const clickWindowPoint = (windowId: string, x: number, y: number): WindowDomQueryMatch | null => {
    const context = automationContext(windowId);
    if (!context) {
      return null;
    }

    const target = context.document.elementFromPoint(x, y);
    if (!target) {
      return null;
    }
    dispatchDomClick(target, { x, y });
    return toDomQueryMatch(target, 0);
  };

  const focusWindowDom = (windowId: string, selector: string, index = 0): WindowDomQueryMatch | null => {
    const context = automationContext(windowId);
    if (!context) {
      return null;
    }

    const elements = queryAutomationElements(context.root, selector);
    const target = elements[Math.max(0, Math.floor(index))] ?? null;
    if (!target) {
      return null;
    }

    focusDomElement(target);
    return toDomQueryMatch(target, elements.indexOf(target));
  };

  const inputWindowDom = (windowId: string, selector: string, value: string, index = 0): WindowDomInputResult | null => {
    const context = automationContext(windowId);
    if (!context) {
      return null;
    }

    const elements = queryAutomationElements(context.root, selector);
    const target = elements[Math.max(0, Math.floor(index))] ?? null;
    if (!target) {
      return null;
    }

    focusDomElement(target);
    const input = setDomElementInputValue(target, value);
    if (!input) {
      return null;
    }

    return {
      ...toDomQueryMatch(target, elements.indexOf(target)),
      ...input,
    };
  };

  const runWindowJavaScript = async (windowId: string, source: string): Promise<WindowJsRunResult | null> => {
    const context = automationContext(windowId);
    if (!context) {
      return null;
    }

    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<unknown>;
    const fn = new AsyncFunction(
      "window",
      "document",
      "root",
      `
        return await (async function () {
          with (window) {
            ${jsExecutionBody(source)}
          }
        }).call(window);
      `,
    );
    const result = await fn(context.window, context.document, context.root);
    return {
      result: serializeJsResult(result),
    };
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
      const resized = resizeWindowRect(
        bounds,
        minimumWindowSizeForWorkspace(record.app.windowDefaults, bounds),
        resizeState,
        event.clientX,
        event.clientY,
      );

      record.x = resized.x;
      record.y = resized.y;
      record.width = resized.width;
      record.height = resized.height;
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
    const changed = dispatchWindowState({ type: "cycle", direction });
    if (!changed) {
      return;
    }

    repaintAll();
    emit();
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
    openPreview,
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
    snapshotWindowDom,
    queryWindowDom,
    clickWindowDom,
    clickWindowPoint,
    focusWindowDom,
    inputWindowDom,
    runWindowJavaScript,
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
