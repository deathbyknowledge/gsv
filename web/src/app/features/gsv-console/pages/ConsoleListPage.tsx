import type { ComponentChildren } from "preact";
import { Icon } from "../../../components/ui/Icon";
import { ListRow } from "../../../components/ui/ListRow";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { StatusDot, type StatusTone } from "../../../components/ui/StatusDot";
import { Tag, type TagTone } from "../../../components/ui/Tag";
import {
  useConsoleAccounts,
  useConsolePackages,
  useConsoleProcesses,
  useConsoleTargets,
} from "../hooks/useConsoleData";
import type {
  ConsoleAccount,
  ConsoleAccountRelation,
  ConsolePackage,
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
import "./ConsoleListPage.css";

type ConsoleListKind = "crew" | "machines" | "library" | "tasks";

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
};

const EMPTY_RESOURCE_LABEL: Record<ConsoleListKind, string> = {
  crew: "NO ACCOUNTS",
  machines: "NO MACHINES",
  library: "NO PACKAGES",
  tasks: "NO PROCESSES",
};

const RELATION_LABEL: Record<ConsoleAccountRelation, string> = {
  self: "SELF",
  "personal-agent": "PERSONAL AGENT",
  agent: "AGENT",
  human: "HUMAN",
  unknown: "UNKNOWN",
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
  const accounts = useConsoleAccounts({ enabled: kind === "crew" });
  const targets = useConsoleTargets({ enabled: kind === "machines" });
  const packages = useConsolePackages({ enabled: kind === "library" });
  const processes = useConsoleProcesses({ enabled: kind === "tasks" });

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

  if (kind === "library") {
    return (
      <ConsolePage>
        <ConsoleResourceBoundary
          resource={resourceWithLocalEmptyState(packages.resource)}
          emptyLabel={EMPTY_RESOURCE_LABEL.library}
          errorLabel="LIBRARY"
          render={(data) => (
            <LibraryConsoleSection
              packages={data}
              refreshing={packages.resource.isRefreshing}
            />
          )}
        />
      </ConsolePage>
    );
  }

  return (
    <ConsolePage>
      <ConsoleResourceBoundary
        resource={resourceWithLocalEmptyState(accounts.resource)}
        emptyLabel={EMPTY_RESOURCE_LABEL.crew}
        errorLabel="CREW"
        render={(data) => (
          <CrewConsoleSection
            accounts={data}
            refreshing={accounts.resource.isRefreshing}
          />
        )}
      />
    </ConsolePage>
  );
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
          />
        ))}
      </InventoryGroup>
    </OperationalLayout>
  );
}

function CrewConsoleSection({
  accounts,
  refreshing,
}: {
  accounts: readonly ConsoleAccount[];
  refreshing: boolean;
}) {
  const runnable = accounts.filter((account) => account.runnable);
  const operators = accounts.filter((account) => account.relation === "self" || account.relation === "human");
  const agents = accounts.filter((account) => account.relation === "personal-agent" || account.relation === "agent");
  const other = accounts.filter((account) => !operators.includes(account) && !agents.includes(account));

  return (
    <OperationalLayout
      title="CREW"
      meta={refreshing ? "REFRESHING" : `${accounts.length} ACCOUNTS`}
      signals={[
        { label: "ACCOUNTS", value: accounts.length, meta: "KNOWN IDENTITIES", tone: accounts.length > 0 ? "online" : "idle" },
        { label: "RUNNABLE", value: runnable.length, meta: "PROC SPAWN", tone: runnable.length > 0 ? "online" : "idle" },
        { label: "AGENTS", value: agents.length, meta: "AUTONOMOUS", tone: agents.length > 0 ? "online" : "idle" },
        { label: "OPERATORS", value: operators.length, meta: "HUMAN ACCESS", tone: operators.length > 0 ? "online" : "idle" },
      ]}
      rail={(
        <>
          <RailSection title="ACCESS STATE" meta={`${runnable.length}/${accounts.length} RUNNABLE`}>
            <RailSignalRow icon="stars" label="PROC.SPAWN" meta={`${runnable.length} runnable identities`} tone={runnable.length > 0 ? "online" : "idle"} />
            <RailSignalRow icon="tag" label="ACCOUNT ONLY" meta={`${accounts.length - runnable.length} non-runnable identities`} tone={accounts.length - runnable.length > 0 ? "idle" : "online"} />
            <RailSignalRow icon="chat" label="PERSONAL AGENTS" meta={`${accounts.filter((account) => account.relation === "personal-agent").length} assigned`} tone="online" />
          </RailSection>
          <RailSection title="RELATIONS" meta="GROUPED">
            <RailSignalRow icon="tag" label="SELF" meta={`${accounts.filter((account) => account.relation === "self").length} accounts`} tone="online" />
            <RailSignalRow icon="chat" label="AGENT" meta={`${agents.length} accounts`} tone={agents.length > 0 ? "online" : "idle"} />
            <RailSignalRow icon="computer" label="HUMAN" meta={`${accounts.filter((account) => account.relation === "human").length} accounts`} tone={operators.length > 0 ? "online" : "idle"} />
          </RailSection>
        </>
      )}
    >
      <AccountGroup title="OPERATORS" accounts={operators} emptyLabel="NO OPERATOR ACCOUNTS" />
      <AccountGroup title="AGENTS" accounts={agents} emptyLabel="NO AGENT ACCOUNTS" />
      <AccountGroup title="OTHER ACCESS" accounts={other} emptyLabel="NO OTHER ACCOUNTS" />
    </OperationalLayout>
  );
}

function AccountGroup({
  title,
  accounts,
  emptyLabel,
}: {
  title: string;
  accounts: readonly ConsoleAccount[];
  emptyLabel: string;
}) {
  const runnable = accounts.filter((account) => account.runnable).length;

  return (
    <InventoryGroup title={title} meta={`${runnable}/${accounts.length} RUNNABLE`} emptyLabel={emptyLabel} isEmpty={accounts.length === 0}>
      {accounts.map((account) => (
        <OperationalRow
          key={String(account.uid)}
          icon={account.runnable ? "chat" : "tag"}
          label={account.displayName}
          sub={accountSub(account)}
          tone={account.runnable ? "online" : "idle"}
          statusLabel={account.runnable ? "RUNNABLE" : "ACCOUNT"}
          detail={`UID ${account.uid}`}
          tags={accountTags(account)}
        />
      ))}
    </InventoryGroup>
  );
}

function LibraryConsoleSection({
  packages,
  refreshing,
}: {
  packages: readonly ConsolePackage[];
  refreshing: boolean;
}) {
  const reviewQueue = packages.filter((pkg) => pkg.reviewPending);
  const enabled = packages.filter((pkg) => pkg.enabled && !pkg.reviewPending);
  const disabled = packages.filter((pkg) => !pkg.enabled && !pkg.reviewPending);
  const trusted = packages.filter(isTrustedPackage);
  const updated = packages.filter((pkg) => pkg.updatedAt !== null);
  const latestUpdate = newestTimestamp(packages.map((pkg) => pkg.updatedAt));

  return (
    <OperationalLayout
      title="LIBRARY"
      meta={refreshing ? "REFRESHING" : `${packages.length} PACKAGES`}
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
      <PackageGroup title="ENABLED PACKAGES" packages={enabled} emptyLabel="NO ENABLED PACKAGES" />
      <PackageGroup title="DISABLED PACKAGES" packages={disabled} emptyLabel="NO DISABLED PACKAGES" />
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
        />
      ))}
    </InventoryGroup>
  );
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

function accountSub(account: ConsoleAccount): string {
  return compactText([
    account.username,
    account.gecos,
  ], `uid ${account.uid}`);
}

function accountTags(account: ConsoleAccount): RowTag[] {
  return [
    { label: RELATION_LABEL[account.relation], tone: account.relation === "unknown" ? "warn" : "info" },
    { label: account.runnable ? "PROC.SPAWN" : "ACCESS", tone: account.runnable ? "online" : "idle" },
  ];
}

function isTrustedPackage(pkg: ConsolePackage): boolean {
  return !pkg.reviewRequired || pkg.reviewApprovedAt !== null;
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
  tags.push({ label: pkg.sourcePublic ? "PUBLIC" : "PRIVATE", tone: pkg.sourcePublic ? "info" : "warn" });
  if (pkg.uiEntrypoints.length > 0) tags.push({ label: `UI ${pkg.uiEntrypoints.length}`, tone: "accent" });
  if (pkg.bindingNames.length > 0) tags.push({ label: `BIND ${pkg.bindingNames.length}`, tone: "idle" });
  return tags;
}

function compactText(parts: readonly (string | null | undefined)[], fallback: string): string {
  const value = parts
    .map((part) => part?.trim() ?? "")
    .filter(Boolean)
    .join(" / ");
  return value || fallback;
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
