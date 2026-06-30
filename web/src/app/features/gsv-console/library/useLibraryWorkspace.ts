import { useMutation, useQuery, useQueryClient } from "@tanstack/preact-query";
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import type { ShellLibraryRoute } from "../../gsv-shell/domain/shellModel";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import {
  createLibraryCollection,
  ingestLibrarySource,
  loadLibraryWorkspace,
  previewLibraryContent,
  saveLibraryPage,
  startLibraryBuild,
} from "./libraryService";
import {
  extractLibraryHeadings,
  localLibraryPath,
  normalizeDbScopedLibraryPath,
  slugifyLibraryId,
  suggestLibraryPagePath,
} from "./libraryModel";
import type {
  LibraryBuildInput,
  LibraryCreateCollectionInput,
  LibraryIngestSourceInput,
  LibraryMutationResult,
  LibraryPreviewRequest,
  LibrarySavePageInput,
} from "./libraryTypes";

export const libraryWorkspaceQueryKey = ["gsv-console", "library-workspace"] as const;

export function useLibraryWorkspace(
  route: ShellLibraryRoute = { view: "index" },
  onRouteChange?: (route: ShellLibraryRoute) => void,
  requestLeave?: (proceed: () => void) => void,
) {
  const { client, connected } = useGateway();
  const queryClient = useQueryClient();
  const [internalRoute, setInternalRoute] = useState<ShellLibraryRoute>(route);
  const activeRoute = onRouteChange ? route : internalRoute;
  const navigate = useCallback((nextRoute: ShellLibraryRoute) => {
    if (onRouteChange) {
      onRouteChange(nextRoute);
    } else {
      setInternalRoute(nextRoute);
    }
  }, [onRouteChange]);
  // User-initiated navigation away from the current view: routed through the
  // unsaved guard so leaving a dirty editor prompts "Discard changes?". Save-
  // driven navigation uses `navigate` directly (the editor is clean by then).
  const guardedNavigate = useCallback((nextRoute: ShellLibraryRoute) => {
    if (requestLeave) {
      requestLeave(() => navigate(nextRoute));
    } else {
      navigate(nextRoute);
    }
  }, [requestLeave, navigate]);

  useEffect(() => {
    if (!onRouteChange) {
      setInternalRoute(route);
    }
  }, [onRouteChange, route]);

  const loadArgs = loadArgsForRoute(activeRoute);
  const query = useQuery({
    queryKey: [...libraryWorkspaceQueryKey, loadArgs],
    enabled: connected,
    queryFn: () => loadLibraryWorkspace(client, loadArgs),
  });

  const state = query.data ?? {
    selectedDb: activeRoute.db ?? "",
    selectedPath: "",
    dbs: [],
    pages: [],
    selectedNote: null,
    searchQuery: "",
    searchMatches: null,
    errorText: "",
  };
  const selectedDb = state.selectedDb || activeRoute.db || "";
  const selectedNote = state.selectedNote;
  const pageHeadings = useMemo(
    () => selectedNote ? extractLibraryHeadings(selectedNote.markdown) : [],
    [selectedNote],
  );

  const [searchDraft, setSearchDraft] = useState(loadArgs.q ?? "");
  const [notice, setNotice] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [editorPath, setEditorPath] = useState("");
  const [editorMarkdown, setEditorMarkdown] = useState("");
  const [newPageTitle, setNewPageTitle] = useState("");
  const [createCollectionOpen, setCreateCollectionOpen] = useState(false);
  // Which folder the page browser is showing (a local page path like
  // "pages/accounts-access", or "" for the collection's content root). Lifted
  // here so it survives opening a page — the reader's breadcrumb and Back reuse
  // it to return to the right folder. Resets when the collection changes.
  const [browserFolder, setBrowserFolder] = useState("");
  const [newCollectionTitle, setNewCollectionTitle] = useState("");
  const [newCollectionId, setNewCollectionId] = useState("");
  const [ingestTarget, setIngestTarget] = useState("gsv");
  const [ingestPath, setIngestPath] = useState("");
  const [ingestTitle, setIngestTitle] = useState("");
  const [ingestSummary, setIngestSummary] = useState("");
  const [buildTarget, setBuildTarget] = useState("gsv");
  const [buildPath, setBuildPath] = useState("");
  const [buildDbId, setBuildDbId] = useState("");
  const [buildDbTitle, setBuildDbTitle] = useState("");

  useEffect(() => {
    setSearchDraft(loadArgs.q ?? "");
  }, [loadArgs.q]);

  useEffect(() => {
    setBrowserFolder("");
  }, [selectedDb]);

  useEffect(() => {
    if (activeRoute.view !== "editor") {
      return;
    }
    if (selectedNote) {
      setEditorPath(selectedNote.path);
      setEditorMarkdown(selectedNote.markdown);
      return;
    }
    if (selectedDb && activeRoute.path) {
      setEditorPath(normalizeDbScopedLibraryPath(activeRoute.path, selectedDb));
      setEditorMarkdown("");
      return;
    }
    if (selectedDb && !editorPath) {
      setEditorPath(suggestLibraryPagePath(selectedDb, newPageTitle || "New Page", state.selectedPath));
      setEditorMarkdown(newPageTitle ? `# ${newPageTitle}\n\n` : "");
    }
  }, [activeRoute, editorPath, newPageTitle, selectedDb, selectedNote, state.selectedPath]);

  useEffect(() => {
    if (newCollectionTitle && !newCollectionId) {
      setNewCollectionId(slugifyLibraryId(newCollectionTitle));
    }
  }, [newCollectionId, newCollectionTitle]);

  useEffect(() => {
    if (activeRoute.view === "build" && activeRoute.db && !buildDbId) {
      setBuildDbId(activeRoute.db);
    } else if (!buildDbId && selectedDb) {
      setBuildDbId(selectedDb);
    }
  }, [activeRoute, buildDbId, selectedDb]);

  const routeForMutationResult = (result: LibraryMutationResult): ShellLibraryRoute => ({
    view: "reader",
    db: result.db,
    path: localLibraryPath(result.openPath, result.db),
  });

  const handleMutationSuccess = async (result: LibraryMutationResult) => {
    setNotice(result.statusText);
    setLocalError(null);
    navigate(routeForMutationResult(result));
    await queryClient.invalidateQueries({ queryKey: libraryWorkspaceQueryKey });
  };

  const handleMutationError = (error: unknown) => {
    setNotice(null);
    setLocalError(error instanceof Error ? error.message : String(error));
  };

  const createCollection = useMutation({
    mutationFn: (input: LibraryCreateCollectionInput) => createLibraryCollection(client, input),
    onSuccess: async (result) => {
      setCreateCollectionOpen(false);
      setNewCollectionTitle("");
      setNewCollectionId("");
      await handleMutationSuccess(result);
    },
    onError: handleMutationError,
  });
  const savePage = useMutation({
    mutationFn: (input: LibrarySavePageInput) => saveLibraryPage(client, input),
    onSuccess: handleMutationSuccess,
    onError: handleMutationError,
  });
  const ingestSource = useMutation({
    mutationFn: (input: LibraryIngestSourceInput) => ingestLibrarySource(client, input),
    onSuccess: async (result) => {
      setIngestPath("");
      setIngestTitle("");
      setIngestSummary("");
      await handleMutationSuccess(result);
    },
    onError: handleMutationError,
  });
  const startBuild = useMutation({
    mutationFn: (input: LibraryBuildInput) => startLibraryBuild(client, input),
    onSuccess: handleMutationSuccess,
    onError: handleMutationError,
  });

  const preview = useMutation({
    mutationFn: (request: LibraryPreviewRequest) => previewLibraryContent(client, request),
  });

  const mutating = createCollection.isPending || savePage.isPending || ingestSource.isPending || startBuild.isPending;

  return {
    activeRoute,
    browserFolder,
    setBrowserFolder,
    connected,
    createCollectionOpen,
    editorMarkdown,
    editorPath,
    error: localError ?? state.errorText,
    ingestPath,
    ingestSummary,
    ingestTarget,
    ingestTitle,
    buildDbId,
    buildDbTitle,
    buildPath,
    buildTarget,
    mutating,
    newCollectionId,
    newCollectionTitle,
    newPageTitle,
    notice,
    pageHeadings,
    preview,
    query,
    searchDraft,
    state,
    applySearch: () => {
      const q = searchDraft.trim();
      guardedNavigate({ view: "index", db: selectedDb || undefined, ...(q ? { q } : {}) });
    },
    clearSearch: () => {
      setSearchDraft("");
      guardedNavigate({ view: "index", db: selectedDb || undefined });
    },
    createCollection: () => createCollection.mutate({
      dbId: newCollectionId.trim() || slugifyLibraryId(newCollectionTitle),
      dbTitle: newCollectionTitle.trim() || undefined,
    }),
    createPageDraft: () => {
      const title = newPageTitle.trim();
      if (!selectedDb || !title) {
        setLocalError("page title is required");
        return;
      }
      // Guard before replacing the editor: starting a new page abandons any
      // unsaved edits in the current editor. Mutate state only once confirmed.
      const proceed = () => {
        const path = suggestLibraryPagePath(selectedDb, title, state.selectedPath);
        setEditorPath(path);
        setEditorMarkdown(`# ${title}\n\n`);
        setNewPageTitle("");
        navigate({ view: "editor", db: selectedDb, path: localLibraryPath(path, selectedDb) });
      };
      if (requestLeave) {
        requestLeave(proceed);
      } else {
        proceed();
      }
    },
    ingestSource: () => ingestSource.mutate({
      db: selectedDb,
      sourceTarget: ingestTarget,
      sourcePath: ingestPath,
      sourceTitle: ingestTitle || undefined,
      summary: ingestSummary || undefined,
    }),
    // Exposed navigation is guarded so every in-Library route change from the UI
    // (BACK buttons, view switches, tree clicks) prompts before discarding a
    // dirty editor. The save flow uses the raw `navigate` internally.
    navigate: guardedNavigate,
    openCollection: (db: string) => guardedNavigate({ view: "index", db }),
    openEditor: (path?: string) => {
      if (!selectedDb) {
        return;
      }
      const target: ShellLibraryRoute = path
        ? { view: "editor", db: selectedDb, path: localLibraryPath(path, selectedDb) }
        : { view: "editor", db: selectedDb };
      const proceed = () => {
        // Opening a fresh blank page: clear any leftover editor draft so the
        // initializer rebuilds it from scratch. Without this, the `!editorPath`
        // guard in the editor effect skips re-init and a previously-discarded
        // draft reappears (and could be saved by accident). Editing an existing
        // page passes a path; selectedNote then repopulates the editor.
        if (!path) {
          setEditorPath("");
          setEditorMarkdown("");
        }
        navigate(target);
      };
      if (requestLeave) {
        requestLeave(proceed);
      } else {
        proceed();
      }
    },
    openBuild: () => {
      const proceed = () => {
        // Fresh build draft: clear leftover fields so a previously-discarded
        // build doesn't reappear (and can't be submitted by accident). buildDbId
        // is re-seeded from the collection by the effect once cleared.
        setBuildPath("");
        setBuildDbTitle("");
        setBuildTarget("gsv");
        setBuildDbId("");
        navigate({ view: "build", ...(selectedDb ? { db: selectedDb } : {}) });
      };
      if (requestLeave) {
        requestLeave(proceed);
      } else {
        proceed();
      }
    },
    openCapture: () => {
      if (!selectedDb) {
        return;
      }
      const proceed = () => {
        // Fresh capture draft: clear leftover ingest fields for the same reason.
        setIngestPath("");
        setIngestTitle("");
        setIngestSummary("");
        setIngestTarget("gsv");
        navigate({ view: "capture", db: selectedDb });
      };
      if (requestLeave) {
        requestLeave(proceed);
      } else {
        proceed();
      }
    },
    closeCreateCollection: () => {
      // Closing the NEW COLLECTION box discards its draft. Route through the
      // guard (the collection probe is still live on index/reader) so a typed
      // title/id prompts first, then clear the draft once the close goes through
      // — otherwise the abandoned text silently reappears on the next open.
      const proceed = () => {
        setCreateCollectionOpen(false);
        setNewCollectionTitle("");
        setNewCollectionId("");
      };
      if (requestLeave) {
        requestLeave(proceed);
      } else {
        proceed();
      }
    },
    openPage: (path: string) => {
      const db = path.split("/")[0] || selectedDb;
      if (db) {
        guardedNavigate({ view: "reader", db, path: localLibraryPath(path, db) });
      }
    },
    resetEditor: () => {
      setEditorPath(selectedNote?.path ?? "");
      setEditorMarkdown(selectedNote?.markdown ?? "");
    },
    savePage: () => savePage.mutate({
      db: selectedDb,
      path: editorPath,
      markdown: editorMarkdown,
    }),
    startBuild: () => startBuild.mutate({
      sourceTarget: buildTarget,
      sourcePath: buildPath,
      dbId: buildDbId || selectedDb,
      dbTitle: buildDbTitle || undefined,
    }),
    setBuildDbId,
    setBuildDbTitle,
    setBuildPath,
    setBuildTarget,
    setCreateCollectionOpen,
    setEditorMarkdown,
    setEditorPath,
    setIngestPath,
    setIngestSummary,
    setIngestTarget,
    setIngestTitle,
    setNewCollectionId,
    setNewCollectionTitle,
    setNewPageTitle,
    setSearchDraft,
  };
}

function loadArgsForRoute(route: ShellLibraryRoute): { db?: string; path?: string; q?: string } {
  if (route.view === "reader" || route.view === "editor") {
    return {
      db: route.db,
      path: route.path,
    };
  }
  if (route.view === "capture") {
    return { db: route.db };
  }
  if (route.view === "build") {
    return route.db ? { db: route.db } : {};
  }
  return {
    db: route.db,
    q: route.q,
  };
}
