import { AddAction } from "../../../components/ui/AddAction";
import { AgentCard, type AgentTask } from "../../../components/ui/AgentCard";
import type { AvatarStatus } from "../../../components/ui/Avatar";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { StatusDot, type StatusTone } from "../../../components/ui/StatusDot";
import { Tag, type TagTone } from "../../../components/ui/Tag";
import {
  ConsolePage,
  ConsoleResourceBoundary,
} from "../components/ConsolePageTemplate";
import type {
  ConsoleAccount,
  ConsoleAccountRelation,
  ConsoleProcess,
  ConsoleResourceState,
} from "../domain/consoleModels";
import { modelLabelsForConfig } from "../domain/consoleAi";
import {
  useConsoleAccounts,
  useConsoleConfig,
  useConsoleProcesses,
} from "../hooks/useConsoleData";
import "./ConsoleCrewPage.css";

type CrewCardModel = {
  account: ConsoleAccount;
  processes: ConsoleProcess[];
  imageSrc: string;
  role: string;
  description: string;
  status: AvatarStatus;
  statusLabel: string;
  tone: StatusTone;
  tasks: AgentTask[];
  active: boolean;
  modelIsDefault: boolean;
};

type CrewMetric = {
  label: string;
  value: number | string;
  tone: StatusTone;
  meta: string;
};

const RELATION_LABEL: Record<ConsoleAccountRelation, string> = {
  self: "OPERATOR",
  "personal-agent": "PERSONAL AGENT",
  agent: "AGENT",
  human: "HUMAN",
  unknown: "ACCOUNT",
};

type ConsoleCrewPageProps = {
  onManageAgent?: (uid: number) => void;
};

export function ConsoleCrewPage({ onManageAgent }: ConsoleCrewPageProps) {
  const accounts = useConsoleAccounts();
  const config = useConsoleConfig();
  const processes = useConsoleProcesses();

  return (
    <ConsolePage>
      <ConsoleResourceBoundary
        resource={accounts.resource}
        emptyLabel="NO CREW ACCOUNTS"
        errorLabel="CREW"
        render={(data) => (
          <CrewRoster
            accounts={data}
            modelLabels={modelLabelsForConfig(config.config)}
            processResource={processes.resource}
            onManageAgent={onManageAgent}
          />
        )}
      />
    </ConsolePage>
  );
}

function CrewRoster({
  accounts,
  modelLabels,
  processResource,
  onManageAgent,
}: {
  accounts: readonly ConsoleAccount[];
  modelLabels: string[];
  processResource: ConsoleResourceState<ConsoleProcess[]>;
  onManageAgent?: (uid: number) => void;
}) {
  const processes = processResource.data ?? [];
  const cards = accounts
    .map((account, index) => buildCrewCard(account, processes, index))
    .sort(compareCrewCards);
  const running = cards.filter((card) => card.processes.some(isRunningProcess)).length;
  const runnable = accounts.filter((account) => account.runnable).length;
  const agents = accounts.filter(isAgentAccount).length;
  const operators = accounts.filter((account) => account.relation === "self" || account.relation === "human").length;
  const processMeta = processResource.isRefreshing
    ? "REFRESHING PROCESS TELEMETRY"
    : processResource.isError
      ? "PROCESS TELEMETRY ERROR"
      : processResource.isUnavailable
        ? "PROCESS TELEMETRY OFFLINE"
        : `${processes.length} PROCESS ${processes.length === 1 ? "TRACE" : "TRACES"}`;
  const metrics: CrewMetric[] = [
    { label: "AGENTS", value: agents, meta: "AUTONOMOUS", tone: agents > 0 ? "online" : "idle" },
    { label: "OPERATORS", value: operators, meta: "HUMAN ACCESS", tone: operators > 0 ? "online" : "idle" },
    { label: "RUNNABLE", value: runnable, meta: "PROC.SPAWN", tone: runnable > 0 ? "online" : "idle" },
    { label: "PROCESSES", value: processes.length, meta: processMeta, tone: processToneForResource(processResource) },
  ];

  return (
    <section class="gsv-console-crew">
      <div class="gsv-console-crew-panel">
        <SectionHeader
          title="CREW"
          meta={`${cards.length} ACCOUNTS / ${running} RUNNING`}
          divider
        />
        <div class="gsv-console-crew-metrics">
          {metrics.map((metric) => (
            <CrewMetricCell key={metric.label} metric={metric} />
          ))}
        </div>
        <div class="gsv-console-crew-grid">
          {cards.map((card) => (
            <div class="gsv-console-crew-card-shell" key={card.account.uid}>
              <AgentCard
                agentName={card.account.displayName}
                agentRole={card.role}
                description={card.description}
                imgSrc={card.imageSrc}
                status={card.status}
                modelIsDefault={card.modelIsDefault}
                models={modelLabels}
                tasks={card.tasks}
                tasksTotal={card.processes.length}
                active={card.active}
                showActions={false}
                readOnly
                onManage={onManageAgent ? () => onManageAgent(card.account.uid) : undefined}
              />
              <div class="gsv-console-crew-card-footer">
                <Tag label={card.statusLabel} tone={tagToneForCard(card)} boxed dot />
                <span>{accountFooter(card.account)}</span>
              </div>
            </div>
          ))}
          <div class="gsv-console-crew-add-tile" aria-disabled="true">
            <AddAction variant="tile" label="NEW AGENT" />
          </div>
        </div>
      </div>
    </section>
  );
}

function CrewMetricCell({ metric }: { metric: CrewMetric }) {
  return (
    <div class="gsv-console-crew-metric">
      <span>{metric.label}</span>
      <strong>{metric.value}</strong>
      <small>
        <StatusDot tone={metric.tone} size={7} />
        {metric.meta}
      </small>
    </div>
  );
}

function buildCrewCard(
  account: ConsoleAccount,
  processes: readonly ConsoleProcess[],
  index: number,
): CrewCardModel {
  const ownedProcesses = processes.filter((process) => ownsProcess(account, process));
  const queued = ownedProcesses.some(isQueuedProcess);
  const running = ownedProcesses.some(isRunningProcess);
  const unknown = ownedProcesses.some((process) => process.state === "unknown");
  const role = RELATION_LABEL[account.relation];
  const status: AvatarStatus = unknown ? "error" : running || queued ? "live" : account.runnable ? "idle" : "idle";
  const statusLabel = unknown ? "ERROR" : queued ? "QUEUED" : running ? "RUNNING" : account.runnable ? "IDLE" : "ACCOUNT";

  return {
    account,
    processes: ownedProcesses,
    imageSrc: `/img/agent-${index % 3}.png`,
    role,
    description: accountDescription(account),
    status,
    statusLabel,
    tone: unknown ? "error" : queued ? "update" : running ? "live" : account.runnable ? "idle" : "idle",
    tasks: tasksForProcesses(ownedProcesses),
    active: account.runnable,
    modelIsDefault: isAgentAccount(account),
  };
}

function compareCrewCards(left: CrewCardModel, right: CrewCardModel): number {
  return accountRank(left.account.relation) - accountRank(right.account.relation)
    || Number(right.account.runnable) - Number(left.account.runnable)
    || left.account.username.localeCompare(right.account.username);
}

function accountRank(relation: ConsoleAccountRelation): number {
  if (relation === "personal-agent") return 0;
  if (relation === "agent") return 1;
  if (relation === "self") return 2;
  if (relation === "human") return 3;
  return 4;
}

function processToneForResource(resource: ConsoleResourceState<ConsoleProcess[]>): StatusTone {
  if (resource.isError) return "error";
  if (resource.isUnavailable) return "idle";
  if (resource.isLoading || resource.isRefreshing) return "live";
  return resource.data && resource.data.length > 0 ? "online" : "idle";
}

function tagToneForCard(card: CrewCardModel): TagTone {
  if (card.tone === "live") return "online";
  if (card.tone === "update") return "update";
  if (card.tone === "error") return "error";
  return "idle";
}

function isAgentAccount(account: ConsoleAccount): boolean {
  return account.relation === "personal-agent" || account.relation === "agent";
}

function ownsProcess(account: ConsoleAccount, process: ConsoleProcess): boolean {
  return process.uid === account.uid || process.username === account.username;
}

function isRunningProcess(process: ConsoleProcess): boolean {
  return process.state === "running" || process.activeRunId !== null;
}

function isQueuedProcess(process: ConsoleProcess): boolean {
  return process.state === "queued" || process.queuedCount > 0;
}

function tasksForProcesses(processes: readonly ConsoleProcess[]): AgentTask[] {
  if (processes.length === 0) {
    return [{ name: "No process activity", status: "idle" }];
  }
  return processes.map((process) => ({
    name: process.label || process.pid,
    status: process.state === "unknown" ? "error" : isRunningProcess(process) || isQueuedProcess(process) ? "running" : "idle",
  }));
}

function accountDescription(account: ConsoleAccount): string {
  if (account.gecos.trim().length > 0) {
    return account.gecos;
  }
  return `${account.username} / uid ${account.uid}`;
}

function accountFooter(account: ConsoleAccount): string {
  return `${account.username} / uid ${account.uid}`;
}
