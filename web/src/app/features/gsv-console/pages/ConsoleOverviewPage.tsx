import { AsciiPlanet } from "../../../components/ui/AsciiPlanet";
import { Checkbox } from "../../../components/ui/Checkbox";
import { CrewAddTile, CrewTile } from "../../../components/ui/CrewTile";
import { Icon } from "../../../components/ui/Icon";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { StatusDot, type StatusTone } from "../../../components/ui/StatusDot";
import { Tag, type TagTone } from "../../../components/ui/Tag";
import {
  ConsolePage,
  ConsoleResourceBoundary,
} from "../components/ConsolePageTemplate";
import type { ConsoleListKind } from "./ConsoleListPage";
import {
  defaultModelLabelForConfig,
  modelConfigCount,
  overrideConfigEntries,
} from "../domain/consoleAi";
import {
  agentImageSrcForIndex,
  sortedConsoleAccounts,
} from "../domain/agentPresentation";
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
import type { ShellSurfaceId } from "../../gsv-shell/domain/shellModel";
import { useTerminalRunInBackgroundPreference } from "../../terminal/hooks/useTerminalPreferences";
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

type OverviewSurface = Exclude<ShellSurfaceId, "desktop">;
export type ConsoleOverviewTarget = OverviewSurface | "models" | "new-agent" | "overrides";
type OpenSurface = (surface: ConsoleOverviewTarget) => void;
type OpenAgent = (accountUid: number) => void;
type OpenListDetail = (kind: ConsoleListKind, detailId: string, detailLabel?: string) => void;
type OpenListCreate = (kind: ConsoleListKind) => void;

const DASHBOARD_ROW_LIMIT = 5;
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
    label: formatTokenLabel(adapter.adapter),
    meta: hasError ? adapter.error : undefined,
    tone: connected ? "online" : hasError ? "error" : "idle",
    statusLabel: hasError ? "ERROR" : undefined,
  };
}

function integrationRow(pkg: ConsolePackage): OverviewRow {
  const status = packageStatus(pkg);
  return {
    id: pkg.packageId,
    label: pkg.name,
    tone: status.tone,
    statusLabel: pkg.reviewPending ? status.statusLabel : undefined,
    tag: status.tag,
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
  const content = (
    <>
      <span>{title}</span>
      {meta ? <small>{meta}</small> : null}
      {showChevron ? <Chevron /> : null}
    </>
  );

  return onClick ? (
    <button type="button" class="gsv-settings-mini-heading" data-clickable="true" onClick={onClick}>
      {content}
    </button>
  ) : (
    <div class="gsv-settings-mini-heading">
      {content}
    </div>
  );
}

function MiniRow({ row, showIcon = true, onClick }: { row: OverviewRow; showIcon?: boolean; onClick?: () => void }) {
  const content = (
    <>
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
      {showIcon && row.icon ? (
        <span class="gsv-settings-tail-dot">
          <StatusDot tone={row.tone} size={8} />
        </span>
      ) : null}
    </>
  );

  return onClick ? (
    <button type="button" class="gsv-settings-mini-row" data-clickable="true" onClick={onClick}>
      {content}
    </button>
  ) : (
    <div class="gsv-settings-mini-row">
      {content}
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

function AddRow({ label, onClick }: { label: string; onClick?: () => void }) {
  const content = (
    <>
      <Icon name="plus" size={15} />
      <span>{label}</span>
      <Chevron />
    </>
  );

  return onClick ? (
    <button type="button" class="gsv-settings-add-row" data-clickable="true" onClick={onClick}>
      {content}
    </button>
  ) : (
    <div class="gsv-settings-add-row">
      {content}
    </div>
  );
}

function SplitCells({
  className = "",
  left,
  right,
}: {
  className?: string;
  left: preact.ComponentChildren;
  right: preact.ComponentChildren;
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
  const content = (
    <>
      <SectionHeader title={title} meta={meta} divider />
      {onClick ? <Chevron /> : null}
    </>
  );

  return onClick ? (
    <button type="button" class="gsv-settings-action-header" data-clickable="true" onClick={onClick}>
      {content}
    </button>
  ) : (
    <div class="gsv-settings-action-header">
      {content}
    </div>
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
        <span class="gsv-settings-scan">SCAN {scanCode(data)}</span>
        <span class="gsv-settings-ship-id">GSV-01</span>
      </div>
      <SplitCells
        left={(
          <div class="gsv-settings-mini-cell">
            <MiniHeading title="TERMINAL" />
            <div
              class="gsv-settings-terminal-state"
            >
              <Checkbox
                checked={terminalBackground}
                label="RUN IN BACKGROUND"
                size="medium"
                onChange={onTerminalBackgroundChange}
              />
              {onOpenSurface ? (
                <button type="button" aria-label="Open terminal" onClick={() => onOpenSurface("terminal")}>
                  <Chevron />
                </button>
              ) : null}
            </div>
          </div>
        )}
        right={(
          <div class="gsv-settings-mini-cell">
            <MiniHeading title="OVERRIDES" />
            {onOpenSurface ? (
              <button
                type="button"
                class="gsv-settings-overrides-state"
                data-clickable="true"
                onClick={() => onOpenSurface("overrides")}
              >
                <span class="gsv-settings-overrides-copy">
                  <span>{configured > 0 ? `${configured} CONFIGURED` : "NOT CONFIGURED"}</span>
                  {redacted > 0 ? <Tag label={`${redacted} REDACTED`} tone="warn" boxed /> : null}
                </span>
                <Chevron />
              </button>
            ) : (
              <div class="gsv-settings-overrides-state">
                <span class="gsv-settings-overrides-copy">
                  <span>{configured > 0 ? `${configured} CONFIGURED` : "NOT CONFIGURED"}</span>
                  {redacted > 0 ? <Tag label={`${redacted} REDACTED`} tone="warn" boxed /> : null}
                </span>
              </div>
            )}
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
        <button
          type="button"
          class="gsv-settings-deep-cell"
          data-clickable="true"
          onClick={() => onOpenSurface("models")}
        >
          <MiniHeading title="MODELS" />
          <div class="gsv-settings-model-summary">
            <span>DEFAULT: <strong>{model}</strong></span>
            <small>{modelSummary}</small>
          </div>
          <Chevron />
        </button>
      ) : (
        <div class="gsv-settings-deep-cell">
          <MiniHeading title="MODELS" />
          <div class="gsv-settings-model-summary">
            <span>DEFAULT: <strong>{model}</strong></span>
            <small>{modelSummary}</small>
          </div>
        </div>
      )}
      right={onOpenSurface ? (
        <button
          type="button"
          class="gsv-settings-deep-cell"
          data-clickable="true"
          onClick={() => onOpenSurface("runtime")}
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
        </button>
      ) : (
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
        </div>
      )}
    />
  );
}

function FleetPanel({
  adapters,
  integrationPackages,
  onOpenListCreate,
  onOpenListDetail,
  onOpenSurface,
  targets,
}: {
  adapters: readonly ConsoleAdapterAccount[];
  integrationPackages: readonly ConsolePackage[];
  onOpenListCreate?: OpenListCreate;
  onOpenListDetail?: OpenListDetail;
  onOpenSurface?: OpenSurface;
  targets: readonly ConsoleTarget[];
}) {
  const targetRows = sortTargets(targets).map(targetRow);
  const adapterRows = sortAdapters(adapters).map(adapterRow);
  const integrationRows = sortPackages(integrationPackages).map(integrationRow);
  const openList = (surface: ConsoleOverviewTarget) => onOpenSurface ? () => onOpenSurface(surface) : undefined;
  const openDetail = (kind: ConsoleListKind, row: OverviewRow, surface: ConsoleOverviewTarget) => (
    onOpenListDetail ? () => onOpenListDetail(kind, row.id, row.label) : openList(surface)
  );
  const openCreate = (kind: ConsoleListKind, surface: ConsoleOverviewTarget) => (
    onOpenListCreate ? () => onOpenListCreate(kind) : openList(surface)
  );

  return (
    <section class="gsv-settings-block gsv-settings-fleet-block">
      <SectionHeader title="FLEET" divider />
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
      <SectionHeader title="SATELLITES" divider />
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

function SettingsOverviewDashboard({
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
  const applications = data.packages.filter(isApplicationPackage);
  const integrationPackages = data.packages.filter((pkg) => !isApplicationPackage(pkg));
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
          integrationPackages={integrationPackages}
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

export function ConsoleOverviewPage({
  onOpenAgent,
  onOpenListCreate,
  onOpenListDetail,
  onOpenSurface,
}: {
  onOpenAgent?: OpenAgent;
  onOpenListCreate?: OpenListCreate;
  onOpenListDetail?: OpenListDetail;
  onOpenSurface?: OpenSurface;
}) {
  const overview = useConsoleOverview();

  return (
    <ConsolePage flush>
      <ConsoleResourceBoundary
        resource={overview.resource}
        emptyLabel="NO CONSOLE DATA"
        errorLabel="CONSOLE OVERVIEW"
        render={(data) => (
          <SettingsOverviewDashboard
            counts={overview.counts}
            data={data}
            onOpenAgent={onOpenAgent}
            onOpenListCreate={onOpenListCreate}
            onOpenListDetail={onOpenListDetail}
            onOpenSurface={onOpenSurface}
          />
        )}
      />
    </ConsolePage>
  );
}
