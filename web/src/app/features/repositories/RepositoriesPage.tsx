import type { JSX } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { Breadcrumbs } from "../../components/ui/Breadcrumbs";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { ListRow } from "../../components/ui/ListRow";
import { Search } from "../../components/ui/Search";
import { SectionHeader } from "../../components/ui/SectionHeader";
import { Select } from "../../components/ui/Select";
import { Spinner } from "../../components/ui/Spinner";
import { StatusDot, type StatusTone } from "../../components/ui/StatusDot";
import { Surface } from "../../components/ui/Surface";
import { Tabs } from "../../components/ui/Tabs";
import { Tag } from "../../components/ui/Tag";
import { useGateway } from "../../services/gateway/GatewayProvider";
import {
  ConsolePage,
  ConsoleResourceBoundary,
} from "../gsv-console/components/ConsolePageTemplate";
import { RepositoryDiffView } from "./components/RepositoryDiffView";
import type {
  RepositoryCommit,
  RepositoryReadResult,
  RepositorySearchResult,
  RepositorySummary,
  RepositoryTreeEntry,
} from "./domain/models";
import {
  buildRepoPathCrumbs,
  chooseInitialRepository,
  firstLine,
  formatAge,
  formatBytes,
  formatCommitAuthor,
  formatRepositoryOption,
  initialRefForRepository,
  normalizeRepoPath,
  parentRepoPath,
  pathBasename,
  refHash,
  refsToOptions,
  repoKindLabel,
  repoKindTone,
  repositoryDescription,
  shortHash,
  sortTreeEntries,
} from "./domain/presentation";
import {
  createBrowserTab,
  createCommitTab,
  createCompareTab,
  createFileTab,
  createHistoryTab,
  tabLabel,
  type RepositoryBrowserTab,
  type RepositoryCompareTab,
  type RepositoryFileTab,
  type RepositoryHistoryTab,
  type RepositoryWorkspaceTab,
} from "./domain/workspace";
import {
  useRepositories,
  useRepositoryCommits,
  useRepositoryCompare,
  useRepositoryDiff,
  useRepositoryPath,
  useRepositoryRefs,
  useRepositorySearch,
} from "./hooks/useRepositoryQueries";
import "./RepositoriesPage.css";

const FILE_ICON = "doticons/file";
const FOLDER_ICON = "doticons/folder";
const LINK_ICON = "doticons/weblink";
const COMMIT_PAGE_SIZE = 20;
const COMPACT_ROW_STYLE: JSX.CSSProperties = {
  minHeight: "46px",
  padding: "12px 14px",
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

function repositoryForTab(tab: RepositoryWorkspaceTab | null, repos: readonly RepositorySummary[]): RepositorySummary | null {
  if (!tab) {
    return null;
  }
  return repos.find((repo) => repo.repo === tab.repo) ?? null;
}

function RepositoriesStateMessage({
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
    <div class={`repositories-state repositories-state-${kind}`} role={kind === "error" ? "alert" : "status"}>
      <span class="repositories-state-mark">
        {kind === "loading" ? <Spinner size={18} /> : <StatusDot tone={STATE_TONE[kind]} size={8} />}
      </span>
      <span class="repositories-state-copy">
        <strong>{title}</strong>
        {detail ? <span>{detail}</span> : null}
      </span>
      {action ? <span class="repositories-state-action">{action}</span> : null}
    </div>
  );
}

function isTreePayload(payload: RepositoryReadResult | undefined): payload is Extract<RepositoryReadResult, { kind: "tree" }> {
  return payload?.kind === "tree";
}

function isFilePayload(payload: RepositoryReadResult | undefined): payload is Extract<RepositoryReadResult, { kind: "file" }> {
  return payload?.kind === "file";
}

function DirectoryBrowser({
  directory,
  onOpenDirectory,
  onOpenFile,
  onOpenFileInNewTab,
  onOpenParent,
}: {
  directory: Extract<RepositoryReadResult, { kind: "tree" }>;
  onOpenDirectory: (path: string) => void;
  onOpenFile: (path: string, preview: boolean) => void;
  onOpenFileInNewTab: (path: string) => void;
  onOpenParent: () => void;
}) {
  const entries = sortTreeEntries(directory.entries);
  const directoryCount = entries.filter((entry) => entry.type === "tree").length;
  const fileCount = entries.length - directoryCount;
  const [selectedRowIndex, setSelectedRowIndex] = useState(-1);
  const cursor = entries.length === 0 ? -1 : Math.min(selectedRowIndex, entries.length - 1);

  useEffect(() => {
    setSelectedRowIndex(-1);
  }, [directory.path]);

  const openEntry = (entry: RepositoryTreeEntry) => {
    if (entry.type === "tree") {
      onOpenDirectory(entry.path);
      return;
    }
    onOpenFile(entry.path, true);
  };

  const onKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedRowIndex((index) => Math.min(index + 1, entries.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedRowIndex((index) => Math.max((index < 0 ? 0 : index) - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const entry = cursor >= 0 ? entries[cursor] : null;
      if (entry) {
        openEntry(entry);
      }
    } else if (event.key === "Backspace" || event.key === "ArrowLeft") {
      event.preventDefault();
      onOpenParent();
    }
  };

  return (
    <div class="repositories-browser-list" tabIndex={0} onKeyDown={onKeyDown} aria-label="Repository entries">
      <div class="repositories-list-summary">
        <Tag tone="accent" label={`${directoryCount} DIR`} boxed />
        <Tag tone="idle" label={`${fileCount} FILE`} boxed />
      </div>
      {entries.length === 0 ? (
        <RepositoriesStateMessage
          kind="empty"
          title="EMPTY DIRECTORY"
          detail={`${directory.path || "/"} has no entries returned by ripgit.`}
        />
      ) : entries.map((entry, index) => (
        <div class="repositories-row-wrap" key={`${entry.type}:${entry.path}`}>
          <ListRow
            className={`repositories-object-row${index === cursor ? " is-selected" : ""}`}
            icon={entry.type === "tree" ? FOLDER_ICON : entry.type === "symlink" ? LINK_ICON : FILE_ICON}
            label={entry.name}
            sub={entry.path}
            status="none"
            tag={entry.type === "tree" ? "DIR" : entry.type === "symlink" ? "LINK" : "FILE"}
            tagTone={entry.type === "tree" ? "accent" : "idle"}
            chevron
            style={COMPACT_ROW_STYLE}
            onClick={() => {
              setSelectedRowIndex(index);
              openEntry(entry);
            }}
          />
          {entry.type !== "tree" ? (
            <span class="repositories-row-action">
              <IconButton glyph="newTab" size="small" title="Open in new tab" onClick={() => onOpenFileInNewTab(entry.path)} />
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function SearchResults({
  connected,
  payload,
  query,
  isLoading,
  queryError,
  onOpenFile,
  onRetry,
}: {
  connected: boolean;
  payload: RepositorySearchResult | undefined;
  query: string;
  isLoading: boolean;
  queryError: string;
  onOpenFile: (path: string) => void;
  onRetry: () => void;
}) {
  if (!connected) {
    return <RepositoriesStateMessage kind="offline" title="GATEWAY OFFLINE" detail="Reconnect to search ripgit repositories." />;
  }
  if (!query) {
    return <RepositoriesStateMessage kind="empty" title="SEARCH READY" detail="Enter a query to search the current repository path." />;
  }
  if (isLoading && !payload) {
    return <RepositoriesStateMessage kind="loading" title="SEARCHING" detail={query} />;
  }
  if (queryError) {
    return (
      <RepositoriesStateMessage
        kind="error"
        title="SEARCH FAILED"
        detail={queryError}
        action={<Button variant="secondary" label="RETRY" onClick={onRetry} />}
      />
    );
  }
  if (!payload) {
    return <RepositoriesStateMessage kind="empty" title="NO SEARCH RESULTS" detail="Run a search to inspect matches." />;
  }
  if (payload.matches.length === 0) {
    return <RepositoriesStateMessage kind="empty" title="NO MATCHES" detail={`No results for "${payload.query}".`} />;
  }

  return (
    <div class="repositories-search-results">
      {payload.matches.map((match, index) => (
        <button
          type="button"
          class="repositories-search-row"
          key={`${match.path}:${match.line}:${index}`}
          onClick={() => onOpenFile(match.path)}
        >
          <span class="repositories-search-path">{match.path}</span>
          <span class="repositories-search-line">LINE {match.line}</span>
          <span class="repositories-search-preview">{match.content}</span>
        </button>
      ))}
      {payload.truncated ? <div class="repositories-empty-inline">RESULTS TRUNCATED BY RIPGIT</div> : null}
    </div>
  );
}

function BrowserTabView({
  connected,
  repo,
  tab,
  payload,
  isLoading,
  isFetching,
  queryError,
  searchPayload,
  searchLoading,
  searchError,
  onNavigate,
  onSearchInputChange,
  onSearchSubmit,
  onOpenFile,
  onOpenFileInNewTab,
  onOpenHistory,
  onOpenCompare,
  onRefresh,
  onSearchRetry,
}: {
  connected: boolean;
  repo: RepositorySummary | null;
  tab: RepositoryBrowserTab;
  payload: RepositoryReadResult | undefined;
  isLoading: boolean;
  isFetching: boolean;
  queryError: string;
  searchPayload: RepositorySearchResult | undefined;
  searchLoading: boolean;
  searchError: string;
  onNavigate: (path: string) => void;
  onSearchInputChange: (value: string) => void;
  onSearchSubmit: (value: string) => void;
  onOpenFile: (path: string, preview: boolean) => void;
  onOpenFileInNewTab: (path: string) => void;
  onOpenHistory: () => void;
  onOpenCompare: () => void;
  onRefresh: () => void;
  onSearchRetry: () => void;
}) {
  const displayedPath = payload?.path ?? tab.path;
  const atRoot = normalizeRepoPath(displayedPath) === "";
  const crumbs = buildRepoPathCrumbs(displayedPath).map((crumb, index, list) => ({
    label: crumb.label,
    onClick: index === list.length - 1 ? undefined : () => onNavigate(crumb.path),
  }));
  const readMeta = [
    repo?.repo ?? tab.repo,
    tab.ref,
    isFetching && payload ? "REFRESHING" : "",
  ].filter(Boolean).join(" | ");

  return (
    <section class="repositories-tab-panel" aria-label="Repository browser">
      <SectionTitle title="BROWSER" meta={readMeta} />
      <div class="repositories-breadcrumbs-container">
        <Breadcrumbs
          items={crumbs}
          onBack={atRoot ? undefined : () => onNavigate(parentRepoPath(displayedPath))}
          size="medium"
          maxVisible={3}
        />
        <span class="repositories-breadcrumbs-actions">
          <IconButton glyph="refresh" size="small" title="Refresh repository path" disabled={!connected} onClick={onRefresh} />
        </span>
      </div>
      <div class="repositories-browser-toolbar">
        <div class="repositories-toolbar-row">
          <span class="repositories-toolbar-search">
            <Search
              key={`repo-search-${tab.id}-${tab.commandInputKey}`}
              size="small"
              value={tab.commandInput}
              placeholder="Search this repository — press ENTER"
              disabled={!connected}
              onChange={onSearchInputChange}
              onSearch={(value) => {
                if (connected) {
                  onSearchSubmit(value);
                }
              }}
            />
          </span>
          <span class="repositories-toolbar-actions">
            <Button variant="secondary" label="HISTORY" disabled={!connected} onClick={onOpenHistory} />
            <Button variant="secondary" label="COMPARE" disabled={!connected} onClick={onOpenCompare} />
          </span>
        </div>
      </div>

      {tab.searchQuery ? (
        <SearchResults
          connected={connected}
          payload={searchPayload}
          query={tab.searchQuery}
          isLoading={searchLoading}
          queryError={searchError}
          onOpenFile={(path) => onOpenFile(path, true)}
          onRetry={onSearchRetry}
        />
      ) : !connected ? (
        <RepositoriesStateMessage kind="offline" title="GATEWAY OFFLINE" detail="Reconnect to browse ripgit repositories." />
      ) : isLoading && !payload ? (
        <RepositoriesStateMessage kind="loading" title="OPENING REPOSITORY" detail={`${tab.repo}#${tab.ref}:${tab.path || "/"}`} />
      ) : queryError ? (
        <RepositoriesStateMessage
          kind="error"
          title="READ FAILED"
          detail={queryError}
          action={<Button variant="secondary" label="RETRY" onClick={onRefresh} />}
        />
      ) : !payload ? (
        <RepositoriesStateMessage kind="empty" title="NO PATH LOADED" detail="Choose a repository path to browse." />
      ) : isTreePayload(payload) ? (
        <DirectoryBrowser
          directory={payload}
          onOpenDirectory={onNavigate}
          onOpenFile={onOpenFile}
          onOpenFileInNewTab={onOpenFileInNewTab}
          onOpenParent={() => onNavigate(parentRepoPath(displayedPath))}
        />
      ) : isFilePayload(payload) ? (
        <RepositoriesStateMessage
          kind="empty"
          title="FILE PATH"
          detail="Open this path in a preview tab."
          action={<Button variant="primary" label="OPEN FILE" onClick={() => onOpenFile(payload.path, true)} />}
        />
      ) : (
        <RepositoriesStateMessage kind="empty" title="UNRECOGNIZED RESPONSE" detail="Ripgit returned a payload this UI cannot render." />
      )}
    </section>
  );
}

function FileTabView({
  connected,
  repo,
  tab,
  payload,
  isLoading,
  isFetching,
  queryError,
  onRefresh,
  onNavigate,
}: {
  connected: boolean;
  repo: RepositorySummary | null;
  tab: RepositoryFileTab;
  payload: RepositoryReadResult | undefined;
  isLoading: boolean;
  isFetching: boolean;
  queryError: string;
  onRefresh: () => void;
  onNavigate: (path: string) => void;
}) {
  const file = isFilePayload(payload) ? payload : null;
  const crumbs = buildRepoPathCrumbs(tab.path).map((crumb, index, list) => ({
    label: crumb.label,
    onClick: index === list.length - 1 ? undefined : () => onNavigate(crumb.path),
  }));

  return (
    <section class="repositories-tab-panel" aria-label="Repository file">
      <SectionTitle
        title={pathBasename(tab.path)}
        meta={[
          repo?.repo ?? tab.repo,
          tab.ref,
          isFetching && payload ? "REFRESHING" : "",
        ].filter(Boolean).join(" | ")}
      />
      <div class="repositories-editor-toolbar">
        <Breadcrumbs
          items={crumbs}
          onBack={() => onNavigate(parentRepoPath(tab.path))}
          size="medium"
          maxVisible={3}
        />
        <span class="repositories-toolbar-actions">
          <IconButton glyph="refresh" size="small" title="Refresh file" disabled={!connected} onClick={onRefresh} />
        </span>
      </div>
      {!connected ? (
        <RepositoriesStateMessage kind="offline" title="GATEWAY OFFLINE" detail="Reconnect to read this repository file." />
      ) : isLoading && !payload ? (
        <RepositoriesStateMessage kind="loading" title="OPENING FILE" detail={tab.path} />
      ) : queryError ? (
        <RepositoriesStateMessage
          kind="error"
          title="READ FAILED"
          detail={queryError}
          action={<Button variant="secondary" label="RETRY" onClick={onRefresh} />}
        />
      ) : !payload ? (
        <RepositoriesStateMessage kind="empty" title="NO FILE LOADED" detail={tab.path} />
      ) : !file ? (
        <RepositoriesStateMessage kind="empty" title="NOT A FILE" detail="This tab path no longer resolves to file content." />
      ) : (
        <div class="repositories-file-view">
          <div class="repositories-file-meta">
            <Tag tone="idle" label="FILE" boxed />
            {file.isBinary ? <Tag tone="warn" label="BINARY" boxed /> : null}
            {formatBytes(file.size) ? <small>{formatBytes(file.size)}</small> : null}
          </div>
          {file.isBinary ? (
            <RepositoriesStateMessage kind="empty" title="BINARY FILE" detail="This file cannot be previewed inline." />
          ) : (
            <CodeBlock content={file.content ?? ""} path={file.path} />
          )}
        </div>
      )}
    </section>
  );
}

function HistoryTabView({
  connected,
  repo,
  tab,
  page,
  isLoading,
  isFetching,
  queryError,
  onRefresh,
  onSelectCommit,
  onOffsetChange,
}: {
  connected: boolean;
  repo: RepositorySummary | null;
  tab: RepositoryHistoryTab;
  page: ReturnType<typeof useRepositoryCommits>["data"];
  isLoading: boolean;
  isFetching: boolean;
  queryError: string;
  onRefresh: () => void;
  onSelectCommit: (commit: RepositoryCommit) => void;
  onOffsetChange: (offset: number) => void;
}) {
  const entries = page?.entries ?? [];
  const pageNumber = page ? Math.floor(page.offset / page.limit) + 1 : 1;

  return (
    <section class="repositories-tab-panel" aria-label="Repository history">
      <SectionTitle
        title="HISTORY"
        meta={[
          repo?.repo ?? tab.repo,
          tab.ref,
          isFetching && page ? "REFRESHING" : "",
        ].filter(Boolean).join(" | ")}
      />
      <div class="repositories-browser-toolbar">
        <div class="repositories-toolbar-row">
          <span class="repositories-toolbar-actions">
            <Button variant="secondary" label="PREVIOUS" disabled={!page || page.offset <= 0 || isFetching} onClick={() => onOffsetChange(Math.max(0, tab.offset - COMMIT_PAGE_SIZE))} />
            <Tag tone="idle" label={`PAGE ${pageNumber}`} boxed />
            <Button variant="secondary" label="NEXT" disabled={!page?.hasNextPage || isFetching} onClick={() => onOffsetChange(tab.offset + COMMIT_PAGE_SIZE)} />
            <IconButton glyph="refresh" size="small" title="Refresh history" disabled={!connected} onClick={onRefresh} />
          </span>
        </div>
      </div>
      {!connected ? (
        <RepositoriesStateMessage kind="offline" title="GATEWAY OFFLINE" detail="Reconnect to read repository history." />
      ) : isLoading && !page ? (
        <RepositoriesStateMessage kind="loading" title="LOADING HISTORY" detail={`${tab.repo}#${tab.ref}`} />
      ) : queryError ? (
        <RepositoriesStateMessage
          kind="error"
          title="HISTORY FAILED"
          detail={queryError}
          action={<Button variant="secondary" label="RETRY" onClick={onRefresh} />}
        />
      ) : entries.length === 0 ? (
        <RepositoriesStateMessage kind="empty" title="NO COMMITS" detail="Ripgit returned no commit history for this ref." />
      ) : (
        <div class="repositories-history-list">
          {entries.map((commit) => (
            <button
              type="button"
              class="repositories-commit-row"
              key={commit.hash}
              onClick={() => onSelectCommit(commit)}
            >
              <span class="repositories-commit-message">{firstLine(commit.message)}</span>
              <span class="repositories-commit-meta">{formatCommitAuthor(commit)} · {formatAge(commit.commitTime)}</span>
              <span class="repositories-commit-hash">{shortHash(commit.hash)}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function CommitTabView({
  connected,
  tab,
  commit,
  diff,
  isLoading,
  isFetching,
  queryError,
  onOpenHistory,
  onRefresh,
}: {
  connected: boolean;
  tab: Extract<RepositoryWorkspaceTab, { kind: "commit" }>;
  commit: RepositoryCommit | null;
  diff: ReturnType<typeof useRepositoryDiff>["data"];
  isLoading: boolean;
  isFetching: boolean;
  queryError: string;
  onOpenHistory: () => void;
  onRefresh: () => void;
}) {
  return (
    <section class="repositories-tab-panel" aria-label="Commit diff">
      <SectionTitle
        title={commit ? firstLine(commit.message) : shortHash(tab.commit)}
        meta={[
          tab.repo,
          commit ? `${formatCommitAuthor(commit)} · ${formatAge(commit.commitTime)}` : tab.ref,
          isFetching && diff ? "REFRESHING" : "",
        ].filter(Boolean).join(" | ")}
      />
      <div class="repositories-browser-toolbar">
        <div class="repositories-toolbar-row">
          <span class="repositories-toolbar-actions">
            <Button variant="secondary" label="HISTORY" onClick={onOpenHistory} />
            <IconButton glyph="refresh" size="small" title="Refresh diff" disabled={!connected} onClick={onRefresh} />
          </span>
        </div>
      </div>
      {!connected ? (
        <RepositoriesStateMessage kind="offline" title="GATEWAY OFFLINE" detail="Reconnect to read this commit diff." />
      ) : isLoading && !diff ? (
        <RepositoriesStateMessage kind="loading" title="LOADING DIFF" detail={tab.commit} />
      ) : queryError ? (
        <RepositoriesStateMessage
          kind="error"
          title="DIFF FAILED"
          detail={queryError}
          action={<Button variant="secondary" label="RETRY" onClick={onRefresh} />}
        />
      ) : !diff ? (
        <RepositoriesStateMessage kind="empty" title="NO DIFF LOADED" detail={tab.commit} />
      ) : (
        <div class="repositories-diff-scroll">
          <RepositoryDiffView diff={diff} title={commit ? firstLine(commit.message) : `Commit ${shortHash(tab.commit)}`} />
        </div>
      )}
    </section>
  );
}

function CompareTabView({
  connected,
  tab,
  refOptions,
  comparison,
  isLoading,
  isFetching,
  queryError,
  onChange,
  onRefresh,
}: {
  connected: boolean;
  tab: RepositoryCompareTab;
  refOptions: string[];
  comparison: ReturnType<typeof useRepositoryCompare>["data"];
  isLoading: boolean;
  isFetching: boolean;
  queryError: string;
  onChange: (base: string, head: string) => void;
  onRefresh: () => void;
}) {
  const options = [...new Set([tab.base, tab.head, ...refOptions].filter(Boolean))];
  const baseIndex = Math.max(0, options.indexOf(tab.base));
  const headIndex = Math.max(0, options.indexOf(tab.head));

  return (
    <section class="repositories-tab-panel" aria-label="Repository compare">
      <SectionTitle
        title="COMPARE"
        meta={[
          tab.repo,
          `${tab.base}...${tab.head}`,
          isFetching && comparison ? "REFRESHING" : "",
        ].filter(Boolean).join(" | ")}
      />
      <div class="repositories-compare-controls">
        <Select
          label="BASE"
          width={260}
          options={options.length > 0 ? options : ["main"]}
          value={baseIndex}
          disabled={!connected}
          size="small"
          onChange={(index) => onChange(options[index] ?? tab.base, tab.head)}
        />
        <Select
          label="HEAD"
          width={260}
          options={options.length > 0 ? options : ["main"]}
          value={headIndex}
          disabled={!connected}
          size="small"
          onChange={(index) => onChange(tab.base, options[index] ?? tab.head)}
        />
        <span class="repositories-toolbar-actions">
          <IconButton glyph="refresh" size="small" title="Refresh comparison" disabled={!connected} onClick={onRefresh} />
        </span>
      </div>
      {!connected ? (
        <RepositoriesStateMessage kind="offline" title="GATEWAY OFFLINE" detail="Reconnect to compare repository refs." />
      ) : isLoading && !comparison ? (
        <RepositoriesStateMessage kind="loading" title="COMPARING REFS" detail={`${tab.base}...${tab.head}`} />
      ) : queryError ? (
        <RepositoriesStateMessage
          kind="error"
          title="COMPARE FAILED"
          detail={queryError}
          action={<Button variant="secondary" label="RETRY" onClick={onRefresh} />}
        />
      ) : !comparison ? (
        <RepositoriesStateMessage kind="empty" title="NO COMPARISON LOADED" detail="Choose base and head refs." />
      ) : (
        <div class="repositories-diff-scroll">
          <RepositoryDiffView diff={comparison} title={`${shortHash(tab.base)}...${shortHash(tab.head)}`} />
        </div>
      )}
    </section>
  );
}

function SectionTitle({ title, meta }: { title: string; meta?: string }) {
  return <SectionHeader title={title} meta={meta ?? ""} divider />;
}

function CodeBlock({ content, path }: { content: string; path: string }) {
  const lines = content.length > 0
    ? (content.endsWith("\n") ? content.slice(0, -1) : content).split("\n")
    : [""];
  return (
    <pre class="repositories-code-block" aria-label={path || "repository file"}>
      {lines.map((line, index) => (
        <code key={index} class="repositories-code-line">
          <span class="repositories-code-line-number">{index + 1}</span>
          <span class="repositories-code-line-content">{line}</span>
        </code>
      ))}
    </pre>
  );
}

export function RepositoriesPage() {
  const { connected } = useGateway();
  const repositoriesQuery = useRepositories();
  const repos = repositoriesQuery.repos;
  const [tabs, setTabs] = useState<RepositoryWorkspaceTab[]>([]);
  const [activeTabId, setActiveTabId] = useState("");
  const [previewTabId, setPreviewTabId] = useState<string | null>(null);
  const [knownCommits, setKnownCommits] = useState<Record<string, RepositoryCommit>>({});

  useEffect(() => {
    setTabs((currentTabs) => {
      if (repos.length === 0) {
        return currentTabs.length === 0 ? currentTabs : [];
      }
      const repoIds = new Set(repos.map((repo) => repo.repo));
      const validTabs = currentTabs.filter((tab) => repoIds.has(tab.repo));
      if (validTabs.length > 0) {
        return validTabs.length === currentTabs.length ? currentTabs : validTabs;
      }
      const initialRepoSlug = chooseInitialRepository(repos);
      const initialRepo = repos.find((repo) => repo.repo === initialRepoSlug) ?? repos[0];
      return initialRepo ? [createBrowserTab(initialRepo.repo, initialRefForRepository(initialRepo))] : [];
    });
  }, [repos]);

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
  const activeRepo = repositoryForTab(activeTab, repos);
  const refsQuery = useRepositoryRefs(activeTab?.repo, Boolean(activeTab));
  const activeRef = activeTab?.ref ?? initialRefForRepository(activeRepo);
  const refOptions = useMemo(() => refsToOptions(refsQuery.data, activeRef), [activeRef, refsQuery.data]);
  const activeBrowserTab = activeTab?.kind === "browser" ? activeTab : null;
  const activeFileTab = activeTab?.kind === "file" ? activeTab : null;
  const activeHistoryTab = activeTab?.kind === "history" ? activeTab : null;
  const activeCommitTab = activeTab?.kind === "commit" ? activeTab : null;
  const activeCompareTab = activeTab?.kind === "compare" ? activeTab : null;
  const canQuery = connected && Boolean(activeTab);

  const readTab = activeBrowserTab ?? activeFileTab;
  const readQuery = useRepositoryPath({
    repo: readTab?.repo ?? "",
    ref: readTab?.ref,
    path: readTab?.path ?? "",
  }, canQuery && Boolean(readTab));
  const readPayload = readQuery.data;

  const searchResult = useRepositorySearch({
    repo: activeBrowserTab?.repo ?? "",
    ref: activeBrowserTab?.ref,
    query: activeBrowserTab?.searchQuery ?? "",
    prefix: activeBrowserTab?.path ?? "",
  }, canQuery && Boolean(activeBrowserTab?.searchQuery));

  const commitsQuery = useRepositoryCommits({
    repo: activeHistoryTab?.repo ?? "",
    ref: activeHistoryTab?.ref,
    limit: COMMIT_PAGE_SIZE,
    offset: activeHistoryTab?.offset ?? 0,
  }, canQuery && Boolean(activeHistoryTab));

  useEffect(() => {
    if (!commitsQuery.data?.entries.length) {
      return;
    }
    setKnownCommits((current) => {
      const next = { ...current };
      for (const commit of commitsQuery.data.entries) {
        next[commit.hash] = commit;
      }
      return next;
    });
  }, [commitsQuery.data]);

  const diffQuery = useRepositoryDiff({
    repo: activeCommitTab?.repo ?? "",
    commit: activeCommitTab?.commit ?? "",
    context: 3,
  }, canQuery && Boolean(activeCommitTab));

  const compareQuery = useRepositoryCompare({
    repo: activeCompareTab?.repo ?? "",
    base: activeCompareTab?.base ?? "",
    head: activeCompareTab?.head ?? "",
    context: 3,
  }, canQuery && Boolean(activeCompareTab));

  const tabLabels = tabs.map((tab) => tabLabel(tab, repositoryForTab(tab, repos)));
  const activeIndex = Math.max(0, tabs.findIndex((tab) => tab.id === activeTabId));
  const activeRepoIndex = Math.max(0, repos.findIndex((repo) => repo.repo === activeTab?.repo));
  const activeRefIndex = Math.max(0, refOptions.indexOf(activeRef));
  const previewIndex = tabs.findIndex((tab) => tab.id === previewTabId);

  const focusOrOpenBrowserTab = (repo: RepositorySummary, ref = initialRefForRepository(repo), path = "") => {
    const nextTab = createBrowserTab(repo.repo, ref, normalizeRepoPath(path));
    const existing = tabs.find((tab) => tab.id === nextTab.id);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    setTabs((currentTabs) => [...currentTabs, nextTab]);
    setActiveTabId(nextTab.id);
  };

  const updateBrowserTab = (tabId: string, updater: (tab: RepositoryBrowserTab) => RepositoryBrowserTab) => {
    setTabs((currentTabs) => currentTabs.map((tab) => tab.id === tabId && tab.kind === "browser" ? updater(tab) : tab));
  };

  const updateHistoryTab = (tabId: string, updater: (tab: RepositoryHistoryTab) => RepositoryHistoryTab) => {
    setTabs((currentTabs) => currentTabs.map((tab) => tab.id === tabId && tab.kind === "history" ? updater(tab) : tab));
  };

  const navigateBrowserTab = (tab: RepositoryBrowserTab, path: string) => {
    updateBrowserTab(tab.id, (currentTab) => ({
      ...currentTab,
      path: normalizeRepoPath(path),
      commandInput: "",
      commandInputKey: currentTab.commandInputKey + 1,
      searchQuery: "",
    }));
  };

  const openFileTab = (repo: string, ref: string, path: string, preview = false) => {
    const nextTab = createFileTab(repo, ref, normalizeRepoPath(path));
    const alreadyPermanent = tabs.some((tab) => tab.id === nextTab.id && tab.id !== previewTabId);
    if (preview && !alreadyPermanent) {
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

    const existing = tabs.find((tab) => tab.id === nextTab.id);
    if (existing) {
      setPreviewTabId((current) => (current === existing.id ? null : current));
      setActiveTabId(existing.id);
      return;
    }
    setTabs((currentTabs) => [...currentTabs, nextTab]);
    setPreviewTabId((current) => (current === nextTab.id ? null : current));
    setActiveTabId(nextTab.id);
  };

  const openHistoryTab = (repo: string, ref: string) => {
    const nextTab = createHistoryTab(repo, ref);
    const existing = tabs.find((tab) => tab.id === nextTab.id);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    setTabs((currentTabs) => [...currentTabs, nextTab]);
    setActiveTabId(nextTab.id);
  };

  const openCommitTab = (repo: string, ref: string, commit: RepositoryCommit | string) => {
    const commitHash = typeof commit === "string" ? commit : commit.hash;
    if (typeof commit !== "string") {
      setKnownCommits((current) => ({ ...current, [commit.hash]: commit }));
    }
    const nextTab = createCommitTab(repo, ref, commitHash);
    const existing = tabs.find((tab) => tab.id === nextTab.id);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    setTabs((currentTabs) => [...currentTabs, nextTab]);
    setActiveTabId(nextTab.id);
  };

  const openCompareTab = (repo: string, ref: string) => {
    const repoSummary = repos.find((summary) => summary.repo === repo) ?? null;
    const currentHash = refHash(refsQuery.data, ref);
    const base = repoSummary?.baseRef || currentHash || ref;
    const head = repoSummary?.ref || ref;
    const nextTab = createCompareTab(repo, ref, base, head);
    const existing = tabs.find((tab) => tab.id === nextTab.id);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    setTabs((currentTabs) => [...currentTabs, nextTab]);
    setActiveTabId(nextTab.id);
  };

  const updateCompareTab = (tab: RepositoryCompareTab, base: string, head: string) => {
    const nextTab = createCompareTab(tab.repo, tab.ref, base, head);
    setTabs((currentTabs) => currentTabs.map((candidate) => candidate.id === tab.id ? nextTab : candidate));
    setActiveTabId(nextTab.id);
  };

  const closeTabNow = (tabId: string) => {
    const index = tabs.findIndex((tab) => tab.id === tabId);
    const nextTabs = tabs.filter((tab) => tab.id !== tabId);
    if (nextTabs.length === 0) {
      return;
    }
    setTabs(nextTabs);
    setPreviewTabId((current) => (current === tabId ? null : current));
    if (activeTabId === tabId) {
      const nextActiveTab = nextTabs[Math.min(index, nextTabs.length - 1)] ?? nextTabs[0];
      setActiveTabId(nextActiveTab.id);
    }
  };

  return (
    <ConsolePage flush>
      <ConsoleResourceBoundary
        resource={repositoriesQuery.resource}
        emptyLabel="NO REPOSITORIES"
        errorLabel="REPOSITORIES"
        loadingLabel="LOADING REPOSITORIES"
        render={(data) => (
          <div class="repositories-surface">
            <div class="repositories-header-bar">
              <Select
                label="REPOSITORY"
                width={320}
                options={data.map(formatRepositoryOption)}
                value={activeRepoIndex}
                onChange={(index) => {
                  const repo = data[index];
                  if (repo) {
                    focusOrOpenBrowserTab(repo);
                  }
                }}
                size="medium"
              />
              <Select
                label="REF"
                width={260}
                options={refOptions.length > 0 ? refOptions : [activeRef || "main"]}
                value={activeRefIndex}
                disabled={!activeRepo || refsQuery.isLoading}
                onChange={(index) => {
                  const ref = refOptions[index] ?? activeRef;
                  if (activeRepo && ref) {
                    focusOrOpenBrowserTab(activeRepo, ref);
                  }
                }}
                size="medium"
              />
              {activeRepo ? (
                <span class="repositories-header-tags">
                  <Tag tone={repoKindTone(activeRepo.kind)} label={repoKindLabel(activeRepo.kind, activeRepo.rawKind)} boxed />
                  <Tag tone={activeRepo.public ? "online" : "idle"} label={activeRepo.public ? "PUBLIC" : "PRIVATE"} boxed />
                  <Tag tone={activeRepo.writable ? "online" : "idle"} label={activeRepo.writable ? "WRITABLE" : "READ ONLY"} boxed />
                  {activeRepo.updatedAt ? <Tag tone="idle" label={`UPDATED ${formatAge(activeRepo.updatedAt)}`} boxed /> : null}
                </span>
              ) : null}
            </div>
            <section class="repositories-workspace" aria-label="Repositories workspace">
              <div class="repositories-tabbar">
                <Tabs
                  tabs={tabLabels.length > 0 ? tabLabels : ["REPOSITORIES"]}
                  value={activeIndex}
                  previewIndex={previewIndex >= 0 ? previewIndex : undefined}
                  onChange={(index) => {
                    const tab = tabs[index];
                    if (tab) {
                      setActiveTabId(tab.id);
                    }
                  }}
                  onClose={tabs.length > 1 ? (index) => {
                    const tab = tabs[index];
                    if (tab) {
                      closeTabNow(tab.id);
                    }
                  } : undefined}
                />
              </div>
              {!activeTab ? (
                <Surface class="repositories-tab-panel" flush>
                  <RepositoriesStateMessage kind="empty" title="NO REPOSITORY TAB" detail="Select a repository to open a browser tab." />
                </Surface>
              ) : activeBrowserTab ? (
                <BrowserTabView
                  connected={connected}
                  repo={activeRepo}
                  tab={activeBrowserTab}
                  payload={readPayload}
                  isLoading={readQuery.isLoading}
                  isFetching={readQuery.isFetching}
                  queryError={queryErrorText(readQuery.error)}
                  searchPayload={searchResult.data}
                  searchLoading={searchResult.isLoading}
                  searchError={queryErrorText(searchResult.error)}
                  onNavigate={(path) => navigateBrowserTab(activeBrowserTab, path)}
                  onSearchInputChange={(commandInput) => updateBrowserTab(activeBrowserTab.id, (tab) => ({
                    ...tab,
                    commandInput,
                    searchQuery: commandInput.trim() ? tab.searchQuery : "",
                  }))}
                  onSearchSubmit={(value) => updateBrowserTab(activeBrowserTab.id, (tab) => ({
                    ...tab,
                    searchQuery: value.trim(),
                  }))}
                  onOpenFile={(path, preview) => openFileTab(activeBrowserTab.repo, activeBrowserTab.ref, path, preview)}
                  onOpenFileInNewTab={(path) => openFileTab(activeBrowserTab.repo, activeBrowserTab.ref, path)}
                  onOpenHistory={() => openHistoryTab(activeBrowserTab.repo, activeBrowserTab.ref)}
                  onOpenCompare={() => openCompareTab(activeBrowserTab.repo, activeBrowserTab.ref)}
                  onRefresh={() => {
                    void readQuery.refetch();
                  }}
                  onSearchRetry={() => {
                    void searchResult.refetch();
                  }}
                />
              ) : activeFileTab ? (
                <FileTabView
                  connected={connected}
                  repo={activeRepo}
                  tab={activeFileTab}
                  payload={readPayload}
                  isLoading={readQuery.isLoading}
                  isFetching={readQuery.isFetching}
                  queryError={queryErrorText(readQuery.error)}
                  onRefresh={() => {
                    void readQuery.refetch();
                  }}
                  onNavigate={(path) => {
                    const repo = repos.find((summary) => summary.repo === activeFileTab.repo);
                    if (repo) {
                      focusOrOpenBrowserTab(repo, activeFileTab.ref, path);
                    }
                  }}
                />
              ) : activeHistoryTab ? (
                <HistoryTabView
                  connected={connected}
                  repo={activeRepo}
                  tab={activeHistoryTab}
                  page={commitsQuery.data}
                  isLoading={commitsQuery.isLoading}
                  isFetching={commitsQuery.isFetching}
                  queryError={queryErrorText(commitsQuery.error)}
                  onRefresh={() => {
                    void commitsQuery.refetch();
                  }}
                  onSelectCommit={(commit) => openCommitTab(activeHistoryTab.repo, activeHistoryTab.ref, commit)}
                  onOffsetChange={(offset) => updateHistoryTab(activeHistoryTab.id, (tab) => ({ ...tab, offset }))}
                />
              ) : activeCommitTab ? (
                <CommitTabView
                  connected={connected}
                  tab={activeCommitTab}
                  commit={knownCommits[activeCommitTab.commit] ?? null}
                  diff={diffQuery.data}
                  isLoading={diffQuery.isLoading}
                  isFetching={diffQuery.isFetching}
                  queryError={queryErrorText(diffQuery.error)}
                  onOpenHistory={() => openHistoryTab(activeCommitTab.repo, activeCommitTab.ref)}
                  onRefresh={() => {
                    void diffQuery.refetch();
                  }}
                />
              ) : activeCompareTab ? (
                <CompareTabView
                  connected={connected}
                  tab={activeCompareTab}
                  refOptions={refOptions}
                  comparison={compareQuery.data}
                  isLoading={compareQuery.isLoading}
                  isFetching={compareQuery.isFetching}
                  queryError={queryErrorText(compareQuery.error)}
                  onChange={(base, head) => updateCompareTab(activeCompareTab, base, head)}
                  onRefresh={() => {
                    void compareQuery.refetch();
                  }}
                />
              ) : null}
            </section>
          </div>
        )}
      />
    </ConsolePage>
  );
}
