import { normalizeThreadContext, type ThreadContext } from "./thread-context";

export const OPEN_APP_EVENT = "gsv:open-app";

export type FilesOpenPayload = {
  device?: string;
  path?: string;
  open?: string;
  q?: string;
  context?: ThreadContext | null;
};

export type ShellOpenPayload = {
  device?: string;
  workdir?: string;
  context?: ThreadContext | null;
};

export type ChatOpenPayload = {
  pid: string;
  workspaceId?: string | null;
  cwd: string;
};

export type WikiOpenPayload = {
  db?: string;
  path?: string;
  mode?: "browse" | "edit" | "build" | "ingest" | "inbox";
};

export type OpenAppRequest =
  | { target: "files"; payload?: FilesOpenPayload }
  | { target: "shell"; payload?: ShellOpenPayload }
  | { target: "chat"; payload: ChatOpenPayload }
  | { target: "wiki"; payload?: WikiOpenPayload }
  | { target: string; payload?: { route?: string } };

export type OpenAppEventDetail = {
  request?: OpenAppRequest | null;
  appId?: string;
  route?: string;
  threadContext?: ThreadContext | null;
};

export type ResolvedOpenAppDetail =
  | {
      type: "app";
      appId: string;
      route?: string;
      threadContext?: ThreadContext | null;
    }
  | {
      type: "chat-process";
      threadContext: ThreadContext;
    };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function writeParam(url: URL, key: string, value: string | undefined): void {
  const normalized = value?.trim();
  if (normalized) {
    url.searchParams.set(key, normalized);
  } else {
    url.searchParams.delete(key);
  }
}

function buildFilesRoute(payload: Record<string, unknown> | null): string {
  const context = normalizeThreadContext(payload?.context);
  const url = new URL("/apps/files", window.location.href);
  writeParam(url, "target", asString(payload?.device) ?? undefined);
  writeParam(url, "path", asString(payload?.path) ?? context?.cwd ?? undefined);
  writeParam(url, "open", asString(payload?.open) ?? undefined);
  writeParam(url, "q", asString(payload?.q) ?? undefined);
  return `${url.pathname}${url.search}`;
}

function buildShellRoute(payload: Record<string, unknown> | null): string {
  const context = normalizeThreadContext(payload?.context);
  const url = new URL("/apps/shell", window.location.href);
  writeParam(url, "target", asString(payload?.device) ?? undefined);
  writeParam(url, "workdir", asString(payload?.workdir) ?? context?.cwd ?? undefined);
  return `${url.pathname}${url.search}`;
}

function buildWikiRoute(payload: Record<string, unknown> | null): string {
  const url = new URL("/apps/wiki", window.location.href);
  writeParam(url, "db", asString(payload?.db) ?? undefined);
  writeParam(url, "path", asString(payload?.path) ?? undefined);
  writeParam(url, "mode", asString(payload?.mode) ?? undefined);
  return `${url.pathname}${url.search}`;
}

function resolveOpenAppRequest(request: OpenAppRequest | null | undefined): ResolvedOpenAppDetail | null {
  const record = asRecord(request);
  if (!record) {
    return null;
  }
  const target = asString(record.target)?.trim() || "";
  if (!target) {
    return null;
  }
  const payload = asRecord(record.payload);
  if (target === "chat") {
    const threadContext = normalizeThreadContext(payload);
    if (threadContext) {
      return {
        type: "chat-process",
        threadContext,
      };
    }
    const route = asString(payload?.route)?.trim();
    return {
      type: "app",
      appId: "chat",
      route: route || undefined,
    };
  }
  if (target === "files") {
    return {
      type: "app",
      appId: "files",
      route: buildFilesRoute(payload),
      threadContext: normalizeThreadContext(payload?.context),
    };
  }
  if (target === "shell") {
    return {
      type: "app",
      appId: "shell",
      route: buildShellRoute(payload),
      threadContext: normalizeThreadContext(payload?.context),
    };
  }
  if (target === "wiki") {
    return {
      type: "app",
      appId: "wiki",
      route: buildWikiRoute(payload),
    };
  }
  const route = asString(payload?.route)?.trim();
  return {
    type: "app",
    appId: target,
    route: route || undefined,
  };
}

export function resolveOpenAppDetail(detail: OpenAppEventDetail | null | undefined): ResolvedOpenAppDetail | null {
  const fromRequest = resolveOpenAppRequest(detail?.request);
  if (fromRequest) {
    return fromRequest;
  }
  const appId = typeof detail?.appId === "string" ? detail.appId.trim() : "";
  if (!appId) {
    return null;
  }
  const route = typeof detail?.route === "string" && detail.route.trim().length > 0 ? detail.route.trim() : undefined;
  return {
    type: "app",
    appId,
    route,
    threadContext: normalizeThreadContext(detail?.threadContext),
  };
}
