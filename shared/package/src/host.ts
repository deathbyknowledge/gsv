import {
  OPEN_APP_EVENT,
  buildOpenAppRoute,
  type OpenAppRequest,
} from "@gsv/app-link";

export type HostStatus = {
  connected: boolean;
};

export type HostSignalHandler = (signal: string, payload: unknown) => void;
export type HostStatusHandler = (status: HostStatus) => void;

export type {
  ChatOpenPayload,
  FilesOpenPayload,
  OpenAppRequest,
  ShellOpenPayload,
  ThreadContext,
  WikiOpenPayload,
} from "@gsv/app-link";

export type HostClient = {
  getStatus(): HostStatus;
  onSignal(listener: HostSignalHandler): () => void;
  onStatus(listener: HostStatusHandler): () => void;
  request<T = unknown>(call: string, args?: unknown): Promise<T>;
  spawnProcess(args: unknown): Promise<unknown>;
  sendMessage(message: string, pid?: string): Promise<unknown>;
  getHistory(limit: number, pid?: string, offset?: number): Promise<unknown>;
};

const PENDING_APP_OPEN_KEY = "__gsvPendingAppOpenRequests";

type PendingAppOpenStore = Map<string, OpenAppRequest>;

declare global {
  interface Window {
    [PENDING_APP_OPEN_KEY]?: PendingAppOpenStore;
  }
}

export function consumePendingAppOpen(windowId?: string): OpenAppRequest | null {
  const fallbackWindowId = new URL(window.location.href).searchParams.get("windowId")?.trim() || "";
  const normalizedWindowId = windowId?.trim() || fallbackWindowId;
  if (!normalizedWindowId) {
    return null;
  }

  try {
    const store = window.parent?.[PENDING_APP_OPEN_KEY];
    if (store instanceof Map) {
      const request = store.get(normalizedWindowId) ?? null;
      if (request) {
        store.delete(normalizedWindowId);
      }
      return request as OpenAppRequest | null;
    }
  } catch {
    // Ignore cross-window access failures outside the shell host.
  }

  return null;
}

export function openApp(request: OpenAppRequest): void {
  const detail = { request };
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: OPEN_APP_EVENT, detail }, window.location.origin);
      window.parent.dispatchEvent(new CustomEvent(OPEN_APP_EVENT, { detail }));
      return;
    }
  } catch {
    // Fall back to same-window navigation outside the shell host.
  }
  window.location.href = buildOpenAppRoute(request, window.location.href);
}

export async function connectHost(): Promise<HostClient> {
  throw new Error("HOST runtime is not wired in this local package yet");
}
