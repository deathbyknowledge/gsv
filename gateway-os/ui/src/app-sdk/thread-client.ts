import {
  getActiveThreadContext,
  normalizeThreadContext,
  setActiveThreadContext,
  subscribeActiveThreadContext,
  type ThreadContext,
} from "../thread-context";

export type AppWorkspaceSnapshot = {
  id: string;
  rootPath: string;
};

export type AppThreadSnapshot = ThreadContext & {
  workspace: AppWorkspaceSnapshot | null;
};

export type AppThreadClient = {
  current: () => AppThreadSnapshot | null;
  require: () => AppThreadSnapshot;
  subscribe: (listener: (thread: AppThreadSnapshot | null) => void) => () => void;
  activate: (thread: ThreadContext | null) => void;
};

export function resolveWorkspaceRootPath(workspaceId: string | null | undefined): string | null {
  const normalized = typeof workspaceId === "string" ? workspaceId.trim() : "";
  if (!normalized) {
    return null;
  }
  return `/workspaces/${normalized}`;
}

function toThreadSnapshot(thread: ThreadContext | null): AppThreadSnapshot | null {
  if (!thread) {
    return null;
  }

  const workspaceRoot = resolveWorkspaceRootPath(thread.workspaceId);
  return {
    ...thread,
    workspace: thread.workspaceId && workspaceRoot ? { id: thread.workspaceId, rootPath: workspaceRoot } : null,
  };
}

export function normalizeAppThreadSnapshot(value: unknown): AppThreadSnapshot | null {
  return toThreadSnapshot(normalizeThreadContext(value));
}

export function createThreadClient(): AppThreadClient {
  return {
    current: () => toThreadSnapshot(getActiveThreadContext()),
    require: () => {
      const thread = toThreadSnapshot(getActiveThreadContext());
      if (!thread) {
        throw new Error("App requires an active thread. Open it from Chat or activate a thread first.");
      }
      return thread;
    },
    subscribe: (listener) =>
      subscribeActiveThreadContext((thread) => {
        listener(toThreadSnapshot(thread));
      }),
    activate: (thread) => {
      setActiveThreadContext(normalizeThreadContext(thread));
    },
  };
}
