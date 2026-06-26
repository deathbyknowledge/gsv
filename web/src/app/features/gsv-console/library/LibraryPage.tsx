import type { ComponentChildren, JSX } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ShellLibraryRoute } from "../../gsv-shell/domain/shellModel";
import { AddAction } from "../../../components/ui/AddAction";
import { Button } from "../../../components/ui/Button";
import { Icon } from "../../../components/ui/Icon";
import { ListRow } from "../../../components/ui/ListRow";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { StatusDot } from "../../../components/ui/StatusDot";
import { Surface } from "../../../components/ui/Surface";
import { TextArea } from "../../../components/ui/TextArea";
import { TextInput } from "../../../components/ui/TextInput";
import {
  ConsolePage,
  ConsolePageState,
} from "../components/ConsolePageTemplate";
import {
  ancestorFolderPaths,
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
  LibraryCollection,
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
    const editorDirty =
      library.activeRoute.view === "editor" &&
      library.editorMarkdown !== (library.state.selectedNote?.markdown ?? "");
    const captureDirty =
      library.activeRoute.view === "capture" &&
      (library.ingestPath.trim().length > 0 ||
        library.ingestTitle.trim().length > 0 ||
        library.ingestSummary.trim().length > 0);
    const buildDirty =
      library.activeRoute.view === "build" &&
      (library.buildPath.trim().length > 0 ||
        library.buildDbTitle.trim().length > 0);
    const collectionDirty =
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
  const selectedDb = library.state.selectedDb;
  const pages = sortLibraryEntries(library.state.searchMatches ?? library.state.pages);
  const searching = library.state.searchQuery.trim().length > 0;

  return (
    <div class="gsv-library-index">
      <LibraryPageHeader
        eyebrow="LIBRARY"
        title={selectedDb ? collectionTitle(library.state.dbs, selectedDb) : "Knowledge Library"}
        meta={selectedDb ? selectedDb : "SELECT COLLECTION"}
        actions={(
          <>
            <Button
              variant="secondary"
              label="BUILD"
              onClick={() => library.navigate({ view: "build", ...(selectedDb ? { db: selectedDb } : {}) })}
            />
            <Button
              variant="primary"
              label="NEW PAGE"
              disabled={!selectedDb}
              onClick={() => selectedDb ? library.navigate({ view: "editor", db: selectedDb }) : undefined}
            />
          </>
        )}
      />

      <div class="gsv-library-index-grid">
        <Surface class="gsv-library-panel gsv-library-collections" level={2}>
          <SectionHeader title="COLLECTIONS" meta={`${library.state.dbs.length}`} divider />
          <div class="gsv-library-panel-body">
            {library.state.dbs.length === 0 ? (
              <div class="gsv-library-empty-row">NO COLLECTIONS</div>
            ) : library.state.dbs.map((collection) => (
              <CollectionRow
                collection={collection}
                key={collection.id}
                selected={collection.id === selectedDb}
                onOpen={() => library.openCollection(collection.id)}
              />
            ))}
            <AddAction
              variant="row"
              label={library.createCollectionOpen ? "CLOSE CREATOR" : "NEW COLLECTION"}
              onClick={() => library.setCreateCollectionOpen((open) => !open)}
            />
          </div>
          {library.createCollectionOpen ? <CreateCollectionBox library={library} /> : null}
        </Surface>

        <Surface class="gsv-library-panel gsv-library-tree-panel" level={2}>
          <SectionHeader
            title={searching ? "SEARCH RESULTS" : "PAGES"}
            meta={searching ? `${pages.length} MATCHES` : `${pages.length}`}
            divider
          />
          <div class="gsv-library-search-zone">
            <form
              class="gsv-library-search"
              onSubmit={(event) => {
                event.preventDefault();
                library.applySearch();
              }}
            >
              <TextInput
                label=""
                placeholder="Search pages"
                clearable
                size="small"
                value={library.searchDraft}
                onChange={library.setSearchDraft}
              />
              <Button variant="secondary" label="SEARCH" type="submit" />
              {searching ? <Button variant="link" label="CLEAR" onClick={library.clearSearch} /> : null}
            </form>
          </div>
          <div class="gsv-library-tree-scroll">
            {!selectedDb ? (
              <div class="gsv-library-empty-row">SELECT COLLECTION</div>
            ) : searching ? (
              <SearchResults db={selectedDb} entries={pages} onOpenPage={library.openPage} />
            ) : (
              <LibraryTree
                db={selectedDb}
                entries={pages}
                selectedPath=""
                onOpenPage={library.openPage}
              />
            )}
          </div>
        </Surface>

        <Surface class="gsv-library-panel gsv-library-actions-panel" level={2}>
          <SectionHeader title="AUTHORING" meta={selectedDb || "IDLE"} divider />
          <div class="gsv-library-authoring-stack">
            <TextInput
              label="PAGE TITLE"
              placeholder="New page title"
              value={library.newPageTitle}
              onChange={library.setNewPageTitle}
            />
            <Button
              variant="primary"
              label="WRITE PAGE"
              disabled={!selectedDb || library.mutating}
              onClick={library.createPageDraft}
            />
            <Button
              variant="secondary"
              label="CAPTURE SOURCE"
              disabled={!selectedDb}
              onClick={() => selectedDb ? library.navigate({ view: "capture", db: selectedDb }) : undefined}
            />
            <Button
              variant="secondary"
              label="BUILD FROM DIRECTORY"
              onClick={() => library.navigate({ view: "build", ...(selectedDb ? { db: selectedDb } : {}) })}
            />
          </div>
        </Surface>
      </div>
    </div>
  );
}

function CollectionRow({
  collection,
  onOpen,
  selected,
}: {
  collection: LibraryCollection;
  onOpen: () => void;
  selected: boolean;
}) {
  return (
    <ListRow
      active={selected}
      chevron
      icon="pencil"
      label={collection.title}
      onClick={onOpen}
      status={collection.writable ? "online" : "idle"}
      statusDotPlacement="trailing"
      statusLabel={collection.writable ? "WRITE" : "READ"}
      sub={collection.id}
    />
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

function LibraryTree({
  db,
  entries,
  onOpenPage,
  selectedPath,
}: {
  db: string;
  entries: readonly LibraryEntry[];
  onOpenPage: (path: string) => void;
  selectedPath: string;
}) {
  const tree = useMemo(() => buildLibraryTree(entries, db), [db, entries]);
  const selectedLocalPath = selectedPath ? localLibraryPath(selectedPath, db) : "";
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(ancestorFolderPaths(selectedLocalPath)));

  const toggle = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  if (tree.children.length === 0) {
    return <div class="gsv-library-empty-row">NO PAGES</div>;
  }

  return (
    <div class="gsv-library-tree" role="tree">
      {tree.children.map((node) => (
        <LibraryTreeNodeView
          db={db}
          expanded={expanded}
          key={node.id}
          node={node}
          onOpenPage={onOpenPage}
          onToggle={toggle}
          selectedLocalPath={selectedLocalPath}
          depth={0}
        />
      ))}
    </div>
  );
}

function LibraryTreeNodeView({
  db,
  depth,
  expanded,
  node,
  onOpenPage,
  onToggle,
  selectedLocalPath,
}: {
  db: string;
  depth: number;
  expanded: Set<string>;
  node: LibraryTreeNode;
  onOpenPage: (path: string) => void;
  onToggle: (path: string) => void;
  selectedLocalPath: string;
}) {
  if (node.kind === "file") {
    return (
      <div class="gsv-library-tree-row" style={{ "--library-tree-depth": depth } as JSX.CSSProperties}>
        <ListRow
          active={Boolean(selectedLocalPath && selectedLocalPath === node.path)}
          chevron
          icon={node.path === "index.md" ? "pencil" : "doticons/file"}
          label={node.title}
          onClick={() => node.entry ? onOpenPage(node.entry.path) : undefined}
          status="none"
          sub={node.entry ? libraryEntrySub(node.entry, db) : node.path}
        />
      </div>
    );
  }

  const open = expanded.has(node.path);
  return (
    <div class="gsv-library-tree-folder" role="treeitem" aria-expanded={open}>
      <div class="gsv-library-tree-row" style={{ "--library-tree-depth": depth } as JSX.CSSProperties}>
        <ListRow
          chevron
          icon="folder"
          label={node.title}
          onClick={() => onToggle(node.path)}
          status="none"
          sub={`${node.count} ${node.count === 1 ? "page" : "pages"}`}
          tag={open ? "OPEN" : undefined}
        />
      </div>
      {open ? (
        <div role="group">
          {node.children.map((child) => (
            <LibraryTreeNodeView
              db={db}
              depth={depth + 1}
              expanded={expanded}
              key={child.id}
              node={child}
              onOpenPage={onOpenPage}
              onToggle={onToggle}
              selectedLocalPath={selectedLocalPath}
            />
          ))}
        </div>
      ) : null}
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
            <Button
              variant="secondary"
              label="LIBRARY"
              onClick={() => library.navigate({ view: "index", db })}
            />
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
      <LibraryPageHeader
        eyebrow={db || "LIBRARY"}
        title={editingExisting ? "Edit Page" : "Write Page"}
        meta={library.editorPath || "NEW PAGE"}
        actions={(
          <Button
            variant="secondary"
            label="BACK"
            onClick={() => db ? library.navigate({ view: "index", db }) : library.navigate({ view: "index" })}
          />
        )}
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
        actions={<Button variant="secondary" label="BACK" onClick={() => db ? library.navigate({ view: "index", db }) : library.navigate({ view: "index" })} />}
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
        actions={<Button variant="secondary" label="BACK" onClick={() => db ? library.navigate({ view: "index", db }) : library.navigate({ view: "index" })} />}
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

function collectionTitle(collections: readonly LibraryCollection[], db: string): string {
  return collections.find((collection) => collection.id === db)?.title || db;
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
