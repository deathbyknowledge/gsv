import type { ComponentChildren } from "preact";
import { Icon } from "../../../components/ui/Icon";
import { ListRow } from "../../../components/ui/ListRow";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { StatusDot, type StatusTone } from "../../../components/ui/StatusDot";
import { Tag, type TagTone } from "../../../components/ui/Tag";
import type {
  ConsoleAccount,
  ConsoleAdapterAccount,
  ConsoleOverviewCounts,
  ConsoleOverviewData,
  ConsolePackage,
  ConsoleProcess,
  ConsoleResourceState,
  ConsoleTarget,
} from "../domain/consoleModels";
import "./ConsolePageTemplate.css";

export type ConsolePageStateKind = "loading" | "error" | "empty" | "offline";

export type ConsoleRow = {
  id: string;
  icon: string;
  label: string;
  sub: string;
  tone: StatusTone;
  statusLabel: string;
  tag?: {
    label: string;
    tone: TagTone;
  };
};

type ConsolePageProps = {
  children: ComponentChildren;
  flush?: boolean;
};

type ConsoleResourceBoundaryProps<T> = {
  resource: ConsoleResourceState<T>;
  emptyLabel: string;
  errorLabel: string;
  loadingLabel?: string;
  render: (data: T) => ComponentChildren;
};

type ConsoleSectionProps = {
  title: string;
  meta: string;
  rows: readonly ConsoleRow[];
  emptyLabel: string;
};

const STATE_LABEL: Record<ConsolePageStateKind, string> = {
  loading: "LOADING",
  error: "ERROR",
  empty: "NO DATA",
  offline: "WAITING FOR GATEWAY",
};

const STATE_TONE: Record<ConsolePageStateKind, StatusTone> = {
  loading: "live",
  error: "error",
  empty: "idle",
  offline: "idle",
};

function toneForProcess(process: ConsoleProcess): StatusTone {
  if (process.state === "running") return "live";
  if (process.state === "queued") return "update";
  if (process.state === "unknown") return "warn";
  return "idle";
}

function statusForProcess(process: ConsoleProcess): string {
  if (process.state === "running") return "RUNNING";
  if (process.state === "queued") return "QUEUED";
  if (process.state === "unknown") return "UNKNOWN";
  return "IDLE";
}

export function rowsFromProcesses(processes: readonly ConsoleProcess[]): ConsoleRow[] {
  return processes.map((process) => ({
    id: process.pid,
    icon: "list",
    label: process.label,
    sub: [process.username, process.profile, process.cwd].filter(Boolean).join(" · "),
    tone: toneForProcess(process),
    statusLabel: statusForProcess(process),
  }));
}

export function rowsFromTargets(targets: readonly ConsoleTarget[]): ConsoleRow[] {
  return targets.map((target) => ({
    id: target.deviceId,
    icon: target.kind === "browser" ? "bookmark" : "computer",
    label: target.label,
    sub: [target.platform, target.version, target.ownerUsername].filter(Boolean).join(" · "),
    tone: target.online ? "online" : "idle",
    statusLabel: target.online ? "ONLINE" : "OFFLINE",
  }));
}

export function rowsFromPackages(packages: readonly ConsolePackage[]): ConsoleRow[] {
  return packages.map((pkg) => ({
    id: pkg.packageId,
    icon: pkg.uiEntrypoints.length > 0 ? "stars" : "pencil",
    label: pkg.name,
    sub: [pkg.version, pkg.runtime, pkg.sourceRepo].filter(Boolean).join(" · "),
    tone: pkg.reviewPending ? "update" : pkg.enabled ? "online" : "idle",
    statusLabel: pkg.reviewPending ? "REVIEW" : pkg.enabled ? "ENABLED" : "DISABLED",
    tag: pkg.reviewPending ? { label: "REVIEW", tone: "update" } : undefined,
  }));
}

export function rowsFromAccounts(accounts: readonly ConsoleAccount[]): ConsoleRow[] {
  return accounts.map((account) => ({
    id: String(account.uid),
    icon: account.runnable ? "chat" : "tag",
    label: account.displayName,
    sub: [account.username, account.relation].filter(Boolean).join(" · "),
    tone: account.runnable ? "online" : "idle",
    statusLabel: account.runnable ? "RUNNABLE" : "ACCOUNT",
  }));
}

export function rowsFromAdapters(adapters: readonly ConsoleAdapterAccount[]): ConsoleRow[] {
  return adapters.map((adapter) => ({
    id: `${adapter.adapter}:${adapter.accountId}`,
    icon: adapter.adapter === "discord" ? "discord" : "chat",
    label: `${adapter.adapter}:${adapter.accountId}`,
    sub: [adapter.mode, adapter.error].filter(Boolean).join(" · "),
    tone: adapter.connected ? "online" : adapter.error ? "error" : "idle",
    statusLabel: adapter.connected ? "CONNECTED" : adapter.error ? "ERROR" : "DISCONNECTED",
  }));
}

export function ConsolePage({ children, flush = false }: ConsolePageProps) {
  return (
    <section class={`gsv-console-page${flush ? " is-flush" : ""}`}>
      <div class="gsv-console-page-body">{children}</div>
    </section>
  );
}

export function ConsolePageState({
  kind,
  label,
  detail,
}: {
  kind: ConsolePageStateKind;
  label?: string;
  detail?: string;
}) {
  const resolvedLabel = label ?? STATE_LABEL[kind];
  const text = detail ? `${resolvedLabel} · ${detail}` : resolvedLabel;

  return (
    <div
      class="gsv-console-state"
      role={kind === "error" ? "alert" : "status"}
      aria-live={kind === "loading" ? "polite" : undefined}
    >
      <span class="gsv-console-state-copy">
        <StatusDot tone={STATE_TONE[kind]} size={7} />
        <span>{text}</span>
      </span>
    </div>
  );
}

export function ConsoleResourceBoundary<T>({
  resource,
  emptyLabel,
  errorLabel,
  loadingLabel,
  render,
}: ConsoleResourceBoundaryProps<T>) {
  if (resource.isUnavailable) {
    return <ConsolePageState kind="offline" detail="CONNECTION REQUIRED" />;
  }
  if (resource.isError) {
    return <ConsolePageState kind="error" detail={resource.errorText || errorLabel} />;
  }
  if (resource.isLoading) {
    return <ConsolePageState kind="loading" label={loadingLabel} />;
  }
  if (resource.isEmpty || resource.data === null) {
    return <ConsolePageState kind="empty" label={emptyLabel} />;
  }
  return <>{render(resource.data)}</>;
}

export function ConsoleSection({
  title,
  meta,
  rows,
  emptyLabel,
}: ConsoleSectionProps) {
  return (
    <section class="gsv-console-section">
      <SectionHeader title={title} meta={meta} divider />
      {rows.length === 0 ? (
        <div class="gsv-console-empty-row">{emptyLabel}</div>
      ) : rows.map((row) => (
        <div class="gsv-console-row" key={row.id}>
          <span class="gsv-console-row-icon">
            <Icon name={row.icon} size={18} />
          </span>
          <div class="gsv-console-row-main">
            <ListRow label={row.label} sub={row.sub} status="none" />
          </div>
          {row.tag ? (
            <span class="gsv-console-row-tag">
              <Tag label={row.tag.label} tone={row.tag.tone} boxed />
            </span>
          ) : null}
          <span class="gsv-console-row-status">
            <span>{row.statusLabel}</span>
            <StatusDot tone={row.tone} size={8} />
          </span>
        </div>
      ))}
    </section>
  );
}

export function ConsoleOverviewStats({
  counts,
  refreshing = false,
}: {
  counts: ConsoleOverviewCounts | null;
  refreshing?: boolean;
}) {
  const stats = [
    ["TASKS", counts?.processes ?? 0, `${counts?.activeProcesses ?? 0} ACTIVE`],
    ["TARGETS", counts?.targets ?? 0, `${counts?.onlineTargets ?? 0} ONLINE`],
    ["PACKAGES", counts?.packages ?? 0, `${counts?.reviewPendingPackages ?? 0} REVIEW`],
    ["CREW", counts?.accounts ?? 0, `${counts?.runnableAccounts ?? 0} RUNNABLE`],
    ["MESSENGERS", counts?.adapterAccounts ?? 0, `${counts?.connectedAdapterAccounts ?? 0} ONLINE`],
    ["CONFIG", counts?.configEntries ?? 0, "ENTRIES"],
  ] as const;

  return (
    <div class="gsv-console-stats">
      {stats.map(([label, value, meta]) => (
        <div class="gsv-console-stat" key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
          <small>{meta}</small>
        </div>
      ))}
      {refreshing ? (
        <div class="gsv-console-stat">
          <span>SYNC</span>
          <strong>
            <StatusDot tone="live" size={10} />
          </strong>
          <small>REFRESHING</small>
        </div>
      ) : null}
    </div>
  );
}

export function ConsoleOverviewSections({
  overview,
}: {
  overview: ConsoleOverviewData;
}) {
  return (
    <div class="gsv-console-sections">
      <ConsoleSection
        title="TASKS"
        meta={`${overview.processes.length}`}
        rows={rowsFromProcesses(overview.processes).slice(0, 6)}
        emptyLabel="NO TASKS"
      />
      <ConsoleSection
        title="TARGETS"
        meta={`${overview.targets.length}`}
        rows={rowsFromTargets(overview.targets).slice(0, 6)}
        emptyLabel="NO TARGETS"
      />
      <ConsoleSection
        title="PACKAGES"
        meta={`${overview.packages.length}`}
        rows={rowsFromPackages(overview.packages).slice(0, 6)}
        emptyLabel="NO PACKAGES"
      />
      <ConsoleSection
        title="CREW"
        meta={`${overview.accounts.length}`}
        rows={rowsFromAccounts(overview.accounts).slice(0, 6)}
        emptyLabel="NO ACCOUNTS"
      />
      <ConsoleSection
        title="MESSENGERS"
        meta={`${overview.adapters.length}`}
        rows={rowsFromAdapters(overview.adapters).slice(0, 6)}
        emptyLabel="NO ADAPTER ACCOUNTS"
      />
    </div>
  );
}
