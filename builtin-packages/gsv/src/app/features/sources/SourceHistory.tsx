import { ActionButton } from "../../components/ui/ActionButton";
import {
  diffStatusLabel,
  diffStatusTone,
  prefixForDiffLine,
} from "./sources-domain";
import type {
  SourceCommit,
  SourceDiffFile,
  SourceDiffResult,
} from "./types";
import type { SourcesRuntime } from "./useSources";
import { firstLine, formatRelativeTime, shortHash } from "../../utils/format";
import { SourcePill } from "./SourceChrome";

export function HistoryPane({ runtime }: { runtime: SourcesRuntime }) {
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
      <ActionButton
        icon="chevron-left"
        label="Previous"
        disabled={runtime.historyBusy || !page || page.offset <= 0}
        onClick={() => void runtime.previousCommitPage()}
      />
      <span>Page {pageNumber}</span>
      <ActionButton
        icon="chevron-right"
        label="Next"
        disabled={runtime.historyBusy || !page?.hasNextPage}
        onClick={() => void runtime.nextCommitPage()}
      />
    </div>
  );
}

function CommitDetailPage({ runtime }: { runtime: SourcesRuntime }) {
  const commit = runtime.selectedCommit;
  const commitHash = runtime.selectedCommitHash;
  return (
    <article class="gsv-source-commit-detail" aria-label="Commit changes">
      <header>
        <ActionButton icon="arrow-left" label="Commits" onClick={runtime.closeCommit} />
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
