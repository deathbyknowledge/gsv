export const DEBUGGER_PROTOCOL_VERSION = "1.3";
import { isNumber } from "./schemas";

type DebuggerEventListener = (
  source: chrome.debugger.DebuggerSession,
  method: string,
  params?: DebuggerEventParams,
) => void;

type DebuggerEventParams = { [key: string]: ExtensionBoundaryValue };

type DebuggerDetachListener = (
  source: chrome.debugger.Debuggee,
  reason: `${chrome.debugger.DetachReason}`,
) => void;

type DebuggerSessionRecord = {
  target: chrome.debugger.DebuggerSession;
  refCount: number;
  detaching?: Promise<void>;
};

const sessions = new Map<number, DebuggerSessionRecord>();
const eventListeners = new Set<DebuggerEventListener>();
const detachListeners = new Set<DebuggerDetachListener>();
let registeredChromeListeners = false;

export async function acquireDebugger(tabId: number): Promise<chrome.debugger.DebuggerSession> {
  ensureChromeListeners();
  const existing = sessions.get(tabId);
  if (existing) {
    if (existing.detaching) {
      await existing.detaching;
      return await acquireDebugger(tabId);
    }
    existing.refCount += 1;
    return existing.target;
  }

  const target: chrome.debugger.DebuggerSession = { tabId };
  await requireDebuggerApi().attach(target, DEBUGGER_PROTOCOL_VERSION);
  sessions.set(tabId, { target, refCount: 1 });
  return target;
}

export async function releaseDebugger(tabId: number): Promise<void> {
  const existing = sessions.get(tabId);
  if (!existing) {
    return;
  }

  if (existing.detaching) {
    await existing.detaching;
    return;
  }
  if (existing.refCount > 1) {
    existing.refCount -= 1;
    return;
  }

  await detachSession(tabId, existing);
}

export async function sendDebuggerCommand<T extends object | undefined = object | undefined>(
  target: chrome.debugger.DebuggerSession,
  method: string,
  commandParams?: { [key: string]: ExtensionBoundaryValue },
): Promise<T> {
  // SAFETY: Chrome debugger returns the protocol response for the requested method; callers provide its T.
  return await requireDebuggerApi().sendCommand(target, method, commandParams) as T;
}

export function addDebuggerEventListener(listener: DebuggerEventListener): () => void {
  ensureChromeListeners();
  eventListeners.add(listener);
  return () => {
    eventListeners.delete(listener);
  };
}

export function addDebuggerDetachListener(listener: DebuggerDetachListener): () => void {
  ensureChromeListeners();
  detachListeners.add(listener);
  return () => {
    detachListeners.delete(listener);
  };
}

export function isDebuggerAttached(tabId: number): boolean {
  return sessions.has(tabId);
}

export function debuggerTabs(): number[] {
  return Array.from(sessions.keys()).sort((left, right) => left - right);
}

export async function releaseAllDebuggers(): Promise<number[]> {
  const entries = [...sessions.entries()];
  const results = await Promise.allSettled(entries.map(async ([tabId, session]) => {
    await detachSession(tabId, session);
  }));
  const failures = results.flatMap((result, index) => result.status === "rejected"
    ? [`tab ${entries[index][0]}: ${String(result.reason)}`]
    : []);
  if (failures.length > 0) {
    throw new Error(`Could not detach debugger from ${failures.join("; ")}`);
  }
  return entries.map(([tabId]) => tabId);
}

async function detachSession(tabId: number, session: DebuggerSessionRecord): Promise<void> {
  if (sessions.get(tabId) !== session) {
    return;
  }
  if (session.detaching) {
    await session.detaching;
    return;
  }
  session.detaching = Promise.resolve(requireDebuggerApi().detach(session.target)).then(
    () => {
      if (sessions.get(tabId) === session) sessions.delete(tabId);
    },
    (error) => {
      // Chrome's onDetach event may have confirmed an external detach before the API rejected.
      if (sessions.get(tabId) === session) throw error;
    },
  );
  try {
    await session.detaching;
  } finally {
    session.detaching = undefined;
  }
}

function ensureChromeListeners(): void {
  if (registeredChromeListeners) {
    return;
  }
  registeredChromeListeners = true;

  requireDebuggerApi().onEvent.addListener((source, method, params) => {
    for (const listener of eventListeners) {
      // SAFETY: Chrome debugger event parameters are JSON objects by protocol contract.
      listener(source, method, params as DebuggerEventParams);
    }
  });

  requireDebuggerApi().onDetach.addListener((source, reason) => {
    if (isNumber(source.tabId)) {
      sessions.delete(source.tabId);
    }
    for (const listener of detachListeners) {
      listener(source, reason);
    }
  });
}

function requireDebuggerApi(): typeof chrome.debugger {
  if (!globalThis.chrome?.debugger) {
    throw new Error("chrome.debugger is unavailable; check the debugger permission.");
  }
  return chrome.debugger;
}
