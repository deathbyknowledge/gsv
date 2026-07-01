import { useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  AgentEditor,
  type AgentEditorDraft,
  type AgentEditorFile,
  type AgentEditorModelOption,
  type AgentEditorTab,
  type AgentEditorTask,
} from "../../../components/ui/AgentEditor";
import type { AgentToolTarget } from "../../../components/ui/AgentToolsPanel";
import type { AvatarStatus } from "../../../components/ui/Avatar";
import type { ConsoleAgentContextFile } from "../backend/consoleService";
import {
  ConsolePage,
  ConsolePageState,
  ConsoleResourceBoundary,
} from "../components/ConsolePageTemplate";
import type {
  ConsoleAccount,
  ConsoleConfigEntry,
  ConsoleProcess,
  ConsoleResourceState,
  ConsoleTarget,
} from "../domain/consoleModels";
import { modelOptionsForConfig, type ConsoleModelOption } from "../domain/consoleAi";
import {
  behaviorForAccount,
  defaultApprovalPolicyForConfig,
  inheritedModelLabelForAccount,
  inheritedReasoningForAccount,
  modelOptionsForAccount,
  parseApprovalPolicy,
  serializeApprovalPolicy,
} from "../domain/consoleAgentBehavior";
import {
  CREW_HUMAN_IMAGE,
  agentImageSrcForAccount,
  agentImageSrcForIndex,
  isHumanCrewAccount,
  labelForConsoleAccountRelation,
} from "../domain/agentPresentation";
import {
  useConsoleAgentContext,
  useConsoleAccounts,
  useConsoleConfig,
  useConsoleProcesses,
  useConsoleTargets,
  useCreateConsoleAgent,
  useSaveConsoleAgentBehavior,
  useSaveConsoleAgentContext,
} from "../hooks/useConsoleData";
import "./ConsoleAgentPage.css";

type ConsoleAgentPageProps = {
  accountUid: number | null;
  createNew?: boolean;
  onAgentCreated?: (uid: number) => void;
  onBackToCrew: () => void;
};

export function ConsoleAgentPage({
  accountUid,
  createNew = false,
  onAgentCreated,
  onBackToCrew,
}: ConsoleAgentPageProps) {
  const accounts = useConsoleAccounts();
  const config = useConsoleConfig();
  const processes = useConsoleProcesses();
  const targets = useConsoleTargets();
  const modelOptions = modelOptionsForConfig(config.config);
  const toolTargets = agentToolTargetsForConsoleTargets(targets.targets);
  const ownerUid = viewerAccountForAgents(accounts.resource.data ?? [])?.uid ?? null;
  const inheritedNewAgentModel = inheritedModelLabelForAccount(config.config, -1, ownerUid);
  const inheritedNewAgentReasoning = inheritedReasoningForAccount(config.config, -1, ownerUid);
  const defaultApprovalPolicy = defaultApprovalPolicyForConfig(config.config, ownerUid);
  const newAgentModelOptions = modelOptionsForAccount(modelOptions, "", inheritedNewAgentModel);

  if (createNew) {
    return (
      <ConsolePage flush>
        <NewAgentEditorSurface
          accountCount={accounts.resource.data?.length ?? 0}
          modelOptions={newAgentModelOptions}
          toolTargets={toolTargets}
          inheritedReasoning={inheritedNewAgentReasoning}
          defaultApprovalPolicy={defaultApprovalPolicy}
          onAgentCreated={onAgentCreated}
          onBackToCrew={onBackToCrew}
        />
      </ConsolePage>
    );
  }

  return (
    <ConsolePage flush>
      <ConsoleResourceBoundary
        resource={accounts.resource}
        emptyLabel="NO AGENT ACCOUNT"
        errorLabel="AGENT"
        render={(data) => {
          const account = selectAccount(data, accountUid);
          if (!account) {
            return <ConsolePageState kind="empty" label="NO AGENT ACCOUNT" />;
          }
          return (
            <AgentEditorSurface
              account={account}
              accounts={data}
              config={config.config}
              modelOptions={modelOptions}
              toolTargets={toolTargets}
              ownerUid={viewerAccountForAgents(data)?.uid ?? null}
              processResource={processes.resource}
            />
          );
        }}
      />
    </ConsolePage>
  );
}

function AgentEditorSurface({
  account,
  accounts,
  config,
  modelOptions,
  toolTargets,
  ownerUid,
  processResource,
}: {
  account: ConsoleAccount;
  accounts: readonly ConsoleAccount[];
  config: readonly ConsoleConfigEntry[];
  modelOptions: ConsoleModelOption[];
  toolTargets: readonly AgentToolTarget[];
  ownerUid: number | null;
  processResource: ConsoleResourceState<ConsoleProcess[]>;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [activeEditorTab, setActiveEditorTab] = useState<AgentEditorTab>("general");
  const processes = (processResource.data ?? []).filter((process) => ownsProcess(account, process));
  const context = useConsoleAgentContext(account.username);
  const saveBehavior = useSaveConsoleAgentBehavior();
  const saveContext = useSaveConsoleAgentContext();
  const contextEditable = !context.resource.isLoading
    && !context.resource.isUnavailable
    && !context.resource.isError;
  const behavior = behaviorForAccount(config, account.uid, ownerUid);
  const editsUserDefaults = isHumanCrewAccount(account);
  const behaviorEditable = account.runnable;
  const inheritedModelLabel = inheritedModelLabelForAccount(config, account.uid, ownerUid);
  const inheritedReasoning = inheritedReasoningForAccount(config, account.uid, ownerUid);
  const resolvedModelOptions = modelOptionsForAccount(modelOptions, behavior.model, inheritedModelLabel);
  const files = editorFilesForAccount({
    account,
    contextFiles: context.files,
    contextLoading: context.resource.isLoading,
    contextError: context.resource.isError ? context.resource.errorText : "",
    processes,
    processResource,
  });

  useLayoutEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const update = () => setWidth(node.clientWidth);
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <section class="gsv-console-agent">
      <div class="gsv-console-agent-frame">
        <div class="gsv-console-agent-panel" ref={rootRef}>
          <AgentEditor
            key={[
              account.uid,
              context.dataUpdatedAt,
              processes.length,
              behavior.model,
              behavior.reasoning,
              behavior.approval,
              modelOptionsKey(resolvedModelOptions),
            ].join(":")}
            mode="manage"
            avatarSrc={isHumanCrewAccount(account) ? CREW_HUMAN_IMAGE : agentImageSrcForAccount(account, accounts)}
            avatarCover={!isHumanCrewAccount(account)}
            containerWidth={width || undefined}
            initialName={account.displayName}
            initialRole={labelForConsoleAccountRelation(account.relation)}
            initialDescription={accountDescription(account)}
            initialModel={behavior.model}
            initialReasoning={behavior.reasoning}
            inheritedReasoning={inheritedReasoning}
            initialPermission={behavior.permission}
            initialApprovalPolicy={behavior.approval}
            approvalPolicySourceLabel={approvalSourceLabel(editsUserDefaults, behavior.approvalInherited)}
            approvalPolicySourceDescription={approvalSourceDescription(editsUserDefaults, behavior.approvalInherited)}
            capabilities={account.capabilities}
            toolTargets={[...toolTargets]}
            createdLabel={String(account.uid)}
            metaLabel="UID:"
            status={avatarStatusForProcesses(account, processes)}
            models={resolvedModelOptions}
            tasks={tasksForProcesses(processes)}
            files={files}
            identityReadOnly
            behaviorReadOnly={!behaviorEditable}
            filesReadOnly={!contextEditable}
            initialTab={activeEditorTab}
            onTabChange={setActiveEditorTab}
            onSave={async (draft) => {
              if (behaviorEditable) {
                await saveBehavior.mutateAsync({
                  uid: account.uid,
                  model: draft.modelIndex === 0 ? "" : draft.model,
                  reasoning: draft.reasoningIndex === 0 ? "" : draft.reasoning,
                  approval: approvalForAgentSave(draft.approvalPolicy, behavior),
                });
              }
              if (contextEditable) {
                await saveContext.mutateAsync({
                  username: account.username,
                  files: draft.files,
                  baseNames: context.files.map((file) => file.name),
                });
              }
            }}
          />
        </div>
      </div>
    </section>
  );
}

function NewAgentEditorSurface({
  accountCount,
  modelOptions,
  toolTargets,
  inheritedReasoning,
  defaultApprovalPolicy,
  onAgentCreated,
  onBackToCrew,
}: {
  accountCount: number;
  modelOptions: AgentEditorModelOption[];
  toolTargets: readonly AgentToolTarget[];
  inheritedReasoning: string;
  defaultApprovalPolicy: string;
  onAgentCreated?: (uid: number) => void;
  onBackToCrew: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const createAgent = useCreateConsoleAgent();

  useLayoutEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const update = () => setWidth(node.clientWidth);
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <section class="gsv-console-agent">
      <div class="gsv-console-agent-frame">
        <div class="gsv-console-agent-panel" ref={rootRef}>
          <AgentEditor
            key="new-agent-draft"
            mode="new"
            avatarSrc={agentImageSrcForIndex(accountCount)}
            avatarCover
            containerWidth={width || undefined}
            initialRole="AGENT"
            initialDescription=""
            initialApprovalPolicy={defaultApprovalPolicy}
            approvalPolicySourceLabel="Your default"
            approvalPolicySourceDescription="New agents use your default policy unless you change tool approval before creating them."
            createdLabel="DRAFT"
            metaLabel="STATUS:"
            status="idle"
            models={modelOptions}
            toolTargets={[...toolTargets]}
            inheritedReasoning={inheritedReasoning}
            onCreate={async (draft) => {
              const created = await createAgent.mutateAsync(agentDraftToCreateInput(draft, defaultApprovalPolicy));
              window.setTimeout(() => {
                if (created.uid !== null) {
                  onAgentCreated?.(created.uid);
                  return;
                }
                onBackToCrew();
              }, 0);
            }}
          />
        </div>
      </div>
    </section>
  );
}

function agentDraftToCreateInput(draft: AgentEditorDraft, defaultApprovalPolicy: string) {
  return {
    name: draft.name,
    role: draft.role,
    description: draft.description,
    model: draft.modelIndex === 0 ? "" : draft.model,
    reasoning: draft.reasoningIndex === 0 ? "" : draft.reasoning,
    approval: approvalOverrideForInheritedPolicy(draft.approvalPolicy, defaultApprovalPolicy),
    files: draft.files.map((file) => ({
      label: file.label,
      name: file.name,
      content: file.content,
      orig: file.orig,
    })),
  };
}

function normalizedApprovalPolicy(raw: string): string {
  return serializeApprovalPolicy(parseApprovalPolicy(raw));
}

function approvalOverrideForInheritedPolicy(draftApproval: string, inheritedApproval: string): string {
  const normalizedDraft = normalizedApprovalPolicy(draftApproval);
  const normalizedInherited = normalizedApprovalPolicy(inheritedApproval);
  return normalizedDraft === normalizedInherited ? "" : normalizedDraft;
}

function approvalForAgentSave(
  draftApproval: string,
  behavior: ReturnType<typeof behaviorForAccount>,
): string {
  return behavior.approvalInherited
    ? approvalOverrideForInheritedPolicy(draftApproval, behavior.approval)
    : normalizedApprovalPolicy(draftApproval);
}

function approvalSourceLabel(editsUserDefaults: boolean, inherited: boolean): string {
  if (editsUserDefaults) return "Your default";
  return inherited ? "Inherited default" : "Agent override";
}

function approvalSourceDescription(editsUserDefaults: boolean, inherited: boolean): string {
  if (editsUserDefaults) {
    return "Your agents use this policy unless an individual agent has its own tool approval override.";
  }
  if (inherited) {
    return "This agent has no tool approval override and uses your default tool approval policy.";
  }
  return "This agent has its own tool approval policy.";
}

function modelOptionsKey(options: readonly AgentEditorModelOption[]): string {
  return options.map((option) => {
    if (typeof option === "string") {
      return option;
    }
    return `${option.value ?? ""}:${option.label}:${option.description ?? ""}`;
  }).join("\u0000");
}

function agentToolTargetsForConsoleTargets(targets: readonly ConsoleTarget[]): AgentToolTarget[] {
  return targets.map((target) => ({
    id: target.deviceId,
    label: target.label || target.deviceId,
    online: target.online,
    implements: target.implements,
  }));
}

function selectAccount(accounts: readonly ConsoleAccount[], accountUid: number | null): ConsoleAccount | null {
  if (accountUid !== null) {
    const selected = accounts.find((account) => account.uid === accountUid);
    if (selected) return selected;
  }
  return accounts.find((account) => account.relation === "personal-agent")
    ?? accounts.find((account) => account.relation === "agent")
    ?? accounts.find((account) => account.relation === "self")
    ?? accounts[0]
    ?? null;
}

function viewerAccountForAgents(accounts: readonly ConsoleAccount[]): ConsoleAccount | null {
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

function avatarStatusForProcesses(account: ConsoleAccount, processes: readonly ConsoleProcess[]): AvatarStatus {
  if (processes.some((process) => process.state === "unknown")) return "error";
  if (processes.some((process) => isRunningProcess(process) || isQueuedProcess(process))) return "live";
  return account.runnable ? "idle" : "idle";
}

function tasksForProcesses(processes: readonly ConsoleProcess[]): AgentEditorTask[] {
  if (processes.length === 0) {
    return [{ name: "No process activity", status: "idle" }];
  }
  return processes.map((process) => ({
    name: process.label || process.pid,
    status: process.state === "unknown" ? "error" : isRunningProcess(process) || isQueuedProcess(process) ? "running" : "idle",
  }));
}

function filesForAccount(
  account: ConsoleAccount,
  processes: readonly ConsoleProcess[],
  processResource: ConsoleResourceState<ConsoleProcess[]>,
): AgentEditorFile[] {
  return [
    {
      label: "ACCOUNT",
      content: [
        `# ${account.displayName}`,
        "",
        `username: ${account.username}`,
        `uid: ${account.uid}`,
        `relation: ${account.relation}`,
        `runnable: ${account.runnable ? "yes" : "no"}`,
        account.gecos ? `gecos: ${account.gecos}` : "",
      ].filter(Boolean).join("\n"),
    },
    {
      label: "PROCESSES",
      content: processFileContent(processes, processResource),
    },
  ];
}

function editorFilesForAccount({
  account,
  contextError,
  contextFiles,
  contextLoading,
  processes,
  processResource,
}: {
  account: ConsoleAccount;
  contextError: string;
  contextFiles: readonly ConsoleAgentContextFile[];
  contextLoading: boolean;
  processes: readonly ConsoleProcess[];
  processResource: ConsoleResourceState<ConsoleProcess[]>;
}): AgentEditorFile[] {
  if (contextLoading) {
    return [{
      label: "CONTEXT",
      content: "# Context\n\nLoading agent context files.",
      orig: "# Context\n\nLoading agent context files.",
    }];
  }
  if (contextFiles.length > 0) {
    return contextFiles.map((file) => ({ ...file, origName: file.name }));
  }
  if (contextError.trim().length > 0) {
    return [{
      label: "CONTEXT",
      content: `# Context\n\n${contextError}`,
      orig: `# Context\n\n${contextError}`,
    }];
  }
  return [];
}

function processFileContent(
  processes: readonly ConsoleProcess[],
  processResource: ConsoleResourceState<ConsoleProcess[]>,
): string {
  if (processResource.isLoading) return "# Processes\n\nLoading process telemetry.";
  if (processResource.isUnavailable) return "# Processes\n\nProcess telemetry is offline.";
  if (processResource.isError) return `# Processes\n\n${processResource.errorText || "Process telemetry failed."}`;
  if (processes.length === 0) return "# Processes\n\nNo process activity.";
  return [
    "# Processes",
    "",
    ...processes.map((process) => [
      `- ${process.label || process.pid}`,
      `  pid: ${process.pid}`,
      `  state: ${process.rawState || process.state}`,
      process.cwd ? `  cwd: ${process.cwd}` : "",
      process.activeRunId ? `  activeRunId: ${process.activeRunId}` : "",
      process.activeConversationId ? `  conversation: ${process.activeConversationId}` : "",
      process.queuedCount > 0 ? `  queued: ${process.queuedCount}` : "",
    ].filter(Boolean).join("\n")),
  ].join("\n");
}

function accountDescription(account: ConsoleAccount): string {
  if (account.gecos.trim().length > 0) {
    return account.gecos;
  }
  return `${account.username} / ${labelForConsoleAccountRelation(account.relation)}`;
}
