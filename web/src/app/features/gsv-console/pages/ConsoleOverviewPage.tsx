import { AgentImage } from "../../../components/ui/AgentImage";
import { Icon } from "../../../components/ui/Icon";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { StatusDot, type StatusTone } from "../../../components/ui/StatusDot";
import { Tag, type TagTone } from "../../../components/ui/Tag";
import {
  ConsolePage,
  ConsoleResourceBoundary,
} from "../components/ConsolePageTemplate";
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
import { useConsoleOverview } from "../hooks/useConsoleData";
import "./ConsoleOverviewPage.css";

type OverviewRow = {
  id: string;
  icon?: string;
  label: string;
  meta?: string;
  tone: StatusTone;
  statusLabel?: string;
  tag?: {
    label: string;
    tone: TagTone;
  };
};

type CrewCard = {
  id: string;
  name: string;
  meta: string;
  tone: StatusTone;
  statusLabel: string;
};

type StatLine = {
  label: string;
  value: number | string;
  tone: StatusTone;
};

const DASHBOARD_ROW_LIMIT = 5;
const SHIP_ART = String.raw`
        .:++***++:.
     .=############=.
   .+################+.
  .####################.
  +####################+
  *####################*
  +####################+
  .####################.
   .+################+.
     .=############=.
        .:++***++:.
`;

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

function clampLabel(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function packageStatus(pkg: ConsolePackage): Pick<OverviewRow, "statusLabel" | "tag" | "tone"> {
  if (pkg.reviewPending) {
    return {
      tone: "update",
      statusLabel: "REVIEW",
      tag: { label: "UPDATE", tone: "update" },
    };
  }
  if (pkg.enabled) {
    return { tone: "online", statusLabel: "ONLINE" };
  }
  return { tone: "idle", statusLabel: "IDLE" };
}

function processTone(process: ConsoleProcess): StatusTone {
  if (isQueuedProcess(process)) return "update";
  if (isRunningProcess(process)) return "live";
  if (process.state === "unknown") return "warn";
  return "idle";
}

function processStatus(process: ConsoleProcess): string {
  if (isQueuedProcess(process)) return "QUEUED";
  if (isRunningProcess(process)) return "RUNNING";
  if (process.state === "unknown") return "UNKNOWN";
  return "IDLE";
}

function targetRow(target: ConsoleTarget): OverviewRow {
  return {
    id: target.deviceId,
    label: clampLabel(target.label, target.deviceId),
    meta: joinMeta([target.platform, target.ownerUsername]),
    tone: target.online ? "online" : "idle",
    statusLabel: target.online ? "ONLINE" : "IDLE",
  };
}

function adapterRow(adapter: ConsoleAdapterAccount): OverviewRow {
  const hasError = adapter.error.trim().length > 0;
  const connected = adapter.connected && !hasError;
  return {
    id: `${adapter.adapter}:${adapter.accountId}`,
    icon: adapter.adapter === "telegram" ? "telegram" : adapter.adapter === "discord" ? "discord" : "chat",
    label: adapter.adapter,
    meta: joinMeta([adapter.accountId, adapter.mode, adapter.error]),
    tone: connected ? "online" : hasError ? "error" : "idle",
    statusLabel: connected ? "ONLINE" : hasError ? "ERROR" : "IDLE",
  };
}

function integrationRow(pkg: ConsolePackage): OverviewRow {
  return {
    id: pkg.packageId,
    icon: "cog",
    label: pkg.name,
    meta: joinMeta([pkg.runtime, pkg.sourceRepo]),
    ...packageStatus(pkg),
  };
}

function applicationRow(pkg: ConsolePackage): OverviewRow {
  return {
    id: pkg.packageId,
    icon: "rss",
    label: pkg.name,
    meta: joinMeta([pkg.scopeKind, pkg.version]),
    ...packageStatus(pkg),
  };
}

function accountStatus(account: ConsoleAccount, processes: readonly ConsoleProcess[]): Pick<CrewCard, "meta" | "statusLabel" | "tone"> {
  const ownedProcesses = processes.filter((process) => process.username === account.username);
  const running = ownedProcesses.some(isRunningProcess);
  const queued = ownedProcesses.some(isQueuedProcess);
  const unknown = ownedProcesses.some((process) => process.state === "unknown");

  if (queued) {
    return { meta: "queued", statusLabel: "QUEUED", tone: "update" };
  }
  if (running) {
    return { meta: "running", statusLabel: "RUNNING", tone: "live" };
  }
  if (unknown) {
    return { meta: "needs review", statusLabel: "UNKNOWN", tone: "warn" };
  }
  return {
    meta: account.runnable ? "runnable" : account.relation,
    statusLabel: account.runnable ? "IDLE" : "ACCOUNT",
    tone: account.runnable ? "idle" : "idle",
  };
}

function crewCards(accounts: readonly ConsoleAccount[], processes: readonly ConsoleProcess[]): CrewCard[] {
  return [...accounts]
    .sort((left, right) => Number(right.runnable) - Number(left.runnable) || left.username.localeCompare(right.username))
    .slice(0, 3)
    .map((account) => ({
      id: String(account.uid),
      name: account.displayName,
      ...accountStatus(account, processes),
    }));
}

function sortTargets(targets: readonly ConsoleTarget[]): ConsoleTarget[] {
  return [...targets].sort((left, right) => Number(right.online) - Number(left.online) || left.label.localeCompare(right.label));
}

function sortAdapters(adapters: readonly ConsoleAdapterAccount[]): ConsoleAdapterAccount[] {
  return [...adapters].sort((left, right) => Number(right.connected) - Number(left.connected) || left.adapter.localeCompare(right.adapter));
}

function sortPackages(packages: readonly ConsolePackage[]): ConsolePackage[] {
  return [...packages].sort((left, right) => {
    if (left.reviewPending !== right.reviewPending) return left.reviewPending ? -1 : 1;
    if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

function findDefaultModel(config: readonly ConsoleConfigEntry[]): string {
  const entry = config.find((item) => !item.redacted && item.value && /(^|[/.])model($|[/.])|default.*model|model.*default/i.test(item.key));
  return entry?.value ? entry.value : "GATEWAY DEFAULT";
}

function scanCode(data: ConsoleOverviewData): string {
  const seed = data.loadedAt + data.processes.length * 17 + data.targets.length * 31 + data.packages.length * 47;
  return `0x${(seed % 255).toString(16).padStart(2, "0").toUpperCase()}`;
}

function rowLimit<T>(rows: readonly T[], limit = DASHBOARD_ROW_LIMIT): readonly T[] {
  return rows.slice(0, limit);
}

function Chevron() {
  return <span class="gsv-settings-chevron" aria-hidden="true" />;
}

function MiniHeading({ title, meta }: { title: string; meta?: string }) {
  return (
    <div class="gsv-settings-mini-heading">
      <span>{title}</span>
      {meta ? <small>{meta}</small> : null}
      <Chevron />
    </div>
  );
}

function MiniRow({ row, showIcon = true }: { row: OverviewRow; showIcon?: boolean }) {
  return (
    <div class="gsv-settings-mini-row">
      {showIcon ? (
        <span class="gsv-settings-mini-icon">
          {row.icon ? <Icon name={row.icon} size={18} /> : <StatusDot tone={row.tone} size={8} />}
        </span>
      ) : (
        <StatusDot tone={row.tone} size={8} />
      )}
      <span class="gsv-settings-mini-copy">
        <strong>{row.label}</strong>
        {row.meta ? <small>{row.meta}</small> : null}
      </span>
      {row.tag ? <Tag label={row.tag.label} tone={row.tag.tone} boxed /> : null}
      {row.statusLabel ? <span class={`gsv-settings-status is-${row.tone}`}>{row.statusLabel}</span> : null}
    </div>
  );
}

function EmptyRow({ label }: { label: string }) {
  return (
    <div class="gsv-settings-empty-row">
      <StatusDot tone="idle" size={7} />
      <span>{label}</span>
    </div>
  );
}

function AddRow({ label }: { label: string }) {
  return (
    <div class="gsv-settings-add-row">
      <Icon name="plus" size={15} />
      <span>{label}</span>
      <Chevron />
    </div>
  );
}

function SplitCells({ left, right }: { left: preact.ComponentChildren; right: preact.ComponentChildren }) {
  return (
    <div class="gsv-settings-split">
      <div>{left}</div>
      <div>{right}</div>
    </div>
  );
}

function ShipPanel({
  config,
  data,
  shellTargetCount,
}: {
  config: readonly ConsoleConfigEntry[];
  data: ConsoleOverviewData;
  shellTargetCount: number;
}) {
  const redacted = config.filter((entry) => entry.redacted).length;
  const configured = config.filter((entry) => entry.value && !entry.redacted).length;

  return (
    <section class="gsv-settings-block gsv-settings-ship-block">
      <SectionHeader title="THE SHIP" divider />
      <div class="gsv-settings-ship-visual">
        <pre aria-hidden="true">{SHIP_ART}</pre>
        <span class="gsv-settings-scan">SCAN {scanCode(data)}</span>
        <span class="gsv-settings-ship-id">GSV-01</span>
      </div>
      <SplitCells
        left={(
          <div class="gsv-settings-mini-cell">
            <MiniHeading title="TERMINAL" />
            <div class="gsv-settings-terminal-state">
              <span class="gsv-settings-check" aria-hidden="true" />
              <span>{shellTargetCount > 0 ? `${shellTargetCount} SHELL TARGET${shellTargetCount === 1 ? "" : "S"}` : "NO SHELL TARGETS"}</span>
            </div>
          </div>
        )}
        right={(
          <div class="gsv-settings-mini-cell">
            <MiniHeading title="OVERRIDES" />
            <div class="gsv-settings-overrides-state">
              <span>{configured > 0 ? `${configured} CONFIGURED` : "NOT CONFIGURED"}</span>
              {redacted > 0 ? <Tag label={`${redacted} REDACTED`} tone="warn" boxed /> : null}
            </div>
          </div>
        )}
      />
    </section>
  );
}

function CrewPanel({
  accounts,
  processes,
}: {
  accounts: readonly ConsoleAccount[];
  processes: readonly ConsoleProcess[];
}) {
  const cards = crewCards(accounts, processes);
  const remaining = Math.max(0, accounts.length - cards.length);

  return (
    <section class="gsv-settings-block gsv-settings-crew-block">
      <SectionHeader title="CREW" meta={remaining > 0 ? `+${remaining}` : ""} divider />
      <div class="gsv-settings-crew-grid">
        {cards.length === 0 ? <EmptyRow label="NO CREW ACCOUNTS" /> : cards.map((card, index) => (
          <div class="gsv-settings-crew-card" key={card.id}>
            <div class="gsv-settings-crew-portrait">
              <AgentImage agent={index % 3} size={54} />
            </div>
            <strong>{card.name}</strong>
            <span>
              <StatusDot tone={card.tone} size={8} />
              {card.statusLabel}
            </span>
          </div>
        ))}
        <div class="gsv-settings-new-agent">
          <span>
            <Icon name="plus" size={16} />
          </span>
          <strong>NEW AGENT</strong>
        </div>
      </div>
    </section>
  );
}

function ModelsTasksPanel({
  config,
  counts,
  processes,
}: {
  config: readonly ConsoleConfigEntry[];
  counts: ConsoleOverviewCounts | null;
  processes: readonly ConsoleProcess[];
}) {
  const running = counts?.activeProcesses ?? processes.filter(isRunningProcess).length;
  const queued = counts?.queuedProcesses ?? processes.filter(isQueuedProcess).length;
  const idle = Math.max(0, processes.length - running - queued);
  const model = findDefaultModel(config);
  const modelCount = config.filter((entry) => /model/i.test(entry.key)).length;
  const stats: StatLine[] = [
    { label: "RUNNING", value: running, tone: running > 0 ? "live" : "idle" },
    { label: "QUEUED", value: queued, tone: queued > 0 ? "update" : "idle" },
    { label: "IDLE", value: idle, tone: "idle" },
  ];

  return (
    <SplitCells
      left={(
        <div class="gsv-settings-deep-cell">
          <MiniHeading title="MODELS" />
          <div class="gsv-settings-model-summary">
            <span>DEFAULT: <strong>{model}</strong></span>
            <small>{modelCount > 1 ? `+ ${modelCount - 1} OTHER MODEL SETTINGS` : `${config.length} CONFIG ENTRIES`}</small>
          </div>
          <Chevron />
        </div>
      )}
      right={(
        <div class="gsv-settings-deep-cell">
          <MiniHeading title="TASKS" />
          <div class="gsv-settings-task-summary">
            {stats.map((stat) => (
              <span key={stat.label}>
                <StatusDot tone={stat.tone} size={8} />
                {stat.label} · {stat.value}
              </span>
            ))}
          </div>
          <Chevron />
        </div>
      )}
    />
  );
}

function FleetPanel({
  adapters,
  integrationPackages,
  targets,
}: {
  adapters: readonly ConsoleAdapterAccount[];
  integrationPackages: readonly ConsolePackage[];
  targets: readonly ConsoleTarget[];
}) {
  const targetRows = sortTargets(targets).map(targetRow);
  const adapterRows = sortAdapters(adapters).map(adapterRow);
  const integrationRows = sortPackages(integrationPackages).map(integrationRow);

  return (
    <section class="gsv-settings-block gsv-settings-fleet-block">
      <SectionHeader title="FLEET" divider />
      <MiniHeading title="MACHINES" meta={`${targets.filter((target) => target.online).length}/${targets.length} ONLINE`} />
      <div class="gsv-settings-section-rows">
        {targetRows.length === 0 ? <EmptyRow label="NO MACHINES" /> : rowLimit(targetRows, 3).map((row) => (
          <MiniRow key={row.id} row={row} showIcon={false} />
        ))}
        <AddRow label="CONNECT NEW MACHINE" />
      </div>
      <SplitCells
        left={(
          <div class="gsv-settings-mini-cell">
            <MiniHeading title="MESSENGERS" meta={`${adapters.filter((adapter) => adapter.connected).length}/${adapters.length}`} />
            {adapterRows.length === 0 ? <EmptyRow label="NO MESSENGERS" /> : rowLimit(adapterRows, 3).map((row) => (
              <MiniRow key={row.id} row={row} />
            ))}
          </div>
        )}
        right={(
          <div class="gsv-settings-mini-cell">
            <MiniHeading title="INTEGRATIONS" meta={`${integrationPackages.filter((pkg) => pkg.enabled).length}/${integrationPackages.length}`} />
            {integrationRows.length === 0 ? <EmptyRow label="NO INTEGRATIONS" /> : rowLimit(integrationRows, 2).map((row) => (
              <MiniRow key={row.id} row={row} />
            ))}
            <AddRow label="NEW INTEGRATION" />
          </div>
        )}
      />
    </section>
  );
}

function SatellitesPanel({ applications }: { applications: readonly ConsolePackage[] }) {
  const rows = sortPackages(applications).map(applicationRow);

  return (
    <section class="gsv-settings-block gsv-settings-satellites-block">
      <SectionHeader title="SATELLITES" divider />
      <MiniHeading title="APPLICATIONS" meta={`${applications.filter((pkg) => pkg.enabled).length}/${applications.length} ONLINE`} />
      <div class="gsv-settings-section-rows">
        {rows.length === 0 ? <EmptyRow label="NO APPLICATIONS" /> : rowLimit(rows, 5).map((row) => (
          <MiniRow key={row.id} row={row} />
        ))}
        <AddRow label="NEW APPLICATION" />
      </div>
    </section>
  );
}

function SettingsOverviewDashboard({
  counts,
  data,
}: {
  counts: ConsoleOverviewCounts | null;
  data: ConsoleOverviewData;
}) {
  const applications = data.packages.filter(isApplicationPackage);
  const integrationPackages = data.packages.filter((pkg) => !isApplicationPackage(pkg));
  const shellTargetCount = data.targets.filter((target) => target.online && target.implements.some((item) => item === "shell.exec" || item === "shell.*")).length;

  return (
    <div class="gsv-settings-overview" aria-label="GSV settings overview">
      <div class="gsv-settings-left">
        <ShipPanel config={data.config} data={data} shellTargetCount={shellTargetCount} />
        <CrewPanel accounts={data.accounts} processes={data.processes} />
        <ModelsTasksPanel config={data.config} counts={counts} processes={data.processes} />
      </div>
      <div class="gsv-settings-right">
        <FleetPanel adapters={data.adapters} integrationPackages={integrationPackages} targets={data.targets} />
        <SatellitesPanel applications={applications} />
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
            counts={overview.counts}
            data={data}
          />
        )}
      />
    </ConsolePage>
  );
}
