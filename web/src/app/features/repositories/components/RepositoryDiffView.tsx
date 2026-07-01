import { Tag } from "../../../components/ui/Tag";
import type { RepositoryCompareResult, RepositoryDiffFile, RepositoryDiffResult } from "../domain/models";
import {
  diffStatusLabel,
  diffStatusTone,
  prefixForDiffLine,
  shortHash,
} from "../domain/presentation";

type RepositoryDiffViewProps = {
  diff: RepositoryDiffResult | RepositoryCompareResult;
  title: string;
};

export function RepositoryDiffView({ diff, title }: RepositoryDiffViewProps) {
  return (
    <section class="repositories-diff-view" aria-label={title}>
      <header class="repositories-diff-head">
        <div>
          <strong>{title}</strong>
          <span>{diff.stats.filesChanged} files, +{diff.stats.additions} -{diff.stats.deletions}</span>
        </div>
        {"commitHash" in diff ? (
          <Tag tone="idle" label={shortHash(diff.commitHash)} boxed />
        ) : (
          <Tag tone="idle" label={`${shortHash(diff.base)}...${shortHash(diff.head)}`} boxed />
        )}
      </header>
      {diff.files.length === 0 ? (
        <div class="repositories-empty-inline gsv-sublabel">NO CHANGED FILES</div>
      ) : diff.files.map((file) => (
        <DiffFile key={`${file.path}:${file.status}:${file.oldHash ?? ""}:${file.newHash ?? ""}`} file={file} />
      ))}
    </section>
  );
}

function DiffFile({ file }: { file: RepositoryDiffFile }) {
  return (
    <article class="repositories-diff-file">
      <header>
        <strong>{file.path}</strong>
        <Tag tone={diffStatusTone(file.status)} label={diffStatusLabel(file.status)} boxed />
      </header>
      {file.hunks.length === 0 ? (
        <div class="repositories-empty-inline gsv-sublabel">NO TEXT HUNKS AVAILABLE</div>
      ) : file.hunks.map((hunk) => (
        <section class="repositories-diff-hunk" key={`${file.path}:${hunk.oldStart}:${hunk.newStart}`}>
          <div class="repositories-diff-hunk-head">@@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@</div>
          <div class="repositories-diff-lines">
            {hunk.lines.map((line, index) => (
              <code key={`${index}:${line.tag}`} class={`repositories-diff-line is-${line.tag}`}>
                <span>{prefixForDiffLine(line.tag)}</span>
                <span>{line.content}</span>
              </code>
            ))}
          </div>
        </section>
      ))}
    </article>
  );
}
