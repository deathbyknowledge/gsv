import { ActionButton } from "../../components/ui/ActionButton";
import {
  buildBreadcrumbs,
  fileLanguageLabel,
  highlightLine,
  sortTreeEntries,
} from "./sources-domain";
import type {
  SourceCommit,
  SourceReadResult,
  SourceSearchMatch,
  SourceTreeEntry,
} from "./types";
import type { SourcesRuntime } from "./useSources";
import {
  firstLine,
  formatBytes,
  formatRelativeTime,
  shortHash,
} from "../../utils/format";
import { SourceIcon } from "./SourceChrome";

export function SourceCodePane({ runtime, refOptions }: { runtime: SourcesRuntime; refOptions: string[] }) {
  return (
    <div class="gsv-source-code-pane">
      <RepoToolbar runtime={runtime} refOptions={refOptions} />
      <SearchResults runtime={runtime} />
      <ReadPanel runtime={runtime} read={runtime.state?.read ?? null} />
    </div>
  );
}

function RepoToolbar({ runtime, refOptions }: { runtime: SourcesRuntime; refOptions: string[] }) {
  const currentCommit = currentRefCommit(runtime);
  const currentHash = currentCommit?.hash ?? currentRefHash(runtime);
  return (
    <header class="gsv-source-toolbar">
      <div class="gsv-source-ref-row">
        <label>
          <span>Ref</span>
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
          <ActionButton
            icon="search"
            label="Search"
            busyLabel="Searching"
            busy={runtime.searchBusy}
            disabled={!runtime.searchQuery.trim()}
            type="submit"
          />
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
        <ActionButton icon="folder" label="Directory" onClick={() => void onOpenParent()} />
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

function currentRefHash(runtime: SourcesRuntime): string | null {
  const refs = runtime.state?.refs;
  if (!refs) return null;
  const remoteRef = runtime.ref.startsWith("refs/remotes/")
    ? runtime.ref.slice("refs/remotes/".length)
    : runtime.ref;
  return refs.heads[runtime.ref] ?? refs.tags[runtime.ref] ?? refs.remotes?.[remoteRef] ?? null;
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
