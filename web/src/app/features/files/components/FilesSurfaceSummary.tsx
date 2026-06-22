import { useEffect, useMemo, useState } from "preact/hooks";
import { Button } from "../../../components/ui/Button";
import { Icon } from "../../../components/ui/Icon";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { Select } from "../../../components/ui/Select";
import { Spinner } from "../../../components/ui/Spinner";
import { StatusDot, type StatusTone } from "../../../components/ui/StatusDot";
import { Tag } from "../../../components/ui/Tag";
import { TextInput } from "../../../components/ui/TextInput";
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
  formatFileStats,
  formatSearchMatchLine,
  formatTargetOption,
  imagePreviewsFromContent,
  pathRoot,
  resolveEnteredPath,
  sortDirectoryEntries,
  textFromContent,
} from "../domain/view";
import { useFilesPath, useFilesSearch, useFilesTargets } from "../hooks/useFilesQueries";
import "./FilesSurfaceSummary.css";

const DEFAULT_PATH = ".";

type ReadPanelProps = {
  connected: boolean;
  target: FilesTarget | null;
  path: string;
  payload: FilesReadPayload | FilesErrorPayload | undefined;
  isLoading: boolean;
  queryError: string;
  onOpenPath: (path: string) => void;
};

type SearchPanelProps = {
  connected: boolean;
  target: FilesTarget | null;
  query: string;
  payload: FilesSearchPayload | FilesErrorPayload | undefined;
  isLoading: boolean;
  queryError: string;
  onOpenPath: (path: string) => void;
};

type StateKind = "loading" | "error" | "empty" | "offline";

const STATE_TONE: Record<StateKind, StatusTone> = {
  loading: "live",
  error: "error",
  empty: "idle",
  offline: "idle",
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

function FilesStateMessage({
  kind,
  title,
  detail,
}: {
  kind: StateKind;
  title: string;
  detail?: string;
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

function FileView({ file }: { file: FilesFilePayload }) {
  const text = textFromContent(file.content);
  const images = imagePreviewsFromContent(file.content);
  const stats = formatFileStats(file);

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
      {text.length > 0 ? (
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
  onOpenPath,
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
    return <FilesStateMessage kind="error" title="READ FAILED" detail={queryError} />;
  }
  if (!payload) {
    return <FilesStateMessage kind="empty" title="NO PATH LOADED" detail="Enter a path and open it." />;
  }
  if (!payload.ok) {
    return <FilesStateMessage kind="error" title="READ FAILED" detail={payload.error} />;
  }
  if (isDirectoryPayload(payload)) {
    return <DirectoryView directory={payload} onOpenPath={onOpenPath} />;
  }
  if (isFilePayload(payload)) {
    return <FileView file={payload} />;
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
    return <FilesStateMessage kind="error" title="SEARCH FAILED" detail={queryError} />;
  }
  if (!payload) {
    return <FilesStateMessage kind="empty" title="NO SEARCH RESULTS" detail="Run a search to inspect matches." />;
  }
  if (!payload.ok) {
    return <FilesStateMessage kind="error" title="SEARCH FAILED" detail={payload.error} />;
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

export function FilesSurfaceSummary() {
  const { connected } = useGateway();
  const targetsQuery = useFilesTargets();
  const targets = targetsQuery.targets;
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState(DEFAULT_PATH);
  const [pathInput, setPathInput] = useState(DEFAULT_PATH);
  const [pathInputKey, setPathInputKey] = useState(0);
  const [searchInput, setSearchInput] = useState("");
  const [searchInputKey, setSearchInputKey] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");

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

  const resetSearch = () => {
    setSearchInput("");
    setSearchInputKey((key) => key + 1);
    setSearchQuery("");
  };

  const setExternalPath = (nextPath: string) => {
    setCurrentPath(nextPath);
    setPathInput(nextPath);
    setPathInputKey((key) => key + 1);
  };

  const openPath = (nextPath: string) => {
    setExternalPath(nextPath.trim() || pathRoot(displayedPath));
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
                    onOpenPath={openPath}
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
