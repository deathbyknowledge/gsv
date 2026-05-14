import { ActionButton } from "../../components/ui/ActionButton";
import { repoDescription, repoKindLabel, repoKindTone } from "./sources-domain";
import type { SourceRepoRecord } from "./types";
import type { SourcesRuntime } from "./useSources";
import { SourcePill } from "./SourceChrome";

export function RepoSidebar({ runtime }: { runtime: SourcesRuntime }) {
  return (
    <aside class="gsv-sources-sidebar" aria-label="Repositories">
      <header class="gsv-source-sidebar-head">
        <div>
          <span class="gsv-kicker">Sources</span>
          <h3>Repositories</h3>
        </div>
        <ActionButton
          icon="refresh"
          label="Refresh"
          size="icon"
          disabled={runtime.loading || runtime.pendingAction !== null}
          onClick={() => void runtime.refresh()}
        />
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
          <ActionButton
            class="is-wide"
            icon="package"
            label="Create repository"
            busyLabel="Creating"
            busy={runtime.pendingAction === "source:create"}
            variant="primary"
            disabled={disabled}
            type="submit"
          />
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
        <span>{repoDescription(repo)}</span>
      </span>
      <span class="gsv-source-repo-meta">
        <SourcePill className={repoKindTone(repo.kind)}>{repoKindLabel(repo.kind)}</SourcePill>
        <SourcePill>{repo.public ? "Public" : "Private"}</SourcePill>
        {repo.writable ? <SourcePill>Writable</SourcePill> : null}
      </span>
    </button>
  );
}
