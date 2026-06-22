import type { JSX } from "preact";
import { AddAction } from "../../../components/ui/AddAction";
import { AgentCard, type AgentTask } from "../../../components/ui/AgentCard";
import type { AvatarStatus } from "../../../components/ui/Avatar";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import type { StatusTone } from "../../../components/ui/StatusDot";
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
  const telemetryLabel = processResource.isRefreshing
    ? "REFRESHING"
    : processResource.isError
      ? "TELEMETRY ERROR"
      : processResource.isUnavailable
        ? "TELEMETRY OFFLINE"
        : `${processes.length} PROCESS ${processes.length === 1 ? "TRACE" : "TRACES"}`;

  return (
    <section class="gsv-console-crew">
      <div class="gsv-console-crew-panel">
        <SectionHeader
          title="CREW"
          meta={`${agents} AGENTS / ${runnable} RUNNABLE / ${running} RUNNING / ${telemetryLabel}`}
          divider
        />
        <div class="gsv-console-crew-grid">
          {cards.map((card) => (
            <div
              class="gsv-console-crew-card-shell"
              data-clickable={onManageAgent ? "true" : undefined}
              key={card.account.uid}
              onClick={onManageAgent ? () => onManageAgent(card.account.uid) : undefined}
              onKeyDown={onManageAgent ? (event) => handleCardKeyDown(event, card.account.uid, onManageAgent) : undefined}
              tabIndex={onManageAgent ? 0 : undefined}
            >
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

function handleCardKeyDown(
  event: JSX.TargetedKeyboardEvent<HTMLDivElement>,
  uid: number,
  onManageAgent: (uid: number) => void,
): void {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }
  event.preventDefault();
  onManageAgent(uid);
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
