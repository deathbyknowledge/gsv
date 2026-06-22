import { useConsoleOverview } from "../hooks/useConsoleData";
import {
  ConsolePage,
  ConsoleResourceBoundary,
  ConsoleSection,
  rowsFromAccounts,
  rowsFromAdapters,
  rowsFromPackages,
  rowsFromProcesses,
  rowsFromTargets,
} from "../components/ConsolePageTemplate";
import { Icon } from "../../../components/ui/Icon";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { StatusDot, type StatusTone } from "../../../components/ui/StatusDot";
import { Tag, type TagTone } from "../../../components/ui/Tag";
import type { ConsoleOverviewCounts, ConsoleOverviewData, ConsolePackage } from "../domain/consoleModels";
import "./ConsoleOverviewPage.css";

type MetricProps = {
  label: string;
  value: number | string;
  meta: string;
  tone?: StatusTone;
};

type MiniRowProps = {
  icon: string;
  label: string;
  meta: string;
  tone: StatusTone;
  status: string;
  tag?: {
    label: string;
    tone: TagTone;
  };
};

function isApplicationPackage(pkg: ConsolePackage): boolean {
  return pkg.runtime === "web-ui" || pkg.uiEntrypoints.length > 0;
}

function Metric({
  label,
  value,
  meta,
  tone = "online",
}: MetricProps) {
  return (
    <div class="gsv-settings-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>
        <StatusDot tone={tone} size={7} />
        {meta}
      </small>
    </div>
  );
}

function MiniRow({
  icon,
  label,
  meta,
  tone,
  status,
  tag,
}: MiniRowProps) {
  return (
    <div class="gsv-settings-row">
      <span class="gsv-settings-row-icon">
        <Icon name={icon} size={17} />
      </span>
      <span class="gsv-settings-row-main">
        <strong>{label}</strong>
        <small>{meta}</small>
      </span>
      {tag ? <Tag label={tag.label} tone={tag.tone} boxed /> : null}
      <span class="gsv-settings-row-status">
        <StatusDot tone={tone} size={7} />
        {status}
      </span>
    </div>
  );
}

function EmptyRows({ label }: { label: string }) {
  return <div class="gsv-settings-empty">{label}</div>;
}

function SettingsHero({
  data,
  counts,
  refreshing,
}: {
  data: ConsoleOverviewData;
  counts: ConsoleOverviewCounts | null;
  refreshing: boolean;
}) {
  const attention = [
    counts?.reviewPendingPackages ? `${counts.reviewPendingPackages} package review` : "",
    data.targets.some((target) => !target.online) ? `${data.targets.filter((target) => !target.online).length} offline target` : "",
    data.adapters.some((adapter) => !adapter.connected || adapter.error) ? `${data.adapters.filter((adapter) => !adapter.connected || adapter.error).length} adapter issue` : "",
    counts?.queuedProcesses ? `${counts.queuedProcesses} queued run` : "",
  ].filter(Boolean);

  return (
    <section class="gsv-settings-ship">
      <SectionHeader title="THE SHIP" meta={refreshing ? "REFRESHING" : "LIVE OVERVIEW"} divider />
      <div class="gsv-settings-ship-visual">
        <div class="gsv-settings-ship-mark" aria-hidden="true">
          <Icon name="stars" size={52} />
        </div>
        <div>
          <span>GSV CONTROL</span>
          <strong>{attention.length === 0 ? "SYSTEMS NOMINAL" : `${attention.length} ATTENTION ITEMS`}</strong>
          <small>{attention.length === 0 ? "No review, adapter, queue, or target alerts." : attention.join(" · ")}</small>
        </div>
      </div>
      <div class="gsv-settings-metrics">
        <Metric label="RUNTIME" value={counts?.processes ?? 0} meta={`${counts?.activeProcesses ?? 0} active`} tone={(counts?.activeProcesses ?? 0) > 0 ? "live" : "idle"} />
        <Metric label="FLEET" value={counts?.targets ?? 0} meta={`${counts?.onlineTargets ?? 0} online`} tone={(counts?.onlineTargets ?? 0) > 0 ? "online" : "idle"} />
        <Metric label="PACKAGES" value={counts?.packages ?? 0} meta={`${counts?.reviewPendingPackages ?? 0} review`} tone={(counts?.reviewPendingPackages ?? 0) > 0 ? "update" : "online"} />
        <Metric label="CREW" value={counts?.accounts ?? 0} meta={`${counts?.runnableAccounts ?? 0} runnable`} tone={(counts?.runnableAccounts ?? 0) > 0 ? "online" : "idle"} />
      </div>
    </section>
  );
}

function RuntimePanel({ data }: { data: ConsoleOverviewData }) {
  const running = data.processes.filter((process) => process.state === "running").length;
  const queued = data.processes.filter((process) => process.state === "queued" || process.queuedCount > 0).length;
  const idle = Math.max(0, data.processes.length - running - queued);

  return (
    <section class="gsv-settings-panel">
      <SectionHeader title="RUNTIME" meta={`${data.processes.length} PROCESSES`} divider />
      <div class="gsv-settings-status-grid">
        <Metric label="RUNNING" value={running} meta="active runs" tone={running > 0 ? "live" : "idle"} />
        <Metric label="QUEUED" value={queued} meta="waiting" tone={queued > 0 ? "update" : "idle"} />
        <Metric label="IDLE" value={idle} meta="available" tone="idle" />
      </div>
      <div class="gsv-settings-row-stack">
        {rowsFromProcesses(data.processes).slice(0, 4).map((row) => (
          <MiniRow key={row.id} icon={row.icon} label={row.label} meta={row.sub || row.id} tone={row.tone} status={row.statusLabel} />
        ))}
        {data.processes.length === 0 ? <EmptyRows label="NO PROCESSES" /> : null}
      </div>
    </section>
  );
}

function CrewPanel({ data }: { data: ConsoleOverviewData }) {
  const rows = rowsFromAccounts(data.accounts).slice(0, 4);

  return (
    <section class="gsv-settings-panel">
      <SectionHeader title="CREW" meta={`${data.accounts.length} ACCOUNTS`} divider />
      <div class="gsv-settings-crew-grid">
        {rows.length === 0 ? <EmptyRows label="NO ACCOUNTS" /> : rows.map((row) => (
          <MiniRow key={row.id} icon={row.icon} label={row.label} meta={row.sub || row.id} tone={row.tone} status={row.statusLabel} />
        ))}
      </div>
    </section>
  );
}

function ConfigPanel({ data }: { data: ConsoleOverviewData }) {
  const redacted = data.config.filter((entry) => entry.redacted).length;

  return (
    <section class="gsv-settings-panel">
      <SectionHeader title="CONFIG" meta={`${data.config.length} ENTRIES`} divider />
      <div class="gsv-settings-config">
        <MiniRow
          icon="cog"
          label="Runtime configuration"
          meta={redacted > 0 ? `${redacted} redacted values` : "No redacted values returned"}
          tone={data.config.length > 0 ? "online" : "idle"}
          status={data.config.length > 0 ? "LOADED" : "EMPTY"}
        />
      </div>
    </section>
  );
}

function FleetPanel({ data }: { data: ConsoleOverviewData }) {
  const rows = rowsFromTargets(data.targets).slice(0, 6);

  return (
    <section class="gsv-settings-panel">
      <SectionHeader title="FLEET" meta={`${data.targets.filter((target) => target.online).length}/${data.targets.length} ONLINE`} divider />
      <div class="gsv-settings-row-stack">
        {rows.length === 0 ? <EmptyRows label="NO TARGETS" /> : rows.map((row) => (
          <MiniRow key={row.id} icon={row.icon} label={row.label} meta={row.sub || row.id} tone={row.tone} status={row.statusLabel} />
        ))}
      </div>
    </section>
  );
}

function IntegrationsPanel({ data }: { data: ConsoleOverviewData }) {
  const adapterRows = rowsFromAdapters(data.adapters).slice(0, 4);
  const integrationPackages = data.packages.filter((pkg) => !isApplicationPackage(pkg));
  const integrationRows = rowsFromPackages(integrationPackages).slice(0, 4);

  return (
    <section class="gsv-settings-panel">
      <SectionHeader title="INTEGRATIONS" meta={`${data.adapters.length + integrationPackages.length} SURFACES`} divider />
      <div class="gsv-settings-row-stack">
        {[...adapterRows, ...integrationRows].slice(0, 6).map((row) => (
          <MiniRow
            key={row.id}
            icon={row.icon}
            label={row.label}
            meta={row.sub || row.id}
            tone={row.tone}
            status={row.statusLabel}
            tag={row.tag}
          />
        ))}
        {adapterRows.length + integrationRows.length === 0 ? <EmptyRows label="NO INTEGRATIONS" /> : null}
      </div>
    </section>
  );
}

function ApplicationsPanel({ data }: { data: ConsoleOverviewData }) {
  const applications = data.packages.filter(isApplicationPackage);
  const rows = rowsFromPackages(applications).slice(0, 6);

  return (
    <section class="gsv-settings-panel">
      <SectionHeader title="APPLICATIONS" meta={`${applications.length} WEB PACKAGES`} divider />
      <div class="gsv-settings-row-stack">
        {rows.length === 0 ? <EmptyRows label="NO APPLICATIONS" /> : rows.map((row) => (
          <MiniRow
            key={row.id}
            icon={row.icon}
            label={row.label}
            meta={row.sub || row.id}
            tone={row.tone}
            status={row.statusLabel}
            tag={row.tag}
          />
        ))}
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
  return (
    <div class="gsv-settings-dashboard">
      <div class="gsv-settings-column">
        <SettingsHero data={data} counts={counts} refreshing={refreshing} />
        <RuntimePanel data={data} />
        <CrewPanel data={data} />
        <ConfigPanel data={data} />
      </div>
      <div class="gsv-settings-column">
        <FleetPanel data={data} />
        <IntegrationsPanel data={data} />
        <ApplicationsPanel data={data} />
        <ConsoleSection
          title="PACKAGES"
          meta={`${data.packages.length}`}
          rows={rowsFromPackages(data.packages).slice(0, 5)}
          emptyLabel="NO PACKAGES"
        />
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
