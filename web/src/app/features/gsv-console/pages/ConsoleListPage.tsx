import type { ComponentChildren } from "preact";
import { Icon } from "../../../components/ui/Icon";
import { ListRow } from "../../../components/ui/ListRow";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { StatusDot, type StatusTone } from "../../../components/ui/StatusDot";
import { Tag, type TagTone } from "../../../components/ui/Tag";
import {
  useConsoleAdapters,
  useConsolePackages,
  useConsoleProcesses,
  useConsoleTargets,
} from "../hooks/useConsoleData";
import type {
  ConsoleAdapterAccount,
  ConsolePackage,
  ConsolePackageEntrypoint,
  ConsolePackageRuntime,
  ConsoleProcess,
  ConsoleProcessState,
  ConsoleResourceState,
  ConsoleTarget,
  ConsoleTargetKind,
} from "../domain/consoleModels";
import {
  ConsolePage,
  ConsoleResourceBoundary,
} from "../components/ConsolePageTemplate";
import {
  ConsoleDetailChips,
  ConsoleDetailGrid,
  ConsoleDetailList,
  ConsoleRowDetails,
  type ConsoleDetailChip,
  type ConsoleDetailField,
  type ConsoleDetailListItem,
} from "./ConsoleDetailBlocks";
import "./ConsoleListPage.css";

type ConsoleListKind = "machines" | "library" | "tasks" | "messengers" | "integrations" | "applications";
type PackageListKind = "library" | "integrations" | "applications";

type ConsoleListPageProps = {
  kind: ConsoleListKind;
};

type SignalMetric = {
  label: string;
  value: number | string;
  meta: string;
  tone: StatusTone;
};

type RowTag = {
  label: string;
  tone: TagTone;
};

type OperationalLayoutProps = {
  title: string;
  meta: string;
  signals: readonly SignalMetric[];
  children: ComponentChildren;
  rail: ComponentChildren;
};

type OperationalRowProps = {
  icon: string;
  label: string;
  sub: string;
  tone: StatusTone;
  statusLabel: string;
  detail: string;
  tags?: readonly RowTag[];
  details?: ComponentChildren;
};

const EMPTY_RESOURCE_LABEL: Record<ConsoleListKind, string> = {
  machines: "NO MACHINES",
  library: "NO PACKAGES",
  tasks: "NO PROCESSES",
  messengers: "NO MESSENGERS",
  integrations: "NO INTEGRATIONS",
  applications: "NO APPLICATIONS",
};

const TARGET_KIND_LABEL: Record<ConsoleTargetKind, string> = {
  "native-device": "NATIVE",
  browser: "BROWSER",
  adapter: "ADAPTER",
  unknown: "UNKNOWN",
};

const RUNTIME_LABEL: Record<ConsolePackageRuntime, string> = {
  "dynamic-worker": "DYNAMIC WORKER",
  node: "NODE",
  "web-ui": "WEB UI",
  unknown: "UNKNOWN RUNTIME",
};

export function ConsoleListPage({ kind }: ConsoleListPageProps) {
  const targets = useConsoleTargets({ enabled: kind === "machines" });
  const packageKind = isPackageListKind(kind) ? kind : null;
  const packages = useConsolePackages({ enabled: packageKind !== null });
  const processes = useConsoleProcesses({ enabled: kind === "tasks" });
  const adapters = useConsoleAdapters({ enabled: kind === "messengers" });

  if (kind === "tasks") {
    return (
      <ConsolePage>
        <ConsoleResourceBoundary
          resource={resourceWithLocalEmptyState(processes.resource)}
          emptyLabel={EMPTY_RESOURCE_LABEL.tasks}
          errorLabel="RUNTIME"
          render={(data) => (
            <RuntimeConsoleSection
              processes={data}
              refreshing={processes.resource.isRefreshing}
            />
          )}
        />
      </ConsolePage>
    );
  }

  if (kind === "machines") {
    return (
      <ConsolePage>
        <ConsoleResourceBoundary
          resource={resourceWithLocalEmptyState(targets.resource)}
          emptyLabel={EMPTY_RESOURCE_LABEL.machines}
          errorLabel="MACHINES"
          render={(data) => (
            <MachinesConsoleSection
              targets={data}
              refreshing={targets.resource.isRefreshing}
            />
          )}
        />
      </ConsolePage>
    );
  }

  if (kind === "messengers") {
    return (
      <ConsolePage>
        <ConsoleResourceBoundary
          resource={resourceWithLocalEmptyState(adapters.resource)}
          emptyLabel={EMPTY_RESOURCE_LABEL.messengers}
          errorLabel="MESSENGERS"
          render={(data) => (
            <MessengersConsoleSection
              adapters={data}
              refreshing={adapters.resource.isRefreshing}
            />
          )}
        />
      </ConsolePage>
    );
  }

  return (
    <ConsolePage>
      <ConsoleResourceBoundary
        resource={resourceWithLocalEmptyState(packages.resource)}
        emptyLabel={EMPTY_RESOURCE_LABEL[packageKind ?? "library"]}
        errorLabel={packageKind === "applications" ? "APPLICATIONS" : packageKind === "integrations" ? "INTEGRATIONS" : "LIBRARY"}
        render={(data) => (
          <LibraryConsoleSection
            kind={packageKind ?? "library"}
            packages={filterPackagesForKind(data, packageKind ?? "library")}
            refreshing={packages.resource.isRefreshing}
          />
        )}
      />
    </ConsolePage>
  );
}

function isPackageListKind(kind: ConsoleListKind): kind is PackageListKind {
  return kind === "library" || kind === "integrations" || kind === "applications";
}

function resourceWithLocalEmptyState<T>(resource: ConsoleResourceState<T>): ConsoleResourceState<T> {
  return { ...resource, isEmpty: false };
}

function OperationalLayout({
  title,
  meta,
  signals,
  children,
  rail,
}: OperationalLayoutProps) {
  return (
    <section class="gsv-console-list-layout">
      <main class="gsv-console-list-main">
        <SectionHeader title={title} meta={meta} divider />
        <SignalStrip signals={signals} />
        {children}
      </main>
      <aside class="gsv-console-list-rail">{rail}</aside>
    </section>
  );
}

function SignalStrip({ signals }: { signals: readonly SignalMetric[] }) {
  return (
    <div class="gsv-console-list-signals">
      {signals.map((signal) => (
        <div class="gsv-console-list-signal" key={signal.label}>
          <span>{signal.label}</span>
          <strong>{signal.value}</strong>
          <small>
            <StatusDot tone={signal.tone} size={7} />
            {signal.meta}
          </small>
        </div>
      ))}
    </div>
  );
}

function InventoryGroup({
  title,
  meta,
  emptyLabel,
  isEmpty,
  children,
}: {
  title: string;
  meta: string;
  emptyLabel: string;
  isEmpty: boolean;
  children: ComponentChildren;
}) {
  return (
    <section class="gsv-console-list-group">
      <div class="gsv-console-list-group-heading">
        <span>{title}</span>
        <small>{meta}</small>
      </div>
      {isEmpty ? <EmptyInventoryRow label={emptyLabel} /> : children}
    </section>
  );
}

function EmptyInventoryRow({ label }: { label: string }) {
  return <div class="gsv-console-list-empty">{label}</div>;
}

function OperationalRow({
  icon,
  label,
  sub,
  tone,
  statusLabel,
  detail,
  tags = [],
  details,
}: OperationalRowProps) {
  return (
    <div class="gsv-console-list-row">
      <span class="gsv-console-list-row-icon">
        <Icon name={icon} size={18} />
      </span>
      <div class="gsv-console-list-row-main">
        <ListRow label={label} sub={sub} status="none" />
        {tags.length > 0 ? (
          <div class="gsv-console-list-row-tags">
            {tags.map((tag) => (
              <Tag key={`${label}-${tag.label}`} label={tag.label} tone={tag.tone} boxed />
            ))}
          </div>
        ) : null}
        {details ? <div class="gsv-console-list-row-detail-slot">{details}</div> : null}
      </div>
      <div class="gsv-console-list-row-status">
        <span>
          <StatusDot tone={tone} size={8} />
          {statusLabel}
        </span>
        <small>{detail}</small>
      </div>
    </div>
  );
}

function RailSection({
  title,
  meta,
  children,
}: {
  title: string;
  meta: string;
  children: ComponentChildren;
}) {
  return (
    <section class="gsv-console-list-rail-section">
      <SectionHeader title={title} meta={meta} divider />
      <div class="gsv-console-list-rail-body">{children}</div>
    </section>
  );
}

function RailSignalRow({
  icon,
  label,
  meta,
  tone,
  tag,
}: {
  icon: string;
  label: string;
  meta: string;
  tone: StatusTone;
  tag?: RowTag;
}) {
  return (
    <div class="gsv-console-list-rail-row">
      <span class="gsv-console-list-rail-icon">
        <Icon name={icon} size={16} />
      </span>
      <span class="gsv-console-list-rail-copy">
        <strong>{label}</strong>
        <small>{meta}</small>
      </span>
      {tag ? <Tag label={tag.label} tone={tag.tone} boxed /> : null}
      <StatusDot tone={tone} size={7} />
    </div>
  );
}

function RuntimeConsoleSection({
  processes,
  refreshing,
}: {
  processes: readonly ConsoleProcess[];
  refreshing: boolean;
}) {
  const running = processes.filter(isRunningProcess);
  const queued = processes.filter(isQueuedProcess);
  const unknown = processes.filter((process) => process.state === "unknown");
  const active = processes.filter((process) => isRunningProcess(process) || isQueuedProcess(process) || process.state === "unknown");
  const idle = processes.filter((process) => !active.includes(process));
  const interactive = processes.filter((process) => process.interactive).length;
  const contexts = processes.filter((process) => process.activeConversationId).length;

  return (
    <OperationalLayout
      title="RUNTIME"
      meta={refreshing ? "REFRESHING" : `${processes.length} PROCESSES`}
      signals={[
        { label: "RUNNING", value: running.length, meta: "ACTIVE RUNS", tone: running.length > 0 ? "live" : "idle" },
        { label: "QUEUED", value: queued.length, meta: "WAITING", tone: queued.length > 0 ? "update" : "idle" },
        { label: "IDLE", value: idle.length, meta: "READY", tone: idle.length > 0 ? "idle" : "idle" },
        { label: "INTERACTIVE", value: interactive, meta: "PROCESS IO", tone: interactive > 0 ? "online" : "idle" },
      ]}
      rail={(
        <>
          <RailSection title="TOP ACTIONS" meta={running.length > 0 ? "RUN CONTROL" : "PROCESS CONTROL"}>
            <RailSignalRow
              icon="chat"
              label="PROC.SEND"
              meta={processes.length > 0 ? `${processes.length} process targets` : "no process target"}
              tone={processes.length > 0 ? "online" : "idle"}
              tag={{ label: "MESSAGE", tone: "info" }}
            />
            <RailSignalRow
              icon="terminal"
              label="PROC.ABORT"
              meta={running.length > 0 ? `${running.length} active runs` : "no active runs"}
              tone={running.length > 0 ? "warn" : "idle"}
              tag={{ label: "RUN", tone: running.length > 0 ? "warn" : "idle" }}
            />
            <RailSignalRow
              icon="list"
              label="PROC.HISTORY"
              meta={contexts > 0 ? `${contexts} active contexts` : "no active contexts"}
              tone={contexts > 0 ? "online" : "idle"}
            />
            <RailSignalRow
              icon="cog"
              label="PROC.RESET"
              meta={`${idle.length} idle / ${queued.length} queued`}
              tone={queued.length > 0 ? "update" : "idle"}
            />
          </RailSection>
          <RailSection title="STATE MIX" meta={unknown.length > 0 ? "ATTENTION" : "NORMALIZED"}>
            <RailSignalRow icon="stars" label="ACTIVE RUN IDS" meta={`${running.filter((process) => process.activeRunId).length} present`} tone={running.length > 0 ? "live" : "idle"} />
            <RailSignalRow icon="list" label="QUEUE DEPTH" meta={`${sum(processes.map((process) => process.queuedCount))} pending messages`} tone={queued.length > 0 ? "update" : "idle"} />
            <RailSignalRow icon="tag" label="UNKNOWN STATE" meta={`${unknown.length} processes`} tone={unknown.length > 0 ? "warn" : "idle"} />
          </RailSection>
        </>
      )}
    >
      <InventoryGroup title="ACTIVE AND QUEUED" meta={`${active.length} PROCESSES`} emptyLabel="NO ACTIVE RUNS" isEmpty={active.length === 0}>
        {active.map((process) => (
          <OperationalRow
            key={process.pid}
            icon="list"
            label={process.label}
            sub={processSub(process)}
            tone={toneForProcess(process)}
            statusLabel={statusForProcess(process)}
            detail={processDetail(process)}
            tags={processTags(process)}
            details={<ProcessDetails process={process} />}
          />
        ))}
      </InventoryGroup>
      <InventoryGroup title="IDLE PROCESSES" meta={`${idle.length} READY`} emptyLabel="NO IDLE PROCESSES" isEmpty={idle.length === 0}>
        {idle.map((process) => (
          <OperationalRow
            key={process.pid}
            icon="list"
            label={process.label}
            sub={processSub(process)}
            tone={toneForProcess(process)}
            statusLabel={statusForProcess(process)}
            detail={processDetail(process)}
            tags={processTags(process)}
            details={<ProcessDetails process={process} />}
          />
        ))}
      </InventoryGroup>
    </OperationalLayout>
  );
}

function MachinesConsoleSection({
  targets,
  refreshing,
}: {
  targets: readonly ConsoleTarget[];
  refreshing: boolean;
}) {
  const online = targets.filter((target) => target.online);
  const offline = targets.filter((target) => !target.online);
  const filesReady = online.filter(supportsFilesSurface);
  const shellReady = online.filter(supportsShellSurface);
  const capabilityCount = targets.reduce((total, target) => total + target.implements.length, 0);

  return (
    <OperationalLayout
      title="MACHINES"
      meta={refreshing ? "REFRESHING" : `${online.length}/${targets.length} ONLINE`}
      signals={[
        { label: "ONLINE", value: online.length, meta: `${targets.length} TOTAL`, tone: online.length > 0 ? "online" : "idle" },
        { label: "OFFLINE", value: offline.length, meta: "UNREACHABLE", tone: offline.length > 0 ? "warn" : "idle" },
        { label: "FILES", value: filesReady.length, meta: "READY TARGETS", tone: filesReady.length > 0 ? "online" : "idle" },
        { label: "SHELL", value: shellReady.length, meta: "READY TARGETS", tone: shellReady.length > 0 ? "online" : "idle" },
      ]}
      rail={(
        <>
          <RailSection title="COMPANIONS" meta="FILES / SHELL">
            <RailSignalRow icon="folder" label="FILES TARGETS" meta={`${filesReady.length} online with file capability`} tone={filesReady.length > 0 ? "online" : "idle"} />
            <RailSignalRow icon="terminal" label="SHELL TARGETS" meta={`${shellReady.length} online with shell capability`} tone={shellReady.length > 0 ? "online" : "idle"} />
            <RailSignalRow icon="computer" label="OFFLINE TARGETS" meta={`${offline.length} unavailable to companions`} tone={offline.length > 0 ? "warn" : "idle"} />
          </RailSection>
          <RailSection title="CAPABILITY MAP" meta={`${capabilityCount} CLAIMS`}>
            <RailSignalRow icon="computer" label="NATIVE" meta={`${targets.filter((target) => target.kind === "native-device").length} devices`} tone="online" />
            <RailSignalRow icon="bookmark" label="BROWSER" meta={`${targets.filter((target) => target.kind === "browser").length} devices`} tone="online" />
            <RailSignalRow icon="chat" label="ADAPTER" meta={`${targets.filter((target) => target.kind === "adapter").length} surfaces`} tone="idle" />
          </RailSection>
        </>
      )}
    >
      <InventoryGroup title="ONLINE FLEET" meta={`${online.length} TARGETS`} emptyLabel="NO ONLINE MACHINES" isEmpty={online.length === 0}>
        {online.map((target) => (
          <OperationalRow
            key={target.deviceId}
            icon={iconForTarget(target)}
            label={target.label}
            sub={targetSub(target)}
            tone="online"
            statusLabel="ONLINE"
            detail={targetDetail(target)}
            tags={targetTags(target)}
            details={<TargetDetails target={target} />}
          />
        ))}
      </InventoryGroup>
      <InventoryGroup title="OFFLINE FLEET" meta={`${offline.length} TARGETS`} emptyLabel="NO OFFLINE MACHINES" isEmpty={offline.length === 0}>
        {offline.map((target) => (
          <OperationalRow
            key={target.deviceId}
            icon={iconForTarget(target)}
            label={target.label}
            sub={targetSub(target)}
            tone="idle"
            statusLabel="OFFLINE"
            detail={targetDetail(target)}
            tags={targetTags(target)}
            details={<TargetDetails target={target} />}
          />
        ))}
      </InventoryGroup>
    </OperationalLayout>
  );
}

function MessengersConsoleSection({
  adapters,
  refreshing,
}: {
  adapters: readonly ConsoleAdapterAccount[];
  refreshing: boolean;
}) {
  const connected = adapters.filter((adapter) => adapter.connected && adapter.authenticated && !adapter.error);
  const attention = adapters.filter((adapter) => adapter.error || !adapter.authenticated);
  const idle = adapters.filter((adapter) => !connected.includes(adapter) && !attention.includes(adapter));
  const authenticated = adapters.filter((adapter) => adapter.authenticated);
  const errors = adapters.filter((adapter) => adapter.error);
  const adapterNames = uniqueSorted(adapters.map((adapter) => adapter.adapter));
  const latestActivity = newestTimestamp(adapters.map((adapter) => adapter.lastActivity));

  return (
    <OperationalLayout
      title="MESSENGERS"
      meta={refreshing ? "REFRESHING" : `${connected.length}/${adapters.length} CONNECTED`}
      signals={[
        { label: "CONNECTED", value: connected.length, meta: `${adapters.length} ACCOUNTS`, tone: connected.length > 0 ? "online" : "idle" },
        { label: "AUTH", value: authenticated.length, meta: "VALID SESSIONS", tone: authenticated.length === adapters.length ? "online" : "warn" },
        { label: "ERROR", value: errors.length, meta: "CHANNEL FAULTS", tone: errors.length > 0 ? "error" : "online" },
        { label: "ACTIVE", value: latestActivity ? formatAge(latestActivity) : "NONE", meta: "LAST ACTIVITY", tone: latestActivity ? "live" : "idle" },
      ]}
      rail={(
        <>
          <RailSection title="CHANNEL STATE" meta={errors.length > 0 ? "ATTENTION" : "NORMAL"}>
            <RailSignalRow icon="chat" label="CONNECTED ACCOUNTS" meta={`${connected.length} live channels`} tone={connected.length > 0 ? "online" : "idle"} />
            <RailSignalRow icon="cog" label="AUTH REQUIRED" meta={`${adapters.filter((adapter) => !adapter.authenticated).length} accounts`} tone={adapters.some((adapter) => !adapter.authenticated) ? "warn" : "online"} />
            <RailSignalRow icon="tag" label="ERROR STATE" meta={`${errors.length} accounts`} tone={errors.length > 0 ? "error" : "online"} />
          </RailSection>
          <RailSection title="ADAPTERS" meta={`${adapterNames.length} TYPES`}>
            {adapterNames.length === 0 ? (
              <RailSignalRow icon="chat" label="NO ADAPTERS" meta="adapter.status returned no accounts" tone="idle" />
            ) : adapterNames.map((adapter) => (
              <RailSignalRow
                key={adapter}
                icon={iconForAdapterName(adapter)}
                label={adapter.toUpperCase()}
                meta={`${adapters.filter((entry) => entry.adapter === adapter).length} accounts`}
                tone={adapters.some((entry) => entry.adapter === adapter && entry.connected) ? "online" : "idle"}
              />
            ))}
          </RailSection>
        </>
      )}
    >
      <AdapterGroup title="CONNECTED CHANNELS" adapters={connected} emptyLabel="NO CONNECTED CHANNELS" />
      <AdapterGroup title="NEEDS ATTENTION" adapters={attention} emptyLabel="NO CHANNELS NEED ATTENTION" />
      <AdapterGroup title="IDLE CHANNELS" adapters={idle} emptyLabel="NO IDLE CHANNELS" />
    </OperationalLayout>
  );
}

function AdapterGroup({
  title,
  adapters,
  emptyLabel,
}: {
  title: string;
  adapters: readonly ConsoleAdapterAccount[];
  emptyLabel: string;
}) {
  return (
    <InventoryGroup title={title} meta={`${adapters.length} CHANNELS`} emptyLabel={emptyLabel} isEmpty={adapters.length === 0}>
      {adapters.map((adapter) => (
        <OperationalRow
          key={`${adapter.adapter}:${adapter.accountId}`}
          icon={iconForAdapterName(adapter.adapter)}
          label={adapterLabel(adapter)}
          sub={adapterSub(adapter)}
          tone={toneForAdapter(adapter)}
          statusLabel={statusForAdapter(adapter)}
          detail={adapterDetail(adapter)}
          tags={adapterTags(adapter)}
          details={<AdapterDetails adapter={adapter} />}
        />
      ))}
    </InventoryGroup>
  );
}

function LibraryConsoleSection({
  kind,
  packages,
  refreshing,
}: {
  kind: PackageListKind;
  packages: readonly ConsolePackage[];
  refreshing: boolean;
}) {
  const title = packageListTitle(kind);
  const noun = packageListNoun(kind);
  const reviewQueue = packages.filter((pkg) => pkg.reviewPending);
  const enabled = packages.filter((pkg) => pkg.enabled && !pkg.reviewPending);
  const disabled = packages.filter((pkg) => !pkg.enabled && !pkg.reviewPending);
  const trusted = packages.filter(isTrustedPackage);
  const updated = packages.filter((pkg) => pkg.updatedAt !== null);
  const latestUpdate = newestTimestamp(packages.map((pkg) => pkg.updatedAt));

  return (
    <OperationalLayout
      title={title}
      meta={refreshing ? "REFRESHING" : `${packages.length} ${noun}${packages.length === 1 ? "" : "S"}`}
      signals={[
        { label: "REVIEW", value: reviewQueue.length, meta: "PENDING", tone: reviewQueue.length > 0 ? "update" : "online" },
        { label: "ENABLED", value: enabled.length, meta: "INSTALLED", tone: enabled.length > 0 ? "online" : "idle" },
        { label: "TRUSTED", value: trusted.length, meta: "APPROVED/POLICY", tone: trusted.length === packages.length ? "online" : "warn" },
        { label: "UPDATED", value: updated.length, meta: "WITH TRACE", tone: updated.length > 0 ? "online" : "idle" },
      ]}
      rail={(
        <>
          <RailSection title="REVIEW STATE" meta={reviewQueue.length > 0 ? "ACTION REQUIRED" : "CLEAR"}>
            <RailSignalRow icon="pencil" label="PENDING REVIEW" meta={`${reviewQueue.length} packages`} tone={reviewQueue.length > 0 ? "update" : "online"} />
            <RailSignalRow icon="stars" label="APPROVED" meta={`${packages.filter((pkg) => pkg.reviewApprovedAt !== null).length} packages`} tone="online" />
            <RailSignalRow icon="tag" label="REVIEW REQUIRED" meta={`${packages.filter((pkg) => pkg.reviewRequired).length} packages`} tone={reviewQueue.length > 0 ? "update" : "idle"} />
          </RailSection>
          <RailSection title="TRUST AND SOURCE" meta={`${trusted.length}/${packages.length} TRUSTED`}>
            <RailSignalRow icon="weblink" label="PUBLIC SOURCE" meta={`${packages.filter((pkg) => pkg.sourcePublic).length} packages`} tone="online" />
            <RailSignalRow icon="folder" label="PRIVATE SOURCE" meta={`${packages.filter((pkg) => !pkg.sourcePublic).length} packages`} tone={packages.some((pkg) => !pkg.sourcePublic) ? "warn" : "idle"} />
            <RailSignalRow icon="cog" label="GLOBAL SCOPE" meta={`${packages.filter((pkg) => pkg.scopeKind === "global").length} packages`} tone="online" />
          </RailSection>
          <RailSection title="INSTALL TRACE" meta={latestUpdate ? `LATEST ${formatAge(latestUpdate)}` : "NO UPDATE TRACE"}>
            <RailSignalRow icon="computer" label="INSTALLED" meta={`${packages.filter((pkg) => pkg.installedAt !== null).length} packages`} tone="online" />
            <RailSignalRow icon="list" label="UPDATE TRACE" meta={`${updated.length} packages`} tone={updated.length > 0 ? "online" : "idle"} />
            <RailSignalRow icon="bookmark" label="UI ENTRYPOINTS" meta={`${sum(packages.map((pkg) => pkg.uiEntrypoints.length))} declared`} tone="online" />
          </RailSection>
        </>
      )}
    >
      <PackageGroup title="REVIEW QUEUE" packages={reviewQueue} emptyLabel="NO PACKAGES WAITING FOR REVIEW" />
      <PackageGroup title={`ENABLED ${noun}S`} packages={enabled} emptyLabel={`NO ENABLED ${noun}S`} />
      <PackageGroup title={`DISABLED ${noun}S`} packages={disabled} emptyLabel={`NO DISABLED ${noun}S`} />
    </OperationalLayout>
  );
}

function PackageGroup({
  title,
  packages,
  emptyLabel,
}: {
  title: string;
  packages: readonly ConsolePackage[];
  emptyLabel: string;
}) {
  return (
    <InventoryGroup title={title} meta={`${packages.length} PACKAGES`} emptyLabel={emptyLabel} isEmpty={packages.length === 0}>
      {packages.map((pkg) => (
        <OperationalRow
          key={pkg.packageId}
          icon={pkg.uiEntrypoints.length > 0 ? "stars" : "pencil"}
          label={pkg.name}
          sub={packageSub(pkg)}
          tone={toneForPackage(pkg)}
          statusLabel={statusForPackage(pkg)}
          detail={packageDetail(pkg)}
          tags={packageTags(pkg)}
          details={<PackageDetails pkg={pkg} />}
        />
      ))}
    </InventoryGroup>
  );
}

function ProcessDetails({ process }: { process: ConsoleProcess }) {
  return (
    <ConsoleRowDetails summary="PROCESS DETAIL">
      <ConsoleDetailGrid fields={processDetailFields(process)} />
      <ConsoleDetailChips
        title="STATE FLAGS"
        emptyLabel="NO STATE FLAGS"
        chips={processContextChips(process)}
      />
    </ConsoleRowDetails>
  );
}

function TargetDetails({ target }: { target: ConsoleTarget }) {
  return (
    <ConsoleRowDetails summary="MACHINE DETAIL">
      <ConsoleDetailGrid fields={targetDetailFields(target)} />
      <ConsoleDetailChips
        title="CAPABILITIES"
        emptyLabel="NO CAPABILITIES DECLARED"
        chips={targetCapabilityChips(target)}
      />
    </ConsoleRowDetails>
  );
}

function AdapterDetails({ adapter }: { adapter: ConsoleAdapterAccount }) {
  return (
    <ConsoleRowDetails summary="MESSENGER DETAIL">
      <ConsoleDetailGrid fields={adapterDetailFields(adapter)} />
      <ConsoleDetailChips
        title="CHANNEL FLAGS"
        emptyLabel="NO CHANNEL FLAGS"
        chips={adapterContextChips(adapter)}
      />
    </ConsoleRowDetails>
  );
}

function PackageDetails({ pkg }: { pkg: ConsolePackage }) {
  return (
    <ConsoleRowDetails summary="PACKAGE DETAIL">
      <ConsoleDetailGrid fields={packageDetailFields(pkg)} />
      <ConsoleDetailList
        title="ENTRYPOINTS"
        emptyLabel="NO ENTRYPOINTS DECLARED"
        items={packageEntrypointItems(pkg.entrypoints)}
      />
      <ConsoleDetailChips
        title="BINDINGS"
        emptyLabel="NO BINDINGS DECLARED"
        chips={pkg.bindingNames.map((binding) => ({ label: binding, tone: "idle" }))}
      />
    </ConsoleRowDetails>
  );
}

function processDetailFields(process: ConsoleProcess): ConsoleDetailField[] {
  return [
    { label: "PID", value: process.pid, wide: true },
    { label: "STATE", value: processStateLabel(process.state), tone: tagToneForProcess(process) },
    { label: "RAW STATE", value: process.rawState },
    { label: "USER", value: process.username || uidLabel(process.uid) },
    { label: "UID", value: process.uid },
    { label: "PROFILE", value: process.profile },
    { label: "CWD", value: process.cwd, wide: true },
    { label: "PARENT PID", value: process.parentPid },
    { label: "ACTIVE RUN", value: process.activeRunId, wide: true },
    { label: "CONVERSATION", value: process.activeConversationId, wide: true },
    { label: "QUEUE DEPTH", value: process.queuedCount },
    { label: "INTERACTIVE", value: yesNo(process.interactive), tone: process.interactive ? "info" : "idle" },
    { label: "CREATED", value: formatTimestampTrace(process.createdAt), wide: true },
    { label: "LAST ACTIVE", value: formatTimestampTrace(process.lastActiveAt), wide: true },
  ];
}

function processContextChips(process: ConsoleProcess): ConsoleDetailChip[] {
  const chips: ConsoleDetailChip[] = [
    { label: processStateLabel(process.state), tone: tagToneForProcess(process) },
  ];
  if (process.interactive) chips.push({ label: "INTERACTIVE IO", tone: "info" });
  if (process.activeRunId) chips.push({ label: "ACTIVE RUN", tone: "update" });
  if (process.activeConversationId) chips.push({ label: "CONVERSATION", tone: "accent" });
  if (process.queuedCount > 0) chips.push({ label: `QUEUE ${process.queuedCount}`, tone: "update" });
  if (process.parentPid) chips.push({ label: "CHILD PROCESS", tone: "idle" });
  return chips;
}

function targetDetailFields(target: ConsoleTarget): ConsoleDetailField[] {
  return [
    { label: "DEVICE ID", value: target.deviceId, wide: true },
    { label: "STATE", value: target.online ? "ONLINE" : "OFFLINE", tone: target.online ? "online" : "idle" },
    { label: "KIND", value: TARGET_KIND_LABEL[target.kind], tone: target.kind === "unknown" ? "warn" : "info" },
    { label: "OWNER", value: target.ownerUsername },
    { label: "OWNER UID", value: target.ownerUid },
    { label: "PLATFORM", value: target.platform },
    { label: "VERSION", value: target.version },
    { label: "FILES SURFACE", value: yesNo(supportsFilesSurface(target)), tone: supportsFilesSurface(target) ? "online" : "idle" },
    { label: "SHELL SURFACE", value: yesNo(supportsShellSurface(target)), tone: supportsShellSurface(target) ? "online" : "idle" },
    { label: "DESCRIPTION", value: target.description, wide: true },
    { label: "LAST SEEN", value: formatTimestampTrace(target.lastSeenAt), wide: true },
  ];
}

function targetCapabilityChips(target: ConsoleTarget): ConsoleDetailChip[] {
  return target.implements.map((capability) => ({
    label: capability,
    tone: target.online ? "accent" : "idle",
  }));
}

function adapterDetailFields(adapter: ConsoleAdapterAccount): ConsoleDetailField[] {
  return [
    { label: "ADAPTER", value: adapter.adapter, tone: "info" },
    { label: "ACCOUNT ID", value: adapter.accountId, wide: true },
    { label: "STATE", value: statusForAdapter(adapter), tone: tagToneForAdapter(adapter) },
    { label: "CONNECTED", value: yesNo(adapter.connected), tone: adapter.connected ? "online" : "idle" },
    { label: "AUTHENTICATED", value: yesNo(adapter.authenticated), tone: adapter.authenticated ? "online" : "warn" },
    { label: "MODE", value: adapter.mode },
    { label: "ERROR", value: adapter.error, tone: adapter.error ? "error" : "idle", wide: true },
    { label: "LAST ACTIVITY", value: formatTimestampTrace(adapter.lastActivity), wide: true },
  ];
}

function adapterContextChips(adapter: ConsoleAdapterAccount): ConsoleDetailChip[] {
  const chips: ConsoleDetailChip[] = [
    { label: statusForAdapter(adapter), tone: tagToneForAdapter(adapter) },
  ];
  if (adapter.connected) chips.push({ label: "CONNECTED", tone: "online" });
  if (adapter.authenticated) chips.push({ label: "AUTHENTICATED", tone: "online" });
  if (!adapter.authenticated) chips.push({ label: "AUTH REQUIRED", tone: "warn" });
  if (adapter.mode) chips.push({ label: adapter.mode.toUpperCase(), tone: "info" });
  if (adapter.error) chips.push({ label: "ERROR", tone: "error" });
  return chips;
}

function packageDetailFields(pkg: ConsolePackage): ConsoleDetailField[] {
  return [
    { label: "PACKAGE ID", value: pkg.packageId, wide: true },
    { label: "VERSION", value: pkg.version },
    { label: "RUNTIME", value: RUNTIME_LABEL[pkg.runtime], tone: pkg.runtime === "unknown" ? "warn" : "info" },
    { label: "STATE", value: statusForPackage(pkg), tone: packageStateTone(pkg) },
    { label: "SCOPE", value: packageScopeLabel(pkg), tone: pkg.scopeKind === "unknown" ? "warn" : "info" },
    { label: "SCOPE UID", value: pkg.scopeUid },
    { label: "REVIEW", value: packageReviewLabel(pkg), tone: packageReviewTone(pkg) },
    { label: "APPROVED", value: formatTimestampTrace(pkg.reviewApprovedAt), wide: true },
    { label: "SOURCE REPO", value: pkg.sourceRepo, wide: true },
    { label: "SOURCE REF", value: pkg.sourceRef },
    { label: "SOURCE SUBDIR", value: pkg.sourceSubdir, wide: true },
    { label: "SOURCE VISIBILITY", value: sourceVisibilityLabel(pkg), tone: pkg.sourcePublic ? "info" : "warn" },
    { label: "INSTALLED", value: formatTimestampTrace(pkg.installedAt), wide: true },
    { label: "UPDATED", value: formatTimestampTrace(pkg.updatedAt), wide: true },
  ];
}

function packageEntrypointItems(entrypoints: readonly ConsolePackageEntrypoint[]): ConsoleDetailListItem[] {
  return entrypoints.map((entrypoint, index) => ({
    id: `${index}:${entrypoint.kind}:${entrypoint.name}:${entrypoint.route}:${entrypoint.command}`,
    label: `${entrypoint.kind.toUpperCase()} / ${entrypoint.name}`,
    meta: compactText([
      entrypoint.route ? `route ${entrypoint.route}` : "",
      entrypoint.command ? `command ${entrypoint.command}` : "",
      entrypoint.description,
    ], "NO ROUTE OR COMMAND"),
    chips: entrypoint.syscalls.map((syscall) => ({ label: syscall, tone: "idle" })),
  }));
}

function isRunningProcess(process: ConsoleProcess): boolean {
  return process.state === "running";
}

function isQueuedProcess(process: ConsoleProcess): boolean {
  return process.state === "queued" || process.queuedCount > 0;
}

function toneForProcess(process: ConsoleProcess): StatusTone {
  if (process.state === "running") return "live";
  if (isQueuedProcess(process)) return "update";
  if (process.state === "unknown") return "warn";
  return "idle";
}

function statusForProcess(process: ConsoleProcess): string {
  if (process.state === "running") return "RUNNING";
  if (isQueuedProcess(process)) return "QUEUED";
  if (process.state === "unknown") return "UNKNOWN";
  return "IDLE";
}

function processSub(process: ConsoleProcess): string {
  return compactText([
    process.username || uidLabel(process.uid),
    process.profile,
    process.cwd,
  ], process.pid);
}

function processDetail(process: ConsoleProcess): string {
  if (process.lastActiveAt !== null) {
    return `ACTIVE ${formatAge(process.lastActiveAt)}`;
  }
  if (process.createdAt !== null) {
    return `CREATED ${formatAge(process.createdAt)}`;
  }
  return process.rawState ? `STATE ${process.rawState}` : "NO TIMESTAMP";
}

function processTags(process: ConsoleProcess): RowTag[] {
  const tags: RowTag[] = [];
  if (process.interactive) tags.push({ label: "INTERACTIVE", tone: "info" });
  if (process.activeRunId) tags.push({ label: "RUN ID", tone: "update" });
  if (process.activeConversationId) tags.push({ label: "CONTEXT", tone: "accent" });
  if (process.queuedCount > 0) tags.push({ label: `QUEUE ${process.queuedCount}`, tone: "update" });
  if (process.parentPid) tags.push({ label: "CHILD", tone: "idle" });
  tags.push({ label: processStateLabel(process.state), tone: tagToneForProcess(process) });
  return tags;
}

function processStateLabel(state: ConsoleProcessState): string {
  if (state === "running") return "ACTIVE";
  if (state === "queued") return "QUEUED";
  if (state === "unknown") return "UNKNOWN";
  return "IDLE";
}

function tagToneForProcess(process: ConsoleProcess): TagTone {
  if (process.state === "running") return "online";
  if (isQueuedProcess(process)) return "update";
  if (process.state === "unknown") return "warn";
  return "idle";
}

function supportsFilesSurface(target: ConsoleTarget): boolean {
  return target.implements.some((capability) => /(?:^|[./:-])(fs|file|files|storage|read|write|ripgit)(?:$|[./:-])/i.test(capability));
}

function supportsShellSurface(target: ConsoleTarget): boolean {
  return target.implements.some((capability) => /(?:^|[./:-])(shell|terminal|exec|command|proc|process)(?:$|[./:-])/i.test(capability));
}

function iconForTarget(target: ConsoleTarget): string {
  if (target.kind === "browser") return "bookmark";
  if (target.kind === "adapter") return "chat";
  return "computer";
}

function targetSub(target: ConsoleTarget): string {
  return compactText([
    target.platform,
    target.version,
    target.ownerUsername ? `owner ${target.ownerUsername}` : "",
    target.description,
  ], target.deviceId);
}

function targetDetail(target: ConsoleTarget): string {
  if (target.lastSeenAt !== null) {
    return `SEEN ${formatAge(target.lastSeenAt)}`;
  }
  return target.online ? "LIVE SIGNAL" : "NO LAST SEEN";
}

function targetTags(target: ConsoleTarget): RowTag[] {
  const tags: RowTag[] = [
    { label: TARGET_KIND_LABEL[target.kind], tone: target.online ? "info" : "idle" },
  ];
  if (supportsFilesSurface(target)) tags.push({ label: "FILES", tone: target.online ? "online" : "idle" });
  if (supportsShellSurface(target)) tags.push({ label: "SHELL", tone: target.online ? "online" : "idle" });
  if (target.implements.length > 0) {
    tags.push({ label: `${target.implements.length} CAP`, tone: "accent" });
  } else {
    tags.push({ label: "CAP UNKNOWN", tone: "warn" });
  }
  return tags;
}

function iconForAdapterName(adapter: string): string {
  if (adapter === "telegram") return "telegram";
  if (adapter === "discord") return "discord";
  return "chat";
}

function adapterLabel(adapter: ConsoleAdapterAccount): string {
  return `${formatTokenLabel(adapter.adapter)} · ${adapter.accountId}`;
}

function adapterSub(adapter: ConsoleAdapterAccount): string {
  return compactText([
    adapter.mode ? `mode ${adapter.mode}` : "",
    adapter.lastActivity !== null ? `active ${formatAge(adapter.lastActivity)}` : "",
    adapter.error,
  ], `${adapter.adapter}:${adapter.accountId}`);
}

function adapterDetail(adapter: ConsoleAdapterAccount): string {
  if (adapter.error) return "ERROR";
  if (adapter.lastActivity !== null) return `ACTIVE ${formatAge(adapter.lastActivity)}`;
  if (adapter.connected) return "LIVE SIGNAL";
  return "NO ACTIVITY";
}

function toneForAdapter(adapter: ConsoleAdapterAccount): StatusTone {
  if (adapter.error) return "error";
  if (adapter.connected && adapter.authenticated) return "online";
  if (adapter.connected && !adapter.authenticated) return "warn";
  return "idle";
}

function statusForAdapter(adapter: ConsoleAdapterAccount): string {
  if (adapter.error) return "ERROR";
  if (adapter.connected && adapter.authenticated) return "CONNECTED";
  if (adapter.connected) return "AUTH REQUIRED";
  return "DISCONNECTED";
}

function tagToneForAdapter(adapter: ConsoleAdapterAccount): TagTone {
  if (adapter.error) return "error";
  if (adapter.connected && adapter.authenticated) return "online";
  if (adapter.connected) return "warn";
  return "idle";
}

function adapterTags(adapter: ConsoleAdapterAccount): RowTag[] {
  const tags: RowTag[] = [
    { label: formatTokenLabel(adapter.adapter).toUpperCase(), tone: "info" },
    { label: statusForAdapter(adapter), tone: tagToneForAdapter(adapter) },
  ];
  if (adapter.mode) tags.push({ label: adapter.mode.toUpperCase(), tone: "idle" });
  if (adapter.error) tags.push({ label: "ERROR", tone: "error" });
  return tags;
}

function isTrustedPackage(pkg: ConsolePackage): boolean {
  return !pkg.reviewRequired || pkg.reviewApprovedAt !== null;
}

function filterPackagesForKind(packages: readonly ConsolePackage[], kind: PackageListKind): ConsolePackage[] {
  if (kind === "applications") {
    return packages.filter(isApplicationPackage);
  }
  if (kind === "integrations") {
    return packages.filter((pkg) => !isApplicationPackage(pkg));
  }
  return [...packages];
}

function isApplicationPackage(pkg: ConsolePackage): boolean {
  return pkg.runtime === "web-ui" || pkg.uiEntrypoints.length > 0 || pkg.entrypoints.some((entrypoint) => entrypoint.kind === "ui");
}

function packageListTitle(kind: PackageListKind): string {
  if (kind === "applications") return "APPLICATIONS";
  if (kind === "integrations") return "INTEGRATIONS";
  return "LIBRARY";
}

function packageListNoun(kind: PackageListKind): string {
  if (kind === "applications") return "APPLICATION";
  if (kind === "integrations") return "INTEGRATION";
  return "PACKAGE";
}

function toneForPackage(pkg: ConsolePackage): StatusTone {
  if (pkg.reviewPending) return "update";
  if (pkg.enabled) return "online";
  return "idle";
}

function statusForPackage(pkg: ConsolePackage): string {
  if (pkg.reviewPending) return "REVIEW";
  if (pkg.enabled) return "ENABLED";
  return "DISABLED";
}

function packageSub(pkg: ConsolePackage): string {
  return compactText([
    pkg.version ? `v${pkg.version}` : "",
    RUNTIME_LABEL[pkg.runtime],
    pkg.sourceRepo,
    pkg.sourceRef,
  ], pkg.packageId);
}

function packageDetail(pkg: ConsolePackage): string {
  if (pkg.updatedAt !== null) {
    return `UPDATED ${formatAge(pkg.updatedAt)}`;
  }
  if (pkg.installedAt !== null) {
    return `INSTALLED ${formatAge(pkg.installedAt)}`;
  }
  return "INSTALL TRACE MISSING";
}

function packageTags(pkg: ConsolePackage): RowTag[] {
  const tags: RowTag[] = [];
  if (pkg.reviewPending) {
    tags.push({ label: "REVIEW", tone: "update" });
  } else if (pkg.reviewApprovedAt !== null) {
    tags.push({ label: "APPROVED", tone: "online" });
  } else if (!pkg.reviewRequired) {
    tags.push({ label: "TRUSTED", tone: "online" });
  } else {
    tags.push({ label: "UNREVIEWED", tone: "warn" });
  }
  tags.push({ label: pkg.enabled ? "INSTALLED" : "DISABLED", tone: pkg.enabled ? "online" : "idle" });
  tags.push({ label: pkg.scopeKind === "global" ? "GLOBAL" : pkg.scopeKind === "user" ? "USER" : "SCOPE UNKNOWN", tone: pkg.scopeKind === "unknown" ? "warn" : "info" });
  tags.push({ label: sourceVisibilityLabel(pkg), tone: pkg.sourcePublic ? "info" : "warn" });
  if (pkg.uiEntrypoints.length > 0) tags.push({ label: `UI ${pkg.uiEntrypoints.length}`, tone: "accent" });
  if (pkg.bindingNames.length > 0) tags.push({ label: `BIND ${pkg.bindingNames.length}`, tone: "idle" });
  return tags;
}

function packageStateTone(pkg: ConsolePackage): TagTone {
  if (pkg.reviewPending) return "update";
  if (pkg.enabled) return "online";
  return "idle";
}

function packageReviewLabel(pkg: ConsolePackage): string {
  if (pkg.reviewPending) return "PENDING REVIEW";
  if (pkg.reviewApprovedAt !== null) return "APPROVED";
  if (!pkg.reviewRequired) return "NOT REQUIRED";
  return "REQUIRED";
}

function packageReviewTone(pkg: ConsolePackage): TagTone {
  if (pkg.reviewPending) return "update";
  if (isTrustedPackage(pkg)) return "online";
  return "warn";
}

function packageScopeLabel(pkg: ConsolePackage): string {
  if (pkg.scopeKind === "global") return "GLOBAL";
  if (pkg.scopeKind === "user") {
    return pkg.scopeUid === null ? "USER" : `USER ${pkg.scopeUid}`;
  }
  return "UNKNOWN";
}

function sourceVisibilityLabel(pkg: ConsolePackage): string {
  return pkg.sourcePublic ? "PUBLIC" : "NON-PUBLIC";
}

function compactText(parts: readonly (string | null | undefined)[], fallback: string): string {
  const value = parts
    .map((part) => part?.trim() ?? "")
    .filter(Boolean)
    .join(" / ");
  return value || fallback;
}

function formatTokenLabel(value: string): string {
  return value
    .split(/[-_.:/\s]+/g)
    .filter(Boolean)
    .map((part) => part.length <= 3 ? part.toUpperCase() : `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(" ") || "Unknown";
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function uidLabel(uid: number | null): string {
  return uid === null ? "" : `uid ${uid}`;
}

function newestTimestamp(values: readonly (number | null)[]): number | null {
  const normalized = values
    .filter((value): value is number => value !== null)
    .map(normalizeTimestamp);
  if (normalized.length === 0) {
    return null;
  }
  return Math.max(...normalized);
}

function normalizeTimestamp(value: number): number {
  return value < 10_000_000_000 ? value * 1000 : value;
}

function formatTimestampTrace(value: number | null): string {
  if (value === null) {
    return "";
  }
  const timestamp = normalizeTimestamp(value);
  return `${formatAge(timestamp)} / ${new Date(timestamp).toLocaleString()}`;
}

function formatAge(value: number): string {
  const timestamp = normalizeTimestamp(value);
  const diffMs = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "NOW";
  if (minutes < 60) return `${minutes}M AGO`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}H AGO`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}D AGO`;
  return new Date(timestamp).toLocaleDateString();
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function yesNo(value: boolean): string {
  return value ? "YES" : "NO";
}
