import { openApp } from "@gsv/package/host";
import { useMemo, useState } from "preact/hooks";
import type { GsvBackend } from "../../backend-contract";
import { formatTimestampMs } from "../../utils/format";
import {
  buildPermissionSummary,
  catalogImportSource,
  catalogPackageCount,
  createRepoName,
  formatScope,
  formatRepoDisplay,
  matchInstalledPackage,
  packageActionLimitations,
  packageRiskDescription,
  packageRiskLabel,
  packageStatusLabel,
  packageStatusTone,
  packageSurfaceCounts,
  sourceSummary,
  viewDescription,
  viewTitle,
} from "./packages-domain";
import type {
  CatalogEntry,
  CatalogRecord,
  PackageCreateTemplate,
  PackageRecord,
  PackageScopeFilter,
  PackagesState,
  PackagesView,
} from "./types";
import { usePackages } from "./usePackages";
import type { PackagesRuntime } from "./usePackages";

const VIEWS: Array<{ id: PackagesView; label: string; count(runtime: PackagesRuntime): number }> = [
  { id: "discover", label: "Discover", count: (runtime) => catalogPackageCount(runtime.state) },
  { id: "create", label: "Create", count: () => 0 },
  { id: "remotes", label: "Remotes", count: (runtime) => (runtime.state?.catalogs ?? []).filter((catalog) => catalog.kind === "remote").length },
  { id: "inventory", label: "Inventory", count: (runtime) => runtime.state?.counts.installed ?? 0 },
  { id: "updates", label: "Updates", count: (runtime) => runtime.state?.counts.updates ?? 0 },
  { id: "review", label: "Review", count: (runtime) => runtime.state?.counts.review ?? 0 },
];

type CreatePackageForm = {
  repo: string;
  packageName: string;
  displayName: string;
  description: string;
  ref: string;
  subdir: string;
  template: PackageCreateTemplate;
  command: string;
  enable: boolean;
  overwrite: boolean;
};

const DEFAULT_CREATE_FORM: CreatePackageForm = {
  repo: "",
  packageName: "",
  displayName: "",
  description: "",
  ref: "main",
  subdir: ".",
  template: "web-ui",
  command: "",
  enable: true,
  overwrite: false,
};

export function PackagesSection({
  backend,
  onOpenSources,
}: {
  backend: GsvBackend;
  onOpenSources?: (repo: string, ref?: string, path?: string) => void;
}) {
  const runtime = usePackages(backend);
  const [selectedCatalogName, setSelectedCatalogName] = useState("");
  const selectedCatalog = useMemo(() => {
    const catalogs = runtime.state?.catalogs ?? [];
    return catalogs.find((catalog) => catalog.name === selectedCatalogName) ?? catalogs[0] ?? null;
  }, [runtime.state?.catalogs, selectedCatalogName]);

  return (
    <section class="gsv-packages">
      <div class="gsv-packages-list-pane">
        <section class="gsv-packages-toolbar">
          <div>
            <span class="gsv-kicker">Extensions</span>
            <h3>{viewTitle(runtime.view)}</h3>
            <p class="gsv-runtime-meta">{viewDescription(runtime.view)}</p>
          </div>
          <button
            type="button"
            class="gsv-mini-button"
            onClick={() => void runtime.refresh()}
            disabled={runtime.loading || runtime.pendingAction !== null}
          >
            Refresh
          </button>
          <button
            type="button"
            class="gsv-mini-button"
            onClick={() => void runtime.syncPackages()}
            disabled={runtime.loading || runtime.pendingAction !== null}
          >
            {runtime.pendingAction === "packages:sync" ? "Syncing" : "Sync"}
          </button>

          <div class="gsv-package-queues" aria-label="Package queues">
            {VIEWS.map((view) => (
              <button
                key={view.id}
                type="button"
                class={`gsv-package-queue-button${runtime.view === view.id ? " is-active" : ""}`}
                onClick={() => runtime.setView(view.id)}
              >
                <strong>{view.label}</strong>
                <span>{view.count(runtime)}</span>
              </button>
            ))}
          </div>

          <div class="gsv-package-filters">
            <label class="gsv-package-search">
              <span>Search</span>
              <input
                type="search"
                value={runtime.query}
                placeholder="Package, repo, syscall, binding"
                onInput={(event) => runtime.setQuery((event.currentTarget as HTMLInputElement).value)}
              />
            </label>
            <label>
              <span>Scope</span>
              <select
                value={runtime.scope}
                onChange={(event) => runtime.setScope((event.currentTarget as HTMLSelectElement).value as PackageScopeFilter)}
              >
                <option value="all">All</option>
                <option value="mine">Mine</option>
                <option value="system">System</option>
              </select>
            </label>
          </div>
        </section>

        {runtime.error ? <p class="gsv-inline-error">{runtime.error}</p> : null}
        {runtime.notice ? <p class="gsv-inline-status">{runtime.notice}</p> : null}

        <div class="gsv-package-list" aria-label="Packages">
          {runtime.loading ? (
            <div class="gsv-empty-state">Loading packages...</div>
          ) : runtime.visiblePackages.length === 0 ? (
            <div class="gsv-empty-state">No packages match this view.</div>
          ) : (
            runtime.visiblePackages.map((pkg) => (
              <PackageRow
                key={pkg.packageId}
                pkg={pkg}
                selected={runtime.selectedPackageId === pkg.packageId}
                viewerUsername={runtime.state?.viewer.username ?? ""}
                onSelect={() => runtime.selectPackage(pkg.packageId)}
              />
            ))
          )}
        </div>
      </div>

      {runtime.view === "discover" ? (
        <DiscoverPane
          runtime={runtime}
          selectedCatalog={selectedCatalog}
          onSelectCatalog={setSelectedCatalogName}
        />
      ) : runtime.view === "create" ? (
        <CreatePackagePane runtime={runtime} />
      ) : runtime.view === "remotes" ? (
        <CatalogRemotesPane
          runtime={runtime}
          onOpenCatalog={(catalogName) => {
            setSelectedCatalogName(catalogName);
            runtime.setView("discover");
          }}
        />
      ) : (
        <PackageDetail runtime={runtime} onOpenSources={onOpenSources} />
      )}
    </section>
  );
}

function PackageRow({
  pkg,
  selected,
  viewerUsername,
  onSelect,
}: {
  pkg: PackageRecord;
  selected: boolean;
  viewerUsername: string;
  onSelect(): void;
}) {
  return (
    <button
      type="button"
      class={`gsv-package-row${selected ? " is-selected" : ""}`}
      onClick={onSelect}
    >
      <span class="gsv-package-row-main">
        <span class="gsv-package-title">
          <strong>{pkg.name}</strong>
          <span>{pkg.description || "No description provided."}</span>
        </span>
        <span class="gsv-package-meta">
          <span>{sourceSummary(pkg, viewerUsername)}</span>
          <span>{formatScope(pkg)}</span>
        </span>
      </span>
      <span class="gsv-package-tags">
        <span class={`gsv-package-pill ${packageStatusTone(pkg)}`}>{packageStatusLabel(pkg)}</span>
        <span class="gsv-package-pill">{packageRiskLabel(pkg)}</span>
      </span>
    </button>
  );
}

function DiscoverPane({
  runtime,
  selectedCatalog,
  onSelectCatalog,
}: {
  runtime: PackagesRuntime;
  selectedCatalog: CatalogRecord | null;
  onSelectCatalog(catalogName: string): void;
}) {
  const [source, setSource] = useState("");
  const [ref, setRef] = useState("main");
  const [subdir, setSubdir] = useState(".");
  const busy = runtime.pendingAction !== null;
  const catalogs = runtime.state?.catalogs ?? [];
  const viewerUsername = runtime.state?.viewer.username ?? "";

  async function importSource(): Promise<void> {
    const imported = await runtime.importPackage({ source, ref, subdir });
    if (imported) {
      runtime.setView(imported.reviewPending ? "review" : "inventory");
    }
  }

  async function importCatalogEntry(catalog: CatalogRecord, entry: CatalogEntry): Promise<void> {
    const imported = await runtime.importPackage({
      source: catalogImportSource(catalog, entry),
      ref: entry.source.ref || "main",
      subdir: entry.source.subdir || ".",
    });
    if (imported) {
      runtime.setView(imported.reviewPending ? "review" : "inventory");
    }
  }

  return (
    <section class="gsv-package-detail" aria-label="Discover and import packages">
      <header class="gsv-package-detail-head">
        <div>
          <span class="gsv-kicker">Discover</span>
          <h3>Import packages</h3>
          <p>Install from shorthand, remote URL, local catalog, or configured remote catalog.</p>
        </div>
        <div class="gsv-package-tags">
          <span class="gsv-package-pill">{catalogPackageCount(runtime.state)} catalog packages</span>
        </div>
      </header>

      <div class="gsv-package-detail-body">
        <section class="gsv-package-panel">
          <header>
            <div>
              <h4>Import by source</h4>
              <p>Imported packages stay in the normal inventory and can be reviewed before enablement.</p>
            </div>
            <button
              type="button"
              class="gsv-action-button"
              disabled={busy || !source.trim()}
              onClick={() => void importSource()}
            >
              {runtime.pendingAction === "package:import" ? "Importing" : "Import"}
            </button>
          </header>
          <div class="gsv-package-filters">
            <label class="gsv-package-search">
              <span>Source</span>
              <input
                value={source}
                placeholder="owner/repo or https://example.com/repo.git"
                onInput={(event) => setSource((event.currentTarget as HTMLInputElement).value)}
              />
            </label>
            <label>
              <span>Ref</span>
              <input
                value={ref}
                placeholder="main"
                onInput={(event) => setRef((event.currentTarget as HTMLInputElement).value)}
              />
            </label>
            <label>
              <span>Subdir</span>
              <input
                value={subdir}
                placeholder="."
                onInput={(event) => setSubdir((event.currentTarget as HTMLInputElement).value)}
              />
            </label>
          </div>
        </section>

        <section class="gsv-package-panel">
          <header>
            <div>
              <h4>Catalogs</h4>
              <p>Public package metadata from this system and configured remotes.</p>
            </div>
            <div class="gsv-package-actions">
              {catalogs.map((catalog) => (
                <button
                  key={catalog.name}
                  type="button"
                  class="gsv-mini-button"
                  onClick={() => onSelectCatalog(catalog.name)}
                  disabled={selectedCatalog?.name === catalog.name}
                >
                  {catalog.kind === "local" ? "Local" : catalog.name}
                </button>
              ))}
            </div>
          </header>
          {selectedCatalog ? (
            <>
              <div class="gsv-summary-grid">
                <article class="gsv-info-box">
                  <span>Catalog</span>
                  <strong>{selectedCatalog.kind === "local" ? "Local" : selectedCatalog.name}</strong>
                </article>
                <article class="gsv-info-box">
                  <span>Packages</span>
                  <strong>{selectedCatalog.packages.length}</strong>
                </article>
                <article class="gsv-info-box">
                  <span>Base URL</span>
                  <strong>{selectedCatalog.baseUrl || "This system"}</strong>
                </article>
              </div>
              {selectedCatalog.error ? (
                <div class="gsv-empty-state">{selectedCatalog.error}</div>
              ) : selectedCatalog.packages.length === 0 ? (
                <div class="gsv-empty-state">No packages advertised by this catalog.</div>
              ) : (
                <div class="gsv-package-commit-list">
                  {selectedCatalog.packages.map((entry) => {
                    const installed = matchInstalledPackage(entry, runtime.state?.packages ?? []);
                    const actionId = "package:import";
                    return (
                      <div class="gsv-package-commit-row" key={`${entry.source.repo}:${entry.source.subdir}:${entry.name}`}>
                        <strong>{entry.name}</strong>
                        <span>{entry.description || formatRepoDisplay(entry.source.repo, viewerUsername)}</span>
                        <div class="gsv-package-actions">
                          {installed ? (
                            <button
                              type="button"
                              class="gsv-action-button"
                              onClick={() => {
                                runtime.selectPackage(installed.packageId);
                                runtime.setView(installed.reviewPending ? "review" : installed.updateAvailable ? "updates" : "inventory");
                              }}
                            >
                              Inspect
                            </button>
                          ) : null}
                          <button
                            type="button"
                            class="gsv-action-button"
                            disabled={busy}
                            onClick={() => void importCatalogEntry(selectedCatalog, entry)}
                          >
                            {runtime.pendingAction === actionId ? "Importing" : installed ? "Re-import" : "Import"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            <div class="gsv-empty-state">No catalogs configured.</div>
          )}
        </section>
      </div>
    </section>
  );
}

function CreatePackagePane({ runtime }: { runtime: PackagesRuntime }) {
  const [form, setForm] = useState<CreatePackageForm>(DEFAULT_CREATE_FORM);
  const owner = runtime.state?.viewer.username || "you";
  const busy = runtime.pendingAction !== null;

  function patchForm(patch: Partial<CreatePackageForm>): void {
    setForm((current) => ({ ...current, ...patch }));
  }

  async function createPackage(): Promise<void> {
    const result = await runtime.createPackage({
      repo: createRepoName(form.repo),
      ref: form.ref,
      subdir: form.subdir,
      name: form.packageName,
      displayName: form.displayName,
      description: form.description,
      template: form.template,
      command: form.command,
      enable: form.enable,
      overwrite: form.overwrite,
    });
    if (result) {
      runtime.setView("inventory");
    }
  }

  return (
    <section class="gsv-package-detail" aria-label="Create package">
      <header class="gsv-package-detail-head">
        <div>
          <span class="gsv-kicker">Create</span>
          <h3>Create package source</h3>
          <p>Scaffold a user-owned package source, install it, and keep later source work in Sources.</p>
        </div>
        <button
          type="button"
          class="gsv-action-button"
          disabled={busy || !form.repo.trim()}
          onClick={() => void createPackage()}
        >
          {runtime.pendingAction === "package:create" ? "Creating" : "Create package"}
        </button>
      </header>

      <div class="gsv-package-detail-body">
        <section class="gsv-package-panel">
          <header>
            <div>
              <h4>Package identity</h4>
              <p>Choose the repo, package name, and initial scaffold.</p>
            </div>
          </header>
          <div class="gsv-package-filters">
            <label class="gsv-package-search">
              <span>Repository</span>
              <input
                value={form.repo}
                placeholder={`${owner}/my-package`}
                onInput={(event) => patchForm({ repo: createRepoName((event.currentTarget as HTMLInputElement).value) })}
              />
            </label>
            <label>
              <span>Branch</span>
              <input
                value={form.ref}
                placeholder="main"
                onInput={(event) => patchForm({ ref: (event.currentTarget as HTMLInputElement).value })}
              />
            </label>
            <label>
              <span>Subdir</span>
              <input
                value={form.subdir}
                placeholder="."
                onInput={(event) => patchForm({ subdir: (event.currentTarget as HTMLInputElement).value })}
              />
            </label>
          </div>
          <div class="gsv-package-filters">
            <label class="gsv-package-search">
              <span>Package name</span>
              <input
                value={form.packageName}
                placeholder={`@${owner}/package`}
                onInput={(event) => patchForm({ packageName: (event.currentTarget as HTMLInputElement).value })}
              />
            </label>
            <label>
              <span>Display</span>
              <input
                value={form.displayName}
                placeholder="Desktop label"
                onInput={(event) => patchForm({ displayName: (event.currentTarget as HTMLInputElement).value })}
              />
            </label>
          </div>
          <label class="gsv-package-search">
            <span>Description</span>
            <input
              value={form.description}
              placeholder="What this package does"
              onInput={(event) => patchForm({ description: (event.currentTarget as HTMLInputElement).value })}
            />
          </label>
        </section>

        <section class="gsv-package-panel">
          <header>
            <div>
              <h4>Template and install behavior</h4>
              <p>Pick a focused starter and whether it should become active immediately.</p>
            </div>
          </header>
          <div class="gsv-package-actions">
            {(["web-ui", "command"] as PackageCreateTemplate[]).map((template) => (
              <button
                key={template}
                type="button"
                class={`gsv-action-button${form.template === template ? " is-active" : ""}`}
                onClick={() => patchForm({ template })}
              >
                {template === "web-ui" ? "App UI" : "CLI command"}
              </button>
            ))}
          </div>
          {form.template === "command" ? (
            <label class="gsv-package-search">
              <span>Command name</span>
              <input
                value={form.command}
                placeholder="my-command"
                onInput={(event) => patchForm({ command: (event.currentTarget as HTMLInputElement).value })}
              />
            </label>
          ) : null}
          <div class="gsv-package-permission-list">
            <label class="gsv-package-permission-row">
              <input
                type="checkbox"
                checked={form.enable}
                onChange={(event) => patchForm({ enable: (event.currentTarget as HTMLInputElement).checked })}
              /> Enable immediately after creation
            </label>
            <label class="gsv-package-permission-row">
              <input
                type="checkbox"
                checked={form.overwrite}
                onChange={(event) => patchForm({ overwrite: (event.currentTarget as HTMLInputElement).checked })}
              /> Overwrite scaffold files if the package source already exists
            </label>
          </div>
        </section>
      </div>
    </section>
  );
}

function CatalogRemotesPane({
  runtime,
  onOpenCatalog,
}: {
  runtime: PackagesRuntime;
  onOpenCatalog(catalogName: string): void;
}) {
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const remotes = (runtime.state?.catalogs ?? []).filter((catalog) => catalog.kind === "remote");
  const busy = runtime.pendingAction !== null;

  async function addRemote(): Promise<void> {
    await runtime.addCatalogRemote({ name, baseUrl });
    setName("");
    setBaseUrl("");
  }

  return (
    <section class="gsv-package-detail" aria-label="Catalog remotes">
      <header class="gsv-package-detail-head">
        <div>
          <span class="gsv-kicker">Remotes</span>
          <h3>Catalog remotes</h3>
          <p>Remote catalogs advertise public packages. Installed source repositories stay in Sources.</p>
        </div>
        <div class="gsv-package-tags">
          <span class="gsv-package-pill">{remotes.length} remotes</span>
        </div>
      </header>

      <div class="gsv-package-detail-body">
        <section class="gsv-package-panel">
          <header>
            <div>
              <h4>Add remote catalog</h4>
              <p>Use a stable name and the base URL of the publishing GSV instance.</p>
            </div>
            <button
              type="button"
              class="gsv-action-button"
              disabled={busy || !name.trim() || !baseUrl.trim()}
              onClick={() => void addRemote()}
            >
              {runtime.pendingAction === "catalog-remote:add" ? "Adding" : "Add remote"}
            </button>
          </header>
          <div class="gsv-package-filters">
            <label class="gsv-package-search">
              <span>Name</span>
              <input value={name} placeholder="team" onInput={(event) => setName((event.currentTarget as HTMLInputElement).value)} />
            </label>
            <label class="gsv-package-search">
              <span>Base URL</span>
              <input value={baseUrl} placeholder="https://gsv.example.com" onInput={(event) => setBaseUrl((event.currentTarget as HTMLInputElement).value)} />
            </label>
          </div>
        </section>

        <section class="gsv-package-panel">
          <header>
            <div>
              <h4>Configured remotes</h4>
              <p>Open a remote to import advertised packages, or remove stale catalog endpoints.</p>
            </div>
          </header>
          {remotes.length === 0 ? (
            <div class="gsv-empty-state">No remote catalogs configured.</div>
          ) : (
            <div class="gsv-package-commit-list">
              {remotes.map((catalog) => (
                <div class="gsv-package-commit-row" key={catalog.name}>
                  <strong>{catalog.name}</strong>
                  <span>{catalog.baseUrl || "No base URL"} - {catalog.packages.length} package{catalog.packages.length === 1 ? "" : "s"}</span>
                  <div class="gsv-package-actions">
                    <button
                      type="button"
                      class="gsv-action-button"
                      onClick={() => onOpenCatalog(catalog.name)}
                    >
                      Open catalog
                    </button>
                    <button
                      type="button"
                      class="gsv-action-button is-danger"
                      disabled={busy}
                      onClick={() => void runtime.removeCatalogRemote({ name: catalog.name })}
                    >
                      {runtime.pendingAction === `catalog-remote:remove:${catalog.name}` ? "Removing" : "Remove"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </section>
  );
}

function PackageDetail({
  runtime,
  onOpenSources,
}: {
  runtime: PackagesRuntime;
  onOpenSources?: (repo: string, ref?: string, path?: string) => void;
}) {
  const { selectedPackage: pkg, state } = runtime;
  if (!pkg) {
    return (
      <section class="gsv-package-detail">
        <div class="gsv-empty-state">
          <h3>No package selected</h3>
          <p>Select a package to inspect lifecycle state, source posture, and declared permissions.</p>
        </div>
      </section>
    );
  }

  const surfaces = packageSurfaceCounts(pkg);
  const detail = state?.packageDetail;
  const viewerUsername = state?.viewer.username ?? "";
  const packageId = pkg.packageId;
  const packageRepo = pkg.source.repo;
  const packageSourcePath = pkg.source.subdir && pkg.source.subdir !== "." ? pkg.source.subdir : undefined;
  const busy = runtime.pendingAction !== null;
  const reviewAction = `package:review:${packageId}`;
  const approveAction = `package:approve:${packageId}`;
  const enableAction = `package:enable:${packageId}`;
  const disableAction = `package:disable:${packageId}`;
  const refreshAction = `package:refresh:${packageId}`;
  const pullAction = `package:pull:${packageId}`;
  const pullSourceAction = `source:pull:${packageRepo}`;
  const publicAction = `package:public:${packageId}`;

  async function openReview(): Promise<void> {
    const detail = await runtime.startPackageReview(packageId);
    if (detail) {
      openChatProcess(detail);
    }
  }

  return (
    <section class="gsv-package-detail" aria-label={`${pkg.name} package detail`}>
      <header class="gsv-package-detail-head">
        <div>
          <span class="gsv-kicker">{formatScope(pkg)}</span>
          <h3>{pkg.name}</h3>
          <p>{pkg.description || sourceSummary(pkg, viewerUsername)}</p>
        </div>
        <div class="gsv-package-tags">
          <span class={`gsv-package-pill ${packageStatusTone(pkg)}`}>{packageStatusLabel(pkg)}</span>
          <span class="gsv-package-pill">{pkg.version || "No version"}</span>
        </div>
      </header>

      <div class="gsv-package-detail-body">
        <section class="gsv-package-panel">
          <header>
            <div>
              <h4>Source</h4>
              <p>{sourceSummary(pkg, viewerUsername)}</p>
            </div>
            <button
              type="button"
              class="gsv-mini-button"
              onClick={() => onOpenSources?.(pkg.source.repo, pkg.source.ref, packageSourcePath)}
              disabled={!onOpenSources}
            >
              Open in Sources
            </button>
          </header>
          <div class="gsv-summary-grid">
            <article class="gsv-info-box">
              <span>Installed</span>
              <strong>{shortCommit(pkg.source.resolvedCommit)}</strong>
            </article>
            <article class="gsv-info-box">
              <span>Current head</span>
              <strong>{shortCommit(pkg.currentHead)}</strong>
            </article>
            <article class="gsv-info-box">
              <span>Updated</span>
              <strong>{formatTimestampMs(pkg.updatedAt)}</strong>
            </article>
            <article class="gsv-info-box">
              <span>Public</span>
              <strong>{pkg.source.public ? "Public" : "Private"}</strong>
            </article>
          </div>
        </section>

        <section class="gsv-package-panel">
          <header>
            <div>
              <h4>Surfaces</h4>
              <p>{surfaces.total} declared package surfaces.</p>
            </div>
          </header>
          <div class="gsv-package-surface-list">
            <SurfaceRow label="Apps" value={surfaces.ui} />
            <SurfaceRow label="Commands" value={surfaces.command} />
            <SurfaceRow label="RPC" value={surfaces.rpc} />
            <SurfaceRow label="HTTP" value={surfaces.http} />
            <SurfaceRow label="Profiles" value={surfaces.profile} />
          </div>
        </section>

        <section class="gsv-package-panel">
          <header>
            <div>
              <h4>{packageRiskLabel(pkg)}</h4>
              <p>{packageRiskDescription(pkg)}</p>
            </div>
          </header>
          <div class="gsv-package-permission-list">
            {buildPermissionSummary(pkg).map((note) => (
              <div class="gsv-package-permission-row" key={note}>{note}</div>
            ))}
          </div>
        </section>

        <section class="gsv-package-panel">
          <header>
            <div>
              <h4>Actions</h4>
              <p>Permission-sensitive package lifecycle operations for the selected package.</p>
            </div>
          </header>
          <div class="gsv-package-actions">
            <button
              type="button"
              class="gsv-action-button"
              disabled={busy}
              onClick={() => void openReview()}
            >
              {runtime.pendingAction === reviewAction ? "Opening review" : "Review in Chat"}
            </button>
            {pkg.reviewPending ? (
              <button
                type="button"
                class="gsv-action-button"
                disabled={busy || !pkg.canMutate}
                onClick={() => void runtime.approvePackageReview(pkg.packageId)}
              >
                {runtime.pendingAction === approveAction ? "Approving" : "Approve review"}
              </button>
            ) : pkg.enabled ? (
              <button
                type="button"
                class="gsv-action-button is-danger"
                disabled={busy || !pkg.canMutate}
                onClick={() => void runtime.disablePackage(pkg.packageId)}
              >
                {runtime.pendingAction === disableAction ? "Disabling" : "Disable"}
              </button>
            ) : (
              <button
                type="button"
                class="gsv-action-button"
                disabled={busy || !pkg.canMutate}
                onClick={() => void runtime.enablePackage(pkg.packageId)}
              >
                {runtime.pendingAction === enableAction ? "Enabling" : "Enable"}
              </button>
            )}
            <button
              type="button"
              class="gsv-action-button"
              disabled={busy || !pkg.canMutate}
              onClick={() => void runtime.refreshPackage(pkg.packageId)}
            >
              {runtime.pendingAction === refreshAction ? "Refreshing" : "Refresh package"}
            </button>
            <button
              type="button"
              class="gsv-action-button"
              disabled={busy || !pkg.canPullSource}
              onClick={() => void runtime.pullPackage(pkg.packageId)}
            >
              {runtime.pendingAction === pullAction ? "Pulling" : "Pull upstream"}
            </button>
            <button
              type="button"
              class="gsv-action-button"
              disabled={busy || !pkg.canPullSource}
              onClick={() => void runtime.pullPackageSource(pkg.source.repo)}
            >
              {runtime.pendingAction === pullSourceAction ? "Pulling source" : "Pull source refs"}
            </button>
            {!pkg.isBuiltin ? (
              <button
                type="button"
                class="gsv-action-button"
                disabled={busy || !pkg.canChangeVisibility}
                onClick={() => void runtime.setPackagePublic({
                  packageId: pkg.packageId,
                  public: !pkg.source.public,
                })}
              >
                {runtime.pendingAction === publicAction
                  ? "Updating visibility"
                  : pkg.source.public ? "Make private" : "Publish"}
              </button>
            ) : null}
          </div>
          <div class="gsv-package-permission-list">
            {packageActionLimitations(pkg).map((note) => (
              <div class="gsv-package-permission-row" key={note}>{note}</div>
            ))}
          </div>
        </section>

        {detail?.commits.length ? (
          <section class="gsv-package-panel">
            <header>
              <div>
                <h4>Recent commits</h4>
                <p>{detail.refs.activeRef}</p>
              </div>
            </header>
            <div class="gsv-package-commit-list">
              {detail.commits.slice(0, 6).map((commit) => (
                <div class="gsv-package-commit-row" key={commit.hash}>
                  <strong>{commit.message || shortCommit(commit.hash)}</strong>
                  <span>{shortCommit(commit.hash)} by {commit.author || "unknown"} on {formatTimestampMs(commit.commitTime)}</span>
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </section>
  );
}

function SurfaceRow({ label, value }: { label: string; value: number }) {
  return (
    <div class="gsv-package-surface-row">
      <strong>{label}</strong>
      <span>{value}</span>
    </div>
  );
}

function shortCommit(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : "Unknown";
}

function openChatProcess(detail: { pid: string; workspaceId: string | null; cwd: string | null }): void {
  const pid = String(detail.pid ?? "").trim();
  const cwd = String(detail.cwd ?? "").trim();
  if (!pid || !cwd) {
    return;
  }
  const workspaceId = detail.workspaceId == null ? null : String(detail.workspaceId);
  openApp({
    target: "chat",
    payload: { pid, workspaceId, cwd },
  });
}
