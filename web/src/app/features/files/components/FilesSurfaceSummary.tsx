import type { JSX } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { Button } from "../../../components/ui/Button";
import { Icon } from "../../../components/ui/Icon";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { Select } from "../../../components/ui/Select";
import { Spinner } from "../../../components/ui/Spinner";
import { StatusDot, type StatusTone } from "../../../components/ui/StatusDot";
import { Tag } from "../../../components/ui/Tag";
import { TextInput, type TextInputStatus } from "../../../components/ui/TextInput";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import {
  ConsolePage,
  ConsoleResourceBoundary,
} from "../../gsv-console/components/ConsolePageTemplate";
import type {
  FilesDirectoryPayload,
  FilesErrorPayload,
  FilesFilePayload,
  FilesReadPayload,
  FilesSearchPayload,
  FilesTarget,
} from "../domain/models";
import { detectPathStyle, parentPath } from "../domain/paths";
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
import { useFilesMutations, useFilesPath, useFilesSearch, useFilesTargets } from "../hooks/useFilesQueries";
import "./FilesSurfaceSummary.css";

const DEFAULT_PATH = ".";

type ReadPanelProps = {
  connected: boolean;
  target: FilesTarget | null;
  path: string;
  payload: FilesReadPayload | FilesErrorPayload | undefined;
  isLoading: boolean;
  queryError: string;
  fileDraft: string;
  fileDirty: boolean;
  savePending: boolean;
  saveFeedback: OperationFeedback | null;
  onOpenPath: (path: string) => void;
  onRetry: () => void;
  onFileDraftChange: (value: string) => void;
  onSaveFile: () => void;
  onResetFileDraft: () => void;
};

type SearchPanelProps = {
  connected: boolean;
  target: FilesTarget | null;
  query: string;
  payload: FilesSearchPayload | FilesErrorPayload | undefined;
  isLoading: boolean;
  queryError: string;
  onOpenPath: (path: string) => void;
  onRetry: () => void;
};

type StateKind = "loading" | "error" | "empty" | "offline";
type InlineStateKind = "loading" | "error" | "success" | "info" | "warn";

type OperationFeedback = {
  kind: Exclude<InlineStateKind, "loading">;
  title: string;
  detail: string;
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

function isDirectoryPayload(payload: FilesReadPayload | FilesErrorPayload | undefined): payload is FilesDirectoryPayload {
  return Boolean(payload?.ok && "entries" in payload);
}

function isFilePayload(payload: FilesReadPayload | FilesErrorPayload | undefined): payload is FilesFilePayload {
  return Boolean(payload?.ok && "content" in payload);
}

function mutationErrorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : error ? String(error) : fallback;
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

function TargetRow({
  target,
  active,
  onSelect,
}: {
  target: FilesTarget;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      class={`files-target-row${active ? " is-active" : ""}`}
      aria-pressed={active}
      onClick={onSelect}
    >
      <span class="files-target-icon">
        <Icon name="computer" size={18} />
      </span>
      <span class="files-target-main">
        <strong>{target.label || target.id}</strong>
        <span>{describeTarget(target) || target.id}</span>
      </span>
      <Tag tone={target.online ? "online" : "idle"} label={target.online ? "ONLINE" : "OFFLINE"} boxed dot />
    </button>
  );
}

function DirectoryView({
  directory,
  onOpenPath,
}: {
  directory: FilesDirectoryPayload;
  onOpenPath: (path: string) => void;
}) {
  const entries = sortDirectoryEntries(directory.entries);
  const directoryCount = entries.filter((entry) => entry.kind === "directory").length;
  const fileCount = entries.length - directoryCount;

  if (entries.length === 0) {
    return (
      <FilesStateMessage
        kind="empty"
        title="EMPTY DIRECTORY"
        detail={`${directory.path} has no entries returned by the target.`}
      />
    );
  }

  return (
    <div class="files-entry-list">
      <div class="files-list-summary">
        <Tag tone="accent" label={`${directoryCount} DIR`} boxed />
        <Tag tone="idle" label={`${fileCount} FILE`} boxed />
        <span>{directory.path}</span>
      </div>
      {entries.map((entry) => (
        <button
          type="button"
          class="files-entry-row"
          key={`${entry.kind}:${entry.path}`}
          onClick={() => onOpenPath(entry.path)}
        >
          <span class="files-entry-icon">
            <Icon name={entry.kind === "directory" ? "folder" : "pencil"} size={18} />
          </span>
          <span class="files-entry-main">
            <strong>{entry.name}</strong>
            <span>{entry.path}</span>
          </span>
          <Tag
            tone={entry.kind === "directory" ? "accent" : "idle"}
            label={entry.kind === "directory" ? "DIR" : "FILE"}
            boxed
          />
        </button>
      ))}
    </div>
  );
}

function FileView({
  file,
  connected,
  targetOnline,
  draft,
  dirty,
  savePending,
  feedback,
  onDraftChange,
  onSave,
  onResetDraft,
}: {
  file: FilesFilePayload;
  connected: boolean;
  targetOnline: boolean;
  draft: string;
  dirty: boolean;
  savePending: boolean;
  feedback: OperationFeedback | null;
  onDraftChange: (value: string) => void;
  onSave: () => void;
  onResetDraft: () => void;
}) {
  const text = textFromContent(file.content);
  const images = imagePreviewsFromContent(file.content);
  const stats = formatFileStats(file);
  const canEditText = images.length === 0;
  const saveDisabled = !connected || !targetOnline || !dirty || savePending;
  const editorMetric = dirty ? "DRAFT MODIFIED" : `${draft.length.toLocaleString()} CHARS`;
  const editorState = !connected
    ? "GATEWAY OFFLINE"
    : !targetOnline
      ? "TARGET OFFLINE"
      : savePending
        ? "SAVING"
        : dirty
          ? "UNSAVED CHANGES"
          : "SAVED";
  const editorTone: StatusTone = savePending
    ? "live"
    : !connected || !targetOnline
      ? "idle"
      : dirty
        ? "warn"
        : "online";

  return (
    <div class="files-file-view">
      <div class="files-file-meta">
        <Tag tone="info" label="FILE" boxed />
        <span>{file.path}</span>
        {stats ? <small>{stats}</small> : null}
      </div>
      {images.length > 0 ? (
        <div class="files-image-strip">
          {images.map((image, index) => (
            <img key={`${image.mimeType}:${index}`} src={image.src} alt={`${image.mimeType} preview`} />
          ))}
        </div>
      ) : null}
      {canEditText ? (
        <div class="files-editor">
          <label class="files-editor-field">
            <span>TEXT CONTENT</span>
            <textarea
              class="files-editor-input"
              value={draft}
              rows={18}
              disabled={!connected || !targetOnline || savePending}
              spellcheck={false}
              onInput={(event) => onDraftChange(event.currentTarget.value)}
            />
          </label>
          <div class="files-editor-footer">
            <span class="files-editor-status">
              <StatusDot tone={editorTone} size={8} />
              <span>{editorState}</span>
              <small>{editorMetric}</small>
            </span>
            <span class="files-editor-actions">
              <Button variant="secondary" label="REVERT" disabled={!dirty || savePending} onClick={onResetDraft} />
              <Button
                variant="primary"
                label={savePending ? "SAVING" : "SAVE"}
                disabled={saveDisabled}
                onClick={onSave}
              />
            </span>
          </div>
          {savePending ? (
            <FilesInlineNotice kind="loading" title="SAVING CHANGES" detail={file.path} />
          ) : feedback ? (
            <FilesInlineNotice kind={feedback.kind} title={feedback.title} detail={feedback.detail} />
          ) : null}
        </div>
      ) : text.length > 0 ? (
        <pre class="files-code-block">{text}</pre>
      ) : images.length === 0 ? (
        <FilesStateMessage
          kind="empty"
          title="NO READABLE CONTENT"
          detail="The target returned no text or image content for this file."
        />
      ) : null}
    </div>
  );
}

function ReadPanel({
  connected,
  target,
  path,
  payload,
  isLoading,
  queryError,
  fileDraft,
  fileDirty,
  savePending,
  saveFeedback,
  onOpenPath,
  onRetry,
  onFileDraftChange,
  onSaveFile,
  onResetFileDraft,
}: ReadPanelProps) {
  if (!connected) {
    return <FilesStateMessage kind="offline" title="GATEWAY OFFLINE" detail="Reconnect to browse file targets." />;
  }
  if (!target) {
    return <FilesStateMessage kind="empty" title="NO TARGET SELECTED" detail="Choose a file target to browse." />;
  }
  if (!target.online) {
    return <FilesStateMessage kind="offline" title="TARGET OFFLINE" detail={`${target.label} is not accepting file requests.`} />;
  }
  if (isLoading && !payload) {
    return <FilesStateMessage kind="loading" title="OPENING PATH" detail={path} />;
  }
  if (queryError) {
    return (
      <FilesStateMessage
        kind="error"
        title="READ FAILED"
        detail={queryError}
        action={<Button variant="secondary" label="RETRY" onClick={onRetry} />}
      />
    );
  }
  if (!payload) {
    return (
      <FilesStateMessage
        kind="empty"
        title="NO PATH LOADED"
        detail="Enter a path and open it."
        action={<Button variant="secondary" label="OPEN ROOT" onClick={() => onOpenPath(DEFAULT_PATH)} />}
      />
    );
  }
  if (!payload.ok) {
    return (
      <FilesStateMessage
        kind="error"
        title="READ FAILED"
        detail={payload.error}
        action={<Button variant="secondary" label="RETRY" onClick={onRetry} />}
      />
    );
  }
  if (isDirectoryPayload(payload)) {
    return <DirectoryView directory={payload} onOpenPath={onOpenPath} />;
  }
  if (isFilePayload(payload)) {
    return (
      <FileView
        file={payload}
        connected={connected}
        targetOnline={Boolean(target?.online)}
        draft={fileDraft}
        dirty={fileDirty}
        savePending={savePending}
        feedback={saveFeedback}
        onDraftChange={onFileDraftChange}
        onSave={onSaveFile}
        onResetDraft={onResetFileDraft}
      />
    );
  }
  return <FilesStateMessage kind="empty" title="UNRECOGNIZED RESPONSE" detail="The target returned a payload this UI cannot render." />;
}

function SearchPanel({
  connected,
  target,
  query,
  payload,
  isLoading,
  queryError,
  onOpenPath,
  onRetry,
}: SearchPanelProps) {
  if (!connected) {
    return <FilesStateMessage kind="offline" title="GATEWAY OFFLINE" detail="Reconnect to search file targets." />;
  }
  if (!target) {
    return <FilesStateMessage kind="empty" title="NO TARGET SELECTED" detail="Choose a file target to search." />;
  }
  if (!target.online) {
    return <FilesStateMessage kind="offline" title="TARGET OFFLINE" detail={`${target.label} is not accepting search requests.`} />;
  }
  if (!query) {
    return <FilesStateMessage kind="empty" title="SEARCH READY" detail="Enter a query to search the current path." />;
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
          onClick={() => onOpenPath(match.path)}
        >
          <span class="files-search-path">{match.path}</span>
          <span class="files-search-line">{formatSearchMatchLine(match)}</span>
          <span class="files-search-preview">{match.content}</span>
        </button>
      ))}
      {payload.truncated ? (
        <div class="files-search-truncated">RESULTS TRUNCATED BY TARGET</div>
      ) : null}
    </div>
  );
}

function DeleteConfirmation({
  path,
  pending,
  value,
  onValueChange,
  onCancel,
  onConfirm,
}: {
  path: string;
  pending: boolean;
  value: string;
  onValueChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const normalizedValue = value.trim();
  const confirmed = normalizedValue === path;
  const status: TextInputStatus = pending ? "info" : value.length === 0 ? "warning" : confirmed ? "success" : "error";
  const message = pending
    ? "Deleting path"
    : confirmed
      ? "Path confirmed"
      : "Exact path required";

  return (
    <div class="files-delete-confirm" role="alert">
      <span class="files-inline-mark">
        {pending ? <Spinner size={16} /> : <StatusDot tone="warn" size={8} />}
      </span>
      <span class="files-delete-copy">
        <strong>{pending ? "DELETING" : "CONFIRM DELETE"}</strong>
        <span>{path}</span>
      </span>
      <div class="files-delete-controls">
        <TextInput
          key={`delete-${path}`}
          label="TYPE PATH TO CONFIRM"
          value={value}
          placeholder={path}
          status={status}
          message={message}
          clearable
          disabled={pending}
          onChange={onValueChange}
        />
        <span class="files-delete-actions">
          <Button variant="secondary" label="CANCEL" disabled={pending} onClick={onCancel} />
          <Button
            variant="danger"
            label={pending ? "DELETING" : "DELETE"}
            disabled={pending || !confirmed}
            onClick={onConfirm}
          />
        </span>
      </div>
    </div>
  );
}

export function FilesSurfaceSummary() {
  const { connected } = useGateway();
  const targetsQuery = useFilesTargets();
  const filesMutations = useFilesMutations();
  const targets = targetsQuery.targets;
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState(DEFAULT_PATH);
  const [pathInput, setPathInput] = useState(DEFAULT_PATH);
  const [pathInputKey, setPathInputKey] = useState(0);
  const [searchInput, setSearchInput] = useState("");
  const [searchInputKey, setSearchInputKey] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [editorFileKey, setEditorFileKey] = useState<string | null>(null);
  const [editorSourceText, setEditorSourceText] = useState("");
  const [editorDraft, setEditorDraft] = useState("");
  const [editorBaseline, setEditorBaseline] = useState("");
  const [saveFeedback, setSaveFeedback] = useState<OperationFeedback | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createPathInput, setCreatePathInput] = useState("");
  const [createContent, setCreateContent] = useState("");
  const [createFeedback, setCreateFeedback] = useState<OperationFeedback | null>(null);
  const [deleteConfirmPath, setDeleteConfirmPath] = useState<string | null>(null);
  const [deleteConfirmInput, setDeleteConfirmInput] = useState("");
  const [deleteFeedback, setDeleteFeedback] = useState<OperationFeedback | null>(null);

  const selectedTarget = targets.find((target) => target.id === selectedTargetId) ?? null;
  const selectedTargetIndex = Math.max(0, targets.findIndex((target) => target.id === selectedTargetId));
  const canQueryTarget = connected && Boolean(selectedTarget?.online);

  const readQuery = useFilesPath({
    target: selectedTarget?.id ?? "",
    path: currentPath,
  }, canQueryTarget);
  const readPayload = readQuery.data;
  const displayedPath = readPayload?.path ?? currentPath;
  const inputBasePath = isFilePayload(readPayload) ? readPayload.directoryPath : displayedPath;
  const searchBasePath = isFilePayload(readPayload) ? readPayload.directoryPath : displayedPath;
  const searchResult = useFilesSearch({
    target: selectedTarget?.id ?? "",
    path: searchBasePath,
    query: searchQuery,
  }, canQueryTarget && searchQuery.length > 0);
  const activeFile = isFilePayload(readPayload) ? readPayload : null;
  const activeFileText = activeFile ? textFromContent(activeFile.content) : "";
  const activeFileEditable = Boolean(activeFile && imagePreviewsFromContent(activeFile.content).length === 0);
  const activeFileKey = activeFile && activeFileEditable ? `${activeFile.target}:${activeFile.path}` : null;
  const editorDirty = Boolean(activeFileKey && editorDraft !== editorBaseline);
  const createBasePath = isFilePayload(readPayload) ? readPayload.directoryPath : displayedPath;
  const createResolvedPath = createPathInput.trim().length > 0
    ? resolveEnteredPath(createPathInput, createBasePath)
    : "";
  const canCreateFile = canQueryTarget && createPathInput.trim().length > 0 && !filesMutations.create.isPending;
  const canDeletePath = canQueryTarget
    && Boolean(readPayload?.ok)
    && displayedPath !== pathRoot(displayedPath)
    && !filesMutations.remove.isPending;

  const targetOptions = useMemo(() => targets.map(formatTargetOption), [targets]);
  const onlineCount = targets.filter((target) => target.online).length;
  const crumbs = useMemo(() => buildPathCrumbs(displayedPath), [displayedPath]);
  const atRoot = displayedPath === pathRoot(displayedPath);
  const readTitle = isDirectoryPayload(readPayload) ? "DIRECTORY" : isFilePayload(readPayload) ? "FILE" : "PATH";
  const readMeta = [
    readPayload?.ok ? readPayload.path : displayedPath,
    readQuery.isFetching && readPayload ? "REFRESHING" : "",
  ].filter(Boolean).join(" · ");
  const searchMeta = [
    searchQuery ? `${searchResult.data?.ok ? searchResult.data.count : 0} MATCHES` : "CURRENT PATH",
    searchBasePath,
    searchResult.isFetching && searchResult.data ? "REFRESHING" : "",
  ].filter(Boolean).join(" · ");

  useEffect(() => {
    if (targets.length === 0) {
      if (selectedTargetId !== null) {
        setSelectedTargetId(null);
      }
      return;
    }
    if (selectedTargetId && targets.some((target) => target.id === selectedTargetId)) {
      return;
    }

    setSelectedTargetId(chooseInitialTarget(targets));
    setCurrentPath(DEFAULT_PATH);
    setPathInput(DEFAULT_PATH);
    setPathInputKey((key) => key + 1);
    setSearchInput("");
    setSearchInputKey((key) => key + 1);
    setSearchQuery("");
  }, [selectedTargetId, targets]);

  useEffect(() => {
    if (!activeFileKey) {
      if (editorFileKey !== null) {
        setEditorFileKey(null);
        setEditorSourceText("");
        setEditorDraft("");
        setEditorBaseline("");
        setSaveFeedback(null);
      }
      return;
    }

    if (editorFileKey !== activeFileKey) {
      setEditorFileKey(activeFileKey);
      setEditorSourceText(activeFileText);
      setEditorDraft(activeFileText);
      setEditorBaseline(activeFileText);
      setSaveFeedback(null);
      return;
    }

    if (activeFileText !== editorSourceText && editorDraft === editorBaseline) {
      setEditorSourceText(activeFileText);
      setEditorDraft(activeFileText);
      setEditorBaseline(activeFileText);
      setSaveFeedback(null);
    }
  }, [activeFileKey, activeFileText, editorBaseline, editorDraft, editorFileKey, editorSourceText]);

  const resetSearch = () => {
    setSearchInput("");
    setSearchInputKey((key) => key + 1);
    setSearchQuery("");
  };

  const clearTransientState = () => {
    setCreateOpen(false);
    setCreatePathInput("");
    setCreateContent("");
    setCreateFeedback(null);
    setDeleteConfirmPath(null);
    setDeleteConfirmInput("");
    setDeleteFeedback(null);
    setSaveFeedback(null);
  };

  const setExternalPath = (nextPath: string, preserveFeedback = false) => {
    if (!preserveFeedback) {
      clearTransientState();
    }
    setCurrentPath(nextPath);
    setPathInput(nextPath);
    setPathInputKey((key) => key + 1);
  };

  const openPath = (nextPath: string, preserveFeedback = false) => {
    setExternalPath(nextPath.trim() || pathRoot(displayedPath), preserveFeedback);
    resetSearch();
  };

  const openPathInput = () => {
    openPath(resolveEnteredPath(pathInput, inputBasePath));
  };

  const handlePathSubmit = (event: Event) => {
    event.preventDefault();
    if (canQueryTarget) {
      openPathInput();
    }
  };

  const handleSearchSubmit = (event: Event) => {
    event.preventDefault();
    setSearchQuery(searchInput.trim());
  };

  const selectTargetByIndex = (index: number) => {
    const nextTarget = targets[index];
    if (!nextTarget) {
      return;
    }
    setSelectedTargetId(nextTarget.id);
    setExternalPath(DEFAULT_PATH);
    resetSearch();
  };

  const updateFileDraft = (value: string) => {
    setEditorDraft(value);
    setSaveFeedback(null);
  };

  const resetFileDraft = () => {
    if (!activeFileKey) {
      return;
    }
    setEditorDraft(editorBaseline);
    setSaveFeedback({
      kind: "info",
      title: "REVERTED",
      detail: activeFile?.path ?? displayedPath,
    });
  };

  const saveFile = async () => {
    if (!activeFile || !selectedTarget || !activeFileEditable || !editorDirty || filesMutations.save.isPending) {
      return;
    }

    setSaveFeedback(null);
    const savedDraft = editorDraft;
    try {
      const result = await filesMutations.save.mutateAsync({
        target: selectedTarget.id,
        path: activeFile.path,
        content: savedDraft,
      });
      if (!result.ok) {
        setSaveFeedback({ kind: "error", title: "SAVE FAILED", detail: result.error });
        return;
      }
      setEditorSourceText(savedDraft);
      setEditorBaseline(savedDraft);
      setSaveFeedback({
        kind: "success",
        title: "SAVED",
        detail: [result.path, formatBytes(result.size)].filter(Boolean).join(" · "),
      });
    } catch (error) {
      setSaveFeedback({
        kind: "error",
        title: "SAVE FAILED",
        detail: mutationErrorText(error, `Failed to write ${activeFile.path}`),
      });
    }
  };

  const toggleCreate = () => {
    if (filesMutations.create.isPending) {
      return;
    }
    setCreateOpen((open) => !open);
    setCreateFeedback(null);
  };

  const cancelCreate = () => {
    if (filesMutations.create.isPending) {
      return;
    }
    setCreateOpen(false);
    setCreatePathInput("");
    setCreateContent("");
    setCreateFeedback(null);
  };

  const createFile = async () => {
    if (!selectedTarget || !canCreateFile || !createResolvedPath) {
      return;
    }

    setCreateFeedback(null);
    try {
      const result = await filesMutations.create.mutateAsync({
        target: selectedTarget.id,
        path: createResolvedPath,
        content: createContent,
      });
      if (!result.ok) {
        setCreateFeedback({ kind: "error", title: "CREATE FAILED", detail: result.error });
        return;
      }
      setCreateOpen(false);
      setCreatePathInput("");
      setCreateContent("");
      setCreateFeedback({ kind: "success", title: "CREATED", detail: result.path });
      openPath(result.path, true);
    } catch (error) {
      setCreateFeedback({
        kind: "error",
        title: "CREATE FAILED",
        detail: mutationErrorText(error, `Failed to create ${createResolvedPath}`),
      });
    }
  };

  const requestDeletePath = () => {
    if (!canDeletePath) {
      return;
    }
    setDeleteFeedback(null);
    setDeleteConfirmInput("");
    setDeleteConfirmPath((path) => path === displayedPath ? null : displayedPath);
  };

  const cancelDelete = () => {
    if (filesMutations.remove.isPending) {
      return;
    }
    setDeleteConfirmPath(null);
    setDeleteConfirmInput("");
    setDeleteFeedback(null);
  };

  const confirmDelete = async () => {
    const pathToDelete = deleteConfirmPath;
    if (!selectedTarget || !pathToDelete || !canDeletePath || deleteConfirmInput.trim() !== pathToDelete) {
      return;
    }

    setDeleteFeedback(null);
    try {
      const result = await filesMutations.remove.mutateAsync({
        target: selectedTarget.id,
        path: pathToDelete,
      });
      if (!result.ok) {
        setDeleteConfirmPath(null);
        setDeleteConfirmInput("");
        setDeleteFeedback({ kind: "error", title: "DELETE FAILED", detail: result.error });
        return;
      }
      const nextPath = parentPath(result.path, detectPathStyle(result.path));
      setDeleteConfirmPath(null);
      setDeleteConfirmInput("");
      setDeleteFeedback({ kind: "success", title: "DELETED", detail: result.path });
      openPath(nextPath, true);
    } catch (error) {
      setDeleteConfirmPath(null);
      setDeleteConfirmInput("");
      setDeleteFeedback({
        kind: "error",
        title: "DELETE FAILED",
        detail: mutationErrorText(error, `Failed to delete ${pathToDelete}`),
      });
    }
  };

  const goParent = () => {
    openPath(parentPath(displayedPath, detectPathStyle(displayedPath)));
  };

  const goRoot = () => {
    openPath(pathRoot(displayedPath));
  };

  return (
    <ConsolePage>
      <ConsoleResourceBoundary
        resource={targetsQuery.resource}
        emptyLabel="NO FILE TARGETS"
        errorLabel="FILES"
        loadingLabel="LOADING FILE TARGETS"
        render={(data) => (
          <div class="files-surface">
            <aside class="files-target-panel" aria-label="File targets">
              <SectionHeader title="TARGETS" meta={`${onlineCount}/${data.length} ONLINE`} divider />
              <div class="files-target-list">
                {data.map((target) => (
                  <TargetRow
                    key={target.id}
                    target={target}
                    active={target.id === selectedTargetId}
                    onSelect={() => selectTargetByIndex(targets.findIndex((item) => item.id === target.id))}
                  />
                ))}
              </div>
            </aside>

            <section class="files-workspace" aria-label="File browser">
              <div class="files-control-bar">
                <Select
                  key={selectedTarget?.id ?? "no-target"}
                  label="TARGET"
                  options={targetOptions}
                  value={selectedTargetIndex}
                  disabled={!connected || targetOptions.length === 0}
                  width={280}
                  onChange={selectTargetByIndex}
                />
                <form class="files-path-form" onSubmit={handlePathSubmit}>
                  <TextInput
                    key={`path-${pathInputKey}`}
                    label="PATH"
                    value={pathInput}
                    placeholder="."
                    prefix={selectedTarget?.id ?? ""}
                    clearable
                    disabled={!canQueryTarget}
                    onChange={setPathInput}
                  />
                  <div class="files-action-row">
                    <Button variant="secondary" label="ROOT" disabled={!canQueryTarget} onClick={goRoot} />
                    <Button variant="secondary" label="UP" disabled={!canQueryTarget || atRoot} onClick={goParent} />
                    <Button variant="primary" label="OPEN" disabled={!canQueryTarget} onClick={openPathInput} />
                    <Button
                      variant="secondary"
                      label="REFRESH"
                      disabled={!canQueryTarget || readQuery.isFetching}
                      onClick={() => {
                        void readQuery.refetch();
                      }}
                    />
                    <Button
                      variant="secondary"
                      label={createOpen ? "CANCEL NEW" : "NEW FILE"}
                      disabled={!canQueryTarget || filesMutations.create.isPending}
                      onClick={createOpen ? cancelCreate : toggleCreate}
                    />
                    <Button
                      variant="dangerGhost"
                      label={deleteConfirmPath === displayedPath ? "CONFIRMING" : "DELETE"}
                      disabled={filesMutations.remove.isPending || (!canDeletePath && deleteConfirmPath !== displayedPath)}
                      onClick={deleteConfirmPath === displayedPath ? cancelDelete : requestDeletePath}
                    />
                  </div>
                </form>
              </div>

              <div class="files-context-line">
                <span>{selectedTarget ? describeTarget(selectedTarget) : "NO TARGET SELECTED"}</span>
                {connected ? (
                  <Tag
                    tone={selectedTarget?.online ? "online" : "idle"}
                    label={selectedTarget?.online ? "ONLINE" : "OFFLINE"}
                    boxed
                    dot
                  />
                ) : (
                  <Tag tone="idle" label="GATEWAY OFFLINE" boxed dot />
                )}
              </div>

              <nav class="files-crumbs" aria-label="Current path">
                {crumbs.map((crumb, index) => (
                  <button
                    type="button"
                    key={`${crumb.path}:${index}`}
                    class={index === crumbs.length - 1 ? "is-current" : ""}
                    disabled={!canQueryTarget}
                    onClick={() => openPath(crumb.path)}
                  >
                    {crumb.label}
                  </button>
                ))}
              </nav>

              {createOpen ? (
                <section class="files-create-panel" aria-label="Create file">
                  <SectionHeader title="NEW FILE" meta={createResolvedPath || createBasePath} divider />
                  <div class="files-create-body">
                    <div class="files-field">
                      <TextInput
                        key={`create-path-${createOpen}`}
                        label="FILE PATH"
                        value={createPathInput}
                        placeholder="new-file.txt"
                        status={createPathInput.trim() ? "success" : "warning"}
                        message={createResolvedPath || "Path required"}
                        clearable
                        disabled={!canQueryTarget || filesMutations.create.isPending}
                        onChange={(value) => {
                          setCreatePathInput(value);
                          setCreateFeedback(null);
                        }}
                      />
                    </div>
                    <label class="files-field files-field-full">
                      <span>INITIAL CONTENT</span>
                      <textarea
                        class="files-create-textarea"
                        value={createContent}
                        rows={7}
                        disabled={!canQueryTarget || filesMutations.create.isPending}
                        spellcheck={false}
                        onInput={(event) => {
                          setCreateContent(event.currentTarget.value);
                          setCreateFeedback(null);
                        }}
                      />
                    </label>
                    <div class="files-create-footer">
                      <span class="files-editor-status">
                        <StatusDot
                          tone={filesMutations.create.isPending ? "live" : createPathInput.trim() ? "online" : "idle"}
                          size={8}
                        />
                        <span>{filesMutations.create.isPending ? "CREATING" : createResolvedPath || "PATH REQUIRED"}</span>
                      </span>
                      <span class="files-editor-actions">
                        <Button
                          variant="secondary"
                          label="CANCEL"
                          disabled={filesMutations.create.isPending}
                          onClick={cancelCreate}
                        />
                        <Button
                          variant="primary"
                          label={filesMutations.create.isPending ? "CREATING" : "CREATE"}
                          disabled={!canCreateFile}
                          onClick={createFile}
                        />
                      </span>
                    </div>
                    {filesMutations.create.isPending ? (
                      <FilesInlineNotice kind="loading" title="CREATING" detail={createResolvedPath} />
                    ) : createFeedback && createFeedback.kind === "error" ? (
                      <FilesInlineNotice kind={createFeedback.kind} title={createFeedback.title} detail={createFeedback.detail} />
                    ) : null}
                  </div>
                </section>
              ) : createFeedback ? (
                <FilesInlineNotice kind={createFeedback.kind} title={createFeedback.title} detail={createFeedback.detail} />
              ) : null}

              {deleteConfirmPath ? (
                <DeleteConfirmation
                  path={deleteConfirmPath}
                  pending={filesMutations.remove.isPending}
                  value={deleteConfirmInput}
                  onValueChange={(value) => {
                    setDeleteConfirmInput(value);
                    setDeleteFeedback(null);
                  }}
                  onCancel={cancelDelete}
                  onConfirm={confirmDelete}
                />
              ) : deleteFeedback ? (
                <FilesInlineNotice kind={deleteFeedback.kind} title={deleteFeedback.title} detail={deleteFeedback.detail} />
              ) : null}

              <div class="files-browser-grid">
                <section class="files-browser-panel">
                  <SectionHeader title={readTitle} meta={readMeta} divider />
                  <ReadPanel
                    connected={connected}
                    target={selectedTarget}
                    path={displayedPath}
                    payload={readPayload}
                    isLoading={readQuery.isLoading}
                    queryError={queryErrorText(readQuery.error)}
                    fileDraft={editorDraft}
                    fileDirty={editorDirty}
                    savePending={filesMutations.save.isPending}
                    saveFeedback={saveFeedback}
                    onOpenPath={openPath}
                    onRetry={() => {
                      void readQuery.refetch();
                    }}
                    onFileDraftChange={updateFileDraft}
                    onSaveFile={saveFile}
                    onResetFileDraft={resetFileDraft}
                  />
                </section>

                <section class="files-browser-panel files-search-panel">
                  <SectionHeader title="SEARCH" meta={searchMeta} divider />
                  <form class="files-search-form" onSubmit={handleSearchSubmit}>
                    <TextInput
                      key={`search-${searchInputKey}`}
                      label=""
                      value={searchInput}
                      placeholder="Search current path"
                      clearable
                      disabled={!canQueryTarget}
                      onChange={setSearchInput}
                    />
                    <div class="files-search-actions">
                      <Button
                        variant="primary"
                        label="SEARCH"
                        disabled={!canQueryTarget || searchInput.trim().length === 0}
                        onClick={() => setSearchQuery(searchInput.trim())}
                      />
                      <Button
                        variant="secondary"
                        label="CLEAR"
                        disabled={searchInput.length === 0 && searchQuery.length === 0}
                        onClick={resetSearch}
                      />
                    </div>
                  </form>
                  <SearchPanel
                    connected={connected}
                    target={selectedTarget}
                    query={searchQuery}
                    payload={searchResult.data}
                    isLoading={searchResult.isLoading}
                    queryError={queryErrorText(searchResult.error)}
                    onOpenPath={openPath}
                    onRetry={() => {
                      void searchResult.refetch();
                    }}
                  />
                </section>
              </div>
            </section>
          </div>
        )}
      />
    </ConsolePage>
  );
}
