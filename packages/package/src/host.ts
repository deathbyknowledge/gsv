export type HostStatus = {
  connected: boolean;
};

export type HostSignalHandler = (signal: string, payload: unknown) => void;
export type HostStatusHandler = (status: HostStatus) => void;

export type ThreadContext = {
  pid: string;
  workspaceId: string | null;
  cwd: string;
};

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

export type HostClient = {
  getStatus(): HostStatus;
  onSignal(listener: HostSignalHandler): () => void;
  onStatus(listener: HostStatusHandler): () => void;
  request<T = unknown>(call: string, args?: unknown): Promise<T>;
  spawnProcess(args: unknown): Promise<unknown>;
  sendMessage(message: string, pid?: string): Promise<unknown>;
  getHistory(limit: number, pid?: string, offset?: number): Promise<unknown>;
};

const OPEN_APP_EVENT = "gsv:open-app";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizeThreadContext(value: unknown): ThreadContext | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const pid = asString(record.pid)?.trim() || "";
  const cwd = asString(record.cwd)?.trim() || "";
  const workspaceId = asString(record.workspaceId)?.trim() || null;
  if (!pid || !cwd) {
    return null;
  }
  return { pid, cwd, workspaceId };
}

function writeParam(url: URL, key: string, value: string | undefined): void {
  const normalized = value?.trim();
  if (normalized) {
    url.searchParams.set(key, normalized);
  } else {
    url.searchParams.delete(key);
  }
}

function buildFallbackRoute(request: OpenAppRequest): string {
  const target = String(request.target ?? "").trim();
  const payload = asRecord(request.payload) ?? {};
  if (target === "files") {
    const context = normalizeThreadContext(payload.context);
    const url = new URL("/apps/files", window.location.href);
    writeParam(url, "target", asString(payload.device) ?? undefined);
    writeParam(url, "path", asString(payload.path) ?? context?.cwd ?? undefined);
    writeParam(url, "open", asString(payload.open) ?? undefined);
    writeParam(url, "q", asString(payload.q) ?? undefined);
    return `${url.pathname}${url.search}`;
  }
  if (target === "shell") {
    const context = normalizeThreadContext(payload.context);
    const url = new URL("/apps/shell", window.location.href);
    writeParam(url, "target", asString(payload.device) ?? undefined);
    writeParam(url, "workdir", asString(payload.workdir) ?? context?.cwd ?? undefined);
    return `${url.pathname}${url.search}`;
  }
  if (target === "wiki") {
    const url = new URL("/apps/wiki", window.location.href);
    writeParam(url, "db", asString(payload.db) ?? undefined);
    writeParam(url, "path", asString(payload.path) ?? undefined);
    writeParam(url, "mode", asString(payload.mode) ?? undefined);
    return `${url.pathname}${url.search}`;
  }
  const explicitRoute = asString(payload.route)?.trim();
  if (explicitRoute) {
    return explicitRoute;
  }
  return `/apps/${encodeURIComponent(target)}`;
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
  window.location.href = buildFallbackRoute(request);
}

export async function connectHost(): Promise<HostClient> {
  throw new Error("HOST runtime is not wired in this local package yet");
}
