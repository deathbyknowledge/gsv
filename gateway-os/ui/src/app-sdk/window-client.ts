import {
  APP_WINDOW_ACTION_EVENT,
  OPEN_APP_EVENT,
  type AppWindowAction,
  type AppWindowActionEventDetail,
  type OpenAppEventDetail,
} from "../app-link";
import { getActiveThreadContext, normalizeThreadContext, type ThreadContext } from "../thread-context";
import type { AppManifest } from "./manifest";

export type AppWindowOpenOptions = {
  thread?: ThreadContext | "current" | null;
};

export type AppWindowClient = {
  id: string;
  manifest: AppManifest;
  openApp: (appId: string, options?: AppWindowOpenOptions) => void;
  dispatchAction: (action: AppWindowAction) => void;
  focus: () => void;
  close: () => void;
  minimize: () => void;
  maximize: () => void;
  restart: () => void;
};

function resolveThreadContext(thread: ThreadContext | "current" | null | undefined): ThreadContext | null {
  if (thread === undefined || thread === "current") {
    return getActiveThreadContext();
  }

  return normalizeThreadContext(thread);
}

function dispatchWindowAction(detail: AppWindowActionEventDetail): void {
  window.dispatchEvent(new CustomEvent<AppWindowActionEventDetail>(APP_WINDOW_ACTION_EVENT, { detail }));
}

export function createWindowClient(manifest: AppManifest, windowId: string): AppWindowClient {
  return {
    id: windowId,
    manifest,
    openApp: (appId, options) => {
      const detail: OpenAppEventDetail = { appId };
      const threadContext = resolveThreadContext(options?.thread);
      if (threadContext) {
        detail.threadContext = threadContext;
      }

      window.dispatchEvent(new CustomEvent<OpenAppEventDetail>(OPEN_APP_EVENT, { detail }));
    },
    dispatchAction: (action) => {
      dispatchWindowAction({ windowId, action });
    },
    focus: () => {
      dispatchWindowAction({ windowId, action: "focus" });
    },
    close: () => {
      dispatchWindowAction({ windowId, action: "close" });
    },
    minimize: () => {
      dispatchWindowAction({ windowId, action: "minimize" });
    },
    maximize: () => {
      dispatchWindowAction({ windowId, action: "maximize" });
    },
    restart: () => {
      dispatchWindowAction({ windowId, action: "restart" });
    },
  };
}
