import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { AddAction } from "../../../components/ui/AddAction";
import { Breadcrumbs } from "../../../components/ui/Breadcrumbs";
import { Button } from "../../../components/ui/Button";
import { ConfirmModal } from "../../../components/ui/ConfirmModal";
import { IconButton } from "../../../components/ui/IconButton";
import { ListRow } from "../../../components/ui/ListRow";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { Search } from "../../../components/ui/Search";
import { Select } from "../../../components/ui/Select";
import { Spinner } from "../../../components/ui/Spinner";
import { StatusDot, type StatusTone } from "../../../components/ui/StatusDot";
import { Surface } from "../../../components/ui/Surface";
import { Tabs } from "../../../components/ui/Tabs";
import { Tag } from "../../../components/ui/Tag";
import { TextInput } from "../../../components/ui/TextInput";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import {
  ConsolePage,
  ConsoleResourceBoundary,
} from "../../gsv-console/components/ConsolePageTemplate";
import { pushShellRoute } from "../../gsv-shell/routing/shellRoutes";
import type {
  FilesDirectoryPayload,
  FilesErrorPayload,
  FilesFilePayload,
  FilesReadPayload,
  FilesSearchPayload,
  FilesTarget,
} from "../domain/models";
import {
  buildPathCrumbs,
  chooseInitialTarget,
  describeTarget,
  formatBytes,
  formatFileStats,
  formatSearchMatchLine,
  formatTargetOption,
  imagePreviewsFromContent,
  pathRoot,
  resolveEnteredPath,
  sortDirectoryEntries,
  textFromContent,
} from "../domain/view";
import {
  createBrowserTab,
  createFileTab,
  pathBasename,
  pathParent,
  tabLabel,
  type FilesBrowserTab,
  type FilesFileTab,
  type FilesWorkspaceTab,
} from "../domain/workspace";
import { useFilesMutations, useFilesPath, useFilesSearch, useFilesTargets } from "../hooks/useFilesQueries";
import "./FilesSurfaceSummary.css";

/** Sentinel appended to the machine Select so the user can jump to provisioning. */
const ADD_MACHINE_OPTION = "+ ADD MACHINE";

/** Navigate to the machine-provisioning route. The shell has no nav context that
 *  reaches this deeply-nested console page, so we push the route + dispatch a
 *  popstate, which the shell already listens for to re-render from the URL. */
function openAddMachineRoute() {
  pushShellRoute({
    surface: "settings",
    settingsRoute: { view: "list", kind: "machines", createNew: true },
  });
  window.dispatchEvent(new PopStateEvent("popstate"));
}

const DEFAULT_PATH = ".";
const FILE_ICON = "doticons/file";
const FOLDER_ICON = "doticons/folder";
const COMPACT_ROW_STYLE: JSX.CSSProperties = {
  minHeight: "46px",
  padding: "12px 14px",
};

type InlineStateKind = "loading" | "error" | "success" | "info" | "warn";
type StateKind = "loading" | "error" | "empty" | "offline";

type OperationFeedback = {
  kind: Exclude<InlineStateKind, "loading">;
  title: string;
  detail: string;
};

type FileDraftState = {
  sourceText: string;
  baseline: string;
  draft: string;
  feedback: OperationFeedback | null;
};

type CreateState = {
  open: boolean;
  pathInput: string;
  content: string;
  feedback: OperationFeedback | null;
};

type DeleteRequest = {
  targetId: string;
  sourceTabId: string;
  path: string;
};

const STATE_TONE: Record<StateKind, StatusTone> = {
  loading: "live",
  error: "error",
  empty: "idle",
  offline: "idle",
};

const INLINE_STATE_TONE: Record<InlineStateKind, StatusTone> = {
  loading: "live",
  error: "error",
  success: "online",
  info: "idle",
  warn: "warn",
};

function queryErrorText(error: unknown): string {
  return error instanceof Error ? error.message : error ? String(error) : "";
}

function mutationErrorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : error ? String(error) : fallback;
}

function isDirectoryPayload(payload: FilesReadPayload | FilesErrorPayload | undefined): payload is FilesDirectoryPayload {
  return Boolean(payload?.ok && "entries" in payload);
}

function isFilePayload(payload: FilesReadPayload | FilesErrorPayload | undefined): payload is FilesFilePayload {
  return Boolean(payload?.ok && "content" in payload);
}

function targetForTab(tab: FilesWorkspaceTab, targets: readonly FilesTarget[]): FilesTarget | null {
  return targets.find((target) => target.id === tab.targetId) ?? null;
}

function fileTextEditable(file: FilesFilePayload): boolean {
  return imagePreviewsFromContent(file.content).length === 0;
}

function emptyCreateState(feedback: OperationFeedback | null = null): CreateState {
  return {
    open: false,
    pathInput: "",
    content: "",
    feedback,
  };
}

function FilesStateMessage({
  kind,
  title,
  detail,
  action,
}: {
  kind: StateKind;
  title: string;
  detail?: string;
  action?: JSX.Element;
}) {
  return (
    <div class={`files-state files-state-${kind}`} role={kind === "error" ? "alert" : "status"}>
      <span class="files-state-mark">
        {kind === "loading" ? <Spinner size={18} /> : <StatusDot tone={STATE_TONE[kind]} size={8} />}
      </span>
      <span class="files-state-copy">
        <strong>{title}</strong>
        {detail ? <span>{detail}</span> : null}
      </span>
      {action ? <span class="files-state-action">{action}</span> : null}
    </div>
  );
}

function FilesInlineNotice({
  kind,
  title,
  detail,
  action,
}: {
  kind: InlineStateKind;
  title: string;
  detail: string;
  action?: JSX.Element;
}) {
  return (
    <div class={`files-inline-notice files-inline-${kind}`} role={kind === "error" ? "alert" : "status"}>
      <span class="files-inline-mark">
        {kind === "loading" ? <Spinner size={16} /> : <StatusDot tone={INLINE_STATE_TONE[kind]} size={8} />}
      </span>
      <span class="files-inline-copy">
        <strong>{title}</strong>
        <span>{detail}</span>
      </span>
      {action ? <span class="files-inline-actions">{action}</span> : null}
    </div>
  );
}

function DirectoryBrowser({
  directory,
  onOpenDirectory,
  onOpenFile,
  onOpenFileInNewTab,
  onOpenParent,
  onOpenCreate,
  onSelectionChange,
}: {
  directory: FilesDirectoryPayload;
  onOpenDirectory: (path: string) => void;
  onOpenFile: (path: string) => void;
  onOpenFileInNewTab: (path: string) => void;
  onOpenParent: () => void;
  onOpenCreate: () => void;
  // Reports the currently selected FILE path (or null) up to the toolbar so it
  // can offer DELETE for that file. Directory selections report null.
  onSelectionChange: (path: string | null) => void;
}) {
  const entries = sortDirectoryEntries(directory.entries);
  const directoryCount = entries.filter((entry) => entry.kind === "directory").length;
  const fileCount = entries.length - directoryCount;
  // Keyboard/selection cursor over the listing; clamped against the live entry
  // count below. -1 means "nothing selected" (e.g. after a fresh navigation).
  const [selectedRowIndex, setSelectedRowIndex] = useState(-1);
  const cursor = entries.length === 0 ? -1 : Math.min(selectedRowIndex, entries.length - 1);

  // Re-derive the directory path so a navigation into a new folder resets the
  // selection (stale highlight + toolbar DELETE) back to "nothing selected".
  useEffect(() => {
    setSelectedRowIndex(-1);
  }, [directory.path]);

  // Lift the selected FILE path (directories never expose a DELETE target).
  useEffect(() => {
    const entry = cursor >= 0 ? entries[cursor] : undefined;
    onSelectionChange(entry && entry.kind === "file" ? entry.path : null);
  }, [cursor, directory.path, directory.entries]);

  const selectEntry = (index: number) => {
    setSelectedRowIndex(index);
  };

  const openEntry = (index: number) => {
    const entry = entries[index];
    if (!entry) {
      return;
    }
    if (entry.kind === "directory") {
      onOpenDirectory(entry.path);
    } else {
      onOpenFile(entry.path);
    }
  };

  // ArrowUp/Down move the selection, Enter opens (file → preview, dir → in),
  // Backspace/ArrowLeft go up a dir.
  const onKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedRowIndex((index) => Math.min(index + 1, entries.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedRowIndex((index) => Math.max((index < 0 ? 0 : index) - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      openEntry(cursor);
    } else if (event.key === "Backspace" || event.key === "ArrowLeft") {
      event.preventDefault();
      onOpenParent();
    }
  };

  return (
    <div class="files-browser-list" tabIndex={0} onKeyDown={onKeyDown} aria-label="Directory entries">
      <div class="files-list-summary">
        <Tag tone="accent" label={`${directoryCount} DIR`} boxed />
        <Tag tone="idle" label={`${fileCount} FILE`} boxed />
      </div>
      {entries.length === 0 ? (
        <FilesStateMessage
          kind="empty"
          title="EMPTY DIRECTORY"
          detail={`${directory.path} has no entries returned by the target.`}
        />
      ) : entries.map((entry, index) => (
        <div
          class="files-row-wrap"
          key={`${entry.kind}:${entry.path}`}
        >
          <ListRow
            className={`files-object-row${index === cursor ? " is-selected" : ""}`}
            icon={entry.kind === "directory" ? FOLDER_ICON : FILE_ICON}
            label={entry.name}
            sub={entry.path}
            status="none"
            tag={entry.kind === "directory" ? "DIR" : "FILE"}
            tagTone={entry.kind === "directory" ? "accent" : "idle"}
            chevron
            style={COMPACT_ROW_STYLE}
            // Single-click selects the row AND opens it — directory navigates in,
            // file opens in the preview tab. The selected file (highlight) keys the
            // toolbar DELETE.
            onClick={() => {
              selectEntry(index);
              openEntry(index);
            }}
          />
          {entry.kind === "file" ? (
            <span class="files-row-action">
              <IconButton glyph="newTab" size="small" title="Open in new tab" onClick={() => onOpenFileInNewTab(entry.path)} />
            </span>
          ) : null}
        </div>
      ))}
      <div class="files-add-row">
        <AddAction label="NEW FILE" onClick={onOpenCreate} variant="row" />
      </div>
    </div>
  );
}

function SearchResults({
  connected,
  target,
  payload,
  query,
  isLoading,
  queryError,
  onOpenFile,
  onRetry,
}: {
  connected: boolean;
  target: FilesTarget | null;
  payload: FilesSearchPayload | FilesErrorPayload | undefined;
  query: string;
  isLoading: boolean;
  queryError: string;
  onOpenFile: (path: string) => void;
  onRetry: () => void;
}) {
  if (!connected) {
    return <FilesStateMessage kind="offline" title="GATEWAY OFFLINE" detail="Reconnect to search file targets." />;
  }
  if (!target) {
    return <FilesStateMessage kind="empty" title="NO TARGET SELECTED" detail="Choose a target to search." />;
  }
  if (!target.online) {
    return <FilesStateMessage kind="offline" title="TARGET OFFLINE" detail={`${target.label} is not accepting search requests.`} />;
  }
  if (!query) {
    return <FilesStateMessage kind="empty" title="SEARCH READY" detail="Enter a query to search the current folder." />;
  }
  if (isLoading && !payload) {
    return <FilesStateMessage kind="loading" title="SEARCHING" detail={query} />;
  }
  if (queryError) {
    return (
      <FilesStateMessage
        kind="error"
        title="SEARCH FAILED"
        detail={queryError}
        action={<Button variant="secondary" label="RETRY" onClick={onRetry} />}
      />
    );
  }
  if (!payload) {
    return <FilesStateMessage kind="empty" title="NO SEARCH RESULTS" detail="Run a search to inspect matches." />;
  }
  if (!payload.ok) {
    return (
      <FilesStateMessage
        kind="error"
        title="SEARCH FAILED"
        detail={payload.error}
        action={<Button variant="secondary" label="RETRY" onClick={onRetry} />}
      />
    );
  }
  if (payload.matches.length === 0) {
    return <FilesStateMessage kind="empty" title="NO MATCHES" detail={`No results for "${payload.query}".`} />;
  }

  return (
    <div class="files-search-results">
      {payload.matches.map((match, index) => (
        <button
          type="button"
          class="files-search-row"
          key={`${match.path}:${match.line ?? "match"}:${index}`}
          onClick={() => onOpenFile(match.path)}
        >
          <span class="files-search-path">{match.path}</span>
          <span class="files-search-line">{formatSearchMatchLine(match)}</span>
          <span class="files-search-preview">{match.content}</span>
        </button>
      ))}
      {payload.truncated ? <div class="files-search-truncated">RESULTS TRUNCATED BY TARGET</div> : null}
    </div>
  );
}

function CreateFilePanel({
  basePath,
  state,
  pending,
  onCancel,
  onChange,
  onCreate,
}: {
  basePath: string;
  state: CreateState;
  pending: boolean;
  onCancel: () => void;
  onChange: (state: CreateState) => void;
  onCreate: () => void;
}) {
  if (!state.open) {
    return state.feedback ? <FilesInlineNotice kind={state.feedback.kind} title={state.feedback.title} detail={state.feedback.detail} /> : null;
  }

  const resolvedPath = state.pathInput.trim().length > 0 ? resolveEnteredPath(state.pathInput, basePath) : "";

  return (
    <section class="files-create-panel" aria-label="Create file">
      <SectionHeader title="NEW FILE" meta={resolvedPath || basePath} divider />
      <div class="files-create-body">
        <TextInput
          label="FILE PATH"
          value={state.pathInput}
          placeholder="new-file.txt"
          status={state.pathInput.trim() ? "success" : "warning"}
          message={resolvedPath || "Path required"}
          clearable
          disabled={pending}
          onChange={(pathInput) => onChange({ ...state, pathInput, feedback: null })}
        />
        <label class="files-field">
          <span>INITIAL CONTENT</span>
          <textarea
            class="files-textarea"
            value={state.content}
            rows={7}
            disabled={pending}
            spellcheck={false}
            onInput={(event) => onChange({ ...state, content: event.currentTarget.value, feedback: null })}
          />
        </label>
        <div class="files-create-footer">
          <span class="files-editor-status">
            <StatusDot tone={pending ? "live" : state.pathInput.trim() ? "online" : "idle"} size={8} />
            <span>{pending ? "CREATING" : resolvedPath || "PATH REQUIRED"}</span>
          </span>
          <span class="files-editor-actions">
            <Button variant="secondary" label="CANCEL" disabled={pending} onClick={onCancel} />
            <Button variant="primary" label={pending ? "CREATING" : "CREATE"} disabled={pending || !resolvedPath} onClick={onCreate} />
          </span>
        </div>
        {pending ? <FilesInlineNotice kind="loading" title="CREATING" detail={resolvedPath} /> : state.feedback ? (
          <FilesInlineNotice kind={state.feedback.kind} title={state.feedback.title} detail={state.feedback.detail} />
        ) : null}
      </div>
    </section>
  );
}

function BrowserTabView({
  connected,
  target,
  tab,
  payload,
  isLoading,
  isFetching,
  queryError,
  searchPayload,
  searchLoading,
  searchError,
  createState,
  createPending,
  onCreateStateChange,
  onCreateCancel,
  onCreateSubmit,
  onNavigate,
  onSearchInputChange,
  onSearchSubmit,
  onOpenFile,
  onOpenFileInNewTab,
  onRefresh,
  onSearchRetry,
  onRequestDelete,
}: {
  connected: boolean;
  target: FilesTarget | null;
  tab: FilesBrowserTab;
  payload: FilesReadPayload | FilesErrorPayload | undefined;
  isLoading: boolean;
  isFetching: boolean;
  queryError: string;
  searchPayload: FilesSearchPayload | FilesErrorPayload | undefined;
  searchLoading: boolean;
  searchError: string;
  createState: CreateState;
  createPending: boolean;
  onCreateStateChange: (state: CreateState) => void;
  onCreateCancel: () => void;
  onCreateSubmit: () => void;
  onNavigate: (path: string) => void;
  onSearchInputChange: (value: string) => void;
  onSearchSubmit: (value: string) => void;
  onOpenFile: (path: string) => void;
  onOpenFileInNewTab: (path: string) => void;
  onRefresh: () => void;
  onSearchRetry: () => void;
  onRequestDelete: (path: string) => void;
}) {
  const displayedPath = payload?.path ?? tab.path;
  const canQuery = connected && Boolean(target?.online);
  const atRoot = displayedPath === pathRoot(displayedPath);
  const basePath = isDirectoryPayload(payload) ? payload.path : isFilePayload(payload) ? payload.directoryPath : tab.path;
  // The listing lifts its selected FILE path here so the toolbar's second row
  // can offer DELETE for that file. Cleared on navigate/search/payload change.
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const readMeta = [
    target ? describeTarget(target) : "",
    isFetching && payload ? "REFRESHING" : "",
  ].filter(Boolean).join(" | ");

  // While the search view replaces the listing, there is no row selection, so
  // drop any stale selected file (and its toolbar DELETE) until we're back.
  const searchActive = Boolean(tab.searchQuery);
  useEffect(() => {
    if (searchActive && selectedFilePath !== null) {
      setSelectedFilePath(null);
    }
  }, [searchActive, selectedFilePath]);

  // Crumbs navigate; the current page (last crumb) stays static via no onClick.
  const crumbs = buildPathCrumbs(displayedPath).map((crumb, index, list) => ({
    label: crumb.label,
    onClick: index === list.length - 1 ? undefined : () => onNavigate(crumb.path),
  }));

  return (
    <section class="files-tab-panel" aria-label="Files browser">
      <SectionHeader title="BROWSER" meta={readMeta} divider />
      <div class="files-breadcrumbs-container">
        <Breadcrumbs
          items={crumbs}
          onBack={atRoot ? undefined : () => onNavigate(pathParent(displayedPath))}
          size="medium"
          maxVisible={3}
        />
        <span class="files-breadcrumbs-actions">
          <IconButton glyph="refresh" size="small" title="Refresh directory" disabled={!canQuery} onClick={onRefresh} />
        </span>
      </div>
      <div class="files-browser-toolbar">
        {/* Row 1: bounded search (left) + CREATE NEW (right). */}
        <div class="files-toolbar-row">
          <span class="files-toolbar-search">
            <Search
              key={`search-${tab.id}-${tab.commandInputKey}`}
              size="small"
              value={tab.commandInput}
              placeholder="Search this target — press ENTER"
              disabled={!canQuery}
              // Typing keeps the field in sync (and clears the active query when
              // emptied, via the parent's onSearchInputChange handler).
              onChange={onSearchInputChange}
              // ENTER drives the existing whole-target search; an empty submit
              // clears it back to the directory listing.
              onSearch={(value) => {
                if (canQuery) {
                  onSearchSubmit(value);
                }
              }}
            />
          </span>
          <span class="files-toolbar-actions">
            <Button variant="primary" label="CREATE NEW" disabled={!canQuery} onClick={() => onCreateStateChange({ ...emptyCreateState(), open: true })} />
          </span>
        </div>
        {/* Row 2: DELETE for the selected file — present only when one is selected. */}
        {selectedFilePath ? (
          <div class="files-toolbar-row files-toolbar-row-secondary">
            <span class="files-toolbar-actions">
              <Button
                variant="dangerGhost"
                label="DELETE"
                disabled={!canQuery}
                onClick={() => onRequestDelete(selectedFilePath)}
              />
            </span>
          </div>
        ) : null}
      </div>

      <CreateFilePanel
        basePath={basePath}
        state={createState}
        pending={createPending}
        onCancel={onCreateCancel}
        onChange={onCreateStateChange}
        onCreate={onCreateSubmit}
      />

      {tab.searchQuery ? (
        <SearchResults
          connected={connected}
          target={target}
          payload={searchPayload}
          query={tab.searchQuery}
          isLoading={searchLoading}
          queryError={searchError}
          onOpenFile={onOpenFile}
          onRetry={onSearchRetry}
        />
      ) : !connected ? (
        <FilesStateMessage kind="offline" title="GATEWAY OFFLINE" detail="Reconnect to browse file targets." />
      ) : !target ? (
        <FilesStateMessage kind="empty" title="NO TARGET SELECTED" detail="Choose a target to browse." />
      ) : !target.online ? (
        <FilesStateMessage kind="offline" title="TARGET OFFLINE" detail={`${target.label} is not accepting file requests.`} />
      ) : isLoading && !payload ? (
        <FilesStateMessage kind="loading" title="OPENING PATH" detail={tab.path} />
      ) : queryError ? (
        <FilesStateMessage
          kind="error"
          title="READ FAILED"
          detail={queryError}
          action={<Button variant="secondary" label="RETRY" onClick={onRefresh} />}
        />
      ) : !payload ? (
        <FilesStateMessage kind="empty" title="NO PATH LOADED" detail="Enter a path and open it." />
      ) : !payload.ok ? (
        <FilesStateMessage
          kind="error"
          title="READ FAILED"
          detail={payload.error}
          action={<Button variant="secondary" label="RETRY" onClick={onRefresh} />}
        />
      ) : isDirectoryPayload(payload) ? (
        <DirectoryBrowser
          directory={payload}
          onOpenDirectory={onNavigate}
          onOpenFile={onOpenFile}
          onOpenFileInNewTab={onOpenFileInNewTab}
          onOpenParent={() => onNavigate(pathParent(displayedPath))}
          onOpenCreate={() => onCreateStateChange({ ...emptyCreateState(), open: true })}
          onSelectionChange={setSelectedFilePath}
        />
      ) : isFilePayload(payload) ? (
        <FilesStateMessage
          kind="empty"
          title="FILE PATH"
          detail="Open this path in an editor tab."
          action={<Button variant="primary" label="OPEN FILE" onClick={() => onOpenFile(payload.path)} />}
        />
      ) : (
        <FilesStateMessage kind="empty" title="UNRECOGNIZED RESPONSE" detail="The target returned a payload this UI cannot render." />
      )}
    </section>
  );
}

function FileTabView({
  connected,
  target,
  tab,
  payload,
  isLoading,
  isFetching,
  queryError,
  draftState,
  savePending,
  deletePending,
  onDraftChange,
  onReset,
  onSave,
  onRefresh,
  onNavigate,
  onRequestDelete,
}: {
  connected: boolean;
  target: FilesTarget | null;
  tab: FilesFileTab;
  payload: FilesReadPayload | FilesErrorPayload | undefined;
  isLoading: boolean;
  isFetching: boolean;
  queryError: string;
  draftState: FileDraftState | null;
  savePending: boolean;
  deletePending: boolean;
  onDraftChange: (value: string) => void;
  onReset: () => void;
  onSave: () => void;
  onRefresh: () => void;
  onNavigate: (path: string) => void;
  onRequestDelete: () => void;
}) {
  const file = isFilePayload(payload) ? payload : null;
  const images = file ? imagePreviewsFromContent(file.content) : [];
  const editable = Boolean(file && fileTextEditable(file));
  const draft = draftState?.draft ?? "";
  const dirty = Boolean(draftState && draftState.draft !== draftState.baseline);
  const saveDisabled = !connected || !target?.online || !editable || !dirty || savePending;
  const statusTone: StatusTone = savePending ? "live" : dirty ? "warn" : target?.online ? "online" : "idle";
  const editorStatus = savePending
    ? "SAVING"
    : dirty
      ? "UNSAVED CHANGES"
      : target?.online
        ? "SAVED"
        : "READ ONLY";

  // Single path UI for the file view: the same Breadcrumbs trail as the browser,
  // ending on the file name (static). Ancestors + the back arrow navigate to the
  // owning folder, so no separate path string or SHOW FOLDER button is needed.
  const crumbs = buildPathCrumbs(tab.path).map((crumb, index, list) => ({
    label: crumb.label,
    onClick: index === list.length - 1 ? undefined : () => onNavigate(crumb.path),
  }));

  return (
    <section class="files-tab-panel" aria-label="File editor">
      <SectionHeader
        title={pathBasename(tab.path)}
        meta={[
          target ? describeTarget(target) : "",
          isFetching && payload ? "REFRESHING" : "",
        ].filter(Boolean).join(" | ")}
        divider
      />
      <div class="files-editor-toolbar">
        <Breadcrumbs
          items={crumbs}
          onBack={() => onNavigate(pathParent(tab.path))}
          size="medium"
          maxVisible={3}
        />
        <span class="files-toolbar-actions">
          <Button variant="dangerGhost" label={deletePending ? "DELETING" : "DELETE"} disabled={!target?.online || deletePending} onClick={onRequestDelete} />
        </span>
      </div>
      {!connected ? (
        <FilesStateMessage kind="offline" title="GATEWAY OFFLINE" detail="Reconnect to read this file." />
      ) : !target ? (
        <FilesStateMessage kind="empty" title="TARGET MISSING" detail="The file target no longer exists." />
      ) : !target.online ? (
        <FilesStateMessage kind="offline" title="TARGET OFFLINE" detail={`${target.label} is not accepting file requests.`} />
      ) : isLoading && !payload ? (
        <FilesStateMessage kind="loading" title="OPENING FILE" detail={tab.path} />
      ) : queryError ? (
        <FilesStateMessage
          kind="error"
          title="READ FAILED"
          detail={queryError}
          action={<Button variant="secondary" label="RETRY" onClick={onRefresh} />}
        />
      ) : !payload ? (
        <FilesStateMessage kind="empty" title="NO FILE LOADED" detail={tab.path} />
      ) : !payload.ok ? (
        <FilesStateMessage
          kind="error"
          title="READ FAILED"
          detail={payload.error}
          action={<Button variant="secondary" label="RETRY" onClick={onRefresh} />}
        />
      ) : !file ? (
        <FilesStateMessage kind="empty" title="NOT A FILE" detail="This tab path no longer resolves to editable file content." />
      ) : (
        <div class="files-file-view">
          <div class="files-file-meta">
            <Tag tone="idle" label="FILE" boxed />
            {formatFileStats(file) ? <small>{formatFileStats(file)}</small> : null}
          </div>
          {images.length > 0 ? (
            <div class="files-image-strip">
              {images.map((image, index) => (
                <img key={`${image.mimeType}:${index}`} src={image.src} alt={`${image.mimeType} preview`} />
              ))}
            </div>
          ) : editable ? (
            <div class="files-editor">
              <textarea
                class="files-editor-input"
                value={draft}
                rows={18}
                disabled={!target.online || savePending}
                spellcheck={false}
                onInput={(event) => onDraftChange(event.currentTarget.value)}
              />
              <div class="files-editor-footer">
                <span class="files-editor-status">
                  <StatusDot tone={statusTone} size={8} />
                  <span>{editorStatus}</span>
                  <small>{dirty ? "DRAFT MODIFIED" : `${draft.length.toLocaleString()} CHARS`}</small>
                </span>
                <span class="files-editor-actions">
                  <Button variant="secondary" label="RESET" disabled={!dirty || savePending} onClick={onReset} />
                  <Button variant="primary" label={savePending ? "SAVING" : "SAVE"} disabled={saveDisabled} onClick={onSave} />
                </span>
              </div>
              {savePending ? (
                <FilesInlineNotice kind="loading" title="SAVING CHANGES" detail={file.path} />
              ) : draftState?.feedback ? (
                <FilesInlineNotice kind={draftState.feedback.kind} title={draftState.feedback.title} detail={draftState.feedback.detail} />
              ) : null}
            </div>
          ) : (
            <pre class="files-code-block">{textFromContent(file.content)}</pre>
          )}
        </div>
      )}
    </section>
  );
}

export function FilesSurfaceSummary() {
  const { connected } = useGateway();
  const targetsQuery = useFilesTargets();
  const filesMutations = useFilesMutations();
  const targets = targetsQuery.targets;
  const [tabs, setTabs] = useState<FilesWorkspaceTab[]>([]);
  const [activeTabId, setActiveTabId] = useState("");
  const [drafts, setDrafts] = useState<Record<string, FileDraftState>>({});
  const [createState, setCreateState] = useState<CreateState>(emptyCreateState());
  const [deleteRequest, setDeleteRequest] = useState<DeleteRequest | null>(null);
  const [deleteFeedback, setDeleteFeedback] = useState<OperationFeedback | null>(null);
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(null);
  // Single reusable preview/peek tab (VS Code semantics): single-click opens here;
  // editing or the explicit "open in new tab" action promotes it to permanent.
  const [previewTabId, setPreviewTabId] = useState<string | null>(null);

  useEffect(() => {
    setTabs((currentTabs) => {
      if (targets.length === 0) {
        return currentTabs.length === 0 ? currentTabs : [];
      }
      const targetIds = new Set(targets.map((target) => target.id));
      const validTabs = currentTabs.filter((tab) => targetIds.has(tab.targetId));
      if (validTabs.length > 0) {
        return validTabs.length === currentTabs.length ? currentTabs : validTabs;
      }
      const initialTargetId = chooseInitialTarget(targets) ?? targets[0]?.id;
      return initialTargetId ? [createBrowserTab(initialTargetId, DEFAULT_PATH)] : [];
    });
  }, [targets]);

  useEffect(() => {
    if (tabs.length === 0) {
      if (activeTabId) {
        setActiveTabId("");
      }
      return;
    }
    if (!tabs.some((tab) => tab.id === activeTabId)) {
      setActiveTabId(tabs[0].id);
    }
  }, [activeTabId, tabs]);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null;
  const activeTarget = activeTab ? targetForTab(activeTab, targets) : null;
  const canQueryActiveTarget = connected && Boolean(activeTarget?.online && activeTab);
  const readQuery = useFilesPath({
    target: activeTab?.targetId ?? "",
    path: activeTab?.path ?? DEFAULT_PATH,
  }, canQueryActiveTarget);
  const readPayload = readQuery.data;
  const activeBrowserTab = activeTab?.kind === "browser" ? activeTab : null;
  const activeSearchPath = activeBrowserTab
    ? isFilePayload(readPayload) ? readPayload.directoryPath : activeBrowserTab.path
    : DEFAULT_PATH;
  const searchResult = useFilesSearch({
    target: activeBrowserTab?.targetId ?? "",
    path: activeSearchPath,
    query: activeBrowserTab?.searchQuery ?? "",
  }, canQueryActiveTarget && Boolean(activeBrowserTab?.searchQuery));

  useEffect(() => {
    if (!activeTab || activeTab.kind !== "file" || !isFilePayload(readPayload) || !fileTextEditable(readPayload)) {
      return;
    }
    const tabId = activeTab.id;
    const sourceText = textFromContent(readPayload.content);
    setDrafts((currentDrafts) => {
      const current = currentDrafts[tabId];
      if (!current) {
        return {
          ...currentDrafts,
          [tabId]: { sourceText, baseline: sourceText, draft: sourceText, feedback: null },
        };
      }
      if (current.sourceText === sourceText || current.draft !== current.baseline) {
        return currentDrafts;
      }
      return {
        ...currentDrafts,
        [tabId]: { sourceText, baseline: sourceText, draft: sourceText, feedback: null },
      };
    });
  }, [activeTab, readPayload]);

  const draftDirty = (tab: FilesWorkspaceTab): boolean => {
    if (tab.kind !== "file") {
      return false;
    }
    const draft = drafts[tab.id];
    return Boolean(draft && draft.draft !== draft.baseline);
  };

  const tabLabels = tabs.map((tab) => tabLabel(tab, targetForTab(tab, targets), draftDirty(tab)));
  const activeIndex = Math.max(0, tabs.findIndex((tab) => tab.id === activeTabId));
  const activeTargetId = activeTab?.targetId ?? null;
  const previewIndex = tabs.findIndex((tab) => tab.id === previewTabId);

  const focusOrOpenBrowserTab = (targetId: string) => {
    const id = createBrowserTab(targetId).id;
    const existing = tabs.find((tab) => tab.id === id);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const nextTab = createBrowserTab(targetId, DEFAULT_PATH);
    setTabs((currentTabs) => [...currentTabs, nextTab]);
    setActiveTabId(nextTab.id);
  };

  // Promote the active preview tab to a permanent tab (first edit, or explicit action).
  const promotePreviewTab = (tabId: string) => {
    setPreviewTabId((current) => (current === tabId ? null : current));
  };

  // preview=true reuses a single peek tab (replacing any prior preview); preview=false
  // opens/focuses a permanent tab and never disturbs the existing preview slot.
  const openFileTab = (targetId: string, path: string, preview = false) => {
    const nextTab = createFileTab(targetId, path);
    const alreadyPermanent = tabs.some((tab) => tab.id === nextTab.id && tab.id !== previewTabId);

    if (preview && !alreadyPermanent) {
      // Swap the file into the single preview slot, dropping the prior preview.
      setTabs((currentTabs) => {
        const withoutPreview = previewTabId
          ? currentTabs.filter((tab) => tab.id !== previewTabId)
          : currentTabs;
        return withoutPreview.some((tab) => tab.id === nextTab.id)
          ? withoutPreview
          : [...withoutPreview, nextTab];
      });
      setPreviewTabId(nextTab.id);
      setActiveTabId(nextTab.id);
      return;
    }

    // Permanent open (explicit action) or focusing a tab that already exists.
    const existing = tabs.find((tab) => tab.id === nextTab.id);
    if (existing) {
      promotePreviewTab(existing.id);
      setActiveTabId(existing.id);
      return;
    }
    setTabs((currentTabs) => [...currentTabs, nextTab]);
    setActiveTabId(nextTab.id);
  };

  const updateBrowserTab = (tabId: string, updater: (tab: FilesBrowserTab) => FilesBrowserTab) => {
    setTabs((currentTabs) => currentTabs.map((tab) => tab.id === tabId && tab.kind === "browser" ? updater(tab) : tab));
  };

  const navigateBrowserTab = (tab: FilesBrowserTab, path: string) => {
    const nextPath = path.trim() || pathRoot(tab.path);
    updateBrowserTab(tab.id, (currentTab) => ({
      ...currentTab,
      path: nextPath,
      commandInput: "",
      commandInputKey: currentTab.commandInputKey + 1,
      searchQuery: "",
    }));
    setCreateState(emptyCreateState());
    setDeleteFeedback(null);
  };

  const closeTabNow = (tabId: string) => {
    const index = tabs.findIndex((tab) => tab.id === tabId);
    const nextTabs = tabs.filter((tab) => tab.id !== tabId);
    if (nextTabs.length === 0) {
      return;
    }
    setTabs(nextTabs);
    setPreviewTabId((current) => (current === tabId ? null : current));
    setDrafts((currentDrafts) => {
      const nextDrafts = { ...currentDrafts };
      delete nextDrafts[tabId];
      return nextDrafts;
    });
    if (activeTabId === tabId) {
      const nextActiveTab = nextTabs[Math.min(index, nextTabs.length - 1)] ?? nextTabs[0];
      setActiveTabId(nextActiveTab.id);
    }
  };

  const saveActiveFile = async () => {
    if (!activeTab || activeTab.kind !== "file" || !activeTarget || filesMutations.save.isPending) {
      return;
    }
    const draft = drafts[activeTab.id];
    if (!draft || draft.draft === draft.baseline) {
      return;
    }
    try {
      const savedDraft = draft.draft;
      const result = await filesMutations.save.mutateAsync({
        target: activeTarget.id,
        path: activeTab.path,
        content: savedDraft,
      });
      if (!result.ok) {
        setDrafts((currentDrafts) => ({
          ...currentDrafts,
          [activeTab.id]: { ...draft, feedback: { kind: "error", title: "SAVE FAILED", detail: result.error } },
        }));
        return;
      }
      setDrafts((currentDrafts) => ({
        ...currentDrafts,
        [activeTab.id]: {
          sourceText: savedDraft,
          baseline: savedDraft,
          draft: savedDraft,
          feedback: {
            kind: "success",
            title: "SAVED",
            detail: [result.path, formatBytes(result.size)].filter(Boolean).join(" | "),
          },
        },
      }));
    } catch (error) {
      setDrafts((currentDrafts) => ({
        ...currentDrafts,
        [activeTab.id]: {
          ...draft,
          feedback: { kind: "error", title: "SAVE FAILED", detail: mutationErrorText(error, `Failed to write ${activeTab.path}`) },
        },
      }));
    }
  };

  const createFile = async () => {
    if (!activeBrowserTab || !activeTarget || filesMutations.create.isPending) {
      return;
    }
    const basePath = isDirectoryPayload(readPayload) ? readPayload.path : activeBrowserTab.path;
    const resolvedPath = createState.pathInput.trim().length > 0 ? resolveEnteredPath(createState.pathInput, basePath) : "";
    if (!resolvedPath) {
      return;
    }
    try {
      const result = await filesMutations.create.mutateAsync({
        target: activeTarget.id,
        path: resolvedPath,
        content: createState.content,
      });
      if (!result.ok) {
        setCreateState({ ...createState, feedback: { kind: "error", title: "CREATE FAILED", detail: result.error } });
        return;
      }
      setCreateState(emptyCreateState({ kind: "success", title: "CREATED", detail: result.path }));
      openFileTab(activeTarget.id, result.path);
    } catch (error) {
      setCreateState({
        ...createState,
        feedback: { kind: "error", title: "CREATE FAILED", detail: mutationErrorText(error, `Failed to create ${resolvedPath}`) },
      });
    }
  };

  // The ConfirmModal's confirmPhrase guard keeps its button disabled until the
  // typed path matches, so onConfirm only fires once the path is confirmed.
  const confirmDelete = async () => {
    if (!deleteRequest || filesMutations.remove.isPending) {
      return;
    }
    try {
      const result = await filesMutations.remove.mutateAsync({
        target: deleteRequest.targetId,
        path: deleteRequest.path,
      });
      if (!result.ok) {
        setDeleteRequest(null);
        setDeleteFeedback({ kind: "error", title: "DELETE FAILED", detail: result.error });
        return;
      }
      const sourceTab = tabs.find((tab) => tab.id === deleteRequest.sourceTabId);
      const nextParent = pathParent(result.path);
      setDeleteRequest(null);
      setDeleteFeedback({ kind: "success", title: "DELETED", detail: result.path });
      if (sourceTab?.kind === "browser") {
        navigateBrowserTab(sourceTab, nextParent);
      } else if (sourceTab?.kind === "file") {
        const browserTab = createBrowserTab(sourceTab.targetId, nextParent);
        setPreviewTabId((current) => (current === sourceTab.id ? null : current));
        setTabs((currentTabs) => {
          const withoutFile = currentTabs.filter((tab) => tab.id !== sourceTab.id);
          const existingBrowser = withoutFile.some((tab) => tab.id === browserTab.id);
          if (!existingBrowser) {
            return [...withoutFile, browserTab];
          }
          return withoutFile.map((tab) => (
            tab.id === browserTab.id && tab.kind === "browser"
              ? {
                ...tab,
                path: browserTab.path,
                commandInput: "",
                commandInputKey: tab.commandInputKey + 1,
                searchQuery: "",
              }
              : tab
          ));
        });
        setActiveTabId(browserTab.id);
        setDrafts((currentDrafts) => {
          const nextDrafts = { ...currentDrafts };
          delete nextDrafts[sourceTab.id];
          return nextDrafts;
        });
      }
    } catch (error) {
      setDeleteRequest(null);
      setDeleteFeedback({
        kind: "error",
        title: "DELETE FAILED",
        detail: mutationErrorText(error, `Failed to delete ${deleteRequest.path}`),
      });
    }
  };

  return (
    <ConsolePage flush>
      <ConsoleResourceBoundary
        resource={targetsQuery.resource}
        emptyLabel="NO FILE TARGETS"
        errorLabel="FILES"
        loadingLabel="LOADING FILE TARGETS"
        render={(data) => (
          <div class="files-surface">
            <div class="files-header-bar">
              <Select
                label="MACHINE"
                width={280}
                options={[...data.map((target) => formatTargetOption(target)), ADD_MACHINE_OPTION]}
                value={Math.max(0, data.findIndex((target) => target.id === activeTargetId))}
                onChange={(index) => {
                  if (index === data.length) {
                    openAddMachineRoute();
                    return;
                  }
                  const target = data[index];
                  if (target) {
                    focusOrOpenBrowserTab(target.id);
                  }
                }}
                size="medium"
              />
            </div>
            <section class="files-workspace" aria-label="Files workspace">
              <div class="files-tabbar">
                <Tabs
                  tabs={tabLabels.length > 0 ? tabLabels : ["FILES"]}
                  value={activeIndex}
                  previewIndex={previewIndex >= 0 ? previewIndex : undefined}
                  onChange={(index) => {
                    const tab = tabs[index];
                    if (tab) {
                      setActiveTabId(tab.id);
                      setCreateState(emptyCreateState());
                      setDeleteFeedback(null);
                    }
                  }}
                  onClose={tabs.length > 1 ? (index) => {
                    const tab = tabs[index];
                    if (!tab) {
                      return;
                    }
                    if (draftDirty(tab)) {
                      setPendingCloseTabId(tab.id);
                      return;
                    }
                    closeTabNow(tab.id);
                  } : undefined}
                />
              </div>
              {deleteFeedback ? (
                <FilesInlineNotice kind={deleteFeedback.kind} title={deleteFeedback.title} detail={deleteFeedback.detail} />
              ) : null}
              {!activeTab ? (
                <Surface class="files-tab-panel" flush>
                  <FilesStateMessage kind="empty" title="NO FILE TAB" detail="Select a target to open a browser tab." />
                </Surface>
              ) : activeTab.kind === "browser" ? (
                <BrowserTabView
                  connected={connected}
                  target={activeTarget}
                  tab={activeTab}
                  payload={readPayload}
                  isLoading={readQuery.isLoading}
                  isFetching={readQuery.isFetching}
                  queryError={queryErrorText(readQuery.error)}
                  searchPayload={searchResult.data}
                  searchLoading={searchResult.isLoading}
                  searchError={queryErrorText(searchResult.error)}
                  createState={createState}
                  createPending={filesMutations.create.isPending}
                  onCreateStateChange={setCreateState}
                  onCreateCancel={() => setCreateState(emptyCreateState())}
                  onCreateSubmit={createFile}
                  onNavigate={(path) => navigateBrowserTab(activeTab, path)}
                  onSearchInputChange={(commandInput) => updateBrowserTab(activeTab.id, (tab) => ({
                    ...tab,
                    commandInput,
                    // Emptying the field (e.g. the clear button) drops back to the listing.
                    searchQuery: commandInput.trim() ? tab.searchQuery : "",
                  }))}
                  onSearchSubmit={(value) => {
                    const query = value.trim();
                    // Submitting a query drives the existing whole-target search; an
                    // empty submit clears it, returning to the directory listing.
                    updateBrowserTab(activeTab.id, (tab) => ({ ...tab, searchQuery: query }));
                  }}
                  onOpenFile={(path) => openFileTab(activeTab.targetId, path, true)}
                  onOpenFileInNewTab={(path) => openFileTab(activeTab.targetId, path, false)}
                  onRefresh={() => {
                    void readQuery.refetch();
                  }}
                  onSearchRetry={() => {
                    void searchResult.refetch();
                  }}
                  onRequestDelete={(path) => {
                    if (activeTarget) {
                      setDeleteRequest({ targetId: activeTarget.id, sourceTabId: activeTab.id, path });
                      setDeleteFeedback(null);
                    }
                  }}
                />
              ) : (
                <FileTabView
                  connected={connected}
                  target={activeTarget}
                  tab={activeTab}
                  payload={readPayload}
                  isLoading={readQuery.isLoading}
                  isFetching={readQuery.isFetching}
                  queryError={queryErrorText(readQuery.error)}
                  draftState={drafts[activeTab.id] ?? null}
                  savePending={filesMutations.save.isPending}
                  deletePending={filesMutations.remove.isPending}
                  onDraftChange={(draft) => {
                    // First edit promotes a preview tab to permanent.
                    promotePreviewTab(activeTab.id);
                    setDrafts((currentDrafts) => {
                      const current = currentDrafts[activeTab.id];
                      if (!current) {
                        return currentDrafts;
                      }
                      return {
                        ...currentDrafts,
                        [activeTab.id]: { ...current, draft, feedback: null },
                      };
                    });
                  }}
                  onReset={() => setDrafts((currentDrafts) => {
                    const current = currentDrafts[activeTab.id];
                    if (!current) {
                      return currentDrafts;
                    }
                    return {
                      ...currentDrafts,
                      [activeTab.id]: {
                        ...current,
                        draft: current.baseline,
                        feedback: { kind: "info", title: "RESET", detail: activeTab.path },
                      },
                    };
                  })}
                  onSave={saveActiveFile}
                  onRefresh={() => {
                    void readQuery.refetch();
                  }}
                  onNavigate={(path) => {
                    const browserTab = createBrowserTab(activeTab.targetId, path);
                    setTabs((currentTabs) => currentTabs.some((tab) => tab.id === browserTab.id) ? currentTabs.map((tab) => (
                      tab.id === browserTab.id && tab.kind === "browser"
                        ? { ...tab, path: browserTab.path, commandInput: "", commandInputKey: tab.commandInputKey + 1, searchQuery: "" }
                        : tab
                    )) : [...currentTabs, browserTab]);
                    setActiveTabId(browserTab.id);
                  }}
                  onRequestDelete={() => {
                    if (activeTarget) {
                      setDeleteRequest({ targetId: activeTarget.id, sourceTabId: activeTab.id, path: activeTab.path });
                      setDeleteFeedback(null);
                    }
                  }}
                />
              )}
            </section>
            {deleteRequest ? (
              <div class="files-modal-layer">
                <ConfirmModal
                  title="DELETE"
                  message={`Delete ${deleteRequest.path}?`}
                  note="This file is permanently removed from the target — it cannot be recovered."
                  confirmLabel="DELETE"
                  onCancel={() => setDeleteRequest(null)}
                  onConfirm={confirmDelete}
                />
              </div>
            ) : null}
            {pendingCloseTabId ? (
              <div class="files-modal-layer">
                <ConfirmModal
                  title="CLOSE TAB"
                  message="This file tab has unsaved changes."
                  note="Closing it will discard the current draft."
                  confirmLabel="CLOSE"
                  onCancel={() => setPendingCloseTabId(null)}
                  onConfirm={() => {
                    closeTabNow(pendingCloseTabId);
                    setPendingCloseTabId(null);
                  }}
                />
              </div>
            ) : null}
          </div>
        )}
      />
    </ConsolePage>
  );
}
