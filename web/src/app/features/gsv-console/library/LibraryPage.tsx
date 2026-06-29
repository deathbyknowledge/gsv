import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ShellLibraryRoute } from "../../gsv-shell/domain/shellModel";
import { Breadcrumbs, type Crumb } from "../../../components/ui/Breadcrumbs";
import { Button } from "../../../components/ui/Button";
import { Icon } from "../../../components/ui/Icon";
import { ListRow } from "../../../components/ui/ListRow";
import { Search } from "../../../components/ui/Search";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { Select } from "../../../components/ui/Select";
import { StatusDot } from "../../../components/ui/StatusDot";
import { Surface } from "../../../components/ui/Surface";
import { TextArea } from "../../../components/ui/TextArea";
import { TextInput } from "../../../components/ui/TextInput";
import {
  ConsolePage,
  ConsolePageState,
} from "../components/ConsolePageTemplate";
import {
  buildLibraryTree,
  libraryEntrySub,
  localLibraryPath,
  sortLibraryEntries,
} from "./libraryModel";
import {
  LibraryMarkdownView,
  renderPreviewBodyHtml,
} from "./libraryMarkdown";
import { useLibraryWorkspace } from "./useLibraryWorkspace";
import { useUnsavedGuard, useUnsavedGuardLeave } from "../../gsv-shell/unsaved/unsavedGuard";
import type {
  LibraryEntry,
  LibraryPreviewPayload,
  LibraryPreviewRequest,
  LibraryTreeNode,
} from "./libraryTypes";
import "./LibraryPage.css";

type LibraryPageProps = {
  route?: ShellLibraryRoute;
  onRouteChange?: (route: ShellLibraryRoute) => void;
};

type LibraryRuntime = ReturnType<typeof useLibraryWorkspace>;

type PreviewState = {
  key: string;
  pinned: boolean;
  rect: DOMRect;
  request: LibraryPreviewRequest;
};

export function LibraryPage({ route = { view: "index" }, onRouteChange }: LibraryPageProps) {
  const requestLeave = useUnsavedGuardLeave();
  const library = useLibraryWorkspace(route, onRouteChange, requestLeave);

  useUnsavedGuard(() => {
    const editorNote = library.state.selectedNote;
    const editorDirty =
      library.activeRoute.view === "editor" &&
      (library.editorMarkdown !== (editorNote?.markdown ?? "") ||
        // Renaming an existing note only changes editorPath; savePage persists
        // it, so a path-only edit must register as dirty. New pages have no
        // saved baseline and are already dirty via their markdown body.
        (editorNote != null && library.editorPath !== editorNote.path));
    const captureDirty =
      library.activeRoute.view === "capture" &&
      (library.ingestPath.trim().length > 0 ||
        library.ingestTitle.trim().length > 0 ||
        library.ingestSummary.trim().length > 0 ||
        library.ingestTarget !== "gsv");
    const buildDirty =
      library.activeRoute.view === "build" &&
      (library.buildPath.trim().length > 0 ||
        library.buildDbTitle.trim().length > 0 ||
        library.buildTarget !== "gsv");
    const collectionDirty =
      library.activeRoute.view === "index" &&
      library.createCollectionOpen &&
      (library.newCollectionTitle.trim().length > 0 ||
        library.newCollectionId.trim().length > 0);
    return editorDirty || captureDirty || buildDirty || collectionDirty;
  });

  if (!library.connected) {
    return (
      <ConsolePage flush>
        <ConsolePageState kind="offline" detail="CONNECTION REQUIRED" />
      </ConsolePage>
    );
  }

  if (library.query.isLoading) {
    return (
      <ConsolePage flush>
        <ConsolePageState kind="loading" label="LOADING LIBRARY" />
      </ConsolePage>
    );
  }

  if (library.query.isError) {
    const message = library.query.error instanceof Error ? library.query.error.message : "LIBRARY";
    return (
      <ConsolePage flush>
        <ConsolePageState kind="error" detail={message} />
      </ConsolePage>
    );
  }

  return (
    <ConsolePage flush>
      <div class="gsv-library" aria-label="GSV library">
        {library.error ? <StatusBanner tone="error" label={library.error} /> : null}
        {!library.error && library.notice ? <StatusBanner tone="live" label={library.notice} /> : null}
        {library.activeRoute.view === "reader" ? (
          <LibraryReader library={library} />
        ) : library.activeRoute.view === "editor" ? (
          <LibraryEditor library={library} />
        ) : library.activeRoute.view === "capture" ? (
          <LibraryCapture library={library} />
        ) : library.activeRoute.view === "build" ? (
          <LibraryBuild library={library} />
        ) : (
          <LibraryIndex library={library} />
        )}
      </div>
    </ConsolePage>
  );
}

function LibraryIndex({ library }: { library: LibraryRuntime }) {
  const { dbs } = library.state;
  const selectedDb = library.state.selectedDb;
  const selectedCollection = dbs.find((collection) => collection.id === selectedDb) ?? null;
  const searching = library.state.searchQuery.trim().length > 0;
  const searchResults = sortLibraryEntries(library.state.searchMatches ?? []);
  const pageCount = library.state.pages.length;
  const collectionLabel = selectedCollection ? selectedCollection.title : "LIBRARY";
  const collectionOptions = dbs.length
    ? dbs.map((collection) => collection.title.toUpperCase())
    : ["NO COLLECTIONS"];
  const selectedIndex = Math.max(0, dbs.findIndex((collection) => collection.id === selectedDb));

  return (
    <div class="gsv-library-index">
      {/* Collection bar — every collection-level control lives here (mirrors the
          FILES machine bar): pick a collection, see its status, create / build one. */}
      <header class="gsv-library-collection-bar">
        <Select
          label="COLLECTION"
          size="medium"
          width={280}
          disabled={dbs.length === 0}
          options={collectionOptions}
          value={selectedIndex}
          onChange={(index) => {
            const next = dbs[index];
            if (next) {
              library.openCollection(next.id);
            }
          }}
        />
        {selectedCollection ? (
          <span class="gsv-library-collection-meta">
            <StatusDot tone={selectedCollection.writable ? "online" : "idle"} size={7} />
            {selectedCollection.writable ? "WRITE" : "READ"} · {pageCount} {pageCount === 1 ? "PAGE" : "PAGES"}
          </span>
        ) : null}
        <div class="gsv-library-collection-actions">
          <Button
            variant="primary"
            label={library.createCollectionOpen ? "CLOSE" : "NEW COLLECTION"}
            onClick={() => library.setCreateCollectionOpen((open) => !open)}
          />
          <Button
            variant="secondary"
            label="BUILD"
            onClick={() => library.navigate({ view: "build", ...(selectedDb ? { db: selectedDb } : {}) })}
          />
        </div>
      </header>
      {library.createCollectionOpen ? <CreateCollectionBox library={library} /> : null}

      {/* Body — left action panel (page-level: search + create inside the
          collection) beside a FILES-style page browser. */}
      <div class="gsv-library-workspace">
        <section class="gsv-library-action">
          <Search
            block
            placeholder="Search pages"
            disabled={!selectedDb}
            value={library.searchDraft}
            onChange={library.setSearchDraft}
            onSearch={() => library.applySearch()}
          />
          {searching ? (
            <Button variant="link" label="CLEAR SEARCH" onClick={library.clearSearch} />
          ) : null}
          <Button
            variant="primary"
            label="WRITE PAGE"
            disabled={!selectedDb || library.mutating}
            onClick={() => library.openEditor()}
          />
          <Button
            variant="secondary"
            label="CAPTURE SOURCE"
            disabled={!selectedDb}
            onClick={() => selectedDb ? library.navigate({ view: "capture", db: selectedDb }) : undefined}
          />
        </section>

        <section class="gsv-library-browser">
          {!selectedDb ? (
            <div class="gsv-library-empty-row">SELECT COLLECTION</div>
          ) : searching ? (
            <>
              <div class="gsv-library-browser-crumbs">
                <span class="gsv-library-browser-label">
                  SEARCH RESULTS · {searchResults.length} {searchResults.length === 1 ? "MATCH" : "MATCHES"}
                </span>
              </div>
              <div class="gsv-library-browser-list">
                <SearchResults db={selectedDb} entries={searchResults} onOpenPage={library.openPage} />
              </div>
            </>
          ) : (
            <FolderBrowser
              collectionLabel={collectionLabel}
              db={selectedDb}
              entries={library.state.pages}
              onOpenPage={library.openPage}
            />
          )}
        </section>
      </div>
    </div>
  );
}

/** FILES-style page browser: drill through the collection's folder tree with a
 *  breadcrumb trail. Folders synthesize from the flat page paths (buildLibraryTree). */
function FolderBrowser({
  collectionLabel,
  db,
  entries,
  onOpenPage,
}: {
  collectionLabel: string;
  db: string;
  entries: readonly LibraryEntry[];
  onOpenPage: (path: string) => void;
}) {
  const tree = useMemo(() => buildLibraryTree(entries, db), [db, entries]);
  const [folderPath, setFolderPath] = useState("");
  useEffect(() => {
    setFolderPath("");
  }, [db]);

  // Walk to the current folder, collecting ancestors for the breadcrumb trail.
  const ancestors: LibraryTreeNode[] = [];
  let current = tree;
  for (const part of folderPath.split("/").filter(Boolean)) {
    const next = current.children.find((child) => child.kind !== "file" && child.name === part);
    if (!next) {
      break;
    }
    ancestors.push(next);
    current = next;
  }

  const crumbs: Crumb[] = [
    { label: collectionLabel, onClick: () => setFolderPath("") },
    ...ancestors.map((folder) => ({ label: folder.title, onClick: () => setFolderPath(folder.path) })),
  ];
  const goUp = folderPath
    ? () => setFolderPath(ancestors.length > 1 ? ancestors[ancestors.length - 2].path : "")
    : undefined;

  const children = [...current.children].sort((left, right) =>
    (left.kind === "file" ? 1 : 0) - (right.kind === "file" ? 1 : 0)
    || left.title.localeCompare(right.title));

  return (
    <>
      <div class="gsv-library-browser-crumbs">
        <Breadcrumbs items={crumbs} size="medium" maxVisible={4} onBack={goUp} currentAriaCurrent="location" />
      </div>
      <div class="gsv-library-browser-list">
        {children.length === 0 ? (
          <div class="gsv-library-empty-row">NO PAGES</div>
        ) : children.map((child) => child.kind === "file" ? (
          <ListRow
            chevron
            icon={child.path === "index.md" ? "pencil" : "doticons/file"}
            key={child.id}
            label={child.title}
            onClick={() => child.entry ? onOpenPage(child.entry.path) : undefined}
            status="none"
            sub={child.entry ? libraryEntrySub(child.entry, db) : child.path}
          />
        ) : (
          <ListRow
            chevron
            icon="folder"
            key={child.id}
            label={child.title}
            onClick={() => setFolderPath(child.path)}
            status="none"
            sub={`${child.count} ${child.count === 1 ? "page" : "pages"}`}
            tag="DIR"
          />
        ))}
      </div>
    </>
  );
}

function SearchResults({
  db,
  entries,
  onOpenPage,
}: {
  db: string;
  entries: readonly LibraryEntry[];
  onOpenPage: (path: string) => void;
}) {
  if (entries.length === 0) {
    return <div class="gsv-library-empty-row">NO MATCHES</div>;
  }
  return (
    <div class="gsv-library-search-results">
      {entries.map((entry) => (
        <ListRow
          chevron
          icon={entry.path.endsWith("/index.md") ? "pencil" : "doticons/file"}
          key={entry.path}
          label={entry.path.endsWith("/index.md") ? "Overview" : entry.title}
          onClick={() => onOpenPage(entry.path)}
          status="none"
          sub={entry.snippet || libraryEntrySub(entry, db)}
        />
      ))}
    </div>
  );
}

function LibraryReader({ library }: { library: LibraryRuntime }) {
  const note = library.state.selectedNote;
  const [previewState, setPreviewState] = useState<PreviewState | null>(null);
  const [previewPayload, setPreviewPayload] = useState<LibraryPreviewPayload | null>(null);
  const [previewLoadingKey, setPreviewLoadingKey] = useState<string | null>(null);
  const previewMutateRef = useRef(library.preview.mutate);
  const previewCacheRef = useRef(new Map<string, LibraryPreviewPayload>());
  const previewInFlightRef = useRef(new Set<string>());
  const previewStateRef = useRef<PreviewState | null>(null);
  const previewCloseTimerRef = useRef<number | null>(null);
  const activePreviewKeyRef = useRef<string | null>(null);
  const openPageRef = useRef(library.openPage);

  previewMutateRef.current = library.preview.mutate;
  openPageRef.current = library.openPage;

  const clearPreviewCloseTimer = useCallback(() => {
    if (previewCloseTimerRef.current !== null) {
      window.clearTimeout(previewCloseTimerRef.current);
      previewCloseTimerRef.current = null;
    }
  }, []);
  const hidePreview = useCallback(() => {
    clearPreviewCloseTimer();
    previewStateRef.current = null;
    activePreviewKeyRef.current = null;
    setPreviewPayload(null);
    setPreviewLoadingKey(null);
    setPreviewState(null);
  }, [clearPreviewCloseTimer]);
  const openPreview = useCallback((anchor: HTMLElement, request: LibraryPreviewRequest, pin: boolean) => {
    clearPreviewCloseTimer();
    const key = previewRequestKey(request);
    const cached = previewCacheRef.current.get(key);
    const inFlight = previewInFlightRef.current.has(key);
    const shouldFetch = activePreviewKeyRef.current !== key && !cached && !inFlight;
    activePreviewKeyRef.current = key;

    const nextPreviewState = {
      key,
      pinned: pin || Boolean(previewStateRef.current?.key === key && previewStateRef.current.pinned),
      rect: anchor.getBoundingClientRect(),
      request,
    };
    previewStateRef.current = nextPreviewState;
    setPreviewState(nextPreviewState);

    if (cached) {
      setPreviewPayload(cached);
      setPreviewLoadingKey(null);
      return;
    }

    setPreviewPayload(null);
    setPreviewLoadingKey(key);

    if (shouldFetch) {
      previewInFlightRef.current.add(key);
      previewMutateRef.current(request, {
        onSuccess: (payload) => {
          previewCacheRef.current.set(key, payload);
          previewInFlightRef.current.delete(key);
          if (activePreviewKeyRef.current === key) {
            setPreviewPayload(payload);
            setPreviewLoadingKey(null);
          }
        },
        onError: (error) => {
          const payload: LibraryPreviewPayload = {
            ok: false,
            error: previewErrorMessage(error),
          };
          previewInFlightRef.current.delete(key);
          if (activePreviewKeyRef.current === key) {
            setPreviewPayload(payload);
            setPreviewLoadingKey(null);
          }
        },
      });
    }
  }, [clearPreviewCloseTimer]);
  const closePreview = useCallback((force: boolean) => {
    const current = previewStateRef.current;
    if (!current || (!force && current.pinned)) {
      return;
    }
    if (force) {
      hidePreview();
      return;
    }
    clearPreviewCloseTimer();
    previewCloseTimerRef.current = window.setTimeout(() => {
      hidePreview();
    }, 220);
  }, [clearPreviewCloseTimer, hidePreview]);
  const openPage = useCallback((path: string) => {
    openPageRef.current(path);
  }, []);

  useEffect(() => clearPreviewCloseTimer, [clearPreviewCloseTimer]);

  if (!note || !library.activeRoute.db) {
    return (
      <Surface class="gsv-library-empty-state" level={2}>
        <Icon name="doticons/file" size={34} />
        <h2>PAGE NOT FOUND</h2>
        <p>Select an existing page or create a new one.</p>
      </Surface>
    );
  }
  const db = library.activeRoute.db;

  return (
    <div class="gsv-library-reader-page">
      <LibraryPageHeader
        eyebrow={library.activeRoute.db}
        title={note.title}
        meta={note.path}
        actions={(
          <>
            {/* Back to the library index is owned by the breadcrumb now. */}
            <Button
              variant="primary"
              label="EDIT"
              onClick={() => library.navigate({
                view: "editor",
                db,
                path: localLibraryPath(note.path, db),
              })}
            />
          </>
        )}
      />
      <div class="gsv-library-reader-grid">
        <Surface class="gsv-library-reader" level={2}>
          <LibraryMarkdownView
            note={note}
            selectedDb={db}
            onOpenPage={openPage}
            onPreviewClose={closePreview}
            onPreviewOpen={openPreview}
          />
        </Surface>
        <Surface class="gsv-library-outline" level={1}>
          <SectionHeader title="OUTLINE" meta={`${library.pageHeadings.length}`} divider />
          {library.pageHeadings.length === 0 ? (
            <div class="gsv-library-empty-row">NO HEADINGS</div>
          ) : library.pageHeadings.map((heading) => (
            <a
              class={`gsv-library-outline-row level-${heading.level}`}
              href={`#${heading.id}`}
              key={heading.id}
            >
              {heading.text}
            </a>
          ))}
        </Surface>
      </div>
      <LibraryPreviewLayer
        data={previewPayload}
        loading={Boolean(previewState && previewLoadingKey === previewState.key)}
        state={previewState}
        onClose={() => closePreview(true)}
        onPreviewEnter={clearPreviewCloseTimer}
        onPreviewLeave={() => closePreview(false)}
      />
    </div>
  );
}

function LibraryEditor({ library }: { library: LibraryRuntime }) {
  const db = library.activeRoute.db || library.state.selectedDb;
  const editingExisting = library.activeRoute.view === "editor" && Boolean(library.activeRoute.path);
  return (
    <div class="gsv-library-editor-page">
      {/* Back to the library index is owned by the breadcrumb now. */}
      <LibraryPageHeader
        eyebrow={db || "LIBRARY"}
        title={editingExisting ? "Edit Page" : "Write Page"}
        meta={library.editorPath || "NEW PAGE"}
      />
      <Surface class="gsv-library-editor" level={2}>
        <div class="gsv-library-editor-meta">
          <TextInput
            label="PATH"
            placeholder={`${db || "memory"}/pages/page.md`}
            requirement="required"
            value={library.editorPath}
            onChange={library.setEditorPath}
          />
        </div>
        <TextArea
          label="MARKDOWN"
          rows={24}
          value={library.editorMarkdown}
          onChange={library.setEditorMarkdown}
        />
        <div class="gsv-library-actions">
          <Button
            variant="secondary"
            label="RESET"
            disabled={library.mutating}
            onClick={library.resetEditor}
          />
          <Button
            variant="primary"
            label={library.mutating ? "SAVING" : "SAVE"}
            disabled={library.mutating || !db}
            onClick={library.savePage}
          />
        </div>
      </Surface>
    </div>
  );
}

function LibraryCapture({ library }: { library: LibraryRuntime }) {
  const db = library.activeRoute.db || library.state.selectedDb;
  return (
    <div class="gsv-library-form-page">
      <LibraryPageHeader
        eyebrow={db || "LIBRARY"}
        title="Capture Source"
        meta="CREATE SOURCE-BACKED PAGE"
      />
      <Surface class="gsv-library-form-panel" level={2}>
        <div class="gsv-library-form-grid">
          <TextInput
            label="TARGET"
            placeholder="gsv"
            requirement="required"
            value={library.ingestTarget}
            onChange={library.setIngestTarget}
          />
          <TextInput
            label="SOURCE PATH"
            placeholder="/home/xanadu/project/notes.md"
            requirement="required"
            value={library.ingestPath}
            onChange={library.setIngestPath}
          />
          <TextInput
            label="TITLE"
            placeholder="Source note title"
            value={library.ingestTitle}
            onChange={library.setIngestTitle}
          />
          <TextArea
            label="SUMMARY"
            placeholder="Why this source matters."
            rows={9}
            value={library.ingestSummary}
            onChange={library.setIngestSummary}
          />
        </div>
        <div class="gsv-library-actions">
          <Button variant="secondary" label="BACK" onClick={() => db ? library.navigate({ view: "index", db }) : library.navigate({ view: "index" })} />
          <Button
            variant="primary"
            label={library.mutating ? "CAPTURING" : "CAPTURE"}
            disabled={library.mutating || !db}
            onClick={library.ingestSource}
          />
        </div>
      </Surface>
    </div>
  );
}

function LibraryBuild({ library }: { library: LibraryRuntime }) {
  const db = library.activeRoute.db || library.state.selectedDb;
  return (
    <div class="gsv-library-form-page">
      <LibraryPageHeader
        eyebrow={db || "LIBRARY"}
        title="Build From Directory"
        meta="BACKGROUND AGENT"
      />
      <Surface class="gsv-library-form-panel" level={2}>
        <div class="gsv-library-form-grid">
          <TextInput
            label="SOURCE TARGET"
            placeholder="gsv"
            requirement="required"
            value={library.buildTarget}
            onChange={library.setBuildTarget}
          />
          <TextInput
            label="SOURCE DIRECTORY"
            placeholder="/home/xanadu/project/docs"
            requirement="required"
            value={library.buildPath}
            onChange={library.setBuildPath}
          />
          <TextInput
            label="DESTINATION ID"
            placeholder="memory"
            requirement="required"
            value={library.buildDbId}
            onChange={library.setBuildDbId}
          />
          <TextInput
            label="DESTINATION TITLE"
            placeholder="Agent Memory"
            value={library.buildDbTitle}
            onChange={library.setBuildDbTitle}
          />
        </div>
        <div class="gsv-library-actions">
          <Button variant="secondary" label="BACK" onClick={() => db ? library.navigate({ view: "index", db }) : library.navigate({ view: "index" })} />
          <Button
            variant="primary"
            label={library.mutating ? "STARTING" : "START BUILD"}
            disabled={library.mutating}
            onClick={library.startBuild}
          />
        </div>
      </Surface>
    </div>
  );
}

function LibraryPageHeader({
  actions,
  eyebrow,
  meta,
  title,
}: {
  actions?: ComponentChildren;
  eyebrow: string;
  meta: string;
  title: string;
}) {
  return (
    <header class="gsv-library-page-head">
      <div>
        <span>{eyebrow}</span>
        <h2>{title}</h2>
      </div>
      <p>{meta}</p>
      {actions ? <div class="gsv-library-page-actions">{actions}</div> : null}
    </header>
  );
}

function CreateCollectionBox({ library }: { library: LibraryRuntime }) {
  return (
    <Surface class="gsv-library-create-box" level={2}>
      <TextInput
        label="TITLE"
        placeholder="Agent Memory"
        requirement="required"
        value={library.newCollectionTitle}
        onChange={library.setNewCollectionTitle}
      />
      <TextInput
        label="ID"
        placeholder="memory"
        requirement="required"
        value={library.newCollectionId}
        onChange={library.setNewCollectionId}
      />
      <div class="gsv-library-inline-actions">
        <Button
          variant="secondary"
          label="CANCEL"
          disabled={library.mutating}
          onClick={() => library.setCreateCollectionOpen(false)}
        />
        <Button
          variant="primary"
          label={library.mutating ? "CREATING" : "CREATE"}
          disabled={library.mutating}
          onClick={library.createCollection}
        />
      </div>
    </Surface>
  );
}

function LibraryPreviewLayer({
  data,
  loading,
  onClose,
  onPreviewEnter,
  onPreviewLeave,
  state,
}: {
  data: LibraryPreviewPayload | null | undefined;
  loading: boolean;
  onClose: () => void;
  onPreviewEnter: () => void;
  onPreviewLeave: () => void;
  state: PreviewState | null;
}) {
  if (!state) {
    return null;
  }
  const left = Math.min(Math.max(16, state.rect.left), Math.max(16, window.innerWidth - 456));
  const top = Math.min(state.rect.bottom + 10, Math.max(16, window.innerHeight - 360));

  return (
    <Surface
      class="gsv-library-preview"
      level={2}
      dataAttrs={{ "data-pinned": state.pinned ? "true" : "false" }}
    >
      <div
        class="gsv-library-preview-shell"
        onMouseEnter={onPreviewEnter}
        onMouseLeave={onPreviewLeave}
        style={{ left: `${left}px`, top: `${top}px` }}
      >
        <div class="gsv-library-preview-head">
          <span>{state.request.kind === "page" ? "PAGE PREVIEW" : "SOURCE PREVIEW"}</span>
          <button type="button" aria-label="Close preview" onClick={onClose}>×</button>
        </div>
        <div
          class="gsv-library-preview-body"
          dangerouslySetInnerHTML={{
            __html: loading ? '<div class="gsv-library-preview-empty">Loading preview...</div>' : renderPreviewBodyHtml(data ?? { ok: false, error: "Preview unavailable." }),
          }}
        />
      </div>
    </Surface>
  );
}

function StatusBanner({
  label,
  tone,
}: {
  label: string;
  tone: "error" | "live";
}) {
  return (
    <div class={`gsv-library-status is-${tone}`} role={tone === "error" ? "alert" : "status"}>
      <StatusDot tone={tone} size={7} />
      <span>{label}</span>
    </div>
  );
}


function previewRequestKey(request: LibraryPreviewRequest): string {
  if (request.kind === "page") {
    return `page:${request.db || ""}:${request.path}`;
  }
  return `source:${request.target}:${request.path}:${request.title || ""}`;
}

function previewErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "Preview unavailable.");
}
