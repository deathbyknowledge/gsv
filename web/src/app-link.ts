import {
  OPEN_APP_EVENT,
  resolveOpenAppDetail as resolveOpenAppDetailBase,
  type OpenAppEventDetail,
  type OpenAppRequest,
  type ResolvedOpenAppDetail,
} from "@gsv/app-link";

const PENDING_APP_OPEN_KEY = "__gsvPendingAppOpenRequests";

type PendingAppOpenStore = Map<string, OpenAppRequest>;

declare global {
  interface Window {
    [PENDING_APP_OPEN_KEY]?: PendingAppOpenStore;
  }
}

export { OPEN_APP_EVENT };
export type {
  ChatOpenPayload,
  FilesOpenPayload,
  OpenAppEventDetail,
  OpenAppRequest,
  ResolvedOpenAppDetail,
  ShellOpenPayload,
  ThreadContext,
  WikiOpenPayload,
} from "@gsv/app-link";

function getPendingStore(): PendingAppOpenStore {
  const existing = window[PENDING_APP_OPEN_KEY];
  if (existing instanceof Map) {
    return existing;
  }

  const created = new Map<string, OpenAppRequest>();
  window[PENDING_APP_OPEN_KEY] = created;
  return created;
}

export function queuePendingAppOpen(windowId: string, request: OpenAppRequest): void {
  const normalizedWindowId = windowId.trim();
  if (!normalizedWindowId) {
    return;
  }
  getPendingStore().set(normalizedWindowId, request);
}

export function consumePendingAppOpen(windowId: string): OpenAppRequest | null {
  const normalizedWindowId = windowId.trim();
  if (!normalizedWindowId) {
    return null;
  }
  const store = getPendingStore();
  const request = store.get(normalizedWindowId) ?? null;
  if (request) {
    store.delete(normalizedWindowId);
  }
  return request;
}

export function resolveOpenAppDetail(detail: OpenAppEventDetail | null | undefined): ResolvedOpenAppDetail | null {
  return resolveOpenAppDetailBase(detail, window.location.href);
}
