import type {
  CatalogEntry,
  CatalogRecord,
  PackageEntrypoint,
  PackageRecord,
  PackageScopeFilter,
  PackagesState,
  PackagesView,
} from "./types";

export function viewTitle(view: PackagesView): string {
  if (view === "discover") return "Discover packages";
  if (view === "create") return "Create package";
  if (view === "remotes") return "Catalog remotes";
  if (view === "updates") return "Available updates";
  if (view === "review") return "Trust review";
  return "Installed packages";
}

export function viewDescription(view: PackagesView): string {
  if (view === "discover") return "Import from a source URL, shorthand, local catalog, or configured remote.";
  if (view === "create") return "Scaffold a user package source and install it into your package inventory.";
  if (view === "remotes") return "Manage remote catalogs that advertise public packages from other systems.";
  if (view === "updates") return "Packages with source changes under their installed package path.";
  if (view === "review") return "Packages that need a trust decision before enablement.";
  return "Operational inventory of software installed in this GSV instance.";
}

export function packageMatchesView(pkg: PackageRecord, view: PackagesView): boolean {
  if (view === "updates") return pkg.updateAvailable;
  if (view === "review") return pkg.reviewPending;
  return true;
}

export function packageMatchesScope(pkg: PackageRecord, scope: PackageScopeFilter): boolean {
  if (scope === "mine") return pkg.scope.kind === "user";
  if (scope === "system") return pkg.scope.kind === "global";
  return true;
}

export function packageMatchesQuery(pkg: PackageRecord, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [
    pkg.name,
    pkg.description,
    pkg.source.repo,
    pkg.source.ref,
    pkg.version,
    pkg.runtime,
    ...pkg.bindingNames,
    ...pkg.declaredSyscalls,
  ].some((value) => value.toLowerCase().includes(normalized));
}

export function comparePackagesForView(view: PackagesView): (left: PackageRecord, right: PackageRecord) => number {
  return (left, right) => {
    if (view === "updates") {
      return Number(right.updateAvailable) - Number(left.updateAvailable)
        || right.updatedAt - left.updatedAt
        || left.name.localeCompare(right.name);
    }
    if (view === "review") {
      return Number(right.reviewPending) - Number(left.reviewPending)
        || packageRiskRank(right) - packageRiskRank(left)
        || left.name.localeCompare(right.name);
    }
    const leftScore = packageAttentionScore(left);
    const rightScore = packageAttentionScore(right);
    return rightScore - leftScore || left.name.localeCompare(right.name);
  };
}

export function formatScope(pkg: PackageRecord): string {
  if (pkg.scope.kind === "user") return "Mine";
  if (pkg.scope.kind === "workspace") return `Workspace ${pkg.scope.workspaceId ?? "unknown"}`;
  return "System";
}

export function formatRepoDisplay(repo: string, viewerUsername: string): string {
  const [owner, ...rest] = repo.split("/").filter(Boolean);
  const repoName = rest.join("/") || repo || "unknown";
  return `${owner === viewerUsername ? "you" : owner || "unknown"} / ${repoName}`;
}

export function packageSurfaceCounts(pkg: PackageRecord): Record<PackageEntrypoint["kind"] | "profile" | "total", number> {
  const ui = pkg.entrypoints.filter((entry) => entry.kind === "ui").length;
  const command = pkg.entrypoints.filter((entry) => entry.kind === "command").length;
  const rpc = pkg.entrypoints.filter((entry) => entry.kind === "rpc").length;
  const http = pkg.entrypoints.filter((entry) => entry.kind === "http").length;
  const profile = pkg.profiles.length;
  return {
    ui,
    command,
    rpc,
    http,
    profile,
    total: ui + command + rpc + http + profile,
  };
}

export function packageStatusLabel(pkg: PackageRecord): string {
  if (pkg.reviewPending) return "Review";
  if (pkg.updateAvailable) return "Update";
  if (pkg.enabled) return "Enabled";
  return "Disabled";
}

export function packageStatusTone(pkg: PackageRecord): "is-review" | "is-update" | "is-enabled" | "is-disabled" {
  if (pkg.reviewPending) return "is-review";
  if (pkg.updateAvailable) return "is-update";
  if (pkg.enabled) return "is-enabled";
  return "is-disabled";
}

export function packageRiskLevel(pkg: PackageRecord): "low" | "medium" | "high" {
  if (pkg.declaredSyscalls.some((syscall) => (
    syscall.startsWith("shell.")
    || syscall.startsWith("fs.")
    || syscall.startsWith("pkg.")
    || syscall.startsWith("sys.")
    || syscall === "proc.spawn"
  ))) {
    return "high";
  }
  if (pkg.bindingNames.includes("KERNEL") || pkg.declaredSyscalls.length > 0) {
    return "medium";
  }
  return "low";
}

export function packageRiskLabel(pkg: PackageRecord): string {
  const level = packageRiskLevel(pkg);
  if (level === "high") return "High risk";
  if (level === "medium") return "Medium risk";
  return "Low risk";
}

export function packageRiskDescription(pkg: PackageRecord): string {
  const level = packageRiskLevel(pkg);
  if (level === "high") return "This package declares access to privileged runtime surfaces. Review source and diffs before approval.";
  if (level === "medium") return "This package has runtime bridge or syscall exposure. Confirm the declared surfaces match its job.";
  return "This package declares no elevated syscall or binding surface in the package summary.";
}

export function buildPermissionSummary(pkg: PackageRecord): string[] {
  const notes = new Set<string>();
  if (pkg.bindingNames.includes("KERNEL")) notes.add("Can call kernel-backed app RPC through the package runtime bridge.");
  if (pkg.declaredSyscalls.some((syscall) => syscall.startsWith("shell."))) notes.add("Can execute shell commands on a control target or routed device.");
  if (pkg.declaredSyscalls.some((syscall) => syscall.startsWith("fs."))) notes.add("Can read or modify files exposed through filesystem syscalls.");
  if (pkg.declaredSyscalls.includes("proc.spawn")) notes.add("Can spawn new processes and route work into more runtime contexts.");
  if (pkg.declaredSyscalls.some((syscall) => syscall.startsWith("pkg."))) notes.add("Can inspect or change package state, including install or update flows.");
  if (pkg.declaredSyscalls.some((syscall) => syscall.startsWith("sys.config."))) notes.add("Can modify system configuration.");
  if (pkg.declaredSyscalls.some((syscall) => syscall.startsWith("sys.token."))) notes.add("Can issue or revoke access tokens.");
  if (pkg.declaredSyscalls.some((syscall) => syscall.startsWith("sys.link") || syscall.startsWith("sys.unlink"))) notes.add("Can modify identity links and trust relationships.");
  if (notes.size === 0) notes.add("No elevated bindings or syscall surfaces were declared in the package summary.");
  return [...notes];
}

export function packageActionLimitations(pkg: PackageRecord): string[] {
  const notes: string[] = [];
  if (!pkg.canMutate) notes.push("You cannot mutate this package from the current viewer.");
  if (isRequiredSystemConsolePackage(pkg)) notes.push("The GSV console is required and cannot be disabled.");
  if (!pkg.canChangeVisibility) notes.push("Visibility is controlled by the source owner or root.");
  if (!pkg.canPullSource) notes.push("Pulling source updates is unavailable for this package.");
  if (notes.length === 0) notes.push("Lifecycle actions are available for this package.");
  return notes;
}

export function isRequiredSystemConsolePackage(pkg: PackageRecord): boolean {
  if (pkg.name === "packages") {
    return true;
  }
  return pkg.name === "gsv"
    && pkg.packageId.startsWith("builtin:gsv@")
    && pkg.source.repo === "root/gsv"
    && pkg.source.subdir.replace(/^\/+|\/+$/g, "") === "builtin-packages/gsv";
}

export function filteredPackages(
  state: PackagesState,
  view: PackagesView,
  scope: PackageScopeFilter,
  query: string,
): PackageRecord[] {
  return state.packages
    .filter((pkg) => packageMatchesView(pkg, view))
    .filter((pkg) => packageMatchesScope(pkg, scope))
    .filter((pkg) => packageMatchesQuery(pkg, query))
    .sort(comparePackagesForView(view));
}

export function sourceSummary(pkg: PackageRecord, viewerUsername: string): string {
  const subdir = pkg.source.subdir && pkg.source.subdir !== "." ? `:${pkg.source.subdir}` : "";
  return `${formatRepoDisplay(pkg.source.repo, viewerUsername)} @ ${pkg.source.ref}${subdir}`;
}

export function catalogPackageCount(state: PackagesState | null): number {
  return (state?.catalogs ?? []).reduce((total, catalog) => total + catalog.packages.length, 0);
}

export function matchInstalledPackage(entry: CatalogEntry, packages: PackageRecord[]): PackageRecord | null {
  return packages.find((pkg) => pkg.source.repo === entry.source.repo && pkg.source.subdir === entry.source.subdir) ?? null;
}

export function catalogImportSource(catalog: CatalogRecord, entry: CatalogEntry): string {
  if (catalog.kind === "remote" && catalog.baseUrl) {
    const [owner, repo] = entry.source.repo.split("/");
    if (owner && repo) {
      return `${catalog.baseUrl.replace(/\/+$/g, "")}/git/${owner}/${repo}.git`;
    }
  }
  return entry.source.repo;
}

export function createRepoName(raw: string): string {
  return raw
    .trim()
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/+/g, "/");
}

function packageAttentionScore(pkg: PackageRecord): number {
  return (pkg.reviewPending ? 4 : 0)
    + (pkg.updateAvailable ? 3 : 0)
    + (!pkg.enabled ? 1 : 0)
    + packageRiskRank(pkg);
}

function packageRiskRank(pkg: PackageRecord): number {
  const level = packageRiskLevel(pkg);
  if (level === "high") return 3;
  if (level === "medium") return 2;
  return 1;
}
