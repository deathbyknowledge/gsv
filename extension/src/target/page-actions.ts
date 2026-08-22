import {
  acquireDebugger,
  releaseDebugger,
  sendDebuggerCommand,
} from "../shared/debugger";
import { abortableDelay, throwIfAborted } from "./abort";
import {
  keyEvent,
  parsePageKey as parseKey,
  readPageScrollState,
  scrollChanged,
  scrollDeltas,
  scrollSummary,
  viewportCenter,
  type InputPoint,
  type PageScrollTarget,
  type ScrollState,
} from "./page-input";
import {
  beginPageObservation as beginObservation,
  endPageObservation as endObservation,
  pageDocumentChanged as hasDocumentChanged,
  summarizeActionObservation as actionObservation,
  type ObservationPoint,
} from "./page-observation";
import {
  currentDocumentIdentity,
  pageReferences,
  type PageElementReference,
  type PageReferenceStore,
} from "./page-semantics";

const ACTION_SETTLE_MS = 100;
const BOUNDARY_SCROLL_STEP_SETTLE_MS = 16;
const MAX_BOUNDARY_SCROLL_EVENTS = 240;

type RemoteObject = {
  objectId?: string;
  subtype?: string;
  value?: unknown;
  description?: string;
};

type RuntimeResult = {
  result?: RemoteObject;
  exceptionDetails?: {
    text?: string;
    exception?: RemoteObject;
  };
};

type DomNode = {
  nodeId?: number;
  backendNodeId?: number;
  nodeName?: string;
  localName?: string;
  frameId?: string;
  attributes?: string[];
};

type DescribeNodeResult = {
  node?: DomNode;
};

type DocumentResult = {
  root?: DomNode;
};

type QuerySelectorAllResult = {
  nodeIds?: number[];
};

type ContentQuadsResult = {
  quads?: number[][];
};

type NodeForLocationResult = {
  backendNodeId?: number;
  frameId?: string;
};

type AccessibilityValue = {
  value?: unknown;
};

type AccessibilityNode = {
  ignored?: boolean;
  role?: AccessibilityValue;
  name?: AccessibilityValue;
  properties?: Array<{ name?: string; value?: AccessibilityValue }>;
  backendDOMNodeId?: number;
};

type PartialAccessibilityTreeResult = {
  nodes?: AccessibilityNode[];
};

type ElementState = {
  connected: boolean;
  tag: string;
  focused: boolean;
  disabled: boolean;
  readOnly: boolean;
  editable: boolean;
  valueLength?: number;
  checked?: boolean;
  selected?: boolean;
  expanded?: boolean;
  scrollLeft: number;
  scrollTop: number;
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
};

type ElementSummary = {
  ref?: string;
  tag: string;
  role?: string;
  name?: string;
  states?: Record<string, string | number | boolean>;
};

type ResolvedElement = {
  backendNodeId: number;
  nodeId?: number;
  frameId?: string;
  tag: string;
  attributes: Record<string, string>;
  reference?: PageElementReference;
};

type Point = InputPoint;

export type PageLocator =
  | { kind: "reference"; reference: PageElementReference }
  | { kind: "selector"; selector: string; index: number };

export type { PageScrollTarget } from "./page-input";

export async function clickPageElement(
  tabId: number,
  locator: PageLocator,
  signal?: AbortSignal,
  store: PageReferenceStore = pageReferences,
): Promise<Record<string, unknown>> {
  return await withDebugger(tabId, signal, async (target) => {
    const element = await resolveElement(target, tabId, locator);
    await validateElementReference(target, element);
    const document = await currentDocumentIdentity(target);
    const requested = await summarizeElement(
      target,
      tabId,
      element.backendNodeId,
      store,
      element.reference,
    );
    throwIfAborted(signal);
    await sendDebuggerCommand(target, "DOM.scrollIntoViewIfNeeded", {
      backendNodeId: element.backendNodeId,
    });
    const point = await clickablePoint(target, element.backendNodeId);
    const receiverId = await hitTest(target, point);
    if (!await nodesRelated(target, element.backendNodeId, receiverId)) {
      const receiver = await summarizeElement(target, tabId, receiverId, store);
      throw new Error(`Click target is occluded by ${formatElement(receiver)}`);
    }

    const beforeState = await readElementState(target, element.backendNodeId);
    if (beforeState.disabled) {
      throw new Error("Click target is disabled");
    }
    const observation = await beginObservation(target);
    let afterObservation: ObservationPoint | null = null;
    try {
      throwIfAborted(signal);
      await sendDebuggerCommand(target, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
        button: "none",
        buttons: 0,
        pointerType: "mouse",
      });
      await sendDebuggerCommand(target, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: point.x,
        y: point.y,
        button: "left",
        buttons: 1,
        clickCount: 1,
        pointerType: "mouse",
      });
      await sendDebuggerCommand(target, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: point.x,
        y: point.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
        pointerType: "mouse",
      });
      await abortableDelay(ACTION_SETTLE_MS, signal);
      afterObservation = await endObservation(target, observation);
    } finally {
      if (!afterObservation) {
        await endObservation(target, observation).catch(() => undefined);
      }
    }

    const [receiver, afterState, documentChanged] = await Promise.all([
      summarizeElement(target, tabId, receiverId, store).catch(() => ({ tag: "detached" })),
      readElementState(target, element.backendNodeId).catch(() => null),
      hasDocumentChanged(target, document.documentId).catch(() => true),
    ]);
    const observed = actionObservation(observation.before, afterObservation, beforeState, afterState, documentChanged);
    return {
      action: "click",
      delivered: {
        method: "cdp",
        accepted: true,
        requested,
        receiver,
        point: roundedPoint(point),
      },
      observed,
      ...(observed.semanticChanged ? {} : {
        warning: "Chrome accepted the click input, but no observable page state change was detected. The page may have handled a no-op or an effect outside the observer.",
      }),
    };
  });
}

export async function typePageText(
  tabId: number,
  locator: PageLocator,
  text: string,
  signal?: AbortSignal,
  store: PageReferenceStore = pageReferences,
): Promise<Record<string, unknown>> {
  return await withDebugger(tabId, signal, async (target) => {
    const selected = await resolveElement(target, tabId, locator);
    await validateElementReference(target, selected);
    const document = await currentDocumentIdentity(target);
    const requested = await summarizeElement(
      target,
      tabId,
      selected.backendNodeId,
      store,
      selected.reference,
    );
    const editable = await resolveEditableElement(target, selected);
    const beforeState = await readElementState(target, editable.backendNodeId);
    if (!beforeState.editable) {
      throw new Error(`Element is not editable: ${formatLocator(locator)}`);
    }
    if (beforeState.disabled) {
      throw new Error("Editable element is disabled");
    }
    if (beforeState.readOnly) {
      throw new Error("Editable element is read-only");
    }

    await sendDebuggerCommand(target, "DOM.scrollIntoViewIfNeeded", {
      backendNodeId: editable.backendNodeId,
    });
    const point = await clickablePoint(target, editable.backendNodeId);
    const hitReceiverId = await hitTest(target, point);
    if (!await nodesRelated(target, editable.backendNodeId, hitReceiverId)) {
      const hitReceiver = await summarizeElement(target, tabId, hitReceiverId, store);
      throw new Error(`Editable target is occluded by ${formatElement(hitReceiver)}`);
    }
    await sendDebuggerCommand(target, "DOM.focus", {
      backendNodeId: editable.backendNodeId,
    });
    const observation = await beginObservation(target);
    let afterObservation: ObservationPoint | null = null;
    try {
      throwIfAborted(signal);
      await sendDebuggerCommand(target, "Input.insertText", { text });
      await abortableDelay(ACTION_SETTLE_MS, signal);
      afterObservation = await endObservation(target, observation);
    } finally {
      if (!afterObservation) {
        await endObservation(target, observation).catch(() => undefined);
      }
    }

    const [receiver, afterState, documentChanged] = await Promise.all([
      summarizeElement(target, tabId, editable.backendNodeId, store).catch(() => detachedSummary(editable)),
      readElementState(target, editable.backendNodeId).catch(() => null),
      hasDocumentChanged(target, document.documentId).catch(() => true),
    ]);
    const observed = actionObservation(observation.before, afterObservation, beforeState, afterState, documentChanged);
    return {
      action: "type",
      delivered: {
        method: "cdp",
        accepted: true,
        requested,
        receiver,
        point: roundedPoint(point),
        textLength: text.length,
      },
      observed,
      ...(afterState?.valueLength === beforeState.valueLength ? {
        warning: "Chrome accepted the text input, but the editable value length did not change. Replacing a selection with equal-length text can produce this result.",
      } : {}),
    };
  });
}

export async function sendPageKey(
  tabId: number,
  rawKey: string,
  signal?: AbortSignal,
  store: PageReferenceStore = pageReferences,
): Promise<Record<string, unknown>> {
  return await withDebugger(tabId, signal, async (target) => {
    const key = parseKey(rawKey);
    const focused = await activeElement(target);
    const beforeState = focused ? await readElementState(target, focused.backendNodeId).catch(() => null) : null;
    const receiver = focused
      ? await summarizeElement(target, tabId, focused.backendNodeId, store).catch(() => detachedSummary(focused))
      : null;
    const document = await currentDocumentIdentity(target);
    const observation = await beginObservation(target);
    let afterObservation: ObservationPoint | null = null;
    try {
      throwIfAborted(signal);
      // SAFETY: keyEvent produces a JSON debugger command payload.
      await sendDebuggerCommand(target, "Input.dispatchKeyEvent", keyEvent("down", key) as { [key: string]: ExtensionBoundaryValue });
      // SAFETY: keyEvent produces a JSON debugger command payload.
      await sendDebuggerCommand(target, "Input.dispatchKeyEvent", keyEvent("up", key) as { [key: string]: ExtensionBoundaryValue });
      await abortableDelay(ACTION_SETTLE_MS, signal);
      afterObservation = await endObservation(target, observation);
    } finally {
      if (!afterObservation) {
        await endObservation(target, observation).catch(() => undefined);
      }
    }

    const afterState = focused ? await readElementState(target, focused.backendNodeId).catch(() => null) : null;
    const documentChanged = await hasDocumentChanged(target, document.documentId).catch(() => true);
    const observed = actionObservation(observation.before, afterObservation, beforeState, afterState, documentChanged);
    return {
      action: "key",
      delivered: {
        method: "cdp",
        accepted: true,
        key: key.key,
        code: key.code,
        modifiers: key.modifierNames,
        receiver,
      },
      observed,
      ...(observed.semanticChanged ? {} : {
        warning: "Chrome accepted the key input for the reported receiver, but no observable page state change was detected. The page may have handled a no-op or an effect outside the observer.",
      }),
    };
  });
}

export async function scrollPage(
  tabId: number,
  scrollTarget: PageScrollTarget,
  reference: PageElementReference | null,
  signal?: AbortSignal,
  store: PageReferenceStore = pageReferences,
): Promise<Record<string, unknown>> {
  return await withDebugger(tabId, signal, async (target) => {
    const element = reference
      ? await resolveElement(target, tabId, { kind: "reference", reference })
      : null;
    if (element) {
      await validateElementReference(target, element);
    }

    const beforeState = element
      ? await readElementState(target, element.backendNodeId)
      : await readPageScrollState(target);
    if (scrollBoundaryReached(scrollTarget, beforeState)) {
      const targetSummary = element
        ? await summarizeElement(
            target,
            tabId,
            element.backendNodeId,
            store,
            element.reference,
          ).catch(() => detachedSummary(element))
        : { role: "document", tag: "document" };
      const position = scrollSummary(beforeState);
      return {
        action: "scroll",
        delivered: {
          method: "none",
          accepted: false,
          skipped: "already-at-boundary",
          target: targetSummary,
          events: 0,
          delta: { x: 0, y: 0 },
        },
        observed: {
          status: "no-change-detected",
          targetAttached: true,
          semanticChanged: false,
          scroll: {
            before: position,
            after: position,
            changed: false,
            boundaryReached: true,
          },
        },
      };
    }
    if (element) {
      await sendDebuggerCommand(target, "DOM.scrollIntoViewIfNeeded", {
        backendNodeId: element.backendNodeId,
      });
    }
    const document = await currentDocumentIdentity(target);
    const point = element
      ? await clickablePoint(target, element.backendNodeId)
      : await viewportCenter(target);
    const receiverId = await hitTest(target, point);
    if (element && !await nodesRelated(target, element.backendNodeId, receiverId)) {
      const receiver = await summarizeElement(target, tabId, receiverId, store);
      throw new Error(`Scroll target is occluded by ${formatElement(receiver)}`);
    }
    const observation = await beginObservation(target);
    let afterObservation: ObservationPoint | null = null;
    let aggregateDelta: InputPoint = { x: 0, y: 0 };
    let dispatchedEvents = 0;
    try {
      let currentState: ScrollState = beforeState;
      do {
        throwIfAborted(signal);
        const deltas = scrollDeltas(boundaryDirection(scrollTarget) ?? scrollTarget, currentState);
        await dispatchWheel(target, point, deltas);
        aggregateDelta = {
          x: aggregateDelta.x + deltas.x,
          y: aggregateDelta.y + deltas.y,
        };
        dispatchedEvents += 1;

        if (!boundaryDirection(scrollTarget) || scrollBoundaryReached(scrollTarget, currentState)) {
          break;
        }
        await abortableDelay(BOUNDARY_SCROLL_STEP_SETTLE_MS, signal);
        const nextState = element
          ? await readElementState(target, element.backendNodeId).catch(() => null)
          : await readPageScrollState(target).catch(() => null);
        if (!nextState || !scrollChanged(currentState, nextState)) {
          break;
        }
        currentState = nextState;
        if (scrollBoundaryReached(scrollTarget, currentState)) {
          break;
        }
      } while (dispatchedEvents < MAX_BOUNDARY_SCROLL_EVENTS);

      await abortableDelay(ACTION_SETTLE_MS, signal);
      afterObservation = await endObservation(target, observation);
    } finally {
      if (!afterObservation) {
        await endObservation(target, observation).catch(() => undefined);
      }
    }

    const afterState = element
      ? await readElementState(target, element.backendNodeId).catch(() => null)
      : await readPageScrollState(target).catch(() => null);
    const documentChanged = await hasDocumentChanged(target, document.documentId).catch(() => true);
    const observed = actionObservation(observation.before, afterObservation, beforeState, afterState, documentChanged);
    const changed = scrollChanged(beforeState, afterState);
    const boundaryReached = scrollBoundaryReached(scrollTarget, afterState);
    return {
      action: "scroll",
      delivered: {
        method: "cdp",
        accepted: true,
        target: element
          ? await summarizeElement(
              target,
              tabId,
              element.backendNodeId,
              store,
              element.reference,
            ).catch(() => detachedSummary(element))
          : { role: "document", tag: "document" },
        receiver: await summarizeElement(target, tabId, receiverId, store).catch(() => ({ tag: "unknown" })),
        point: roundedPoint(point),
        events: dispatchedEvents,
        delta: { x: Math.round(aggregateDelta.x), y: Math.round(aggregateDelta.y) },
      },
      observed: {
        ...observed,
        scroll: {
          before: scrollSummary(beforeState),
          after: scrollSummary(afterState),
          changed,
          ...(boundaryReached === null ? {} : { boundaryReached }),
        },
      },
      ...scrollWarning(changed, boundaryReached, scrollTarget, dispatchedEvents),
    };
  });
}

async function dispatchWheel(
  target: chrome.debugger.DebuggerSession,
  point: InputPoint,
  deltas: InputPoint,
): Promise<void> {
  await sendDebuggerCommand(target, "Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: point.x,
    y: point.y,
    deltaX: deltas.x,
    deltaY: deltas.y,
    pointerType: "mouse",
  });
}

function boundaryDirection(target: PageScrollTarget): "up" | "down" | null {
  if (target === "top") return "up";
  if (target === "bottom") return "down";
  return null;
}

function scrollBoundaryReached(target: PageScrollTarget, state: ScrollState | null): boolean | null {
  if (!state || (target !== "top" && target !== "bottom")) {
    return null;
  }
  const maxY = Math.max(0, state.scrollHeight - state.clientHeight);
  return target === "top" ? state.scrollTop <= 1 : state.scrollTop >= maxY - 1;
}

function scrollWarning(
  changed: boolean,
  boundaryReached: boolean | null,
  target: PageScrollTarget,
  events: number,
): { warning?: string } {
  if (boundaryReached === true || (changed && boundaryReached === null)) {
    return {};
  }
  if (boundaryReached === false) {
    return {
      warning: `Chrome accepted ${events} wheel event(s), but the target did not reach ${String(target)}. The receiver may be different or the event limit was reached.`,
    };
  }
  return {
    warning: "Chrome accepted the wheel input, but no scroll-position change was observed. The target may be at its limit or the receiver may be different.",
  };
}

async function withDebugger<T>(
  tabId: number,
  signal: AbortSignal | undefined,
  use: (target: chrome.debugger.DebuggerSession) => Promise<T>,
): Promise<T> {
  throwIfAborted(signal);
  const target = await acquireDebugger(tabId);
  try {
    throwIfAborted(signal);
    return await use(target);
  } finally {
    await releaseDebugger(tabId).catch((error: unknown) => {
      console.warn("GSV browser target failed to detach debugger", error);
    });
  }
}

async function resolveElement(
  target: chrome.debugger.DebuggerSession,
  tabId: number,
  locator: PageLocator,
): Promise<ResolvedElement> {
  if (locator.kind === "reference") {
    if (locator.reference.tabId !== tabId) {
      throw new Error(`Reference ${locator.reference.ref} belongs to tab ${locator.reference.tabId}, not tab ${tabId}`);
    }
    const document = await currentDocumentIdentity(target);
    if (document.documentId !== locator.reference.documentId) {
      throw new Error(`Reference ${locator.reference.ref} is stale because the page navigated. Run page snapshot again.`);
    }
    const element = await describeNode(target, { backendNodeId: locator.reference.backendNodeId });
    return { ...element, reference: locator.reference };
  }

  const document = await sendDebuggerCommand<DocumentResult>(target, "DOM.getDocument", {
    depth: 0,
    pierce: true,
  });
  if (typeof document.root?.nodeId !== "number") {
    throw new Error("Chrome did not return a DOM root");
  }
  const matches = await sendDebuggerCommand<QuerySelectorAllResult>(target, "DOM.querySelectorAll", {
    nodeId: document.root.nodeId,
    selector: locator.selector,
  });
  const nodeIds = matches.nodeIds ?? [];
  if (nodeIds.length === 0) {
    throw new Error(`No element matches selector: ${locator.selector}`);
  }
  const nodeId = nodeIds[locator.index];
  if (typeof nodeId !== "number") {
    throw new Error(`Selector matched ${nodeIds.length} element(s), index ${locator.index} is out of range`);
  }
  return await describeNode(target, { nodeId });
}

async function describeNode(
  target: chrome.debugger.DebuggerSession,
  locator: { nodeId?: number; backendNodeId?: number; objectId?: string },
): Promise<ResolvedElement> {
  const result = await sendDebuggerCommand<DescribeNodeResult>(target, "DOM.describeNode", {
    ...locator,
    depth: 0,
    pierce: true,
  });
  const node = result.node;
  if (typeof node?.backendNodeId !== "number") {
    throw new Error("The page element is detached or unavailable");
  }
  return {
    backendNodeId: node.backendNodeId,
    nodeId: node.nodeId,
    frameId: node.frameId,
    tag: (node.localName || node.nodeName || "element").toLowerCase(),
    attributes: attributeRecord(node.attributes),
  };
}

async function validateElementReference(
  target: chrome.debugger.DebuggerSession,
  element: ResolvedElement,
): Promise<void> {
  const reference = element.reference;
  if (!reference) {
    return;
  }
  const semantic = await semanticNode(target, element.backendNodeId).catch(() => null);
  if (!semantic) {
    return;
  }
  if (reference.role && semantic.role && reference.role !== semantic.role) {
    throw new Error(`Reference ${reference.ref} is stale because its role changed. Run page snapshot again.`);
  }
  if (reference.name && semantic.name && normalizeText(reference.name) !== normalizeText(semantic.name)) {
    throw new Error(`Reference ${reference.ref} is stale because its accessible name changed. Run page snapshot again.`);
  }
}

async function resolveEditableElement(
  target: chrome.debugger.DebuggerSession,
  element: ResolvedElement,
): Promise<ResolvedElement> {
  const remote = await resolveRemoteNode(target, element.backendNodeId);
  try {
    const result = await sendDebuggerCommand<RuntimeResult>(target, "Runtime.callFunctionOn", {
      objectId: remote.objectId,
      functionDeclaration: `function() {
        const textInput = (element) => element instanceof HTMLInputElement
          && !new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]).has((element.type || "text").toLowerCase());
        const editable = (element) => textInput(element)
          || element instanceof HTMLTextAreaElement
          || (element instanceof HTMLElement && element.isContentEditable);
        if (editable(this)) return this;
        const candidate = this.querySelector?.("input, textarea, [contenteditable=''], [contenteditable='true']");
        return candidate && editable(candidate) ? candidate : null;
      }`,
      returnByValue: false,
      silent: true,
    });
    if (!result.result?.objectId || result.result.subtype === "null") {
      throw new Error(`Element is not editable: ${element.reference?.ref ?? element.tag}`);
    }
    try {
      return await describeNode(target, { objectId: result.result.objectId });
    } finally {
      await releaseRemoteObject(target, result.result.objectId);
    }
  } finally {
    if (remote.objectId) {
      await releaseRemoteObject(target, remote.objectId);
    }
  }
}

async function clickablePoint(
  target: chrome.debugger.DebuggerSession,
  backendNodeId: number,
): Promise<Point> {
  const result = await sendDebuggerCommand<ContentQuadsResult>(target, "DOM.getContentQuads", {
    backendNodeId,
  });
  const candidates = (result.quads ?? [])
    .filter((quad) => quad.length >= 8 && quad.every(Number.isFinite))
    .map((quad) => ({ quad, area: quadArea(quad) }))
    .filter((candidate) => candidate.area > 1)
    .sort((left, right) => right.area - left.area);
  const quad = candidates[0]?.quad;
  if (!quad) {
    throw new Error("Element has no visible clickable area");
  }
  return {
    x: ((quad[0] ?? 0) + (quad[2] ?? 0) + (quad[4] ?? 0) + (quad[6] ?? 0)) / 4,
    y: ((quad[1] ?? 0) + (quad[3] ?? 0) + (quad[5] ?? 0) + (quad[7] ?? 0)) / 4,
  };
}

async function hitTest(target: chrome.debugger.DebuggerSession, point: Point): Promise<number> {
  const result = await sendDebuggerCommand<NodeForLocationResult>(target, "DOM.getNodeForLocation", {
    x: Math.round(point.x),
    y: Math.round(point.y),
    includeUserAgentShadowDOM: true,
    ignorePointerEventsNone: false,
  });
  if (typeof result.backendNodeId !== "number") {
    throw new Error("Chrome could not determine which element would receive the input");
  }
  return result.backendNodeId;
}

async function nodesRelated(
  target: chrome.debugger.DebuggerSession,
  leftBackendNodeId: number,
  rightBackendNodeId: number,
): Promise<boolean> {
  if (leftBackendNodeId === rightBackendNodeId) {
    return true;
  }
  const [left, right] = await Promise.all([
    resolveRemoteNode(target, leftBackendNodeId),
    resolveRemoteNode(target, rightBackendNodeId),
  ]);
  try {
    if (!left.objectId || !right.objectId) {
      return false;
    }
    const result = await sendDebuggerCommand<RuntimeResult>(target, "Runtime.callFunctionOn", {
      objectId: left.objectId,
      functionDeclaration: "function(other) { return this === other || this.contains(other) || other.contains(this); }",
      arguments: [{ objectId: right.objectId }],
      returnByValue: true,
      silent: true,
    });
    return result.result?.value === true;
  } finally {
    await Promise.all([
      left.objectId ? releaseRemoteObject(target, left.objectId) : Promise.resolve(),
      right.objectId ? releaseRemoteObject(target, right.objectId) : Promise.resolve(),
    ]);
  }
}

async function semanticNode(
  target: chrome.debugger.DebuggerSession,
  backendNodeId: number,
): Promise<{ role: string; name: string; states: Record<string, string | number | boolean> }> {
  const result = await sendDebuggerCommand<PartialAccessibilityTreeResult>(target, "Accessibility.getPartialAXTree", {
    backendNodeId,
    fetchRelatives: false,
  });
  const node = result.nodes?.find((candidate) => candidate.backendDOMNodeId === backendNodeId)
    ?? result.nodes?.[0];
  const states: Record<string, string | number | boolean> = {};
  for (const property of node?.properties ?? []) {
    const value = property.value?.value;
    if (property.name && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
      states[property.name] = value;
    }
  }
  return {
    role: normalizeRole(String(node?.role?.value ?? "")),
    name: normalizeText(String(node?.name?.value ?? "")),
    states,
  };
}

async function summarizeElement(
  target: chrome.debugger.DebuggerSession,
  tabId: number,
  backendNodeId: number,
  store: PageReferenceStore,
  preferredReference?: PageElementReference,
): Promise<ElementSummary> {
  const [element, semantic] = await Promise.all([
    describeNode(target, { backendNodeId }),
    semanticNode(target, backendNodeId).catch(() => ({ role: "", name: "", states: {} })),
  ]);
  const preferred = preferredReference?.tabId === tabId
    && preferredReference.backendNodeId === backendNodeId
    ? preferredReference
    : undefined;
  const ref = preferred?.ref ?? store.referenceFor(tabId, backendNodeId);
  const reference = preferred ?? (ref ? store.resolve(ref) : undefined);
  return {
    ...(ref ? { ref } : {}),
    tag: element.tag,
    ...(semantic.role || reference?.role ? { role: semantic.role || reference?.role } : {}),
    ...(semantic.name || reference?.name ? { name: semantic.name || reference?.name } : {}),
    ...(Object.keys(semantic.states).length > 0 ? { states: semantic.states } : {}),
  };
}

function detachedSummary(element: ResolvedElement): ElementSummary {
  return {
    ...(element.reference?.ref ? { ref: element.reference.ref } : {}),
    tag: "detached",
    ...(element.reference?.role ? { role: element.reference.role } : {}),
    ...(element.reference?.name ? { name: element.reference.name } : {}),
  };
}

async function resolveRemoteNode(
  target: chrome.debugger.DebuggerSession,
  backendNodeId: number,
): Promise<RemoteObject> {
  const result = await sendDebuggerCommand<{ object?: RemoteObject }>(target, "DOM.resolveNode", {
    backendNodeId,
  });
  if (!result.object?.objectId) {
    throw new Error("Chrome could not resolve the page element");
  }
  return result.object;
}

async function releaseRemoteObject(
  target: chrome.debugger.DebuggerSession,
  objectId: string,
): Promise<void> {
  await sendDebuggerCommand(target, "Runtime.releaseObject", { objectId }).catch(() => undefined);
}

async function readElementState(
  target: chrome.debugger.DebuggerSession,
  backendNodeId: number,
): Promise<ElementState> {
  const remote = await resolveRemoteNode(target, backendNodeId);
  try {
    return await callFunctionValue<ElementState>(target, remote.objectId!, `function() {
      const input = this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement;
      const editable = input || (this instanceof HTMLElement && this.isContentEditable);
      const details = this instanceof HTMLDetailsElement ? this.open : undefined;
      return {
        connected: Boolean(this.isConnected),
        tag: String(this.tagName || this.nodeName || "element").toLowerCase(),
        focused: document.activeElement === this,
        disabled: Boolean(this.disabled || this.getAttribute?.("aria-disabled") === "true"),
        readOnly: Boolean(this.readOnly || this.getAttribute?.("aria-readonly") === "true"),
        editable,
        valueLength: input ? this.value.length : editable ? (this.innerText || this.textContent || "").length : undefined,
        checked: typeof this.checked === "boolean" ? this.checked : undefined,
        selected: typeof this.selected === "boolean" ? this.selected : undefined,
        expanded: this.hasAttribute?.("aria-expanded")
          ? this.getAttribute("aria-expanded") === "true"
          : details,
        scrollLeft: Number(this.scrollLeft || 0),
        scrollTop: Number(this.scrollTop || 0),
        scrollWidth: Number(this.scrollWidth || 0),
        scrollHeight: Number(this.scrollHeight || 0),
        clientWidth: Number(this.clientWidth || 0),
        clientHeight: Number(this.clientHeight || 0)
      };
    }`);
  } finally {
    await releaseRemoteObject(target, remote.objectId!);
  }
}

async function activeElement(
  target: chrome.debugger.DebuggerSession,
): Promise<ResolvedElement | null> {
  const result = await sendDebuggerCommand<RuntimeResult>(target, "Runtime.evaluate", {
    expression: "document.activeElement",
    returnByValue: false,
    silent: true,
  });
  const objectId = result.result?.objectId;
  if (!objectId || result.result?.subtype === "null") {
    return null;
  }
  try {
    return await describeNode(target, { objectId });
  } finally {
    await releaseRemoteObject(target, objectId);
  }
}

async function callFunctionValue<T>(
  target: chrome.debugger.DebuggerSession,
  objectId: string,
  functionDeclaration: string,
): Promise<T> {
  const result = await sendDebuggerCommand<RuntimeResult>(target, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration,
    returnByValue: true,
    silent: true,
  });
  if (result.exceptionDetails) {
    throw new Error(runtimeError(result));
  }
  return result.result?.value as T;
}

function attributeRecord(attributes: string[] | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  for (let index = 0; index < (attributes?.length ?? 0); index += 2) {
    const name = attributes?.[index];
    if (name) {
      record[name] = attributes?.[index + 1] ?? "";
    }
  }
  return record;
}

function normalizeRole(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replaceAll("_", "-")
    .toLowerCase()
    .replace(/^root-web-area$/, "document")
    .replace(/^static-text$/, "text");
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function quadArea(quad: number[]): number {
  let area = 0;
  for (let index = 0; index < 4; index += 1) {
    const next = (index + 1) % 4;
    area += (quad[index * 2] ?? 0) * (quad[next * 2 + 1] ?? 0)
      - (quad[next * 2] ?? 0) * (quad[index * 2 + 1] ?? 0);
  }
  return Math.abs(area / 2);
}

function roundedPoint(point: Point): Point {
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

function runtimeError(result: RuntimeResult): string {
  const exception = result.exceptionDetails?.exception;
  return String(exception?.description ?? exception?.value ?? result.exceptionDetails?.text ?? "Page evaluation failed");
}

function formatLocator(locator: PageLocator): string {
  return locator.kind === "reference" ? locator.reference.ref : locator.selector;
}

function formatElement(element: ElementSummary): string {
  return [element.role || element.tag, element.ref, element.name ? JSON.stringify(element.name) : ""]
    .filter(Boolean)
    .join(" ");
}
