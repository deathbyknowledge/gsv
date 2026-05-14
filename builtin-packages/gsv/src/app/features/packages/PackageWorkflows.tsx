import { useState } from "preact/hooks";
import { ActionButton } from "../../components/ui/ActionButton";
import {
  catalogImportSource,
  catalogPackageCount,
  createRepoName,
  formatRepoDisplay,
  matchInstalledPackage,
} from "./packages-domain";
import type {
  CatalogEntry,
  CatalogRecord,
  PackageCreateTemplate,
} from "./types";
import type { PackagesRuntime } from "./usePackages";

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

export function DiscoverPane({
  runtime,
  selectedCatalog,
  onBack,
  onSelectCatalog,
}: {
  runtime: PackagesRuntime;
  selectedCatalog: CatalogRecord | null;
  onBack: () => void;
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
        <ActionButton icon="arrow-left" label="Packages" onClick={onBack} />
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
            <ActionButton
              icon="external"
              label="Import"
              busyLabel="Importing"
              busy={runtime.pendingAction === "package:import"}
              disabled={busy || !source.trim()}
              onClick={() => void importSource()}
            />
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
                            <ActionButton
                              icon="external"
                              label="Inspect"
                              onClick={() => {
                                runtime.selectPackage(installed.packageId);
                                runtime.setView(installed.reviewPending ? "review" : installed.updateAvailable ? "updates" : "inventory");
                              }}
                            />
                          ) : null}
                          <ActionButton
                            icon="external"
                            label={installed ? "Re-import" : "Import"}
                            busyLabel="Importing"
                            busy={runtime.pendingAction === actionId}
                            disabled={busy}
                            onClick={() => void importCatalogEntry(selectedCatalog, entry)}
                          />
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

export function CreatePackagePane({ runtime, onBack }: { runtime: PackagesRuntime; onBack: () => void }) {
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
        <ActionButton icon="arrow-left" label="Packages" onClick={onBack} />
        <div>
          <span class="gsv-kicker">Create</span>
          <h3>Create package source</h3>
          <p>Scaffold a user-owned package source, install it, and keep later source work in Sources.</p>
        </div>
        <ActionButton
          icon="package"
          label="Create package"
          busyLabel="Creating"
          busy={runtime.pendingAction === "package:create"}
          disabled={busy || !form.repo.trim()}
          onClick={() => void createPackage()}
        />
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
              <ActionButton
                key={template}
                icon={template === "web-ui" ? "package" : "terminal"}
                label={template === "web-ui" ? "App UI" : "CLI command"}
                class={form.template === template ? "is-active" : ""}
                onClick={() => patchForm({ template })}
              />
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

export function CatalogRemotesPane({
  runtime,
  onBack,
  onOpenCatalog,
}: {
  runtime: PackagesRuntime;
  onBack: () => void;
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
        <ActionButton icon="arrow-left" label="Packages" onClick={onBack} />
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
            <ActionButton
              icon="external"
              label="Add remote"
              busyLabel="Adding"
              busy={runtime.pendingAction === "catalog-remote:add"}
              disabled={busy || !name.trim() || !baseUrl.trim()}
              onClick={() => void addRemote()}
            />
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
                    <ActionButton
                      icon="external"
                      label="Catalog"
                      onClick={() => onOpenCatalog(catalog.name)}
                    />
                    <ActionButton
                      icon="trash"
                      label="Remove"
                      busyLabel="Removing"
                      busy={runtime.pendingAction === `catalog-remote:remove:${catalog.name}`}
                      variant="danger"
                      disabled={busy}
                      onClick={() => void runtime.removeCatalogRemote({ name: catalog.name })}
                    />
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
