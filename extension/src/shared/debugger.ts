export const DEBUGGER_PROTOCOL_VERSION = "1.3";

type DebuggerEventListener = (
  source: chrome.debugger.DebuggerSession,
  method: string,
  params?: object,
) => void;

type DebuggerSessionRecord = {
  target: chrome.debugger.DebuggerSession;
  refCount: number;
};

const sessions = new Map<number, DebuggerSessionRecord>();
const eventListeners = new Set<DebuggerEventListener>();
let registeredChromeListeners = false;

export async function acquireDebugger(tabId: number): Promise<chrome.debugger.DebuggerSession> {
  ensureChromeListeners();
  const existing = sessions.get(tabId);
  if (existing) {
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

  existing.refCount -= 1;
  if (existing.refCount > 0) {
    return;
  }

  sessions.delete(tabId);
  await requireDebuggerApi().detach(existing.target);
}

export async function sendDebuggerCommand<T extends object | undefined = object | undefined>(
  target: chrome.debugger.DebuggerSession,
  method: string,
  commandParams?: Record<string, unknown>,
): Promise<T> {
  return await requireDebuggerApi().sendCommand(target, method, commandParams) as T;
}

export function addDebuggerEventListener(listener: DebuggerEventListener): () => void {
  ensureChromeListeners();
  eventListeners.add(listener);
  return () => {
    eventListeners.delete(listener);
  };
}

export function isDebuggerAttached(tabId: number): boolean {
  return sessions.has(tabId);
}

export function debuggerTabs(): number[] {
  return Array.from(sessions.keys()).sort((left, right) => left - right);
}

export async function releaseAllDebuggers(): Promise<number[]> {
  const tabIds = debuggerTabs();
  await Promise.all(tabIds.map(async (tabId) => {
    const existing = sessions.get(tabId);
    sessions.delete(tabId);
    if (!existing) {
      return;
    }
    await requireDebuggerApi().detach(existing.target).catch(() => undefined);
  }));
  return tabIds;
}

function ensureChromeListeners(): void {
  if (registeredChromeListeners) {
    return;
  }
  registeredChromeListeners = true;

  requireDebuggerApi().onEvent.addListener((source, method, params) => {
    for (const listener of eventListeners) {
      listener(source, method, params);
    }
  });

  requireDebuggerApi().onDetach.addListener((source) => {
    if (typeof source.tabId === "number") {
      sessions.delete(source.tabId);
    }
  });
}

function requireDebuggerApi(): typeof chrome.debugger {
  if (typeof chrome === "undefined" || !chrome.debugger) {
    throw new Error("chrome.debugger is unavailable; check the debugger permission.");
  }
  return chrome.debugger;
}
