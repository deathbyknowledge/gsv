import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { WikiHeader } from "./components/header/wiki-header";
import { WikiInspector } from "./components/navigation/wiki-inspector";
import { WikiRail } from "./components/navigation/wiki-rail";
import { BrowsePane } from "./components/panes/browse-pane";
import { BuildPane } from "./components/panes/build-pane";
import { EditPane } from "./components/panes/edit-pane";
import { InboxPane } from "./components/panes/inbox-pane";
import { IngestPane } from "./components/panes/ingest-pane";
import { PreviewCard } from "./preview-card";
import { useWikiPreview } from "./hooks/use-wiki-preview";
import { extractHeadings, extractTitle, normalizePath } from "./markdown";
import { readMode, readRoute, writeLocation } from "./domain/route";
import { formatError, resolveTarget, slugifyDbId, suggestPagePath } from "./domain/wiki-model";
import type {
  BuildStartArgs,
  WikiBackend,
  WikiMode,
  WikiMutationResult,
  WikiWorkspaceState,
} from "./types";

const EMPTY_STATE: WikiWorkspaceState = {
  selectedDb: "",
  selectedPath: "",
  dbs: [],
  pages: [],
  inbox: [],
  selectedNote: null,
  searchQuery: "",
  searchMatches: null,
  errorText: "",
};

export function App({ backend }: { backend: WikiBackend }) {
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
  const {
    previewRect,
    previewLoading,
    previewPayload,
    previewError,
    previewPinned,
    handleArticlePreviewOpen,
    hidePreview,
    keepPreviewOpen,
  } = useWikiPreview(backend);

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

  const currentTitle = state.selectedNote ? extractTitle(state.selectedNote.markdown || "", state.selectedPath || "Untitled") : "";
  const pageHeadings = useMemo(() => state.selectedNote ? extractHeadings(state.selectedNote.markdown || "") : [], [state.selectedNote]);
  const visiblePages = state.searchMatches ?? state.pages;
  const selectedDb = state.selectedDb || state.dbs[0]?.id || "";
  const activeDb = state.dbs.find((db) => db.id === selectedDb);
  const selectedInboxPath = mode === "inbox" ? (route.path || state.inbox[0]?.path || "") : "";

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
    setRoute(nextRoute);
    void refresh(nextRoute);
  }, [refresh, route]);

  const openPage = useCallback((path: string): void => {
    const nextRoute = { ...route, db: selectedDb, path };
    setRoute(nextRoute);
    void refresh(nextRoute);
  }, [refresh, route, selectedDb]);

  const openInboxNote = useCallback((path: string): void => {
    const nextRoute = { ...route, db: selectedDb, path };
    setRoute(nextRoute);
    void refresh(nextRoute);
  }, [refresh, route, selectedDb]);

  const openPageAndBrowse = useCallback((path: string): void => {
    setMode("browse");
    openPage(path);
  }, [openPage]);

  function changeMode(next: WikiMode): void {
    setMode(next);
    if (next === "inbox" && state.inbox[0]?.path) {
      const nextRoute = { ...route, path: state.inbox[0].path };
      setRoute(nextRoute);
      void refresh(nextRoute);
    }
  }

  function applySearch(event: Event): void {
    event.preventDefault();
    const nextRoute = { ...route, q: searchDraft.trim() || undefined };
    setRoute(nextRoute);
    void refresh(nextRoute);
  }

  async function createDatabaseFlow(event: Event): Promise<void> {
    event.preventDefault();
    const dbTitle = newDatabaseTitle.trim();
    const dbId = (newDatabaseId.trim() || slugifyDbId(dbTitle)).trim();
    if (!dbId) {
      setError("Name the database before creating it.");
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
      setError("Select a database and a page path before saving.");
      return;
    }
    await runMutation(() => backend.savePage({ db, path, markdown: editorMarkdown }));
  }

  async function createPage(): Promise<void> {
    const db = selectedDb;
    if (!db) {
      setError("Choose a database before creating a page.");
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
      setError("Choose an existing database or create a new one for the build output.");
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
      setError("Choose a destination database before staging source material.");
      return;
    }
    const sourcePath = ingestSourcePath.trim();
    if (!sourcePath) {
      setError("Choose a source path before ingesting.");
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

  async function compileSelectedInbox(): Promise<void> {
    if (!selectedDb || !selectedInboxPath) {
      setError("Choose an inbox note first.");
      return;
    }
    await runMutation(() => backend.compileInboxNote({ db: selectedDb, sourcePath: selectedInboxPath }));
  }

  return (
    <div class="wiki-shell">
      <WikiHeader
        mode={mode}
        activeDb={activeDb}
        selectedDb={selectedDb}
        selectedPath={state.selectedPath}
        currentTitle={currentTitle}
        pageCount={state.pages.length}
        inboxCount={state.inbox.length}
      />

      <div class="wiki-layout">
        <WikiRail
          mode={mode}
          onChangeMode={changeMode}
          state={state}
          route={route}
          selectedDb={selectedDb}
          activeDb={activeDb}
          visiblePages={visiblePages}
          selectedInboxPath={selectedInboxPath}
          mutating={mutating}
          searchDraft={searchDraft}
          newDatabaseOpen={newDatabaseOpen}
          newDatabaseTitle={newDatabaseTitle}
          newDatabaseId={newDatabaseId}
          onOpenDb={openDb}
          onOpenPage={openPage}
          onOpenInboxNote={openInboxNote}
          onCompileSelectedInbox={compileSelectedInbox}
          onNewPage={() => setMode("edit")}
          onSearchDraftChange={setSearchDraft}
          onApplySearch={applySearch}
          onToggleCreateDatabase={() => setNewDatabaseOpen((open) => !open)}
          onCreateDatabase={createDatabaseFlow}
          onNewDatabaseTitleChange={setNewDatabaseTitle}
          onNewDatabaseIdChange={setNewDatabaseId}
        />

        <main class="wiki-main">
          {loading ? <div class="wiki-empty">Loading wiki…</div> : null}
          {!loading && error ? <div class="wiki-status is-error">{error}</div> : null}
          {!loading && !error && notice ? <div class="wiki-status is-info">{notice}</div> : null}

          {!loading ? (
            <>
              {mode === "browse" ? (
                <BrowsePane
                  state={state}
                  currentTitle={currentTitle}
                  selectedDb={selectedDb}
                  onOpenPage={openPage}
                  onPreviewOpen={handleArticlePreviewOpen}
                  onPreviewHide={hidePreview}
                />
              ) : null}

              {mode === "edit" ? (
                <EditPane
                  mutating={mutating}
                  editorPath={editorPath}
                  editorMarkdown={editorMarkdown}
                  newPageTitle={newPageTitle}
                  onSaveCurrentPage={saveCurrentPage}
                  onCreatePage={createPage}
                  onUseSuggestedPath={() => setEditorPath(suggestPagePath(selectedDb, newPageTitle, state.selectedPath))}
                  onNewPageTitleChange={setNewPageTitle}
                  onEditorPathChange={setEditorPath}
                  onEditorMarkdownChange={setEditorMarkdown}
                />
              ) : null}

              {mode === "build" ? (
                <BuildPane
                  state={state}
                  selectedDb={selectedDb}
                  mutating={mutating}
                  buildTargetMode={buildTargetMode}
                  buildTargetCustom={buildTargetCustom}
                  buildSourcePath={buildSourcePath}
                  buildDestinationMode={buildDestinationMode}
                  buildSelectedDb={buildSelectedDb}
                  buildDbTitle={buildDbTitle}
                  buildDbId={buildDbId}
                  onStartBuild={startBuildFlow}
                  onBuildTargetModeChange={setBuildTargetMode}
                  onBuildTargetCustomChange={setBuildTargetCustom}
                  onBuildSourcePathChange={setBuildSourcePath}
                  onBuildDestinationModeChange={setBuildDestinationMode}
                  onBuildSelectedDbChange={setBuildSelectedDb}
                  onBuildDbTitleChange={setBuildDbTitle}
                  onBuildDbIdChange={setBuildDbId}
                />
              ) : null}

              {mode === "ingest" ? (
                <IngestPane
                  state={state}
                  selectedDb={selectedDb}
                  mutating={mutating}
                  ingestDb={ingestDb}
                  ingestTargetMode={ingestTargetMode}
                  ingestTargetCustom={ingestTargetCustom}
                  ingestSourcePath={ingestSourcePath}
                  ingestSourceTitle={ingestSourceTitle}
                  ingestSummary={ingestSummary}
                  onIngestSource={ingestSourceFlow}
                  onIngestDbChange={setIngestDb}
                  onIngestTargetModeChange={setIngestTargetMode}
                  onIngestTargetCustomChange={setIngestTargetCustom}
                  onIngestSourcePathChange={setIngestSourcePath}
                  onIngestSourceTitleChange={setIngestSourceTitle}
                  onIngestSummaryChange={setIngestSummary}
                />
              ) : null}

              {mode === "inbox" ? (
                <InboxPane
                  state={state}
                  selectedDb={selectedDb}
                  selectedInboxPath={selectedInboxPath}
                  mutating={mutating}
                  onCompileSelectedInbox={compileSelectedInbox}
                  onOpenPageAndBrowse={openPageAndBrowse}
                  onPreviewOpen={handleArticlePreviewOpen}
                  onPreviewHide={hidePreview}
                />
              ) : null}
            </>
          ) : null}
        </main>

        <WikiInspector
          pageHeadings={pageHeadings}
          currentTitle={currentTitle}
          selectedDb={selectedDb}
          selectedPath={state.selectedPath}
        />
      </div>

      {previewRect ? (
        <PreviewCard
          anchorRect={previewRect}
          loading={previewLoading}
          payload={previewPayload}
          error={previewError}
          pinned={previewPinned}
          onDismiss={() => hidePreview(true)}
          onMouseEnter={keepPreviewOpen}
          onMouseLeave={() => hidePreview(false)}
          onOpenPage={(path) => {
            hidePreview(true);
            openPage(path);
          }}
        />
      ) : null}
    </div>
  );
}
