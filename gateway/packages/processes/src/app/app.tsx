import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ProcessEntry, ProcessesBackend, ProcessesRoute, ProcessesState } from "./types";

type Props = {
  backend: ProcessesBackend;
};

function readRoute(): ProcessesRoute {
  const url = new URL(window.location.href);
  return {
    q: url.searchParams.get("q")?.trim() || "",
  };
}

function writeRoute(route: ProcessesRoute, replace = false) {
  const url = new URL(window.location.href);
  if (route.q) {
    url.searchParams.set("q", route.q);
  } else {
    url.searchParams.delete("q");
  }
  window.history[replace ? "replaceState" : "pushState"](null, "", `${url.pathname}${url.search}${url.hash}`);
}

function formatTimestampMs(value: unknown) {
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) {
    return String(value ?? "");
  }
  return date.toLocaleString();
}

function stateClass(value: unknown) {
  const state = String(value ?? "unknown").trim().toLowerCase();
  if (state === "running") {
    return "is-running";
  }
  if (state === "paused") {
    return "is-paused";
  }
  return "is-other";
}

function openChatProcess(entry: ProcessEntry) {
  const pid = String(entry.pid ?? "").trim();
  const cwd = String(entry.cwd ?? "").trim();
  if (!pid || !cwd) {
    return;
  }
  const workspaceId = entry.workspaceId == null ? null : String(entry.workspaceId);
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({
        type: "gsv:open-chat-process",
        detail: { pid, workspaceId, cwd },
      }, window.location.origin);
      window.parent.dispatchEvent(new CustomEvent("gsv:open-chat-process", {
        detail: { pid, workspaceId, cwd },
      }));
      return;
    }
  } catch {
  }
  window.location.href = "/apps/chat";
}

function filterProcesses(processes: ProcessEntry[], query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return processes;
  }
  return processes.filter((entry) => (
    String(entry?.pid ?? "").toLowerCase().includes(normalizedQuery)
    || String(entry?.profile ?? "").toLowerCase().includes(normalizedQuery)
    || String(entry?.label ?? "").toLowerCase().includes(normalizedQuery)
    || String(entry?.parentPid ?? "").toLowerCase().includes(normalizedQuery)
  ));
}

export function App({ backend }: Props) {
  const [route, setRoute] = useState<ProcessesRoute>(() => readRoute());
  const [state, setState] = useState<ProcessesState | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchDraft, setSearchDraft] = useState(route.q);
  const [errorText, setErrorText] = useState("");
  const loadRequestId = useRef(0);

  const loadState = useCallback(async () => {
    const requestId = ++loadRequestId.current;
    setLoading(true);
    try {
      const nextState = await backend.loadState();
      if (requestId !== loadRequestId.current) {
        return;
      }
      setState(nextState);
      setErrorText(nextState.errorText || "");
    } finally {
      if (requestId === loadRequestId.current) {
        setLoading(false);
      }
    }
  }, [backend]);

  useEffect(() => {
    const onPopState = () => setRoute(readRoute());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    setSearchDraft(route.q);
  }, [route.q]);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  const filtered = useMemo(() => filterProcesses(state?.processes ?? [], route.q), [state?.processes, route.q]);

  const navigate = useCallback((nextRoute: ProcessesRoute, replace = false) => {
    writeRoute(nextRoute, replace);
    setRoute(nextRoute);
  }, []);

  const onKill = useCallback(async (pid: string) => {
    const result = await backend.killProcess({ pid });
    if (!result.ok) {
      setErrorText(result.errorText);
      return;
    }
    setErrorText("");
    await loadState();
  }, [backend, loadState]);

  if (!state && loading) {
    return (
      <section class="process-app">
        <section class="process-stage">
          <section class="process-list">
            <div class="process-empty">
              <h3>Loading</h3>
              <p>Fetching processes…</p>
            </div>
          </section>
        </section>
      </section>
    );
  }

  if (!state) {
    return (
      <section class="process-app">
        <section class="process-stage">
          <section class="process-list">
            <div class="process-empty">
              <h3>Processes unavailable</h3>
              <p>{errorText || "Unable to load processes."}</p>
            </div>
          </section>
        </section>
      </section>
    );
  }

  return (
    <section class="process-app">
      <section class="process-toolbar">
        <form
          class="process-toolbar-form"
          onSubmit={(event) => {
            event.preventDefault();
            navigate({ q: searchDraft.trim() });
          }}
        >
          <label class="process-field">
            <span>Search</span>
            <input
              type="text"
              value={searchDraft}
              placeholder="Filter by pid, label, or parent pid"
              onInput={(event) => setSearchDraft((event.currentTarget as HTMLInputElement).value)}
            />
          </label>
          <div class="process-toolbar-actions">
            <button type="submit" class="process-icon-btn" aria-label="Search" title="Search">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6"></circle><path d="m16 16 4 4"></path></svg>
            </button>
            <button
              type="button"
              class="process-icon-btn"
              aria-label="Clear filter"
              title="Clear filter"
              onClick={() => {
                setSearchDraft("");
                navigate({ q: "" });
              }}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"></path><path d="M18 6 6 18"></path></svg>
            </button>
          </div>
        </form>
        <div class="process-toolbar-meta">Showing {filtered.length} of {state?.processes.length ?? 0} process{(state?.processes.length ?? 0) === 1 ? "" : "es"}.</div>
      </section>

      {errorText ? <p class="control-error-text">{errorText}</p> : null}

      <section class="process-stage">
        <div class="process-list-head">
          <span>Process</span>
          <span>Workspace</span>
          <span>Actions</span>
        </div>
        <section class="process-list">
          {filtered.length === 0 ? (
            <div class="process-empty">
              <h3>No processes</h3>
              <p>No processes match the current filter.</p>
            </div>
          ) : filtered.map((entry) => {
            const title = entry?.label && String(entry.label).trim().length > 0 ? String(entry.label).trim() : String(entry?.pid ?? "unknown");
            const pid = String(entry?.pid ?? "");
            const profile = String(entry?.profile ?? "unknown");
            const uid = String(entry?.uid ?? "?");
            const parentPid = entry?.parentPid == null ? "—" : String(entry.parentPid);
            const workspaceId = entry?.workspaceId == null ? "" : String(entry.workspaceId);
            const cwd = String(entry?.cwd ?? "");
            const workspaceLabel = workspaceId || "—";
            const cwdLabel = cwd || "—";
            const stateLabel = String(entry?.state ?? "unknown").trim().toLowerCase();
            return (
              <article class="process-row">
                <div class="process-row-main">
                  <div class="process-row-head">
                    <span class={`process-state-pill ${stateClass(entry?.state)}`}>
                      <span class="process-state-dot" aria-hidden="true"></span>
                      {stateLabel || "unknown"}
                    </span>
                    <h3>{title}</h3>
                  </div>
                  <p class="muted process-row-meta"><code>{pid}</code> · uid {uid} · profile {profile} · parent {parentPid}</p>
                  <p class="muted process-row-meta">created {formatTimestampMs(entry?.createdAt)}</p>
                </div>
                <div class="process-row-context">
                  <div class="process-context-block">
                    <span class="process-context-label">Workspace</span>
                    <strong>{workspaceLabel}</strong>
                  </div>
                  <div class="process-context-block">
                    <span class="process-context-label">Path</span>
                    <code>{cwdLabel}</code>
                  </div>
                </div>
                <div class="process-row-actions">
                  <button
                    type="button"
                    class="process-icon-btn"
                    aria-label="Open in Chat"
                    title="Open in Chat"
                    onClick={() => openChatProcess(entry)}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 7.5h12A2.5 2.5 0 0 1 20.5 10v5A2.5 2.5 0 0 1 18 17.5H11l-4.5 3v-3H6A2.5 2.5 0 0 1 3.5 15v-5A2.5 2.5 0 0 1 6 7.5z"></path></svg>
                  </button>
                  <button
                    type="button"
                    class="process-icon-btn process-icon-btn-danger"
                    aria-label="Reset process"
                    title="Reset process"
                    onClick={() => onKill(pid)}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v10H7z"></path></svg>
                  </button>
                </div>
              </article>
            );
          })}
        </section>
      </section>
    </section>
  );
}
