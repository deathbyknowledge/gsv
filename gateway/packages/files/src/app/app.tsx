import { consumePendingAppOpen } from "@gsv/package/host";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Stage } from "./stage";
import { Toolbar } from "./toolbar";
import type { FilesBackend, FilesMutationResult, FilesRoute, FilesState } from "./types";

type Props = {
  backend: FilesBackend;
};

const WINDOW_ID = new URL(window.location.href).searchParams.get("windowId")?.trim() || "";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function readTrimmedString(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function readRequestedTarget(payload: Record<string, unknown> | null): string | null {
  return readTrimmedString(payload?.device) ?? readTrimmedString(payload?.deviceId) ?? readTrimmedString(payload?.target);
}

function routeKey(route: FilesRoute) {
  return JSON.stringify(route);
}

function defaultPathForTarget(target: string) {
  return target === "gsv" ? "/" : ".";
}

function readActiveThreadContext() {
  try {
    const raw = window.localStorage.getItem("gsv.activeThreadContext.v1");
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const cwd = typeof parsed.cwd === "string" ? parsed.cwd.trim() : "";
    if (!cwd) {
      return null;
    }
    return { cwd };
  } catch {
    return null;
  }
}

function readRouteFromUrl(): FilesRoute {
  const url = new URL(window.location.href);
  const hasExplicitState = url.searchParams.has("path") || url.searchParams.has("open") || url.searchParams.has("q") || url.searchParams.has("target");
  if (!hasExplicitState) {
    const thread = readActiveThreadContext();
    if (thread) {
      return {
        target: "gsv",
        path: thread.cwd,
        q: "",
        open: "",
      };
    }
  }
  const target = url.searchParams.get("target")?.trim() || "gsv";
  const nextRoute = {
    target,
    path: url.searchParams.get("path")?.trim() || defaultPathForTarget(target),
    q: url.searchParams.get("q")?.trim() || "",
    open: url.searchParams.get("open")?.trim() || "",
  };
  console.debug("[files] using url route", {
    windowId: WINDOW_ID,
    route: nextRoute,
    href: window.location.href,
  });
  return nextRoute;
}

function readRoute(): FilesRoute {
  const nextFromUrl = readRouteFromUrl();
  const pending = consumePendingAppOpen(WINDOW_ID);
  if (pending?.target !== "files") {
    return nextFromUrl;
  }

  const payload = asRecord(pending.payload);
  const context = asRecord(payload?.context);
  const target = readRequestedTarget(payload) ?? nextFromUrl.target;
  const nextRoute = {
    target,
    path: readTrimmedString(payload?.path) ?? readTrimmedString(context?.cwd) ?? nextFromUrl.path,
    q: readTrimmedString(payload?.q) ?? nextFromUrl.q,
    open: readTrimmedString(payload?.open) ?? nextFromUrl.open,
  };
  console.debug("[files] consumed pending app open", {
    windowId: WINDOW_ID,
    pending,
    route: nextRoute,
  });
  return nextRoute;
}

function writeRoute(route: FilesRoute, replace = false) {
  const url = new URL(window.location.href);
  for (const key of ["target", "path", "q", "open"] as const) {
    const value = route[key];
    if (value) {
      url.searchParams.set(key, value);
    } else {
      url.searchParams.delete(key);
    }
  }
  window.history[replace ? "replaceState" : "pushState"](null, "", `${url.pathname}${url.search}${url.hash}`);
}

function sameRoute(left: FilesRoute, right: FilesRoute) {
  return left.target === right.target && left.path === right.path && left.q === right.q && left.open === right.open;
}

export function App({ backend }: Props) {
  const [route, setRoute] = useState<FilesRoute>(() => readRoute());
  const [state, setState] = useState<FilesState | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusText, setStatusText] = useState("");
  const [errorText, setErrorText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [editorContent, setEditorContent] = useState("");
  const [targetDraft, setTargetDraft] = useState(route.target);
  const [pathDraft, setPathDraft] = useState(route.path);
  const [searchDraft, setSearchDraft] = useState(route.q);
  const loadRequestId = useRef(0);
  const skipLoadKeyRef = useRef<string | null>(null);

  const loadRoute = useCallback(async (nextRoute: FilesRoute) => {
    const requestId = ++loadRequestId.current;
    console.debug("[files] loading route", { requestId, route: nextRoute });
    setLoading(true);
    try {
      const nextState = await backend.loadState(nextRoute);
      if (requestId !== loadRequestId.current) {
        return;
      }
      console.debug("[files] loaded state", {
        requestId,
        requestedRoute: nextRoute,
        target: nextState.target,
        currentPath: nextState.currentPath,
        devices: nextState.devices.map((device) => device.deviceId),
      });
      setState(nextState);
      setErrorText(nextState.errorText || "");
    } catch (error) {
      if (requestId !== loadRequestId.current) {
        return;
      }
      console.debug("[files] failed to load route", {
        requestId,
        requestedRoute: nextRoute,
        error: error instanceof Error ? error.message : String(error),
      });
      setErrorText(error instanceof Error ? error.message : String(error));
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
    const key = routeKey(route);
    if (skipLoadKeyRef.current === key) {
      skipLoadKeyRef.current = null;
      return;
    }
    void loadRoute(route);
  }, [route, loadRoute]);

  useEffect(() => {
    if (!state) {
      return;
    }
    setTargetDraft(state.target);
    setPathDraft(state.currentPath);
    setSearchDraft(state.searchQuery);
  }, [state?.target, state?.currentPath, state?.searchQuery]);

  useEffect(() => {
    if (state?.fileResult && typeof state.fileResult.content === "string") {
      setEditorContent(state.fileResult.content);
      setDirty(false);
      document.body.dataset.dirty = "false";
      return;
    }
    setEditorContent("");
    setDirty(false);
    document.body.dataset.dirty = "false";
  }, [state?.filePath, state?.fileResult]);

  useEffect(() => {
    document.body.dataset.dirty = dirty ? "true" : "false";
  }, [dirty]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) {
        return;
      }
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const confirmDiscard = useCallback(() => {
    if (!dirty) {
      return true;
    }
    return window.confirm("Discard unsaved changes to the current file?");
  }, [dirty]);

  const navigate = useCallback((nextRoute: FilesRoute, replace = false) => {
    writeRoute(nextRoute, replace);
    setRoute(nextRoute);
  }, []);

  const navigateSafely = useCallback((nextRoute: FilesRoute, replace = false) => {
    if (!confirmDiscard()) {
      return;
    }
    navigate(nextRoute, replace);
  }, [confirmDiscard, navigate]);

  const changeTarget = useCallback((nextTarget: string) => {
    const normalizedTarget = nextTarget.trim() || "gsv";
    const nextPath = defaultPathForTarget(normalizedTarget);
    setTargetDraft(normalizedTarget);
    setPathDraft(nextPath);
    setSearchDraft("");
    navigateSafely({
      target: normalizedTarget,
      path: nextPath,
      q: "",
      open: "",
    });
  }, [navigateSafely]);

  const runMutation = useCallback(async (operation: Promise<FilesMutationResult>) => {
    const result = await operation;
    setStatusText(result.statusText);
    setErrorText(result.errorText);
    if (result.errorText) {
      return;
    }
    setDirty(false);
    const nextRoute: FilesRoute = {
      target: result.target,
      path: result.path,
      q: result.q,
      open: result.open,
    };
    skipLoadKeyRef.current = routeKey(nextRoute);
    if (!sameRoute(route, nextRoute)) {
      writeRoute(nextRoute);
      setRoute(nextRoute);
    }
    await loadRoute(nextRoute);
  }, [loadRoute, route]);

  const canGoUp = useMemo(() => {
    if (!state) {
      return false;
    }
    return state.pathStyle === "absolute" ? state.currentPath !== "/" : state.currentPath !== ".";
  }, [state]);

  const openDirectory = useCallback((path: string) => {
    if (!state) {
      return;
    }
    navigateSafely({
      target: state.target,
      path,
      q: searchDraft.trim(),
      open: "",
    });
  }, [navigateSafely, searchDraft, state]);

  const openFile = useCallback((path: string) => {
    if (!state) {
      return;
    }
    navigateSafely({
      target: state.target,
      path: state.currentPath,
      q: state.searchQuery,
      open: path,
    });
  }, [navigateSafely, state]);

  if (!state && loading) {
    return <section class="files-shell"><section class="files-stage"><div class="files-empty"><h3>Loading</h3><p>Opening files…</p></div></section></section>;
  }

  if (!state) {
    return <section class="files-shell"><section class="files-stage"><div class="files-empty"><h3>Files unavailable</h3><p>{errorText || "Unable to load files."}</p></div></section></section>;
  }

  return (
    <section class="files-shell">
      <Toolbar
        targetDraft={targetDraft}
        pathDraft={pathDraft}
        searchDraft={searchDraft}
        devices={state.devices}
        currentPath={state.currentPath}
        pathStyle={state.pathStyle}
        canGoUp={canGoUp}
        onTargetDraftChange={changeTarget}
        onPathDraftChange={setPathDraft}
        onSearchDraftChange={setSearchDraft}
        onSubmitNav={() => navigateSafely({ target: targetDraft, path: pathDraft || defaultPathForTarget(targetDraft), q: searchDraft.trim(), open: "" })}
        onSubmitSearch={() => navigateSafely({ target: state.target, path: state.currentPath, q: searchDraft.trim(), open: "" })}
        onClearSearch={() => {
          setSearchDraft("");
          navigateSafely({ target: state.target, path: state.currentPath, q: "", open: "" });
        }}
        onGoUp={() => {
          if (!state) {
            return;
          }
          const nextPath = state.pathStyle === "absolute"
            ? (state.currentPath === "/" ? "/" : state.currentPath.split("/").filter(Boolean).slice(0, -1).length ? `/${state.currentPath.split("/").filter(Boolean).slice(0, -1).join("/")}` : "/")
            : (state.currentPath === "." ? "." : state.currentPath.split("/").filter(Boolean).slice(0, -1).join("/") || ".");
          navigateSafely({ target: state.target, path: nextPath, q: state.searchQuery, open: "" });
        }}
        onCreateFile={() => {
          const name = window.prompt("New file name", "untitled.txt");
          if (!name || !name.trim()) {
            return;
          }
          void runMutation(backend.createFile({
            target: state.target,
            currentPath: state.currentPath,
            name: name.trim(),
            q: state.searchQuery,
          }));
        }}
        onNavigate={(path) => openDirectory(path)}
      />
      <section class="files-stage">
        {statusText ? <section class="files-status-line"><p>{statusText}</p></section> : null}
        {errorText ? <section class="files-status-line is-error"><p>{errorText}</p></section> : null}
        <Stage
          currentPath={state.currentPath}
          searchQuery={state.searchQuery}
          directoryResult={state.directoryResult}
          filePath={state.filePath}
          fileResult={state.fileResult}
          searchResult={state.searchResult}
          editorContent={editorContent}
          onEditorChange={(value) => {
            setEditorContent(value);
            setDirty(true);
          }}
          onOpenDirectory={openDirectory}
          onOpenFile={openFile}
          onSave={() => {
            if (!state.filePath) {
              return;
            }
            void runMutation(backend.saveFile({
              target: state.target,
              path: state.filePath,
              currentPath: state.currentPath,
              q: state.searchQuery,
              content: editorContent,
            }));
          }}
          onDelete={(path) => {
            void runMutation(backend.deletePath({
              target: state.target,
              path,
              currentPath: state.currentPath,
              q: state.searchQuery,
            }));
          }}
        />
      </section>
    </section>
  );
}
