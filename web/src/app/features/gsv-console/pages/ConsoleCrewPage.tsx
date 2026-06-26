import type { JSX } from "preact";
import { AgentCard, type AgentTask } from "../../../components/ui/AgentCard";
import type { AvatarStatus } from "../../../components/ui/Avatar";
import { CrewAddTile } from "../../../components/ui/CrewTile";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import {
  ConsolePage,
  ConsoleResourceBoundary,
} from "../components/ConsolePageTemplate";
import type {
  ConsoleAccount,
  ConsoleConfigEntry,
  ConsoleProcess,
  ConsoleResourceState,
} from "../domain/consoleModels";
import { modelLabelsForConfig } from "../domain/consoleAi";
import {
  behaviorForAccount,
  inheritedModelLabelForAccount,
  modelLabelsForAccount,
  type AgentApprovalAction,
} from "../domain/consoleAgentBehavior";
import {
  agentImageSrcForIndex,
  labelForConsoleAccountRelation,
  sortedConsoleAccounts,
} from "../domain/agentPresentation";
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
  tasks: AgentTask[];
  active: boolean;
  model: string;
  modelIsDefault: boolean;
  modelOptions: string[];
  permission: AgentApprovalAction;
};

type ConsoleCrewPageProps = {
  onManageAgent?: (uid: number) => void;
  onCreateAgent?: () => void;
};

export function ConsoleCrewPage({ onManageAgent, onCreateAgent }: ConsoleCrewPageProps) {
  const accounts = useConsoleAccounts();
  const config = useConsoleConfig();
  const processes = useConsoleProcesses();

  return (
    <ConsolePage flush>
      <ConsoleResourceBoundary
        resource={accounts.resource}
        emptyLabel="NO CREW ACCOUNTS"
        errorLabel="CREW"
        render={(data) => (
          <CrewRoster
            accounts={data}
            config={config.config}
            processResource={processes.resource}
            onManageAgent={onManageAgent}
            onCreateAgent={onCreateAgent}
          />
        )}
      />
    </ConsolePage>
  );
}

function CrewRoster({
  accounts,
  config,
  processResource,
  onManageAgent,
  onCreateAgent,
}: {
  accounts: readonly ConsoleAccount[];
  config: readonly ConsoleConfigEntry[];
  processResource: ConsoleResourceState<ConsoleProcess[]>;
  onManageAgent?: (uid: number) => void;
  onCreateAgent?: () => void;
}) {
  const processes = processResource.data ?? [];
  const sortedAccounts = sortedConsoleAccounts(accounts);
  const modelLabels = modelLabelsForConfig(config);
  const ownerUid = viewerAccountForCrew(sortedAccounts)?.uid ?? null;
  const cards = sortedAccounts.map((account, index) => buildCrewCard(
    account,
    processes,
    index,
    config,
    modelLabels,
    ownerUid,
  ));
  const running = cards.filter((card) => card.processes.some(isRunningProcess)).length;
  const runnable = cards.filter((card) => card.account.runnable).length;
  const accountCount = cards.length;
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
          meta={`${accountCount} ACCOUNTS / ${runnable} RUNNABLE / ${running} RUNNING / ${telemetryLabel}`}
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
                initialModel={card.model}
                initialPermission={card.permission}
                modelIsDefault={card.modelIsDefault}
                models={card.modelOptions}
                tasks={card.tasks}
                tasksTotal={card.processes.length}
                active={card.active}
                showActions={false}
                readOnly
              />
            </div>
          ))}
          <CrewAddTile
            className="gsv-console-crew-add-tile"
            description="Spin up a new crew member with its own persona & files"
            label="NEW AGENT"
            onClick={onCreateAgent}
          />
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
  config: readonly ConsoleConfigEntry[],
  modelLabels: readonly string[],
  ownerUid: number | null,
): CrewCardModel {
  const ownedProcesses = processes.filter((process) => ownsProcess(account, process));
  const behavior = behaviorForAccount(config, account.uid);
  const inheritedModelLabel = inheritedModelLabelForAccount(config, account.uid, ownerUid);
  const queued = ownedProcesses.some(isQueuedProcess);
  const running = ownedProcesses.some(isRunningProcess);
  const unknown = ownedProcesses.some((process) => process.state === "unknown");
  const role = labelForConsoleAccountRelation(account.relation);
  const status: AvatarStatus = unknown ? "error" : running || queued ? "live" : account.runnable ? "idle" : "idle";

  return {
    account,
    processes: ownedProcesses,
    imageSrc: agentImageSrcForIndex(index),
    role,
    description: accountDescription(account),
    status,
    tasks: tasksForProcesses(ownedProcesses),
    active: account.runnable,
    model: behavior.model,
    modelIsDefault: behavior.model.trim().length === 0,
    modelOptions: modelLabelsForAccount(modelLabels, behavior.model, inheritedModelLabel),
    permission: behavior.permission,
  };
}

function viewerAccountForCrew(accounts: readonly ConsoleAccount[]): ConsoleAccount | null {
  return accounts.find((account) => account.relation === "self")
    ?? accounts.find((account) => account.uid === 0)
    ?? accounts.find((account) => account.relation === "human")
    ?? null;
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
