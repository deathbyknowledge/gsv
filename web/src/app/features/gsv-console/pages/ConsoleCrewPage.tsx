import type { JSX } from "preact";
import { useMemo, useState } from "preact/hooks";
import { AgentCard, type AgentTask } from "../../../components/ui/AgentCard";
import type { AvatarStatus } from "../../../components/ui/Avatar";
import { CardListTemplate } from "../card-template/CardListTemplate";
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
  avatarForAccount,
  isConsoleAgentAccount,
  isHumanCrewAccount,
  labelForConsoleAccountRelation,
  orderedCrewAccounts,
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
  displayName: string;
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
  const [query, setQuery] = useState("");
  const processes = processResource.data ?? [];
  const modelLabels = modelLabelsForConfig(config);
  // Humans first; agents keep their existing rank order after.
  const ordered = orderedCrewAccounts(accounts);
  const ownerUid = viewerAccountForCrew(ordered)?.uid ?? null;
  const cards = ordered.map((account) => {
    const human = isHumanCrewAccount(account);
    // Orb for humans; agents show their persisted portrait (legacy position
    // fallback for agents created before portraits were fixed).
    const imageSrc = avatarForAccount(account, config, accounts);
    return buildCrewCard(account, processes, imageSrc, human, config, modelLabels, ownerUid);
  });
  const humanCount = accounts.filter(isHumanCrewAccount).length;
  const machineCount = accounts.filter(isConsoleAgentAccount).length;
  const crewMeta = `${humanCount} HUMAN${humanCount === 1 ? "" : "S"} / ${machineCount} MACHINE${machineCount === 1 ? "" : "S"}`;

  const visibleCards = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? cards.filter((card) =>
          card.displayName.toLowerCase().includes(q) ||
          card.account.displayName.toLowerCase().includes(q)
        )
      : cards;
  }, [cards, query]);

  return (
    <CardListTemplate
      listTitle="CREW"
      listMeta={crewMeta}
      emptyObject="CREW"
      isEmpty={visibleCards.length === 0}
      connectLabel={onCreateAgent ? "+ NEW AGENT" : undefined}
      onConnect={onCreateAgent}
      search={{ value: query, placeholder: "Search crew…", onChange: setQuery }}
    >
      {visibleCards.map((card) => (
        <div
          class="gsv-console-crew-card-shell"
          data-clickable={onManageAgent ? "true" : undefined}
          key={card.account.uid}
          onClick={onManageAgent ? () => onManageAgent(card.account.uid) : undefined}
          onKeyDown={onManageAgent ? (event) => handleCardKeyDown(event, card.account.uid, onManageAgent) : undefined}
          tabIndex={onManageAgent ? 0 : undefined}
        >
          <AgentCard
            agentName={card.displayName}
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
            avatarCover={!isHumanCrewAccount(card.account)}
            showActions={false}
            readOnly
          />
        </div>
      ))}
    </CardListTemplate>
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
  imageSrc: string,
  isHuman: boolean,
  config: readonly ConsoleConfigEntry[],
  modelLabels: readonly string[],
  ownerUid: number | null,
): CrewCardModel {
  const ownedProcesses = processes.filter((process) => ownsProcess(account, process));
  const behavior = behaviorForAccount(config, account.uid, ownerUid);
  const inheritedModelLabel = inheritedModelLabelForAccount(config, account.uid, ownerUid);
  const queued = ownedProcesses.some(isQueuedProcess);
  const running = ownedProcesses.some(isRunningProcess);
  const unknown = ownedProcesses.some((process) => process.state === "unknown");
  const role = labelForConsoleAccountRelation(account.relation);
  // The human is always shown online; agents reflect their process state.
  const status: AvatarStatus = isHuman
    ? "online"
    : unknown ? "error" : running || queued ? "live" : "idle";

  return {
    account,
    processes: ownedProcesses,
    imageSrc,
    displayName: isHuman ? "Defaults" : account.displayName,
    role,
    description: isHuman ? "These are your preferences, applied to all your agents." : accountDescription(account),
    status,
    tasks: tasksForProcesses(ownedProcesses),
    active: account.runnable,
    model: behavior.modelLabel,
    modelIsDefault: behavior.model.trim().length === 0,
    modelOptions: modelLabelsForAccount(modelLabels, behavior.modelLabel || behavior.model, inheritedModelLabel),
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
