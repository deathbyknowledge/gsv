import { useConsoleOverview } from "../hooks/useConsoleData";
import {
  ConsolePage,
  ConsoleResourceBoundary,
} from "../components/ConsolePageTemplate";
import { Icon } from "../../../components/ui/Icon";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { StatusDot, type StatusTone } from "../../../components/ui/StatusDot";
import { Tag, type TagTone } from "../../../components/ui/Tag";
import type {
  ConsoleAccount,
  ConsoleAdapterAccount,
  ConsoleConfigEntry,
  ConsoleOverviewCounts,
  ConsoleOverviewData,
  ConsolePackage,
  ConsoleProcess,
  ConsoleTarget,
} from "../domain/consoleModels";
import "./ConsoleOverviewPage.css";

type SettingsOverviewRow = {
  id: string;
  icon: string;
  label: string;
  meta: string;
  tone: StatusTone;
  statusLabel: string;
  tag?: {
    label: string;
    tone: TagTone;
  };
};

type SettingsSectionProps = {
  title: string;
  meta: string;
  rows: readonly SettingsOverviewRow[];
  emptyLabel: string;
  limit?: number;
  attention?: boolean;
};

const SECTION_LIMIT = 6;
const ATTENTION_LIMIT = 12;

function isApplicationPackage(pkg: ConsolePackage): boolean {
  return pkg.runtime === "web-ui" || pkg.uiEntrypoints.length > 0;
}

function isRunningProcess(process: ConsoleProcess): boolean {
  return process.state === "running" || process.activeRunId !== null;
}

function isQueuedProcess(process: ConsoleProcess): boolean {
  return process.state === "queued" || process.queuedCount > 0;
}

function joinMeta(parts: readonly (number | string | null | undefined | false)[]): string {
  return parts
    .map((part) => typeof part === "number" ? String(part) : part)
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(" · ");
}

function plural(count: number, singular: string, pluralLabel = `${singular}S`): string {
  return `${count} ${count === 1 ? singular : pluralLabel}`;
}

function previewConfigValue(entry: ConsoleConfigEntry): string {
  if (entry.redacted) {
    return "VALUE REDACTED";
  }
  if (!entry.value) {
    return "EMPTY VALUE";
  }
  return entry.value.length > 72 ? `${entry.value.slice(0, 69)}...` : entry.value;
}

function statusForPackage(pkg: ConsolePackage): { tone: StatusTone; statusLabel: string; tag?: SettingsOverviewRow["tag"] } {
  if (pkg.reviewPending) {
    return {
      tone: "update",
      statusLabel: "REVIEW",
      tag: { label: "REVIEW", tone: "update" },
    };
  }
  if (pkg.enabled) {
    return { tone: "online", statusLabel: "ENABLED" };
  }
  return { tone: "idle", statusLabel: "DISABLED" };
}

function rowFromProcess(process: ConsoleProcess, idPrefix = "process"): SettingsOverviewRow {
  const queued = isQueuedProcess(process);
  const running = isRunningProcess(process);
  const tone: StatusTone = queued ? "update" : running ? "live" : process.state === "unknown" ? "warn" : "idle";
  const statusLabel = queued ? "QUEUED" : running ? "RUNNING" : process.state === "unknown" ? "UNKNOWN" : "IDLE";

  return {
    id: `${idPrefix}:${process.pid}`,
    icon: "list",
    label: process.label,
    meta: joinMeta([
      process.username,
      process.profile,
      process.cwd,
      process.queuedCount > 0 ? plural(process.queuedCount, "QUEUED ITEM") : "",
    ]) || process.pid,
    tone,
    statusLabel,
    tag: queued ? { label: "QUEUE", tone: "update" } : running ? { label: "ACTIVE", tone: "accent" } : undefined,
  };
}

function rowFromTarget(target: ConsoleTarget, idPrefix = "target"): SettingsOverviewRow {
  return {
    id: `${idPrefix}:${target.deviceId}`,
    icon: target.kind === "browser" ? "bookmark" : "computer",
    label: target.label,
    meta: joinMeta([target.platform, target.version, target.ownerUsername, target.description]) || target.deviceId,
    tone: target.online ? "online" : "idle",
    statusLabel: target.online ? "ONLINE" : "OFFLINE",
    tag: target.online ? undefined : { label: "OFFLINE", tone: "idle" },
  };
}

function rowFromPackage(pkg: ConsolePackage, idPrefix = "package"): SettingsOverviewRow {
  const status = statusForPackage(pkg);
  return {
    id: `${idPrefix}:${pkg.packageId}`,
    icon: isApplicationPackage(pkg) ? "weblink" : "pencil",
    label: pkg.name,
    meta: joinMeta([pkg.version, pkg.runtime, pkg.scopeKind, pkg.sourceRepo]) || pkg.packageId,
    ...status,
  };
}

function rowFromAdapter(adapter: ConsoleAdapterAccount, idPrefix = "adapter"): SettingsOverviewRow {
  const hasError = adapter.error.length > 0;
  return {
    id: `${idPrefix}:${adapter.adapter}:${adapter.accountId}`,
    icon: adapter.adapter === "discord" ? "discord" : adapter.adapter === "telegram" ? "telegram" : "chat",
    label: `${adapter.adapter}:${adapter.accountId}`,
    meta: joinMeta([
      adapter.mode,
      adapter.authenticated ? "authenticated" : "not authenticated",
      adapter.error,
    ]) || adapter.adapter,
    tone: adapter.connected ? "online" : hasError ? "error" : "idle",
    statusLabel: adapter.connected ? "CONNECTED" : hasError ? "ERROR" : "DISCONNECTED",
    tag: !adapter.connected || hasError ? { label: hasError ? "ERROR" : "DISCONNECTED", tone: hasError ? "error" : "idle" } : undefined,
  };
}

function rowFromAccount(account: ConsoleAccount): SettingsOverviewRow {
  return {
    id: `account:${account.uid}`,
    icon: account.runnable ? "chat" : "tag",
    label: account.displayName,
    meta: joinMeta([account.username, account.relation, account.gecos]) || String(account.uid),
    tone: account.runnable ? "online" : "idle",
    statusLabel: account.runnable ? "RUNNABLE" : "ACCOUNT",
  };
}

function rowFromConfig(entry: ConsoleConfigEntry): SettingsOverviewRow {
  return {
    id: `config:${entry.key}`,
    icon: "cog",
    label: entry.key,
    meta: previewConfigValue(entry),
    tone: entry.redacted ? "warn" : entry.value ? "online" : "idle",
    statusLabel: entry.redacted ? "REDACTED" : entry.value ? "SET" : "EMPTY",
    tag: entry.redacted ? { label: "REDACTED", tone: "warn" } : undefined,
  };
}

function compareProcesses(left: ConsoleProcess, right: ConsoleProcess): number {
  const leftRank = isQueuedProcess(left) ? 0 : isRunningProcess(left) ? 1 : left.state === "unknown" ? 2 : 3;
  const rightRank = isQueuedProcess(right) ? 0 : isRunningProcess(right) ? 1 : right.state === "unknown" ? 2 : 3;
  return leftRank - rightRank || (right.lastActiveAt ?? right.createdAt ?? 0) - (left.lastActiveAt ?? left.createdAt ?? 0);
}

function packageSort(left: ConsolePackage, right: ConsolePackage): number {
  if (left.reviewPending !== right.reviewPending) {
    return left.reviewPending ? -1 : 1;
  }
  if (left.enabled !== right.enabled) {
    return left.enabled ? -1 : 1;
  }
  return left.name.localeCompare(right.name);
}

function adapterSort(left: ConsoleAdapterAccount, right: ConsoleAdapterAccount): number {
  const leftRank = left.error.length > 0 ? 0 : left.connected ? 2 : 1;
  const rightRank = right.error.length > 0 ? 0 : right.connected ? 2 : 1;
  return leftRank - rightRank || left.adapter.localeCompare(right.adapter) || left.accountId.localeCompare(right.accountId);
}

function targetSort(left: ConsoleTarget, right: ConsoleTarget): number {
  if (left.online !== right.online) {
    return left.online ? 1 : -1;
  }
  return left.label.localeCompare(right.label);
}

function configSort(left: ConsoleConfigEntry, right: ConsoleConfigEntry): number {
  if (left.redacted !== right.redacted) {
    return left.redacted ? -1 : 1;
  }
  if (!!left.value !== !!right.value) {
    return left.value ? -1 : 1;
  }
  return left.key.localeCompare(right.key);
}

function buildAttentionRows(data: ConsoleOverviewData): SettingsOverviewRow[] {
  const reviewPackages = data.packages
    .filter((pkg) => pkg.reviewPending)
    .sort(packageSort)
    .map((pkg) => ({
      ...rowFromPackage(pkg, "attention-package"),
      meta: joinMeta(["PACKAGE REVIEW REQUIRED", pkg.version, pkg.sourceRepo]) || pkg.packageId,
    }));
  const offlineTargets = data.targets
    .filter((target) => !target.online)
    .sort(targetSort)
    .map((target) => ({
      ...rowFromTarget(target, "attention-target"),
      meta: joinMeta(["OFFLINE TARGET", target.platform, target.ownerUsername]) || target.deviceId,
    }));
  const adapterIssues = data.adapters
    .filter((adapter) => !adapter.connected || adapter.error.length > 0)
    .sort(adapterSort)
    .map((adapter) => ({
      ...rowFromAdapter(adapter, "attention-adapter"),
      meta: joinMeta([adapter.error || "ADAPTER NOT CONNECTED", adapter.mode, adapter.authenticated ? "authenticated" : "not authenticated"]),
    }));
  const processWork = data.processes
    .filter((process) => isQueuedProcess(process) || isRunningProcess(process))
    .sort(compareProcesses)
    .map((process) => rowFromProcess(process, "attention-process"));

  return [
    ...reviewPackages,
    ...offlineTargets,
    ...adapterIssues,
    ...processWork,
  ];
}

function SettingsRow({ row }: { row: SettingsOverviewRow }) {
  return (
    <div class="gsv-settings-row">
      <span class="gsv-settings-row-icon">
        <Icon name={row.icon} size={18} />
      </span>
      <span class="gsv-settings-row-copy">
        <strong>{row.label}</strong>
        <small>{row.meta}</small>
      </span>
      {row.tag ? (
        <span class="gsv-settings-row-tag">
          <Tag label={row.tag.label} tone={row.tag.tone} boxed />
        </span>
      ) : null}
      <span class="gsv-settings-row-status">
        <span>{row.statusLabel}</span>
        <StatusDot tone={row.tone} size={8} />
      </span>
    </div>
  );
}

function EmptyRows({ label, tone = "idle" }: { label: string; tone?: StatusTone }) {
  return (
    <div class="gsv-settings-empty">
      <StatusDot tone={tone} size={7} />
      <span>{label}</span>
    </div>
  );
}

function SettingsSection({
  title,
  meta,
  rows,
  emptyLabel,
  limit = SECTION_LIMIT,
  attention = false,
}: SettingsSectionProps) {
  const visibleRows = rows.slice(0, limit);
  const hiddenCount = Math.max(0, rows.length - visibleRows.length);

  return (
    <section class={`gsv-settings-section${attention ? " gsv-settings-section-attention" : ""}`}>
      <SectionHeader title={title} meta={meta} divider />
      <div class="gsv-settings-row-stack">
        {visibleRows.length === 0 ? (
          <EmptyRows label={emptyLabel} tone={attention ? "online" : "idle"} />
        ) : visibleRows.map((row) => (
          <SettingsRow key={row.id} row={row} />
        ))}
        {hiddenCount > 0 ? (
          <div class="gsv-settings-more">+ {plural(hiddenCount, "MORE ITEM")}</div>
        ) : null}
      </div>
    </section>
  );
}

function SettingsOverviewDashboard({
  data,
  counts,
  refreshing,
}: {
  data: ConsoleOverviewData;
  counts: ConsoleOverviewCounts | null;
  refreshing: boolean;
}) {
  const attentionRows = buildAttentionRows(data);
  const targets = [...data.targets].sort(targetSort);
  const adapters = [...data.adapters].sort(adapterSort);
  const applications = data.packages.filter(isApplicationPackage).sort(packageSort);
  const integrationPackages = data.packages.filter((pkg) => !isApplicationPackage(pkg)).sort(packageSort);
  const accounts = [...data.accounts].sort(
    (left, right) => Number(right.runnable) - Number(left.runnable) || left.username.localeCompare(right.username),
  );
  const config = [...data.config].sort(configSort);
  const processes = [...data.processes].sort(compareProcesses);
  const redactedConfig = data.config.filter((entry) => entry.redacted).length;
  const runningProcesses = data.processes.filter(isRunningProcess).length;
  const queuedProcesses = data.processes.filter(isQueuedProcess).length;
  const connectedAdapters = data.adapters.filter((adapter) => adapter.connected).length;
  const enabledIntegrationPackages = integrationPackages.filter((pkg) => pkg.enabled).length;
  const enabledApplications = applications.filter((pkg) => pkg.enabled).length;

  return (
    <div class="gsv-settings-overview">
      <SettingsSection
        title="ATTENTION"
        meta={refreshing ? "REFRESHING" : plural(attentionRows.length, "ITEM")}
        rows={attentionRows}
        emptyLabel="NO OPERATOR ATTENTION"
        limit={ATTENTION_LIMIT}
        attention
      />
      <div class="gsv-settings-grid">
        <div class="gsv-settings-column">
          <SettingsSection
            title="MACHINES"
            meta={
              `${counts?.onlineTargets ?? data.targets.filter((target) => target.online).length}/${counts?.targets ?? data.targets.length} ONLINE`
            }
            rows={targets.map((target) => rowFromTarget(target))}
            emptyLabel="NO MACHINES"
          />
          <SettingsSection
            title="MESSENGERS / ADAPTERS"
            meta={`${counts?.connectedAdapterAccounts ?? connectedAdapters}/${counts?.adapterAccounts ?? data.adapters.length} CONNECTED`}
            rows={adapters.map((adapter) => rowFromAdapter(adapter))}
            emptyLabel="NO ADAPTER ACCOUNTS"
          />
          <SettingsSection
            title="INTEGRATIONS / PACKAGES"
            meta={`${enabledIntegrationPackages}/${integrationPackages.length} ENABLED`}
            rows={integrationPackages.map((pkg) => rowFromPackage(pkg))}
            emptyLabel="NO INTEGRATION PACKAGES"
          />
          <SettingsSection
            title="APPLICATIONS"
            meta={`${enabledApplications}/${applications.length} ENABLED`}
            rows={applications.map((pkg) => rowFromPackage(pkg))}
            emptyLabel="NO APPLICATIONS"
          />
        </div>
        <div class="gsv-settings-column">
          <SettingsSection
            title="CREW"
            meta={
              `${counts?.runnableAccounts ?? data.accounts.filter((account) => account.runnable).length}/${counts?.accounts ?? data.accounts.length} RUNNABLE`
            }
            rows={accounts.map((account) => rowFromAccount(account))}
            emptyLabel="NO ACCOUNTS"
          />
          <SettingsSection
            title="MODELS / CONFIG"
            meta={`${counts?.configEntries ?? data.config.length} ENTRIES · ${redactedConfig} REDACTED`}
            rows={config.map((entry) => rowFromConfig(entry))}
            emptyLabel="NO CONFIG ENTRIES"
          />
          <SettingsSection
            title="RUNTIME / TASKS"
            meta={`${counts?.activeProcesses ?? runningProcesses} RUNNING · ${counts?.queuedProcesses ?? queuedProcesses} QUEUED`}
            rows={processes.map((process) => rowFromProcess(process))}
            emptyLabel="NO PROCESSES"
          />
        </div>
      </div>
    </div>
  );
}

export function ConsoleOverviewPage() {
  const overview = useConsoleOverview();

  return (
    <ConsolePage>
      <ConsoleResourceBoundary
        resource={overview.resource}
        emptyLabel="NO CONSOLE DATA"
        errorLabel="CONSOLE OVERVIEW"
        render={(data) => (
          <SettingsOverviewDashboard
            data={data}
            counts={overview.counts}
            refreshing={overview.resource.isRefreshing}
          />
        )}
      />
    </ConsolePage>
  );
}
