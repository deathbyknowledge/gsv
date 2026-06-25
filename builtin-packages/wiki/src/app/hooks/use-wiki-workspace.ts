import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { extractHeadings, extractTitle, normalizePath } from "../markdown";
import { readMode, readRoute, writeLocation } from "../domain/route";
import { formatError, resolveTarget, slugifyDbId, suggestPagePath } from "../domain/wiki-model";
import type {
  BuildStartArgs,
  WikiBackend,
  WikiMode,
  WikiMutationResult,
  WikiWorkspaceState,
} from "../types";

const EMPTY_STATE: WikiWorkspaceState = {
  selectedDb: "",
  selectedPath: "",
  dbs: [],
  pages: [],
  selectedNote: null,
  searchQuery: "",
  searchMatches: null,
  errorText: "",
};

export function useWikiWorkspace(backend: WikiBackend) {
  const [mode, setMode] = useState<WikiMode>(readMode());
  const [route, setRoute] = useState(readRoute());
  const [state, setState] = useState<WikiWorkspaceState>(EMPTY_STATE);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [searchDraft, setSearchDraft] = useState(route.q || "");
  const [editorPath, setEditorPath] = useState("");
  const [editorMarkdown, setEditorMarkdown] = useState("");
  const [newPageTitle, setNewPageTitle] = useState("");
  const [newDatabaseOpen, setNewDatabaseOpen] = useState(false);
  const [newDatabaseTitle, setNewDatabaseTitle] = useState("");
  const [newDatabaseId, setNewDatabaseId] = useState("");
  const [buildTargetMode, setBuildTargetMode] = useState<"gsv" | "custom">("gsv");
  const [buildTargetCustom, setBuildTargetCustom] = useState("");
  const [buildSourcePath, setBuildSourcePath] = useState("");
  const [buildDestinationMode, setBuildDestinationMode] = useState<"existing" | "new">("existing");
  const [buildSelectedDb, setBuildSelectedDb] = useState("");
  const [buildDbTitle, setBuildDbTitle] = useState("");
  const [buildDbId, setBuildDbId] = useState("");
  const [ingestTargetMode, setIngestTargetMode] = useState<"gsv" | "custom">("gsv");
  const [ingestTargetCustom, setIngestTargetCustom] = useState("");
  const [ingestSourcePath, setIngestSourcePath] = useState("");
  const [ingestSourceTitle, setIngestSourceTitle] = useState("");
  const [ingestSummary, setIngestSummary] = useState("");
  const [ingestDb, setIngestDb] = useState("");
  const [searchOpen, setSearchOpen] = useState(Boolean(route.q));
  const [searching, setSearching] = useState(false);

  const currentTitle = state.selectedNote ? extractTitle(state.selectedNote.markdown || "", state.selectedPath || "Untitled") : "";
  const pageHeadings = useMemo(() => state.selectedNote ? extractHeadings(state.selectedNote.markdown || "") : [], [state.selectedNote]);
  const visiblePages = state.pages;
  const selectedDb = state.selectedDb || state.dbs[0]?.id || "";
  const activeDb = state.dbs.find((db) => db.id === selectedDb);

  const refresh = useCallback(async (nextRoute = route): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const next = await backend.loadWorkspace(nextRoute);
      setState(next);
      if (next.errorText) {
        setError(next.errorText);
      }
    } catch (cause) {
      setError(formatError(cause));
    } finally {
      setLoading(false);
    }
  }, [backend, route]);

  useEffect(() => {
    void refresh(route);
  }, []);

  useEffect(() => {
    writeLocation(mode, route);
  }, [mode, route]);

  useEffect(() => {
    setSearchDraft(route.q || "");
  }, [route.q]);

  useEffect(() => {
    const query = searchDraft.trim();
    if (!query) {
      setSearching(false);
      setState((current) => current.searchQuery || current.searchMatches
        ? { ...current, searchQuery: "", searchMatches: null }
        : current);
      return undefined;
    }
    if (!selectedDb) {
      return undefined;
    }

    let cancelled = false;
    setSearchOpen(true);
    setSearching(true);
    const timeout = window.setTimeout(() => {
      void backend.loadWorkspace({
        ...route,
        db: selectedDb,
        path: state.selectedPath || route.path,
        q: query,
      })
        .then((next) => {
          if (cancelled) {
            return;
          }
          setState((current) => ({
            ...current,
            searchQuery: next.searchQuery,
            searchMatches: next.searchMatches ?? [],
            errorText: next.errorText || current.errorText,
          }));
          if (next.errorText) {
            setError(next.errorText);
          }
        })
        .catch((cause) => {
          if (!cancelled) {
            setError(formatError(cause));
          }
        })
        .finally(() => {
          if (!cancelled) {
            setSearching(false);
          }
        });
    }, 260);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [backend, route.db, route.path, searchDraft, selectedDb, state.selectedPath]);

  useEffect(() => {
    if (state.selectedNote) {
      setEditorPath(state.selectedPath || suggestPagePath(state.selectedDb, newPageTitle));
      setEditorMarkdown(state.selectedNote.markdown || "");
    } else if (state.selectedDb) {
      setEditorPath(state.selectedPath || suggestPagePath(state.selectedDb, newPageTitle));
    }
    if (!buildSelectedDb && state.selectedDb) {
      setBuildSelectedDb(state.selectedDb);
    }
    if (!ingestDb && state.selectedDb) {
      setIngestDb(state.selectedDb);
    }
  }, [state.selectedDb, state.selectedPath, state.selectedNote]);

  useEffect(() => {
    if (buildDestinationMode === "new" && buildDbTitle && !buildDbId) {
      setBuildDbId(slugifyDbId(buildDbTitle));
    }
  }, [buildDestinationMode, buildDbTitle]);

  useEffect(() => {
    if (newDatabaseOpen && newDatabaseTitle && !newDatabaseId) {
      setNewDatabaseId(slugifyDbId(newDatabaseTitle));
    }
  }, [newDatabaseOpen, newDatabaseTitle, newDatabaseId]);

  async function runMutation(task: () => Promise<WikiMutationResult | void>): Promise<void> {
    setMutating(true);
    setError(null);
    setNotice(null);
    try {
      const result = await task();
      if (result && typeof result === "object" && "statusText" in result) {
        const mutation = result as WikiMutationResult;
        setNotice(mutation.statusText);
        const nextRoute = { ...route, db: mutation.db, path: mutation.openPath };
        setRoute(nextRoute);
        await refresh(nextRoute);
      }
    } catch (cause) {
      setError(formatError(cause));
    } finally {
      setMutating(false);
    }
  }

  const openDb = useCallback((db: string): void => {
    const nextRoute = { ...route, db, path: db ? `${db}/index.md` : undefined };
    setMode("browse");
    setSearchDraft("");
    setSearchOpen(false);
    setRoute(nextRoute);
    void refresh(nextRoute);
  }, [refresh, route]);

  const openPage = useCallback((path: string): void => {
    const nextRoute = { ...route, db: selectedDb, path };
    setRoute(nextRoute);
    void refresh(nextRoute);
  }, [refresh, route, selectedDb]);

  const openPageAndBrowse = useCallback((path: string): void => {
    setMode("browse");
    openPage(path);
  }, [openPage]);

  const openSearchMatch = useCallback((path: string): void => {
    setSearchDraft("");
    setSearchOpen(false);
    setMode("browse");
    openPage(path);
  }, [openPage]);

  function changeMode(next: WikiMode): void {
    setMode(next);
  }

  function applySearch(event: Event): void {
    event.preventDefault();
    const firstMatch = state.searchMatches?.[0];
    if (firstMatch) {
      openSearchMatch(firstMatch.path);
      return;
    }
    setMode("browse");
    setSearchOpen(true);
  }

  function clearSearch(): void {
    setSearchDraft("");
    setSearchOpen(false);
    setSearching(false);
    setState((current) => current.searchQuery || current.searchMatches
      ? { ...current, searchQuery: "", searchMatches: null }
      : current);
  }

  async function createDatabaseFlow(event: Event): Promise<void> {
    event.preventDefault();
    const dbTitle = newDatabaseTitle.trim();
    const dbId = (newDatabaseId.trim() || slugifyDbId(dbTitle)).trim();
    if (!dbId) {
      setError("Name the collection before creating it.");
      return;
    }
    setMode("browse");
    await runMutation(async () => {
      const result = await backend.createDatabase({ dbId, dbTitle: dbTitle || undefined });
      setNewDatabaseOpen(false);
      setNewDatabaseTitle("");
      setNewDatabaseId("");
      return result;
    });
  }

  async function saveCurrentPage(): Promise<void> {
    const db = selectedDb;
    const path = normalizePath(editorPath);
    if (!db || !path) {
      setError("Select a collection and page path before saving.");
      return;
    }
    await runMutation(() => backend.savePage({ db, path, markdown: editorMarkdown }));
  }

  async function createPage(): Promise<void> {
    const db = selectedDb;
    if (!db) {
      setError("Choose a collection before creating a page.");
      return;
    }
    const title = newPageTitle.trim();
    if (!title) {
      setError("A page title is required.");
      return;
    }
    const path = suggestPagePath(db, title, state.selectedPath);
    const markdown = `# ${title}\n\n`;
    setEditorPath(path);
    setEditorMarkdown(markdown);
    setMode("edit");
    const nextRoute = { ...route, db, path };
    setRoute(nextRoute);
    await runMutation(() => backend.savePage({ db, path, markdown }));
    setNewPageTitle("");
  }

  async function startBuildFlow(event: Event): Promise<void> {
    event.preventDefault();
    const sourceTarget = resolveTarget(buildTargetMode, buildTargetCustom);
    const sourcePath = buildSourcePath.trim();
    if (!sourcePath) {
      setError("Choose a source directory before starting a build.");
      return;
    }
    const args: BuildStartArgs = buildDestinationMode === "existing"
      ? {
          sourceTarget,
          sourcePath,
          dbId: buildSelectedDb || selectedDb,
        }
      : {
          sourceTarget,
          sourcePath,
          dbId: (buildDbId.trim() || slugifyDbId(buildDbTitle)).trim(),
          dbTitle: buildDbTitle.trim(),
        };
    if (!args.dbId) {
      setError("Choose an existing collection or create a new one for the build output.");
      return;
    }
    await runMutation(async () => {
      if (buildDestinationMode === "new" && buildDbTitle.trim()) {
        await backend.createDatabase({ dbId: args.dbId, dbTitle: buildDbTitle.trim() }).catch(() => {});
      }
      return backend.startBuild(args);
    });
  }

  async function ingestSourceFlow(event: Event): Promise<void> {
    event.preventDefault();
    const db = ingestDb || selectedDb;
    if (!db) {
      setError("Choose a destination collection before adding source material.");
      return;
    }
    const sourcePath = ingestSourcePath.trim();
    if (!sourcePath) {
      setError("Choose a source path before creating a page.");
      return;
    }
    await runMutation(() => backend.ingestSource({
      db,
      sourceTarget: resolveTarget(ingestTargetMode, ingestTargetCustom),
      sourcePath,
      sourceTitle: ingestSourceTitle.trim() || undefined,
      summary: ingestSummary.trim() || undefined,
    }));
  }

  return {
    mode,
    route,
    state,
    loading,
    mutating,
    error,
    notice,
    searchDraft,
    searchOpen,
    searching,
    editorPath,
    editorMarkdown,
    newPageTitle,
    newDatabaseOpen,
    newDatabaseTitle,
    newDatabaseId,
    buildTargetMode,
    buildTargetCustom,
    buildSourcePath,
    buildDestinationMode,
    buildSelectedDb,
    buildDbTitle,
    buildDbId,
    ingestTargetMode,
    ingestTargetCustom,
    ingestSourcePath,
    ingestSourceTitle,
    ingestSummary,
    ingestDb,
    currentTitle,
    pageHeadings,
    visiblePages,
    selectedDb,
    activeDb,
    changeMode,
    openDb,
    openPage,
    openPageAndBrowse,
    openSearchMatch,
    applySearch,
    clearSearch,
    createDatabaseFlow,
    saveCurrentPage,
    createPage,
    startBuildFlow,
    ingestSourceFlow,
    setMode,
    setSearchDraft,
    setSearchOpen,
    setEditorPath,
    setEditorMarkdown,
    setNewPageTitle,
    setNewDatabaseOpen,
    setNewDatabaseTitle,
    setNewDatabaseId,
    setBuildTargetMode,
    setBuildTargetCustom,
    setBuildSourcePath,
    setBuildDestinationMode,
    setBuildSelectedDb,
    setBuildDbTitle,
    setBuildDbId,
    setIngestTargetMode,
    setIngestTargetCustom,
    setIngestSourcePath,
    setIngestSourceTitle,
    setIngestSummary,
    setIngestDb,
  };
}
