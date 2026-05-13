import { openApp } from "@gsv/package/host";
import { formatTimestampMs } from "../../utils/format";
import {
  buildPermissionSummary,
  formatScope,
  isRequiredSystemConsolePackage,
  packageActionLimitations,
  packageRiskDescription,
  packageRiskLabel,
  packageStatusLabel,
  packageStatusTone,
  packageSurfaceCounts,
  sourceSummary,
} from "./packages-domain";
import type { PackagesRuntime } from "./usePackages";

export function PackageDetail({
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
  const disableBlocked = isRequiredSystemConsolePackage(pkg);

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
                disabled={busy || !pkg.canMutate || disableBlocked}
                title={disableBlocked ? "The GSV console is required and cannot be disabled." : undefined}
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
