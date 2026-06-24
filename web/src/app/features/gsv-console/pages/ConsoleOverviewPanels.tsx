import type { ComponentChildren, JSX } from "preact";
import { AddAction } from "../../../components/ui/AddAction";
import { AsciiPlanet } from "../../../components/ui/AsciiPlanet";
import { Checkbox } from "../../../components/ui/Checkbox";
import { CrewAddTile, CrewTile } from "../../../components/ui/CrewTile";
import { ListRow, type ListRowStatus } from "../../../components/ui/ListRow";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { StatusDot, type StatusTone } from "../../../components/ui/StatusDot";
import { Surface } from "../../../components/ui/Surface";
import type { TagTone } from "../../../components/ui/Tag";
import {
  defaultModelLabelForConfig,
  modelConfigCount,
  overrideConfigEntries,
} from "../domain/consoleAi";
import type { ConsoleListKind } from "../domain/consoleListTypes";
import {
  agentImageSrcForIndex,
  sortedConsoleAccounts,
} from "../domain/agentPresentation";
import type {
  ConsoleAccount,
  ConsoleAdapterAccount,
  ConsoleConfigEntry,
  ConsoleMcpServer,
  ConsoleOverviewCounts,
  ConsoleOverviewData,
  ConsolePackage,
  ConsoleProcess,
  ConsoleTarget,
} from "../domain/consoleModels";
import type { ShellSurfaceId } from "../../gsv-shell/domain/shellModel";
import { isNativeWebPackageName } from "../../packages/nativePackages";
import { useTerminalRunInBackgroundPreference } from "../../terminal/hooks/useTerminalPreferences";

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
  accountUid: number;
  name: string;
  meta: string;
  imageSrc: string;
  tone: StatusTone;
  statusLabel: string;
};

type StatLine = {
  label: string;
  value: number | string;
  tone: StatusTone;
};

type OverviewSurface = Exclude<ShellSurfaceId, "desktop" | "app">;
export type ConsoleOverviewTarget = OverviewSurface | "models" | "new-agent" | "overrides" | "tasks";
export type OpenSurface = (surface: ConsoleOverviewTarget) => void;
export type OpenAgent = (accountUid: number) => void;
export type OpenListDetail = (kind: ConsoleListKind, detailId: string, detailLabel?: string) => void;
export type OpenListCreate = (kind: ConsoleListKind) => void;

const DASHBOARD_ROW_LIMIT = 5;
const OVERVIEW_ROW_STYLE: JSX.CSSProperties = {
  minHeight: "44px",
  padding: "13px 16px",
};
const OVERVIEW_STATE_ROW_STYLE: JSX.CSSProperties = {
  minHeight: "55px",
  padding: "15px 16px",
};

function listRowStatus(tone: StatusTone): ListRowStatus {
  return tone;
}

function isApplicationPackage(pkg: ConsolePackage): boolean {
  return pkg.runtime === "web-ui" || pkg.uiEntrypoints.length > 0;
}

function isNativeConsolePackage(pkg: ConsolePackage): boolean {
  return isNativeWebPackageName(pkg.name) || isNativeWebPackageName(pkg.packageId);
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

function targetRow(target: ConsoleTarget): OverviewRow {
  return {
    id: target.deviceId,
    label: clampLabel(target.label, target.deviceId),
    tone: target.online ? "online" : "idle",
    statusLabel: target.online ? "ONLINE" : "IDLE",
  };
}

function adapterRow(adapter: ConsoleAdapterAccount): OverviewRow {
  const hasError = adapter.error.trim().length > 0;
  const connected = adapter.connected && !hasError;
  const accountLabel = adapter.accountId.trim();
  return {
    id: `${adapter.adapter}:${adapter.accountId}`,
    icon: adapter.adapter === "telegram" ? "telegram" : adapter.adapter === "discord" ? "discord" : adapter.adapter === "whatsapp" ? "messenger" : "chat",
    label: formatTokenLabel(adapter.adapter),
    meta: joinMeta([accountLabel, hasError ? adapter.error : undefined]),
    tone: connected ? "online" : hasError ? "error" : "idle",
    statusLabel: hasError ? "ERROR" : undefined,
  };
}

function integrationRow(server: ConsoleMcpServer): OverviewRow {
  const failed = server.state === "failed" || server.error.trim().length > 0;
  const active = server.state === "authenticating" || server.state === "connecting" || server.state === "connected" || server.state === "discovering";
  const ready = server.state === "ready";
  return {
    id: server.serverId,
    icon: "weblink",
    label: server.name,
    meta: joinMeta([
      server.tools.length ? `${server.tools.length} tools` : undefined,
      server.resourceCount ? `${server.resourceCount} resources` : undefined,
      server.error,
    ]),
    tone: failed ? "error" : ready ? "online" : active ? "warn" : "idle",
    statusLabel: failed ? "ERROR" : active ? "CHECK" : ready ? undefined : "IDLE",
    tag: server.state === "authenticating" ? { label: "SIGN-IN", tone: "warn" } : undefined,
  };
}

function applicationRow(pkg: ConsolePackage): OverviewRow {
  const status = packageStatus(pkg);
  return {
    id: pkg.packageId,
    icon: "rss",
    label: pkg.name,
    meta: packageSourceLabel(pkg),
    tone: status.tone,
    tag: status.tag,
  };
}

function accountStatus(account: ConsoleAccount, processes: readonly ConsoleProcess[]): Pick<CrewCard, "meta" | "statusLabel" | "tone"> {
  const ownedProcesses = processes.filter((process) => process.uid === account.uid || process.username === account.username);
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
  return sortedConsoleAccounts(accounts)
    .slice(0, 3)
    .map((account, index) => ({
      id: String(account.uid),
      accountUid: account.uid,
      imageSrc: agentImageSrcForIndex(index),
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

function sortMcpServers(servers: readonly ConsoleMcpServer[]): ConsoleMcpServer[] {
  return [...servers].sort((left, right) => {
    const leftError = left.state === "failed" || left.error.trim().length > 0;
    const rightError = right.state === "failed" || right.error.trim().length > 0;
    if (leftError !== rightError) return leftError ? -1 : 1;
    if (left.state === "authenticating" && right.state !== "authenticating") return -1;
    if (left.state !== "authenticating" && right.state === "authenticating") return 1;
    if (left.state === "ready" && right.state !== "ready") return -1;
    if (left.state !== "ready" && right.state === "ready") return 1;
    return left.name.localeCompare(right.name);
  });
}

function formatTokenLabel(value: string): string {
  return value
    .split(/[-_.:/\s]+/g)
    .filter(Boolean)
    .map((part) => part.length <= 3 ? part.toUpperCase() : `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(" ") || "Unknown";
}

function packageSourceLabel(pkg: ConsolePackage): string {
  const sourceParts = pkg.sourceRepo.split(/[/:]/g).filter(Boolean);
  const source = sourceParts[sourceParts.length - 1] ?? "";
  return joinMeta([source, pkg.version ? `v${pkg.version}` : "", pkg.scopeKind === "unknown" ? "" : pkg.scopeKind.toUpperCase()]);
}

function rowLimit<T>(rows: readonly T[], limit = DASHBOARD_ROW_LIMIT): readonly T[] {
  return rows.slice(0, limit);
}

function shipInventoryLabel(data: ConsoleOverviewData): string {
  if (data.targets.length > 0) {
    const online = data.targets.filter((target) => target.online).length;
    return `${online}/${data.targets.length} TARGETS`;
  }
  if (data.processes.length > 0) {
    return `${data.processes.length} ${data.processes.length === 1 ? "PROCESS" : "PROCESSES"}`;
  }
  if (data.accounts.length > 0) {
    const runnable = data.accounts.filter((account) => account.runnable).length;
    return `${runnable}/${data.accounts.length} CREW`;
  }
  return "NO INVENTORY";
}

function Chevron() {
  return <span class="gsv-settings-chevron" aria-hidden="true" />;
}

function MiniHeading({
  title,
  meta,
  onClick,
  showChevron = Boolean(onClick),
}: {
  title: string;
  meta?: string;
  onClick?: () => void;
  showChevron?: boolean;
}) {
  return (
    <SectionHeader
      chevron={showChevron}
      className="gsv-settings-mini-heading"
      density="compact"
      divider
      meta={meta}
      onClick={onClick}
      title={title}
    />
  );
}

function MiniRow({ row, showIcon = true, onClick }: { row: OverviewRow; showIcon?: boolean; onClick?: () => void }) {
  const hasIcon = showIcon && Boolean(row.icon);

  return (
    <ListRow
      chevron={Boolean(onClick)}
      className="gsv-settings-mini-row"
      icon={hasIcon ? row.icon : undefined}
      iconTitle={row.label}
      label={row.label}
      onClick={onClick}
      status={listRowStatus(row.tone)}
      statusDotPlacement={hasIcon ? "trailing" : "leading"}
      statusLabel={row.statusLabel}
      style={OVERVIEW_ROW_STYLE}
      sub={row.meta}
      tag={row.tag?.label}
      tagTone={row.tag?.tone}
    />
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

function AddRow({ label, onClick }: { label: string; onClick?: () => void }) {
  return (
    <div class="gsv-settings-add-action">
      <AddAction label={label} onClick={onClick} variant="row" />
    </div>
  );
}

function SplitCells({
  className = "",
  left,
  right,
}: {
  className?: string;
  left: ComponentChildren;
  right: ComponentChildren;
}) {
  return (
    <div class={`gsv-settings-split${className ? ` ${className}` : ""}`}>
      <div>{left}</div>
      <div>{right}</div>
    </div>
  );
}

function ActionSectionHeader({
  meta,
  onClick,
  title,
}: {
  meta?: string;
  onClick?: () => void;
  title: string;
}) {
  return (
    <SectionHeader
      chevron={Boolean(onClick)}
      className="gsv-settings-action-header"
      divider
      meta={meta}
      onClick={onClick}
      title={title}
    />
  );
}

function ShipPanel({
  config,
  data,
  onOpenSurface,
  terminalBackground,
  onTerminalBackgroundChange,
}: {
  config: readonly ConsoleConfigEntry[];
  data: ConsoleOverviewData;
  onOpenSurface?: OpenSurface;
  terminalBackground: boolean;
  onTerminalBackgroundChange: (enabled: boolean) => void;
}) {
  const overrides = overrideConfigEntries(config);
  const redacted = overrides.filter((entry) => entry.redacted).length;
  const configured = overrides.filter((entry) => entry.value && !entry.redacted).length;

  return (
    <section class="gsv-settings-block gsv-settings-ship-block">
      <SectionHeader title="THE SHIP" divider />
      <div class="gsv-settings-ship-visual">
        <div class="gsv-settings-ship-orbit">
          <AsciiPlanet variant="moon" formDuration={3.4} label="GSV ship scan" />
        </div>
        <span class="gsv-settings-scan">{shipInventoryLabel(data)}</span>
        <span class="gsv-settings-ship-id">GSV</span>
      </div>
      <SplitCells
        left={(
          <div class="gsv-settings-mini-cell">
            <MiniHeading title="TERMINAL" />
            <div class="gsv-settings-terminal-state">
              <Checkbox
                checked={terminalBackground}
                label="RUN IN BACKGROUND"
                size="medium"
                onChange={onTerminalBackgroundChange}
              />
            </div>
          </div>
        )}
        right={(
          <div class="gsv-settings-mini-cell">
            <MiniHeading title="OVERRIDES" />
            <ListRow
              chevron={Boolean(onOpenSurface)}
              className="gsv-settings-overrides-state"
              label={configured > 0 ? `${configured} CONFIGURED` : "NOT CONFIGURED"}
              onClick={onOpenSurface ? () => onOpenSurface("overrides") : undefined}
              status="none"
              style={OVERVIEW_STATE_ROW_STYLE}
              tag={redacted > 0 ? `${redacted} REDACTED` : undefined}
              tagTone="warn"
            />
          </div>
        )}
      />
    </section>
  );
}

function CrewPanel({
  accounts,
  onOpenAgent,
  onOpenSurface,
  processes,
}: {
  accounts: readonly ConsoleAccount[];
  onOpenAgent?: OpenAgent;
  onOpenSurface?: OpenSurface;
  processes: readonly ConsoleProcess[];
}) {
  const cards = crewCards(accounts, processes);

  return (
    <section class="gsv-settings-block gsv-settings-crew-block">
      <ActionSectionHeader
        title="CREW"
        onClick={onOpenSurface ? () => onOpenSurface("crew") : undefined}
      />
      <div class="gsv-settings-crew-grid">
        {cards.length === 0 ? <EmptyRow label="NO CREW ACCOUNTS" /> : cards.map((card) => (
          <CrewTile
            imageSrc={card.imageSrc}
            key={card.id}
            name={card.name}
            onClick={onOpenAgent
              ? () => onOpenAgent(card.accountUid)
              : onOpenSurface
                ? () => onOpenSurface("crew")
                : undefined}
            statusLabel={card.statusLabel}
            tone={card.tone}
          />
        ))}
        <CrewAddTile
          label="NEW AGENT"
          onClick={onOpenSurface ? () => onOpenSurface("new-agent") : undefined}
        />
      </div>
    </section>
  );
}

function ModelsTasksPanel({
  config,
  counts,
  onOpenSurface,
  processes,
}: {
  config: readonly ConsoleConfigEntry[];
  counts: ConsoleOverviewCounts | null;
  onOpenSurface?: OpenSurface;
  processes: readonly ConsoleProcess[];
}) {
  const running = counts?.activeProcesses ?? processes.filter(isRunningProcess).length;
  const queued = counts?.queuedProcesses ?? processes.filter(isQueuedProcess).length;
  const errored = processes.filter((process) => process.state === "unknown").length;
  const idle = Math.max(0, processes.length - running - queued - errored);
  const model = defaultModelLabelForConfig(config);
  const modelCount = modelConfigCount(config);
  const modelSummary = modelCount > 1
    ? `+ ${modelCount - 1} OTHER MODEL ${modelCount === 2 ? "SETTING" : "SETTINGS"}`
    : modelCount === 1
      ? "1 MODEL SETTING"
      : "NO MODEL OVERRIDE";
  const stats: StatLine[] = [
    { label: "RUNNING", value: running, tone: running > 0 ? "live" : "idle" },
    { label: "ERROR", value: errored, tone: errored > 0 ? "error" : "idle" },
    { label: "IDLE", value: idle, tone: "idle" },
  ];

  return (
    <SplitCells
      className="gsv-settings-model-task-split"
      left={onOpenSurface ? (
        <Surface
          as="button"
          class="gsv-settings-deep-cell"
          flush
          interactive
          onClick={() => onOpenSurface("models")}
        >
          <MiniHeading title="MODELS" />
          <div class="gsv-settings-model-summary">
            <span>DEFAULT: <strong>{model}</strong></span>
            <small>{modelSummary}</small>
          </div>
          <Chevron />
        </Surface>
      ) : (
        <Surface class="gsv-settings-deep-cell" flush>
          <MiniHeading title="MODELS" />
          <div class="gsv-settings-model-summary">
            <span>DEFAULT: <strong>{model}</strong></span>
            <small>{modelSummary}</small>
          </div>
        </Surface>
      )}
      right={onOpenSurface ? (
        <Surface
          as="button"
          class="gsv-settings-deep-cell"
          flush
          interactive
          onClick={() => onOpenSurface("tasks")}
        >
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
        </Surface>
      ) : (
        <Surface class="gsv-settings-deep-cell" flush>
          <MiniHeading title="TASKS" />
          <div class="gsv-settings-task-summary">
            {stats.map((stat) => (
              <span key={stat.label}>
                <StatusDot tone={stat.tone} size={8} />
                {stat.label} · {stat.value}
              </span>
            ))}
          </div>
        </Surface>
      )}
    />
  );
}

function FleetPanel({
  adapters,
  integrations,
  onOpenListCreate,
  onOpenListDetail,
  onOpenSurface,
  targets,
}: {
  adapters: readonly ConsoleAdapterAccount[];
  integrations: readonly ConsoleMcpServer[];
  onOpenListCreate?: OpenListCreate;
  onOpenListDetail?: OpenListDetail;
  onOpenSurface?: OpenSurface;
  targets: readonly ConsoleTarget[];
}) {
  const targetRows = sortTargets(targets).map(targetRow);
  const adapterRows = sortAdapters(adapters).map(adapterRow);
  const integrationRows = sortMcpServers(integrations).map(integrationRow);
  const openList = (surface: ConsoleOverviewTarget) => onOpenSurface ? () => onOpenSurface(surface) : undefined;
  const openDetail = (kind: ConsoleListKind, row: OverviewRow, surface: ConsoleOverviewTarget) => (
    onOpenListDetail ? () => onOpenListDetail(kind, row.id, row.label) : openList(surface)
  );
  const openCreate = (kind: ConsoleListKind, surface: ConsoleOverviewTarget) => (
    onOpenListCreate ? () => onOpenListCreate(kind) : openList(surface)
  );

  return (
    <section class="gsv-settings-block gsv-settings-fleet-block">
      <ActionSectionHeader
        title="FLEET"
        onClick={openList("machines")}
      />
      <MiniHeading
        title="MACHINES"
        onClick={openList("machines")}
      />
      <div class="gsv-settings-section-rows">
        {targetRows.length === 0 ? <EmptyRow label="NO MACHINES" /> : rowLimit(targetRows, 3).map((row) => (
          <MiniRow key={row.id} row={row} showIcon={false} onClick={openDetail("machines", row, "machines")} />
        ))}
        <AddRow label="CONNECT NEW MACHINE" onClick={openCreate("machines", "machines")} />
      </div>
      <SplitCells
        left={(
          <div class="gsv-settings-mini-cell">
            <MiniHeading
              title="MESSENGERS"
              onClick={openList("messengers")}
            />
            {adapterRows.length === 0 ? <EmptyRow label="NO MESSENGERS" /> : rowLimit(adapterRows, 3).map((row) => (
              <MiniRow key={row.id} row={row} onClick={openDetail("messengers", row, "messengers")} />
            ))}
          </div>
        )}
        right={(
          <div class="gsv-settings-mini-cell">
            <MiniHeading
              title="INTEGRATIONS"
              onClick={openList("integrations")}
            />
            {integrationRows.length === 0 ? <EmptyRow label="NO INTEGRATIONS" /> : rowLimit(integrationRows, 2).map((row) => (
              <MiniRow key={row.id} row={row} onClick={openDetail("integrations", row, "integrations")} />
            ))}
            <AddRow label="NEW INTEGRATION" onClick={openCreate("integrations", "integrations")} />
          </div>
        )}
      />
    </section>
  );
}

function SatellitesPanel({
  applications,
  onOpenListCreate,
  onOpenListDetail,
  onOpenSurface,
}: {
  applications: readonly ConsolePackage[];
  onOpenListCreate?: OpenListCreate;
  onOpenListDetail?: OpenListDetail;
  onOpenSurface?: OpenSurface;
}) {
  const rows = sortPackages(applications).map(applicationRow);
  const openList = onOpenSurface ? () => onOpenSurface("applications") : undefined;
  const openDetail = (row: OverviewRow) => (
    onOpenListDetail ? () => onOpenListDetail("applications", row.id, row.label) : openList
  );
  const openCreate = onOpenListCreate
    ? () => onOpenListCreate("applications")
    : openList;

  return (
    <section class="gsv-settings-block gsv-settings-satellites-block">
      <ActionSectionHeader
        title="SATELLITES"
        onClick={openList}
      />
      <MiniHeading
        title="APPLICATIONS"
        onClick={openList}
      />
      <div class="gsv-settings-section-rows">
        {rows.length === 0 ? <EmptyRow label="NO APPLICATIONS" /> : rowLimit(rows, 5).map((row) => (
          <MiniRow key={row.id} row={row} onClick={openDetail(row)} />
        ))}
        <AddRow label="NEW APPLICATION" onClick={openCreate} />
      </div>
    </section>
  );
}

export function SettingsOverviewDashboard({
  counts,
  data,
  onOpenAgent,
  onOpenListCreate,
  onOpenListDetail,
  onOpenSurface,
}: {
  counts: ConsoleOverviewCounts | null;
  data: ConsoleOverviewData;
  onOpenAgent?: OpenAgent;
  onOpenListCreate?: OpenListCreate;
  onOpenListDetail?: OpenListDetail;
  onOpenSurface?: OpenSurface;
}) {
  const visiblePackages = data.packages.filter((pkg) => !isNativeConsolePackage(pkg));
  const applications = visiblePackages.filter(isApplicationPackage);
  const [terminalBackground, setTerminalBackground] = useTerminalRunInBackgroundPreference();

  return (
    <div class="gsv-settings-overview" aria-label="GSV settings overview">
      <div class="gsv-settings-left">
        <ShipPanel
          config={data.config}
          data={data}
          onOpenSurface={onOpenSurface}
          terminalBackground={terminalBackground}
          onTerminalBackgroundChange={setTerminalBackground}
        />
        <CrewPanel
          accounts={data.accounts}
          onOpenAgent={onOpenAgent}
          onOpenSurface={onOpenSurface}
          processes={data.processes}
        />
        <ModelsTasksPanel config={data.config} counts={counts} onOpenSurface={onOpenSurface} processes={data.processes} />
      </div>
      <div class="gsv-settings-right">
        <FleetPanel
          adapters={data.adapters}
          integrations={data.mcpServers}
          onOpenListCreate={onOpenListCreate}
          onOpenListDetail={onOpenListDetail}
          onOpenSurface={onOpenSurface}
          targets={data.targets}
        />
        <SatellitesPanel
          applications={applications}
          onOpenListCreate={onOpenListCreate}
          onOpenListDetail={onOpenListDetail}
          onOpenSurface={onOpenSurface}
        />
      </div>
    </div>
  );
}
