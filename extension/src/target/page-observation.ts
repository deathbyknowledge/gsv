import { sendDebuggerCommand } from "../shared/debugger";
import { currentDocumentIdentity } from "./page-semantics";
import type { ScrollState } from "./page-input";

type RemoteObject = {
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

export type ObservationFocus = {
  tag: string;
  role?: string;
  name?: string;
};

export type ObservationPoint = {
  url: string;
  focus: ObservationFocus | null;
  mutations: number | null;
  selection?: string | null;
};

export type ObservationSession = {
  key: string;
  before: ObservationPoint;
};

export type ObservableTargetState = ScrollState & {
  connected?: boolean;
  focused?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  editable?: boolean;
  valueLength?: number;
  checked?: boolean;
  selected?: boolean;
  expanded?: boolean;
};

export async function beginPageObservation(
  target: chrome.debugger.DebuggerSession,
): Promise<ObservationSession> {
  const key = `__gsvObservation_${randomObservationToken()}`;
  const before = await evaluateValue<ObservationPoint>(target, `(() => {
    const key = ${JSON.stringify(key)};
    const focus = () => {
      const element = document.activeElement;
      if (!element) return null;
      const name = element.getAttribute?.("aria-label")
        || element.getAttribute?.("name")
        || element.getAttribute?.("placeholder")
        || element.getAttribute?.("title")
        || undefined;
      return {
        tag: String(element.tagName || element.nodeName || "element").toLowerCase(),
        role: element.getAttribute?.("role") || undefined,
        name
      };
    };
    const selection = () => {
      const element = document.activeElement;
      if (element && typeof element.selectionStart === "number") {
        return ["control", element.selectionStart, element.selectionEnd, element.selectionDirection].join(":");
      }
      const selected = globalThis.getSelection?.();
      if (!selected || selected.rangeCount === 0) return null;
      const path = (node) => {
        const parts = [];
        let current = node;
        while (current && current !== document && parts.length < 16) {
          const parent = current.parentNode;
          if (!parent) break;
          parts.push(Array.prototype.indexOf.call(parent.childNodes, current));
          current = parent;
        }
        return parts.reverse().join(".");
      };
      return [
        "document",
        path(selected.anchorNode),
        selected.anchorOffset,
        path(selected.focusNode),
        selected.focusOffset,
        selected.isCollapsed
      ].join(":");
    };
    const record = { mutations: 0, observer: null };
    record.observer = new MutationObserver((entries) => { record.mutations += entries.length; });
    record.observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true
    });
    globalThis[key] = record;
    return { url: location.href, focus: focus(), mutations: 0, selection: selection() };
  })()`);
  return { key, before };
}

export async function endPageObservation(
  target: chrome.debugger.DebuggerSession,
  session: ObservationSession,
): Promise<ObservationPoint> {
  try {
    return await evaluateValue<ObservationPoint>(target, `(() => {
      const key = ${JSON.stringify(session.key)};
      const record = globalThis[key];
      record?.observer?.disconnect();
      delete globalThis[key];
      const element = document.activeElement;
      const name = element?.getAttribute?.("aria-label")
        || element?.getAttribute?.("name")
        || element?.getAttribute?.("placeholder")
        || element?.getAttribute?.("title")
        || undefined;
      const selection = (() => {
        if (element && typeof element.selectionStart === "number") {
          return ["control", element.selectionStart, element.selectionEnd, element.selectionDirection].join(":");
        }
        const selected = globalThis.getSelection?.();
        if (!selected || selected.rangeCount === 0) return null;
        const path = (node) => {
          const parts = [];
          let current = node;
          while (current && current !== document && parts.length < 16) {
            const parent = current.parentNode;
            if (!parent) break;
            parts.push(Array.prototype.indexOf.call(parent.childNodes, current));
            current = parent;
          }
          return parts.reverse().join(".");
        };
        return [
          "document",
          path(selected.anchorNode),
          selected.anchorOffset,
          path(selected.focusNode),
          selected.focusOffset,
          selected.isCollapsed
        ].join(":");
      })();
      return {
        url: location.href,
        focus: element ? {
          tag: String(element.tagName || element.nodeName || "element").toLowerCase(),
          role: element.getAttribute?.("role") || undefined,
          name
        } : null,
        mutations: typeof record?.mutations === "number" ? record.mutations : null,
        selection
      };
    })()`);
  } catch {
    // A navigation or tab close can destroy the observed execution context.
    return { url: session.before.url, focus: null, mutations: null, selection: null };
  }
}

export function summarizeActionObservation(
  before: ObservationPoint,
  after: ObservationPoint,
  beforeState: ObservableTargetState | null,
  afterState: ObservableTargetState | null,
  documentChanged: boolean,
): Record<string, unknown> & { semanticChanged: boolean } {
  const urlChanged = before.url !== after.url;
  const focusChanged = JSON.stringify(before.focus) !== JSON.stringify(after.focus);
  const selectionChanged = (before.selection ?? null) !== (after.selection ?? null);
  const targetStateChanged = JSON.stringify(relevantState(beforeState)) !== JSON.stringify(relevantState(afterState));
  const mutationCount = after.mutations;
  const semanticChanged = documentChanged
    || urlChanged
    || focusChanged
    || selectionChanged
    || targetStateChanged
    || (typeof mutationCount === "number" && mutationCount > 0);
  return {
    documentChanged,
    status: semanticChanged ? "changed" : "no-change-detected",
    urlChanged,
    focusChanged,
    selectionChanged,
    mutationCount,
    targetAttached: afterState !== null,
    targetStateChanged,
    semanticChanged,
    focus: after.focus,
  };
}

export async function pageDocumentChanged(
  target: chrome.debugger.DebuggerSession,
  documentId: string | undefined,
): Promise<boolean> {
  if (!documentId) {
    return false;
  }
  return (await currentDocumentIdentity(target)).documentId !== documentId;
}

async function evaluateValue<T>(
  target: chrome.debugger.DebuggerSession,
  expression: string,
): Promise<T> {
  const result = await sendDebuggerCommand<RuntimeResult>(target, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    silent: true,
  });
  if (result.exceptionDetails) {
    const exception = result.exceptionDetails.exception;
    throw new Error(String(
      exception?.description
        ?? exception?.value
        ?? result.exceptionDetails.text
        ?? "Page evaluation failed",
    ));
  }
  return result.result?.value as T;
}

function relevantState(state: ObservableTargetState | null): Record<string, unknown> | null {
  if (!state) {
    return null;
  }
  return {
    connected: state.connected,
    focused: state.focused,
    disabled: state.disabled,
    readOnly: state.readOnly,
    editable: state.editable,
    valueLength: state.valueLength,
    checked: state.checked,
    selected: state.selected,
    expanded: state.expanded,
    scrollLeft: Math.round(state.scrollLeft),
    scrollTop: Math.round(state.scrollTop),
  };
}

function randomObservationToken(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(36).padStart(2, "0")).join("");
}
