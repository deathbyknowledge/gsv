import { useMemo, useState } from "preact/hooks";
import { ActionButton } from "../../components/ui/ActionButton";
import type { GsvBackend } from "../../backend-contract";
import {
  catalogPackageCount,
  formatScope,
  packageRiskLabel,
  packageStatusLabel,
  packageStatusTone,
  sourceSummary,
  viewDescription,
  viewTitle,
} from "./packages-domain";
import { PackageDetail } from "./PackageDetail";
import { CatalogRemotesPane, CreatePackagePane, DiscoverPane } from "./PackageWorkflows";
import type {
  PackageRecord,
  PackageScopeFilter,
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
  const packageListView = runtime.view === "inventory" || runtime.view === "updates" || runtime.view === "review";

  if (packageListView && runtime.selectedPackage) {
    return (
      <section class="gsv-packages">
        <PackageDetail
          runtime={runtime}
          onBack={() => runtime.selectPackage(null)}
          onOpenSources={onOpenSources}
        />
      </section>
    );
  }

  if (runtime.view === "discover") {
    return (
      <section class="gsv-packages">
        <DiscoverPane
          runtime={runtime}
          selectedCatalog={selectedCatalog}
          onBack={() => runtime.setView("inventory")}
          onSelectCatalog={setSelectedCatalogName}
        />
      </section>
    );
  }

  if (runtime.view === "create") {
    return (
      <section class="gsv-packages">
        <CreatePackagePane runtime={runtime} onBack={() => runtime.setView("inventory")} />
      </section>
    );
  }

  if (runtime.view === "remotes") {
    return (
      <section class="gsv-packages">
        <CatalogRemotesPane
          runtime={runtime}
          onBack={() => runtime.setView("inventory")}
          onOpenCatalog={(catalogName) => {
            setSelectedCatalogName(catalogName);
            runtime.setView("discover");
          }}
        />
      </section>
    );
  }

  return (
    <section class="gsv-packages">
      <div class="gsv-packages-list-pane">
        <section class="gsv-packages-toolbar">
          <div>
            <span class="gsv-kicker">Extensions</span>
            <h3>{viewTitle(runtime.view)}</h3>
            <p class="gsv-runtime-meta">{viewDescription(runtime.view)}</p>
          </div>
          <ActionButton
            icon="package"
            label="Rebuild from source"
            busyLabel="Rebuilding"
            busy={runtime.pendingAction === "packages:sync"}
            onClick={() => void runtime.syncPackages()}
            disabled={runtime.loading || runtime.pendingAction !== null}
          />

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
                selected={false}
                viewerUsername={runtime.state?.viewer.username ?? ""}
                onSelect={() => runtime.selectPackage(pkg.packageId)}
              />
            ))
          )}
        </div>
      </div>
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
