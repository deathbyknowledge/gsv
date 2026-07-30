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
    const record = { mutations: 0, observer: null };
    record.observer = new MutationObserver((entries) => { record.mutations += entries.length; });
    record.observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true
    });
    globalThis[key] = record;
    return { url: location.href, focus: focus(), mutations: 0 };
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
      return {
        url: location.href,
        focus: element ? {
          tag: String(element.tagName || element.nodeName || "element").toLowerCase(),
          role: element.getAttribute?.("role") || undefined,
          name
        } : null,
        mutations: typeof record?.mutations === "number" ? record.mutations : null
      };
    })()`);
  } catch {
    // A navigation or tab close can destroy the observed execution context.
    return { url: session.before.url, focus: null, mutations: null };
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
  const targetStateChanged = JSON.stringify(relevantState(beforeState)) !== JSON.stringify(relevantState(afterState));
  const mutationCount = after.mutations;
  const semanticChanged = documentChanged
    || urlChanged
    || focusChanged
    || targetStateChanged
    || (typeof mutationCount === "number" && mutationCount > 0);
  return {
    documentChanged,
    urlChanged,
    focusChanged,
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
