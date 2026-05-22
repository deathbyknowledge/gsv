import { ActionButton } from "../../components/ui/ActionButton";
import type { PackagesRouteView } from "../../navigation/route-state";
import { formatRelativeTime } from "../../utils/format";
import { SourceCodePane } from "./SourceCodeBrowser";
import { SourceIcon, SourcePill } from "./SourceChrome";
import { HistoryPane } from "./SourceHistory";
import { repoDescription, repoKindLabel, repoKindTone, sourceModeLabel } from "./sources-domain";
import type { SourceLinkedPackage } from "./types";
import type { SourcesRuntime } from "./useSources";

export function RepoWorkspace({
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
        <header class="gsv-source-repo-head">
          <ActionButton icon="arrow-left" label="Repositories" onClick={() => void runtime.showRepositoryList()} />
        </header>
        <div class="gsv-empty-state">
          <h3>{runtime.loading ? "Loading repository" : "Repository not found"}</h3>
          <p>{runtime.loading ? "Opening the requested source repository." : "Return to the repository list and choose another source."}</p>
        </div>
      </section>
    );
  }

  const refs = runtime.state?.refs;
  const refOptions = refs ? [
    ...Object.keys(refs.heads).sort((left, right) => left.localeCompare(right)),
    ...Object.keys(refs.tags).sort((left, right) => left.localeCompare(right)),
    ...Object.keys(refs.remotes ?? {})
      .sort((left, right) => left.localeCompare(right))
      .map((remote) => `refs/remotes/${remote}`),
  ] : [runtime.ref || "main"];
  const pullAction = `source:pull:${repo.repo}`;
  const publicAction = `source:public:${repo.repo}`;

  return (
    <section class="gsv-source-workspace" aria-label={`${repo.repo} source repository`}>
      <header class="gsv-source-repo-head">
        <div class="gsv-source-repo-identity">
          <ActionButton icon="arrow-left" label="Repositories" onClick={() => void runtime.showRepositoryList()} />
          <span class="gsv-source-repo-icon"><SourceIcon name="repo" /></span>
          <div>
            <span class="gsv-kicker">{repoKindLabel(repo.kind)}</span>
            <h3><span>{repo.owner}</span> / {repo.name}</h3>
            <p>{repoDescription(repo)}</p>
          </div>
        </div>
        <div class="gsv-source-actions">
          <ActionButton
            icon="refresh"
            label="Pull"
            busyLabel="Pulling"
            busy={runtime.pendingAction === pullAction}
            disabled={!repo.writable || runtime.pendingAction !== null}
            onClick={() => void runtime.pullRepo()}
          />
          <ActionButton
            icon={repo.public ? "lock" : "external"}
            label={repo.public ? "Private" : "Publish"}
            busyLabel="Updating"
            busy={runtime.pendingAction === publicAction}
            disabled={!repo.writable || runtime.pendingAction !== null}
            onClick={() => void runtime.setRepoPublic(!repo.public)}
          />
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
          <SourceCodePane runtime={runtime} refOptions={refOptions} />
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
