import { openApp } from "@gsv/package/host";
import { ActionButton } from "../../components/ui/ActionButton";
import { Icon, type IconName } from "../../components/ui/Icon";
import { formatRelativeTime } from "../../utils/format";
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
  onBack,
  onOpenSources,
}: {
  runtime: PackagesRuntime;
  onBack?: () => void;
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
        {onBack ? <ActionButton icon="arrow-left" label="Packages" onClick={onBack} /> : null}
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
            <ActionButton
              icon="external"
              label="Sources"
              onClick={() => onOpenSources?.(pkg.source.repo, pkg.source.ref, packageSourcePath)}
              disabled={!onOpenSources}
            />
          </header>
          <div class="gsv-package-source-compact" aria-label="Source posture">
            <SourceFact label="Installed" value={shortCommit(pkg.source.resolvedCommit)} />
            <SourceFact label="Head" value={shortCommit(pkg.currentHead)} tone={pkg.updateAvailable ? "warning" : "good"} />
            <SourceFact label="Updated" value={formatRelativeTime(pkg.updatedAt)} />
            <SourceFact label="Visibility" value={pkg.source.public ? "Public" : "Private"} />
          </div>
          <div class="gsv-package-surface-chips" aria-label={`${surfaces.total} declared package surfaces`}>
            <SurfaceChip icon="package" label="Apps" value={surfaces.ui} />
            <SurfaceChip icon="terminal" label="Commands" value={surfaces.command} />
            <SurfaceChip icon="plug" label="RPC" value={surfaces.rpc} />
            <SurfaceChip icon="external" label="HTTP" value={surfaces.http} />
            <SurfaceChip icon="user" label="Profiles" value={surfaces.profile} />
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
            <ActionButton
              icon="shield"
              label="Review in Chat"
              busyLabel="Opening review"
              busy={runtime.pendingAction === reviewAction}
              disabled={busy}
              onClick={() => void openReview()}
            />
            {pkg.reviewPending ? (
              <ActionButton
                icon="check"
                label="Approve review"
                busyLabel="Approving"
                busy={runtime.pendingAction === approveAction}
                disabled={busy || !pkg.canMutate}
                onClick={() => void runtime.approvePackageReview(pkg.packageId)}
              />
            ) : pkg.enabled ? (
              <ActionButton
                icon="lock"
                label="Disable"
                busyLabel="Disabling"
                busy={runtime.pendingAction === disableAction}
                variant="danger"
                disabled={busy || !pkg.canMutate || disableBlocked}
                title={disableBlocked ? "The GSV console is required and cannot be disabled." : undefined}
                onClick={() => void runtime.disablePackage(pkg.packageId)}
              />
            ) : (
              <ActionButton
                icon="unlock"
                label="Enable"
                busyLabel="Enabling"
                busy={runtime.pendingAction === enableAction}
                disabled={busy || !pkg.canMutate}
                onClick={() => void runtime.enablePackage(pkg.packageId)}
              />
            )}
            <ActionButton
              icon="refresh"
              label="Refresh"
              busyLabel="Refreshing"
              busy={runtime.pendingAction === refreshAction}
              disabled={busy || !pkg.canMutate}
              onClick={() => void runtime.refreshPackage(pkg.packageId)}
            />
            <ActionButton
              icon="git-commit"
              label="Pull upstream"
              busyLabel="Pulling"
              busy={runtime.pendingAction === pullAction}
              disabled={busy || !pkg.canPullSource}
              onClick={() => void runtime.pullPackage(pkg.packageId)}
            />
            <ActionButton
              icon="refresh"
              label="Source refs"
              busyLabel="Pulling source"
              busy={runtime.pendingAction === pullSourceAction}
              disabled={busy || !pkg.canPullSource}
              onClick={() => void runtime.pullPackageSource(pkg.source.repo)}
            />
            {!pkg.isBuiltin ? (
              <ActionButton
                icon={pkg.source.public ? "lock" : "external"}
                label={pkg.source.public ? "Make private" : "Publish"}
                busyLabel="Updating visibility"
                busy={runtime.pendingAction === publicAction}
                disabled={busy || !pkg.canChangeVisibility}
                onClick={() => void runtime.setPackagePublic({
                  packageId: pkg.packageId,
                  public: !pkg.source.public,
                })}
              />
            ) : null}
          </div>
          <div class="gsv-package-permission-list">
            {packageActionLimitations(pkg).map((note) => (
              <div class="gsv-package-permission-row" key={note}>{note}</div>
            ))}
          </div>
        </section>

      </div>
    </section>
  );
}

function SourceFact({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "good" | "warning";
}) {
  return (
    <span class={`gsv-package-source-fact${tone ? ` is-${tone}` : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </span>
  );
}

function SurfaceChip({ icon, label, value }: { icon: IconName; label: string; value: number }) {
  return (
    <span class="gsv-package-surface-chip" title={`${value} ${label.toLowerCase()}`}>
      <Icon name={icon} />
      <strong>{value}</strong>
      <span>{label}</span>
    </span>
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
