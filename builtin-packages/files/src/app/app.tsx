import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { detectPathStyle, defaultPathForTarget, normalizePath } from "./domain/paths";
import { sameRoute } from "./domain/route";
import { useDevices } from "./hooks/useDevices";
import { useDirectoryResource } from "./hooks/useDirectoryResource";
import { useFileMutations } from "./hooks/useFileMutations";
import { useFileResource } from "./hooks/useFileResource";
import { useFilesRoute } from "./hooks/useFilesRoute";
import { useSearchResource } from "./hooks/useSearchResource";
import { Stage } from "./stage";
import { Toolbar } from "./toolbar";
import type { FilesBackend, FilesDirectoryResult, FilesMutationResult, FilesPendingNavigation, FilesRoute, FilesSearchResult } from "./types";

type Props = {
  backend: FilesBackend;
};

const EMPTY_DIRECTORY: FilesDirectoryResult = {
  ok: true,
  files: [],
  directories: [],
};

const EMPTY_SEARCH: FilesSearchResult = {
  ok: true,
  matches: [],
  truncated: false,
};

function formatOpenLabel(kind: FilesPendingNavigation["kind"]) {
  if (kind === "target") {
    return "Switching target...";
  }
  if (kind === "search") {
    return "Searching...";
  }
  if (kind === "file") {
    return "Opening file...";
  }
  if (kind === "path") {
    return "Opening path...";
  }
  return "Opening folder...";
}

function routeMatchesVisibleView(currentRoute: FilesRoute, nextRoute: FilesRoute, currentPath: string) {
  if (sameRoute(currentRoute, nextRoute)) {
    return true;
  }
  if (currentRoute.target !== nextRoute.target || currentRoute.open || nextRoute.open || currentRoute.q !== nextRoute.q) {
    return false;
  }
  const currentPathRoute = currentRoute.path.trim();
  if (!currentPathRoute || normalizePath(currentPathRoute, detectPathStyle(currentPathRoute)) !== currentPath) {
    return false;
  }
  const requestedPath = nextRoute.path.trim();
  if (!requestedPath) {
    return false;
  }
  return normalizePath(requestedPath, detectPathStyle(requestedPath)) === currentPath;
}

export function App({ backend }: Props) {
  const { route, navigate } = useFilesRoute();
  const devices = useDevices(backend);
  const directory = useDirectoryResource(backend, route.target, route.path);
  const directoryIsCurrent = directory.loadedKey === directory.key && Boolean(directory.data);
  const currentPath = directoryIsCurrent
    ? directory.data?.currentPath ?? route.path
    : (directory.data?.currentPath ?? route.path) || defaultPathForTarget(route.target);
  const pathStyle = directoryIsCurrent ? directory.data?.pathStyle ?? detectPathStyle(currentPath) : detectPathStyle(currentPath);
  const effectiveOpenPath = directoryIsCurrent ? route.open || directory.data?.filePath || "" : route.open;
  const fileEnabled = Boolean(effectiveOpenPath);
  const file = useFileResource(backend, route.target, effectiveOpenPath, fileEnabled);
  const fileIsCurrent = fileEnabled && file.loadedKey === file.key;
  const showSearch = Boolean(route.q.trim()) && !effectiveOpenPath;
  const searchEnabled = showSearch && directoryIsCurrent;
  const search = useSearchResource(backend, route.target, currentPath, route.q, searchEnabled);
  const searchIsCurrent = searchEnabled && search.loadedKey === search.key;
  const mutations = useFileMutations();
  const [dirty, setDirty] = useState(false);
  const [editorContent, setEditorContent] = useState("");
  const [targetDraft, setTargetDraft] = useState(route.target);
  const [pathDraft, setPathDraft] = useState(route.path);
  const [searchDraft, setSearchDraft] = useState(route.q);
  const [pendingNavigation, setPendingNavigation] = useState<FilesPendingNavigation | null>(null);

  const directoryPending = !directoryIsCurrent || directory.loading;
  const filePending = fileEnabled && (!fileIsCurrent || file.loading);
  const searchPending = searchEnabled && (!searchIsCurrent || search.loading);
  const viewPending = directoryPending || filePending || searchPending;
  const visibleDirectory = directory.data?.directoryResult ?? EMPTY_DIRECTORY;
  const visibleSearch = searchIsCurrent ? search.data?.searchResult ?? EMPTY_SEARCH : EMPTY_SEARCH;
  const visibleFileResult = fileIsCurrent ? file.data?.fileResult ?? null : null;
  const visibleFilePath = visibleFileResult ? file.data?.filePath ?? effectiveOpenPath : "";
  const backToFolderPending = pendingNavigation?.kind === "directory" && pendingNavigation.entryKind === "" && pendingNavigation.path === currentPath;
  const openPathRoute = useMemo<FilesRoute>(() => {
    const target = targetDraft.trim() || "gsv";
    return {
      target,
      path: pathDraft || defaultPathForTarget(target),
      q: searchDraft.trim(),
      open: "",
    };
  }, [pathDraft, searchDraft, targetDraft]);
  const searchRoute = useMemo<FilesRoute>(() => ({
    target: route.target,
    path: currentPath,
    q: searchDraft.trim(),
    open: "",
  }), [currentPath, route.target, searchDraft]);
  const openPathDisabled = routeMatchesVisibleView(route, openPathRoute, currentPath);
  const searchDisabled = routeMatchesVisibleView(route, searchRoute, currentPath);

  useEffect(() => {
    if (!viewPending) {
      setPendingNavigation(null);
    }
  }, [viewPending]);

  useEffect(() => {
    const loadedDirectory = fileIsCurrent ? file.data?.directoryResult : null;
    if (!route.open || !loadedDirectory || !file.data?.directoryPath) {
      return;
    }
    navigate({
      target: route.target,
      path: file.data.directoryPath,
      q: route.q,
      open: "",
    }, true);
  }, [file.data?.directoryPath, file.data?.directoryResult, fileIsCurrent, navigate, route.open, route.q, route.target]);

  useEffect(() => {
    if (!directoryIsCurrent || !directory.data) {
      return;
    }
    setTargetDraft(directory.data.target);
    setPathDraft(directory.data.currentPath);
    setSearchDraft(route.q);
  }, [directory.data, directoryIsCurrent, route.q]);

  useEffect(() => {
    if (visibleFileResult && typeof visibleFileResult.content === "string") {
      setEditorContent(visibleFileResult.content);
      setDirty(false);
      document.body.dataset.dirty = "false";
      return;
    }
    setEditorContent("");
    setDirty(false);
    document.body.dataset.dirty = "false";
  }, [visibleFilePath, visibleFileResult]);

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

  const navigateWithPending = useCallback((nextRoute: FilesRoute, pending: FilesPendingNavigation, replace = false) => {
    if (routeMatchesVisibleView(route, nextRoute, currentPath)) {
      setPendingNavigation(null);
      return false;
    }
    if (!confirmDiscard()) {
      return false;
    }
    setPendingNavigation({
      ...pending,
      label: pending.label || formatOpenLabel(pending.kind),
    });
    navigate(nextRoute, replace);
    return true;
  }, [confirmDiscard, currentPath, navigate, route]);

  const handleMutationSuccess = useCallback((result: FilesMutationResult) => {
    setDirty(false);
    const nextRoute: FilesRoute = {
      target: result.target,
      path: result.path,
      q: result.q,
      open: result.open,
    };
    void directory.reload();
    if (sameRoute(route, nextRoute)) {
      if (result.open) {
        void file.reload();
      }
      if (result.q && !result.open) {
        void search.reload();
      }
      return;
    }
    setPendingNavigation({
      kind: result.open ? "file" : "directory",
      entryKind: result.open ? "file" : "directory",
      path: result.open || result.path,
      label: result.open ? "Opening file..." : "Opening folder...",
    });
    navigate(nextRoute);
  }, [directory, file, navigate, route, search]);

  const canGoUp = useMemo(() => {
    return pathStyle === "absolute" ? currentPath !== "/" : currentPath !== ".";
  }, [currentPath, pathStyle]);

  const openDirectory = useCallback((path: string) => {
    navigateWithPending({
      target: route.target,
      path,
      q: searchDraft.trim(),
      open: "",
    }, {
      kind: "directory",
      entryKind: "directory",
      path,
      label: "Opening folder...",
    });
  }, [navigateWithPending, route.target, searchDraft]);

  const openFile = useCallback((path: string) => {
    navigateWithPending({
      target: route.target,
      path: currentPath,
      q: route.q,
      open: path,
    }, {
      kind: "file",
      entryKind: "file",
      path,
      label: "Opening file...",
    });
  }, [currentPath, navigateWithPending, route.q, route.target]);

  const backToFolder = useCallback(() => {
    navigateWithPending({
      target: route.target,
      path: currentPath,
      q: route.q,
      open: "",
    }, {
      kind: "directory",
      entryKind: "",
      path: currentPath,
      label: "Opening folder...",
    });
  }, [currentPath, navigateWithPending, route.q, route.target]);

  const changeTarget = useCallback((nextTarget: string) => {
    const normalizedTarget = nextTarget.trim() || "gsv";
    const nextPath = defaultPathForTarget(normalizedTarget);
    const didNavigate = navigateWithPending({
      target: normalizedTarget,
      path: nextPath,
      q: "",
      open: "",
    }, {
      kind: "target",
      entryKind: "",
      path: nextPath,
      label: "Switching target...",
    });
    if (!didNavigate) {
      return;
    }
    setTargetDraft(normalizedTarget);
    setPathDraft(nextPath);
    setSearchDraft("");
  }, [navigateWithPending]);

  const goUp = useCallback(() => {
    const parts = currentPath.split("/").filter(Boolean);
    parts.pop();
    const nextPath = pathStyle === "absolute" ? (parts.length ? `/${parts.join("/")}` : "/") : (parts.length ? parts.join("/") : ".");
    openDirectory(nextPath);
  }, [currentPath, openDirectory, pathStyle]);

  const submitNav = useCallback(() => {
    navigateWithPending(openPathRoute, {
      kind: "path",
      entryKind: "",
      path: openPathRoute.path,
      label: "Opening path...",
    });
  }, [navigateWithPending, openPathRoute]);

  const submitSearch = useCallback(() => {
    navigateWithPending(searchRoute, {
      kind: "search",
      entryKind: "search",
      path: currentPath,
      label: "Searching...",
    });
  }, [currentPath, navigateWithPending, searchRoute]);

  const clearSearch = useCallback(() => {
    setSearchDraft("");
    navigateWithPending({
      target: route.target,
      path: currentPath,
      q: "",
      open: "",
    }, {
      kind: "directory",
      entryKind: "",
      path: currentPath,
      label: "Opening folder...",
    });
  }, [currentPath, navigateWithPending, route.target]);

  const createFile = useCallback(() => {
    const name = window.prompt("New file name", "untitled.txt");
    if (!name || !name.trim()) {
      return;
    }
    void mutations.runMutation({
      pending: {
        kind: "create",
        path: name.trim(),
        label: "Creating file...",
      },
      operation: () => backend.createFile({
        target: route.target,
        currentPath,
        name: name.trim(),
        q: route.q,
      }),
      onSuccess: handleMutationSuccess,
    });
  }, [backend, currentPath, handleMutationSuccess, mutations, route.q, route.target]);

  const saveFile = useCallback(() => {
    if (!visibleFilePath) {
      return;
    }
    void mutations.runMutation({
      pending: {
        kind: "save",
        path: visibleFilePath,
        label: "Saving file...",
      },
      operation: () => backend.saveFile({
        target: route.target,
        path: visibleFilePath,
        currentPath,
        q: route.q,
        content: editorContent,
      }),
      onSuccess: handleMutationSuccess,
    });
  }, [backend, currentPath, editorContent, handleMutationSuccess, mutations, route.q, route.target, visibleFilePath]);

  const deletePath = useCallback((path: string) => {
    void mutations.runMutation({
      pending: {
        kind: "delete",
        path,
        label: "Deleting file...",
      },
      operation: () => backend.deletePath({
        target: route.target,
        path,
        currentPath,
        q: route.q,
      }),
      onSuccess: handleMutationSuccess,
    });
  }, [backend, currentPath, handleMutationSuccess, mutations, route.q, route.target]);

  const errorText = mutations.errorText
    || directory.errorText
    || (fileIsCurrent ? file.errorText : "")
    || (searchIsCurrent ? search.errorText : "");

  if (!directory.data && directoryPending) {
    return (
      <section class="files-shell">
        <section class="files-stage">
          <div class="files-empty files-initial-loading" role="status" aria-live="polite">
            <span class="files-spinner" aria-hidden="true" />
            <h3>Opening files</h3>
            <p>Loading the current folder...</p>
          </div>
        </section>
      </section>
    );
  }

  if (!directory.data) {
    return (
      <section class="files-shell">
        <section class="files-stage">
          <div class="files-empty">
            <h3>Files unavailable</h3>
            <p>{errorText || "Unable to load files."}</p>
          </div>
        </section>
      </section>
    );
  }

  return (
    <section class="files-shell">
      <Toolbar
        targetDraft={targetDraft}
        pathDraft={pathDraft}
        searchDraft={searchDraft}
        devices={devices.devices}
        currentPath={currentPath}
        pathStyle={pathStyle}
        canGoUp={canGoUp}
        pendingNavigation={pendingNavigation}
        pendingMutation={mutations.pending}
        openPathDisabled={openPathDisabled}
        searchDisabled={searchDisabled}
        onTargetDraftChange={changeTarget}
        onPathDraftChange={setPathDraft}
        onSearchDraftChange={setSearchDraft}
        onSubmitNav={submitNav}
        onSubmitSearch={submitSearch}
        onClearSearch={clearSearch}
        onGoUp={goUp}
        onCreateFile={createFile}
        onNavigate={(path) => openDirectory(path)}
      />
      <section class="files-stage">
        {mutations.statusText ? <section class="files-status-line"><p>{mutations.statusText}</p></section> : null}
        {errorText ? <section class="files-status-line is-error"><p>{errorText}</p></section> : null}
        <Stage
          currentPath={currentPath}
          searchQuery={showSearch ? route.q : ""}
          directoryResult={visibleDirectory}
          filePath={visibleFilePath}
          fileResult={visibleFileResult}
          searchResult={visibleSearch}
          editorContent={editorContent}
          isDirty={dirty}
          pendingEntryPath={pendingNavigation?.path ?? ""}
          pendingEntryKind={pendingNavigation?.entryKind ?? ""}
          backToFolderPending={backToFolderPending}
          pendingMutation={mutations.pending}
          onEditorChange={(value) => {
            setEditorContent(value);
            setDirty(true);
          }}
          onOpenDirectory={openDirectory}
          onBackToFolder={backToFolder}
          onOpenFile={openFile}
          onSave={saveFile}
          onDelete={deletePath}
        />
      </section>
    </section>
  );
}
