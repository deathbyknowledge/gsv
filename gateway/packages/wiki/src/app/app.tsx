import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ArticleView } from "./article-view";
import { PreviewCard } from "./preview-card";
import { extractHeadings, extractTitle, normalizePath } from "./markdown";
import type {
  BuildStartArgs,
  WikiBackend,
  WikiMode,
  WikiMutationResult,
  WikiPreviewPayload,
  WikiPreviewRequest,
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
  queryText: "",
  queryResult: null,
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
  const [askDraft, setAskDraft] = useState(route.ask || "");
  const [editorPath, setEditorPath] = useState("");
  const [editorMarkdown, setEditorMarkdown] = useState("");
  const [newPageTitle, setNewPageTitle] = useState("");
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
  const [previewRect, setPreviewRect] = useState<DOMRect | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewPayload, setPreviewPayload] = useState<WikiPreviewPayload | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [previewPinned, setPreviewPinned] = useState(false);
  const previewToken = useRef(0);
  const previewHideTimer = useRef<number | null>(null);

  useEffect(() => {
    void refresh(route);
  }, []);

  useEffect(() => {
    writeLocation(mode, route);
  }, [mode, route]);

  useEffect(() => {
    setSearchDraft(route.q || "");
    setAskDraft(route.ask || "");
  }, [route.q, route.ask]);

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

  const currentTitle = state.selectedNote ? extractTitle(state.selectedNote.markdown || "", state.selectedPath || "Untitled") : "";
  const pageHeadings = useMemo(() => state.selectedNote ? extractHeadings(state.selectedNote.markdown || "") : [], [state.selectedNote]);
  const visiblePages = state.searchMatches ?? state.pages;
  const selectedDb = state.selectedDb || state.dbs[0]?.id || "";
  const selectedInboxPath = mode === "inbox" ? (route.path || state.inbox[0]?.path || "") : "";

  async function refresh(nextRoute = route): Promise<void> {
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
  }

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

  function openDb(db: string): void {
    const nextRoute = { ...route, db, path: db ? `${db}/index.md` : undefined };
    setRoute(nextRoute);
    void refresh(nextRoute);
  }

  function openPage(path: string): void {
    const nextRoute = { ...route, db: selectedDb, path };
    setRoute(nextRoute);
    void refresh(nextRoute);
  }

  function openInboxNote(path: string): void {
    const nextRoute = { ...route, db: selectedDb, path };
    setRoute(nextRoute);
    void refresh(nextRoute);
  }

  function openPageAndBrowse(path: string): void {
    setMode("browse");
    openPage(path);
  }

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

  function applyAsk(event: Event): void {
    event.preventDefault();
    const nextRoute = { ...route, ask: askDraft.trim() || undefined };
    setRoute(nextRoute);
    void refresh(nextRoute);
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

  async function openPreview(anchor: HTMLElement, request: WikiPreviewRequest, pin: boolean): Promise<void> {
    if (previewHideTimer.current) {
      window.clearTimeout(previewHideTimer.current);
      previewHideTimer.current = null;
    }
    const token = previewToken.current + 1;
    previewToken.current = token;
    setPreviewRect(anchor.getBoundingClientRect());
    setPreviewLoading(true);
    setPreviewPayload(null);
    setPreviewError("");
    setPreviewPinned(pin);
    try {
      const payload = await backend.previewContent(request);
      if (previewToken.current !== token) return;
      setPreviewPayload(payload);
      setPreviewError(payload && payload.ok === false ? payload.error : "");
    } catch (cause) {
      if (previewToken.current !== token) return;
      setPreviewError(formatError(cause));
    } finally {
      if (previewToken.current === token) {
        setPreviewLoading(false);
      }
    }
  }

  function hidePreview(force: boolean): void {
    if (force) {
      previewToken.current += 1;
      setPreviewPinned(false);
      setPreviewRect(null);
      setPreviewLoading(false);
      setPreviewPayload(null);
      setPreviewError("");
      return;
    }
    if (previewPinned) {
      return;
    }
    previewHideTimer.current = window.setTimeout(() => {
      previewToken.current += 1;
      setPreviewRect(null);
      setPreviewLoading(false);
      setPreviewPayload(null);
      setPreviewError("");
    }, 120);
  }

  return (
    <div class="wiki-shell">
      <header class="wiki-header">
        <div class="wiki-header-copy">
          <h1>Wiki</h1>
          <p>Browse knowledge, edit canonical pages, build from source directories, and review inbox material.</p>
        </div>
        <div class="wiki-mode-tabs">
          {(["browse", "edit", "build", "ingest", "inbox"] as WikiMode[]).map((tab) => (
            <button key={tab} type="button" class={`wiki-mode-tab${mode === tab ? " is-active" : ""}`} onClick={() => changeMode(tab)}>
              {labelForMode(tab)}
            </button>
          ))}
        </div>
      </header>

      <div class="wiki-layout">
        <aside class="wiki-rail">
          <section class="wiki-rail-section">
            <h2>Databases</h2>
            <div class="wiki-db-list">
              {state.dbs.map((db) => (
                <button key={db.id} type="button" class={`wiki-db-row${selectedDb === db.id ? " is-active" : ""}`} onClick={() => openDb(db.id)}>
                  <strong>{db.title || db.id}</strong>
                  <span>{db.id}</span>
                </button>
              ))}
            </div>
          </section>

          {(mode === "browse" || mode === "edit") ? (
            <>
              <section class="wiki-rail-section">
                <h2>Search</h2>
                <form class="wiki-inline-form" onSubmit={applySearch}>
                  <input value={searchDraft} onInput={(event) => setSearchDraft((event.currentTarget as HTMLInputElement).value)} placeholder="Search pages" />
                  <button type="submit">Search</button>
                </form>
                <form class="wiki-inline-form" onSubmit={applyAsk}>
                  <input value={askDraft} onInput={(event) => setAskDraft((event.currentTarget as HTMLInputElement).value)} placeholder="Ask the wiki" />
                  <button type="submit">Ask</button>
                </form>
              </section>
              <section class="wiki-rail-section wiki-rail-section--fill">
                <div class="wiki-section-head">
                  <h2>{state.searchMatches ? "Matches" : "Pages"}</h2>
                  <button type="button" class="wiki-link-button" onClick={() => setMode("edit")}>New page</button>
                </div>
                <div class="wiki-entry-list">
                  {visiblePages.map((entry) => (
                    <button key={entry.path} type="button" class={`wiki-entry-row${state.selectedPath === entry.path ? " is-active" : ""}`} onClick={() => openPage(entry.path)}>
                      <strong>{entry.title || displayTitleFromPath(entry.path)}</strong>
                      <span>{entry.path}</span>
                    </button>
                  ))}
                </div>
              </section>
            </>
          ) : null}

          {mode === "inbox" ? (
            <section class="wiki-rail-section wiki-rail-section--fill">
              <div class="wiki-section-head">
                <h2>Inbox</h2>
                <button type="button" class="wiki-link-button" onClick={() => void compileSelectedInbox()} disabled={mutating || !selectedInboxPath}>Compile</button>
              </div>
              <div class="wiki-entry-list">
                {state.inbox.map((entry) => (
                  <button key={entry.path} type="button" class={`wiki-entry-row${selectedInboxPath === entry.path ? " is-active" : ""}`} onClick={() => openInboxNote(entry.path)}>
                    <strong>{entry.title || displayTitleFromPath(entry.path)}</strong>
                    <span>{entry.path}</span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
        </aside>

        <main class="wiki-main">
          {loading ? <div class="wiki-empty">Loading wiki…</div> : null}
          {!loading && error ? <div class="wiki-status is-error">{error}</div> : null}
          {!loading && !error && notice ? <div class="wiki-status is-info">{notice}</div> : null}

          {!loading ? (
            <>
              {mode === "browse" ? (
                <section class="wiki-pane">
                  <div class="wiki-pane-head">
                    <div>
                      <h2>{currentTitle || "Browse"}</h2>
                      <p>{state.selectedPath || "Choose a page from the left rail."}</p>
                    </div>
                  </div>
                  {state.queryResult ? (
                    <div class="wiki-query-result">
                      <h3>Answer</h3>
                      <p>{state.queryResult.brief || "No synthesized answer was available."}</p>
                      {state.queryResult.refs.length > 0 ? (
                        <div class="wiki-ref-list">
                          {state.queryResult.refs.map((ref) => (
                            <button key={ref.path} type="button" class="wiki-ref-row" onClick={() => openPage(ref.path)}>
                              <strong>{ref.title || displayTitleFromPath(ref.path)}</strong>
                              <span>{ref.path}</span>
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  <ArticleView
                    markdown={state.selectedNote?.markdown || ""}
                    articleTitle={currentTitle || "Untitled"}
                    routeBase="/apps/wiki"
                    selectedDb={selectedDb}
                    selectedPath={state.selectedPath}
                    onNavigate={(path) => openPage(path)}
                    onPreviewOpen={(anchor, request, pin) => void openPreview(anchor, request, pin)}
                    onPreviewHide={(force) => hidePreview(force)}
                  />
                </section>
              ) : null}

              {mode === "edit" ? (
                <section class="wiki-pane wiki-pane--editor">
                  <div class="wiki-pane-head">
                    <div>
                      <h2>Edit page</h2>
                      <p>Write canonical pages without hand-building paths unless you want to.</p>
                    </div>
                    <div class="wiki-pane-actions">
                      <button type="button" onClick={() => void saveCurrentPage()} disabled={mutating}>Save page</button>
                    </div>
                  </div>
                  <div class="wiki-form-grid">
                    <label>
                      <span>Page title</span>
                      <input value={newPageTitle} onInput={(event) => setNewPageTitle((event.currentTarget as HTMLInputElement).value)} placeholder="New page title" />
                    </label>
                    <label>
                      <span>Path</span>
                      <input value={editorPath} onInput={(event) => setEditorPath((event.currentTarget as HTMLInputElement).value)} placeholder="database/pages/page.md" />
                    </label>
                  </div>
                  <div class="wiki-inline-actions">
                    <button type="button" onClick={() => void createPage()} disabled={mutating || !newPageTitle.trim()}>Create page</button>
                    <button type="button" class="is-secondary" onClick={() => setEditorPath(suggestPagePath(selectedDb, newPageTitle, state.selectedPath))}>Use suggested path</button>
                  </div>
                  <textarea class="wiki-editor" value={editorMarkdown} onInput={(event) => setEditorMarkdown((event.currentTarget as HTMLTextAreaElement).value)} placeholder="Write markdown for the current page." />
                </section>
              ) : null}

              {mode === "build" ? (
                <section class="wiki-pane">
                  <div class="wiki-pane-head">
                    <div>
                      <h2>Build from directory</h2>
                      <p>Turn a source directory into a first draft wiki without hand-writing database ids and raw prompts.</p>
                    </div>
                  </div>
                  <form class="wiki-workflow" onSubmit={(event) => void startBuildFlow(event)}>
                    <fieldset>
                      <legend>Source</legend>
                      <div class="wiki-form-grid">
                        <label>
                          <span>Source target</span>
                          <select value={buildTargetMode} onChange={(event) => setBuildTargetMode((event.currentTarget as HTMLSelectElement).value as "gsv" | "custom")}>
                            <option value="gsv">Control plane (gsv)</option>
                            <option value="custom">Other target</option>
                          </select>
                        </label>
                        {buildTargetMode === "custom" ? (
                          <label>
                            <span>Target id</span>
                            <input value={buildTargetCustom} onInput={(event) => setBuildTargetCustom((event.currentTarget as HTMLInputElement).value)} placeholder="device id" />
                          </label>
                        ) : <div class="wiki-form-placeholder">Build reads from the control plane by default.</div>}
                        <label class="wiki-field-span-2">
                          <span>Source directory</span>
                          <input value={buildSourcePath} onInput={(event) => setBuildSourcePath((event.currentTarget as HTMLInputElement).value)} placeholder="/workspaces/project/docs" />
                        </label>
                      </div>
                    </fieldset>

                    <fieldset>
                      <legend>Destination</legend>
                      <div class="wiki-toggle-group">
                        <button type="button" class={buildDestinationMode === "existing" ? "is-active" : ""} onClick={() => setBuildDestinationMode("existing")}>Use existing database</button>
                        <button type="button" class={buildDestinationMode === "new" ? "is-active" : ""} onClick={() => setBuildDestinationMode("new")}>Create new database</button>
                      </div>
                      {buildDestinationMode === "existing" ? (
                        <label>
                          <span>Database</span>
                          <select value={buildSelectedDb || selectedDb} onChange={(event) => setBuildSelectedDb((event.currentTarget as HTMLSelectElement).value)}>
                            <option value="">Select a database</option>
                            {state.dbs.map((db) => <option key={db.id} value={db.id}>{db.title || db.id}</option>)}
                          </select>
                        </label>
                      ) : (
                        <div class="wiki-form-grid">
                          <label>
                            <span>Database title</span>
                            <input value={buildDbTitle} onInput={(event) => setBuildDbTitle((event.currentTarget as HTMLInputElement).value)} placeholder="Product Alpha" />
                          </label>
                          <label>
                            <span>Database id</span>
                            <input value={buildDbId} onInput={(event) => setBuildDbId((event.currentTarget as HTMLInputElement).value)} placeholder="product-alpha" />
                          </label>
                        </div>
                      )}
                    </fieldset>

                    <div class="wiki-inline-actions">
                      <button type="submit" disabled={mutating}>Start background build</button>
                    </div>
                  </form>
                </section>
              ) : null}

              {mode === "ingest" ? (
                <section class="wiki-pane">
                  <div class="wiki-pane-head">
                    <div>
                      <h2>Ingest source</h2>
                      <p>Stage a file or directory into inbox without hand-writing raw source specs.</p>
                    </div>
                  </div>
                  <form class="wiki-workflow" onSubmit={(event) => void ingestSourceFlow(event)}>
                    <div class="wiki-form-grid">
                      <label>
                        <span>Destination database</span>
                        <select value={ingestDb || selectedDb} onChange={(event) => setIngestDb((event.currentTarget as HTMLSelectElement).value)}>
                          <option value="">Select a database</option>
                          {state.dbs.map((db) => <option key={db.id} value={db.id}>{db.title || db.id}</option>)}
                        </select>
                      </label>
                      <label>
                        <span>Source target</span>
                        <select value={ingestTargetMode} onChange={(event) => setIngestTargetMode((event.currentTarget as HTMLSelectElement).value as "gsv" | "custom")}>
                          <option value="gsv">Control plane (gsv)</option>
                          <option value="custom">Other target</option>
                        </select>
                      </label>
                      {ingestTargetMode === "custom" ? (
                        <label>
                          <span>Target id</span>
                          <input value={ingestTargetCustom} onInput={(event) => setIngestTargetCustom((event.currentTarget as HTMLInputElement).value)} placeholder="device id" />
                        </label>
                      ) : <div class="wiki-form-placeholder">Use a custom target only when the source corpus lives outside gsv.</div>}
                      <label class="wiki-field-span-2">
                        <span>Source path</span>
                        <input value={ingestSourcePath} onInput={(event) => setIngestSourcePath((event.currentTarget as HTMLInputElement).value)} placeholder="/workspaces/project/docs/plan.md" />
                      </label>
                      <label>
                        <span>Source title</span>
                        <input value={ingestSourceTitle} onInput={(event) => setIngestSourceTitle((event.currentTarget as HTMLInputElement).value)} placeholder="Optional title for the staged note" />
                      </label>
                      <label>
                        <span>Summary</span>
                        <input value={ingestSummary} onInput={(event) => setIngestSummary((event.currentTarget as HTMLInputElement).value)} placeholder="Optional context for the inbox note" />
                      </label>
                    </div>
                    <div class="wiki-inline-actions">
                      <button type="submit" disabled={mutating}>Stage in inbox</button>
                    </div>
                  </form>
                </section>
              ) : null}

              {mode === "inbox" ? (
                <section class="wiki-pane">
                  <div class="wiki-pane-head">
                    <div>
                      <h2>Inbox review</h2>
                      <p>Preview staged notes and compile them into canonical pages when they are ready.</p>
                    </div>
                    <div class="wiki-pane-actions">
                      <button type="button" onClick={() => void compileSelectedInbox()} disabled={mutating || !selectedInboxPath}>Compile into page</button>
                    </div>
                  </div>
                  {state.selectedNote ? (
                    <ArticleView
                      markdown={state.selectedNote.markdown || ""}
                      articleTitle={extractTitle(state.selectedNote.markdown || "", state.selectedNote.path)}
                      routeBase="/apps/wiki"
                      selectedDb={selectedDb}
                      selectedPath={state.selectedPath}
                      onNavigate={(path) => openPageAndBrowse(path)}
                      onPreviewOpen={(anchor, request, pin) => void openPreview(anchor, request, pin)}
                      onPreviewHide={(force) => hidePreview(force)}
                    />
                  ) : <div class="wiki-empty">Select an inbox note from the left rail.</div>}
                </section>
              ) : null}
            </>
          ) : null}
        </main>

        <aside class="wiki-inspector">
          <section class="wiki-inspector-section">
            <h2>Current page</h2>
            <dl>
              <div><dt>Database</dt><dd>{selectedDb || "—"}</dd></div>
              <div><dt>Path</dt><dd>{state.selectedPath || "—"}</dd></div>
              <div><dt>Mode</dt><dd>{labelForMode(mode)}</dd></div>
            </dl>
          </section>
          {pageHeadings.length > 0 ? (
            <section class="wiki-inspector-section">
              <h2>Outline</h2>
              <div class="wiki-outline-list">
                {pageHeadings.map((heading) => (
                  <a key={heading.id} href={`#${heading.id}`} class={`wiki-outline-row level-${heading.level}`}>{heading.text}</a>
                ))}
              </div>
            </section>
          ) : null}
          <section class="wiki-inspector-section">
            <h2>Quick actions</h2>
            <div class="wiki-action-stack">
              <button type="button" onClick={() => setMode("edit")}>Edit current page</button>
              <button type="button" onClick={() => setMode("build")}>Build from directory</button>
              <button type="button" onClick={() => setMode("ingest")}>Stage source</button>
              <button type="button" onClick={() => setMode("inbox")}>Review inbox</button>
            </div>
          </section>
        </aside>
      </div>

      {previewRect ? (
        <PreviewCard
          anchorRect={previewRect}
          loading={previewLoading}
          payload={previewPayload}
          error={previewError}
          onMouseEnter={() => {
            if (previewHideTimer.current) {
              window.clearTimeout(previewHideTimer.current);
              previewHideTimer.current = null;
            }
          }}
          onMouseLeave={() => hidePreview(false)}
        />
      ) : null}
    </div>
  );
}

function readMode(): WikiMode {
  const value = new URL(window.location.href).searchParams.get("mode");
  return value === "edit" || value === "build" || value === "ingest" || value === "inbox" ? value : "browse";
}

function readRoute(): { db?: string; path?: string; q?: string; ask?: string } {
  const url = new URL(window.location.href);
  const read = (key: string) => {
    const value = url.searchParams.get(key);
    return value && value.trim() ? value.trim() : undefined;
  };
  return {
    db: read("db"),
    path: read("path"),
    q: read("q"),
    ask: read("ask"),
  };
}

function writeLocation(mode: WikiMode, route: { db?: string; path?: string; q?: string; ask?: string }): void {
  const url = new URL(window.location.href);
  url.searchParams.set("mode", mode);
  writeParam(url, "db", route.db);
  writeParam(url, "path", route.path);
  writeParam(url, "q", route.q);
  writeParam(url, "ask", route.ask);
  window.history.replaceState({}, "", `${url.pathname}${url.search}`);
}

function writeParam(url: URL, key: string, value: string | undefined): void {
  if (value && value.trim()) {
    url.searchParams.set(key, value.trim());
  } else {
    url.searchParams.delete(key);
  }
}

function resolveTarget(mode: "gsv" | "custom", custom: string): string {
  return mode === "custom" ? (custom.trim() || "gsv") : "gsv";
}

function labelForMode(mode: WikiMode): string {
  if (mode === "browse") return "Browse";
  if (mode === "edit") return "Edit";
  if (mode === "build") return "Build";
  if (mode === "ingest") return "Ingest";
  return "Inbox";
}

function formatError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function displayTitleFromPath(path: string): string {
  const name = String(path || "").split("/").pop() || path || "Untitled";
  return name.replace(/\.md$/i, "").replace(/[-_]+/g, " ");
}

function slugifyDbId(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-");
}

function suggestPagePath(db: string, title: string, currentPath?: string): string {
  const slug = slugifyDbId(title || "new-page") || "new-page";
  const normalizedCurrent = normalizePath(currentPath || "");
  if (normalizedCurrent.includes("/pages/")) {
    const prefix = normalizedCurrent.slice(0, normalizedCurrent.lastIndexOf("/") + 1);
    return `${prefix}${slug}.md`;
  }
  return `${db}/pages/${slug}.md`;
}
