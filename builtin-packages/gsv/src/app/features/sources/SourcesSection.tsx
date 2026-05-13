import type { ComponentChildren } from "preact";
import type { GsvBackend } from "../../backend-contract";
import type { PackagesRouteView } from "../../navigation/route-state";
import {
  buildBreadcrumbs,
  diffStatusLabel,
  diffStatusTone,
  fileLanguageLabel,
  highlightLine,
  prefixForDiffLine,
  repoKindLabel,
  repoKindTone,
  sortTreeEntries,
  sourceModeLabel,
} from "./sources-domain";
import type {
  SourceCommit,
  SourceDiffFile,
  SourceDiffResult,
  SourceLinkedPackage,
  SourceReadResult,
  SourceRepoRecord,
  SourceSearchMatch,
  SourceTreeEntry,
} from "./types";
import { useSources, type SourcesRuntime } from "./useSources";
import {
  firstLine,
  formatBytes,
  formatRelativeTime,
  shortHash,
} from "../../utils/format";

export function SourcesSection({
  backend,
  onOpenPackage,
}: {
  backend: GsvBackend;
  onOpenPackage?: (packageId: string, view?: PackagesRouteView) => void;
}) {
  const runtime = useSources(backend);

  return (
    <section class="gsv-sources">
      <RepoSidebar runtime={runtime} />
      <RepoWorkspace runtime={runtime} onOpenPackage={onOpenPackage} />
    </section>
  );
}

function RepoSidebar({ runtime }: { runtime: SourcesRuntime }) {
  return (
    <aside class="gsv-sources-sidebar" aria-label="Repositories">
      <header class="gsv-source-sidebar-head">
        <div>
          <span class="gsv-kicker">Sources</span>
          <h3>Repositories</h3>
        </div>
        <button
          type="button"
          class="gsv-mini-button"
          disabled={runtime.loading || runtime.pendingAction !== null}
          onClick={() => void runtime.refresh()}
        >
          Refresh
        </button>
      </header>

      <label class="gsv-source-filter">
        <span>Find a repository</span>
        <input
          type="search"
          value={runtime.query}
          placeholder="owner, repo, package"
          onInput={(event) => runtime.setQuery((event.currentTarget as HTMLInputElement).value)}
        />
      </label>

      <CreateRepoForm runtime={runtime} />

      <div class="gsv-source-repo-list">
        {runtime.loading && !runtime.state ? (
          <div class="gsv-empty-state">Loading repositories...</div>
        ) : runtime.visibleRepos.length === 0 ? (
          <div class="gsv-empty-state">No visible repositories match this filter.</div>
        ) : (
          runtime.visibleRepos.map((repo) => (
            <RepoRow
              key={repo.repo}
              repo={repo}
              selected={runtime.selectedRepo?.repo === repo.repo}
              onSelect={() => void runtime.selectRepo(repo.repo)}
            />
          ))
        )}
      </div>
    </aside>
  );
}

function CreateRepoForm({ runtime }: { runtime: SourcesRuntime }) {
  const form = runtime.createForm;
  const disabled = runtime.pendingAction !== null || !form.owner.trim() || !form.name.trim();
  return (
    <form
      class="gsv-source-create"
      onSubmit={(event) => {
        event.preventDefault();
        void runtime.createRepo();
      }}
    >
      <details>
        <summary>New repository</summary>
        <div class="gsv-source-create-grid">
          <label>
            <span>Owner</span>
            <input
              value={form.owner}
              placeholder="owner"
              onInput={(event) => {
                const value = (event.currentTarget as HTMLInputElement).value;
                runtime.setCreateForm((current) => ({ ...current, owner: value }));
              }}
            />
          </label>
          <label>
            <span>Name</span>
            <input
              value={form.name}
              placeholder="repo"
              onInput={(event) => {
                const value = (event.currentTarget as HTMLInputElement).value;
                runtime.setCreateForm((current) => ({ ...current, name: value }));
              }}
            />
          </label>
          <label>
            <span>Branch</span>
            <input
              value={form.ref}
              placeholder="main"
              onInput={(event) => {
                const value = (event.currentTarget as HTMLInputElement).value;
                runtime.setCreateForm((current) => ({ ...current, ref: value }));
              }}
            />
          </label>
          <label class="is-wide">
            <span>Description</span>
            <input
              value={form.description}
              placeholder="Optional"
              onInput={(event) => {
                const value = (event.currentTarget as HTMLInputElement).value;
                runtime.setCreateForm((current) => ({ ...current, description: value }));
              }}
            />
          </label>
          <button type="submit" class="gsv-action-button is-primary is-wide" disabled={disabled}>
            {runtime.pendingAction === "source:create" ? "Creating" : "Create repository"}
          </button>
        </div>
      </details>
    </form>
  );
}

function RepoRow({
  repo,
  selected,
  onSelect,
}: {
  repo: SourceRepoRecord;
  selected: boolean;
  onSelect(): void;
}) {
  return (
    <button
      type="button"
      class={`gsv-source-repo-row${selected ? " is-selected" : ""}`}
      onClick={onSelect}
    >
      <span class="gsv-source-repo-title">
        <strong><span>{repo.owner}</span> / {repo.name}</strong>
        <span>{repo.description || repo.linkedPackages.map((pkg) => pkg.name).join(", ") || "No description"}</span>
      </span>
      <span class="gsv-source-repo-meta">
        <SourcePill className={repoKindTone(repo.kind)}>{repoKindLabel(repo.kind)}</SourcePill>
        <SourcePill>{repo.public ? "Public" : "Private"}</SourcePill>
        {repo.writable ? <SourcePill>Writable</SourcePill> : null}
      </span>
    </button>
  );
}

function RepoWorkspace({
  runtime,
  onOpenPackage,
}: {
  runtime: SourcesRuntime;
  onOpenPackage?: (packageId: string, view?: PackagesRouteView) => void;
}) {
  const repo = runtime.selectedRepo;
  if (!repo) {
    return (
      <section class="gsv-source-workspace">
        <div class="gsv-empty-state">
          <h3>No repository selected</h3>
          <p>Visible ripgit repositories will appear here when the gateway knows about them.</p>
        </div>
      </section>
    );
  }

  const refs = runtime.state?.refs;
  const refOptions = refs ? [
    ...Object.keys(refs.heads).sort((left, right) => left.localeCompare(right)),
    ...Object.keys(refs.tags).sort((left, right) => left.localeCompare(right)),
  ] : [runtime.ref || "main"];
  const pullAction = `source:pull:${repo.repo}`;
  const publicAction = `source:public:${repo.repo}`;

  return (
    <section class="gsv-source-workspace" aria-label={`${repo.repo} source repository`}>
      <header class="gsv-source-repo-head">
        <div class="gsv-source-repo-identity">
          <span class="gsv-source-repo-icon"><SourceIcon name="repo" /></span>
          <div>
            <span class="gsv-kicker">{repoKindLabel(repo.kind)}</span>
            <h3><span>{repo.owner}</span> / {repo.name}</h3>
            <p>{repo.description || repo.linkedPackages.map((pkg) => pkg.name).join(", ") || "Ripgit repository"}</p>
          </div>
        </div>
        <div class="gsv-source-actions">
          <button
            type="button"
            class="gsv-action-button"
            disabled={!repo.writable || runtime.pendingAction !== null}
            onClick={() => void runtime.pullRepo()}
          >
            {runtime.pendingAction === pullAction ? "Pulling" : "Pull upstream"}
          </button>
          <button
            type="button"
            class="gsv-action-button"
            disabled={!repo.writable || runtime.pendingAction !== null}
            onClick={() => void runtime.setRepoPublic(!repo.public)}
          >
            {runtime.pendingAction === publicAction ? "Updating" : repo.public ? "Make private" : "Publish"}
          </button>
        </div>
      </header>

      <div class="gsv-source-repo-badges">
        <SourcePill className={repoKindTone(repo.kind)}>{repoKindLabel(repo.kind)}</SourcePill>
        <SourcePill>{repo.public ? "Public" : "Private"}</SourcePill>
        <SourcePill>{repo.writable ? "Writable" : "Read only"}</SourcePill>
        {repo.updatedAt ? <SourcePill>Updated {formatRelativeTime(repo.updatedAt)}</SourcePill> : null}
      </div>

      {repo.linkedPackages.length > 0 ? (
        <div class="gsv-source-package-links" aria-label="Linked packages">
          {repo.linkedPackages.map((pkg) => (
            <LinkedPackageChip key={pkg.packageId} pkg={pkg} onOpenPackage={onOpenPackage} />
          ))}
        </div>
      ) : null}

      {runtime.error ? <p class="gsv-inline-error">{runtime.error}</p> : null}
      {runtime.notice ? <p class="gsv-inline-status">{runtime.notice}</p> : null}

      <nav class="gsv-source-tabs" aria-label="Repository views">
        {(["code", "history"] as const).map((mode) => (
          <button
            type="button"
            key={mode}
            class={runtime.mode === mode ? "is-active" : ""}
            onClick={() => runtime.setMode(mode)}
          >
            {sourceModeLabel(mode)}
          </button>
        ))}
      </nav>

      <section class="gsv-source-browser">
        {runtime.mode === "history" ? (
          <HistoryPane runtime={runtime} />
        ) : (
          <div class="gsv-source-code-pane">
            <RepoToolbar runtime={runtime} refOptions={refOptions} />
            <SearchResults runtime={runtime} />
            <ReadPanel runtime={runtime} read={runtime.state?.read ?? null} />
          </div>
        )}
      </section>
    </section>
  );
}

function LinkedPackageChip({
  pkg,
  onOpenPackage,
}: {
  pkg: SourceLinkedPackage;
  onOpenPackage?: (packageId: string, view?: PackagesRouteView) => void;
}) {
  const view: PackagesRouteView = pkg.reviewPending ? "review" : "inventory";
  return (
    <button
      type="button"
      class="gsv-source-package-chip"
      onClick={() => onOpenPackage?.(pkg.packageId, view)}
      disabled={!onOpenPackage}
    >
      <SourceIcon name="package" />
      {pkg.name}
      {pkg.subdir && pkg.subdir !== "." ? <small>{pkg.subdir}</small> : null}
      {pkg.reviewPending ? <small>review</small> : null}
    </button>
  );
}

function RepoToolbar({ runtime, refOptions }: { runtime: SourcesRuntime; refOptions: string[] }) {
  const currentCommit = currentRefCommit(runtime);
  const currentHash = currentCommit?.hash ?? currentRefHash(runtime);
  return (
    <header class="gsv-source-toolbar">
      <div class="gsv-source-ref-row">
        <label>
          <span>Branch or tag</span>
          <select
            value={runtime.ref}
            disabled={runtime.loading}
            onChange={(event) => void runtime.selectRef((event.currentTarget as HTMLSelectElement).value)}
          >
            {refOptions.map((ref) => <option key={ref} value={ref}>{ref}</option>)}
          </select>
        </label>
        <form
          class="gsv-source-search"
          onSubmit={(event) => {
            event.preventDefault();
            void runtime.runSearch();
          }}
        >
          <input
            type="search"
            value={runtime.searchQuery}
            placeholder="Search this repository"
            onInput={(event) => runtime.setSearchQuery((event.currentTarget as HTMLInputElement).value)}
          />
          <button type="submit" class="gsv-mini-button" disabled={runtime.searchBusy || !runtime.searchQuery.trim()}>
            {runtime.searchBusy ? "Searching" : "Search"}
          </button>
        </form>
      </div>
      {currentHash ? (
        <button
          type="button"
          class="gsv-source-current-commit"
          onClick={() => void runtime.selectCommit(currentHash)}
        >
          <span>
            <strong>{currentCommit ? firstLine(currentCommit.message) : `Current ${runtime.ref || "main"}`}</strong>
            <small>{currentCommit?.author || "unknown"} - {formatRelativeTime(currentCommit?.commitTime)}</small>
          </span>
          <code>{shortHash(currentHash)}</code>
        </button>
      ) : null}
      <nav class="gsv-source-breadcrumbs" aria-label="Repository path">
        <button type="button" onClick={() => void runtime.openPath("")}>
          <SourceIcon name="repo" />
          Code
        </button>
        {buildBreadcrumbs(runtime.path).map((crumb) => (
          <button type="button" key={crumb.path} onClick={() => void runtime.openPath(crumb.path)}>
            {crumb.label}
          </button>
        ))}
      </nav>
    </header>
  );
}

function ReadPanel({ runtime, read }: { runtime: SourcesRuntime; read: SourceReadResult | null }) {
  if (runtime.loading && !read) {
    return <div class="gsv-empty-state">Loading source...</div>;
  }
  if (!read) {
    return <div class="gsv-empty-state">Select a repository path to browse files.</div>;
  }
  if (read.kind === "tree") {
    return <TreeView entries={read.entries} onOpenPath={runtime.openPath} />;
  }
  return <FileView read={read} onOpenParent={runtime.openParent} />;
}

function TreeView({
  entries,
  onOpenPath,
}: {
  entries: SourceTreeEntry[];
  onOpenPath(path: string): Promise<void>;
}) {
  const sorted = sortTreeEntries(entries);
  return (
    <section class="gsv-source-tree" aria-label="Repository files">
      <div class="gsv-source-tree-head">
        <span>Name</span>
        <span>Mode</span>
        <span>Object</span>
      </div>
      {sorted.length === 0 ? <div class="gsv-empty-state">This directory is empty.</div> : sorted.map((entry) => (
        <button
          type="button"
          class="gsv-source-tree-row"
          key={entry.path}
          onClick={() => void onOpenPath(entry.path)}
        >
          <span class="gsv-source-file-label">
            <SourceIcon name={entry.type === "tree" ? "folder" : "file"} />
            <strong>{entry.name}</strong>
          </span>
          <span>{entry.mode || "-"}</span>
          <span>{shortHash(entry.hash)}</span>
        </button>
      ))}
    </section>
  );
}

function FileView({ read, onOpenParent }: { read: Extract<SourceReadResult, { kind: "file" }>; onOpenParent(): Promise<void> }) {
  return (
    <article class="gsv-source-file">
      <header>
        <div>
          <strong class="gsv-source-file-label">
            <SourceIcon name="file" />
            {read.path || "/"}
          </strong>
          <span>{formatBytes(read.size)} - {read.isBinary ? "Binary" : fileLanguageLabel(read.path)}</span>
        </div>
        <button type="button" class="gsv-mini-button" onClick={() => void onOpenParent()}>Directory</button>
      </header>
      {read.isBinary ? (
        <div class="gsv-empty-state">This file is binary and cannot be previewed inline.</div>
      ) : (
        <CodeBlock path={read.path} content={read.content ?? ""} />
      )}
    </article>
  );
}

function SearchResults({ runtime }: { runtime: SourcesRuntime }) {
  const result = runtime.searchResult;
  if (!result) {
    return null;
  }
  const groups = groupSearchMatches(result.matches);
  return (
    <section class="gsv-source-search-results">
      <header>
        <strong>Search results</strong>
        <span>{result.matches.length} matches in {groups.length} files</span>
      </header>
      {result?.truncated ? <p class="gsv-runtime-meta">Search results were truncated.</p> : null}
      {result.matches.length === 0 ? (
        <div class="gsv-empty-state">No source matches found.</div>
      ) : (
        groups.map((group) => (
          <button
            type="button"
            class="gsv-source-search-file"
            key={group.path}
            onClick={() => void runtime.openPath(group.path)}
          >
            <header>
              <strong>{group.path}</strong>
              <span>{group.matches.length} match{group.matches.length === 1 ? "" : "es"}</span>
            </header>
            {group.matches.slice(0, 4).map((match) => (
              <code key={`${match.line}:${match.content}`}>
                <span>{match.line}</span>
                <span>{match.content}</span>
              </code>
            ))}
            {group.matches.length > 4 ? <small>{group.matches.length - 4} more matches</small> : null}
          </button>
        ))
      )}
    </section>
  );
}

function HistoryPane({ runtime }: { runtime: SourcesRuntime }) {
  const page = runtime.commitsPage;
  const commits = page?.commits ?? runtime.state?.commits ?? [];
  if (runtime.selectedCommitHash) {
    return <CommitDetailPage runtime={runtime} />;
  }
  const start = commits.length > 0 ? (page?.offset ?? 0) + 1 : 0;
  const end = (page?.offset ?? 0) + commits.length;
  return (
    <aside class="gsv-source-history" aria-label="Repository history">
      <header>
        <div>
          <span class="gsv-kicker">History</span>
          <h4>Commits</h4>
        </div>
        <span>{commits.length > 0 ? `${start}-${end}` : "No commits"}</span>
      </header>
      <HistoryPager runtime={runtime} />
      {runtime.historyBusy ? <div class="gsv-empty-state">Loading commits...</div> : null}
      <div class="gsv-source-commit-list">
        {commits.length === 0 ? <div class="gsv-empty-state">No commit history available.</div> : commits.map((commit) => (
          <CommitRow
            key={commit.hash}
            commit={commit}
            selected={runtime.selectedCommitHash === commit.hash}
            onSelect={() => void runtime.selectCommit(commit.hash)}
          />
        ))}
      </div>
      <HistoryPager runtime={runtime} />
    </aside>
  );
}

function HistoryPager({ runtime }: { runtime: SourcesRuntime }) {
  const page = runtime.commitsPage;
  const pageNumber = page ? Math.floor(page.offset / page.limit) + 1 : 1;
  return (
    <div class="gsv-source-history-pager">
      <button
        type="button"
        class="gsv-mini-button"
        disabled={runtime.historyBusy || !page || page.offset <= 0}
        onClick={() => void runtime.previousCommitPage()}
      >
        Previous
      </button>
      <span>Page {pageNumber}</span>
      <button
        type="button"
        class="gsv-mini-button"
        disabled={runtime.historyBusy || !page?.hasNextPage}
        onClick={() => void runtime.nextCommitPage()}
      >
        Next
      </button>
    </div>
  );
}

function CommitDetailPage({ runtime }: { runtime: SourcesRuntime }) {
  const commit = runtime.selectedCommit;
  const commitHash = runtime.selectedCommitHash;
  return (
    <article class="gsv-source-commit-detail" aria-label="Commit changes">
      <header>
        <button type="button" class="gsv-source-back-button" onClick={runtime.closeCommit}>
          Back to commits
        </button>
        <div>
          <span class="gsv-kicker">Commit</span>
          <h4>{commit ? firstLine(commit.message) : shortHash(commitHash)}</h4>
          <p>
            {commit?.author || "unknown"} - {formatRelativeTime(commit?.commitTime)}
            {commitHash ? ` - ${shortHash(commitHash)}` : ""}
          </p>
        </div>
      </header>
      {runtime.diffBusy ? <div class="gsv-empty-state">Loading diff...</div> : null}
      {runtime.diffError ? <p class="gsv-inline-error">{runtime.diffError}</p> : null}
      {runtime.diffResult ? <DiffView diff={runtime.diffResult} /> : null}
    </article>
  );
}

function CommitRow({
  commit,
  selected,
  onSelect,
}: {
  commit: SourceCommit;
  selected: boolean;
  onSelect(): void;
}) {
  return (
    <button
      type="button"
      class={`gsv-source-commit-row${selected ? " is-selected" : ""}`}
      onClick={onSelect}
    >
      <strong>{firstLine(commit.message)}</strong>
      <span>{commit.author || "unknown"} - {formatRelativeTime(commit.commitTime)}</span>
      <code>{shortHash(commit.hash)}</code>
    </button>
  );
}

function DiffView({ diff }: { diff: SourceDiffResult }) {
  return (
    <section class="gsv-source-diff">
      <header>
        <strong>{shortHash(diff.commitHash)}</strong>
        <span>{diff.stats.filesChanged} files, +{diff.stats.additions} -{diff.stats.deletions}</span>
      </header>
      {diff.files.length === 0 ? <div class="gsv-empty-state">No changed files in this diff.</div> : null}
      {diff.files.map((file) => <DiffFile key={`${diff.commitHash}:${file.path}`} file={file} />)}
    </section>
  );
}

function DiffFile({ file }: { file: SourceDiffFile }) {
  return (
    <article class="gsv-source-diff-file">
      <header>
        <strong>{file.path}</strong>
        <SourcePill className={diffStatusTone(file.status)}>{diffStatusLabel(file.status)}</SourcePill>
      </header>
      {file.hunks && file.hunks.length > 0 ? file.hunks.map((hunk) => (
        <section class="gsv-source-diff-hunk" key={`${file.path}:${hunk.oldStart}:${hunk.newStart}`}>
          <div class="gsv-source-diff-hunk-head">@@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@</div>
          <div class="gsv-source-diff-lines">
            {hunk.lines.map((line, index) => (
              <code key={index} class={`gsv-source-diff-line is-${line.tag}`}>
                <span>{prefixForDiffLine(line.tag)}</span>
                <span>{line.content}</span>
              </code>
            ))}
          </div>
        </section>
      )) : <div class="gsv-empty-state">No text hunks available for this file.</div>}
    </article>
  );
}

function CodeBlock({ path, content }: { path: string; content: string }) {
  const lines = content.length > 0
    ? (content.endsWith("\n") ? content.slice(0, -1) : content).split("\n")
    : [""];
  return (
    <div class="gsv-source-code-block" role="region" aria-label={path || "source file"}>
      {lines.map((line, index) => (
        <code key={index} class="gsv-source-code-line">
          <span class="gsv-source-code-line-number">{index + 1}</span>
          <span class="gsv-source-code-line-content">
            {highlightLine(path, line).map((token, tokenIndex) => (
              <span key={tokenIndex} class={token.className}>{token.text}</span>
            ))}
          </span>
        </code>
      ))}
    </div>
  );
}

function SourcePill({ children, className = "" }: { children: ComponentChildren; className?: string }) {
  return <span class={`gsv-source-pill ${className}`}>{children}</span>;
}

function SourceIcon({ name }: { name: "repo" | "folder" | "file" | "package" }) {
  if (name === "repo") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h7l3.5 3.5v13.5h-12a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Z"></path><path d="M14 3.5V7h3.5"></path><path d="M8 12h6"></path><path d="M8 15.5h8"></path></svg>;
  }
  if (name === "folder") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5h6l2 2h9v7.5a2 2 0 0 1-2 2h-15z"></path><path d="M3.5 7.5v-1a1.5 1.5 0 0 1 1.5-1.5h4l2 2"></path></svg>;
  }
  if (name === "package") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9Z"></path><path d="m4 7.5 8 4.5 8-4.5"></path><path d="M12 12v9"></path></svg>;
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h7l3 3V20a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"></path><path d="M14 3.5V7h3"></path></svg>;
}

function currentRefHash(runtime: SourcesRuntime): string | null {
  const refs = runtime.state?.refs;
  if (!refs) return null;
  return refs.heads[runtime.ref] ?? refs.tags[runtime.ref] ?? null;
}

function currentRefCommit(runtime: SourcesRuntime): SourceCommit | null {
  const hash = currentRefHash(runtime);
  if (!hash) return runtime.state?.commits[0] ?? null;
  return runtime.state?.commits.find((commit) => commit.hash === hash) ?? runtime.state?.commits[0] ?? null;
}

function groupSearchMatches(matches: SourceSearchMatch[]): Array<{ path: string; matches: SourceSearchMatch[] }> {
  const groups = new Map<string, SourceSearchMatch[]>();
  for (const match of matches) {
    const group = groups.get(match.path) ?? [];
    group.push(match);
    groups.set(match.path, group);
  }
  return [...groups.entries()]
    .map(([path, group]) => ({
      path,
      matches: group.sort((left, right) => left.line - right.line),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}
