import { useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { combineResourceStates } from "../domain/consoleModels";
import { z } from "zod";
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
import { consoleWorkProcesses } from "../domain/consoleProcesses";
import {
  modelOptionsForConfig,
  type ConsoleModelOption,
} from "../domain/consoleAi";
import {
  approvalForAgentSave,
  approvalOverrideForInheritedPolicy,
  behaviorForAccount,
  defaultApprovalPolicyForConfig,
  inheritedModelLabelForAccount,
  inheritedReasoningForAccount,
  modelOptionsForAccount,
  normalizedApprovalPolicy,
} from "../domain/consoleAgentBehavior";
import {
  avatarForAccount,
  isHumanCrewAccount,
  labelForConsoleAccountRelation,
  pickAgentImage,
  usedAgentImages,
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
  useConsoleModels,
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
  const models = useConsoleModels();
  const ownerUid = viewerAccountForAgents(accounts.resource.data ?? [])?.uid ?? null;
  const modelOptions = modelOptionsForConfig(models.listing, config.config, ownerUid);
  const toolTargets = agentToolTargetsForConsoleTargets(targets.targets);
  const inheritedNewAgentModel = inheritedModelLabelForAccount(models.listing, config.config, -1, ownerUid);
  const inheritedNewAgentReasoning = inheritedReasoningForAccount(config.config, -1, ownerUid);
  const defaultApprovalPolicy = defaultApprovalPolicyForConfig(config.config, ownerUid);
  const newAgentModelOptions = modelOptionsForAccount(modelOptions, "", inheritedNewAgentModel);

  if (createNew) {
    // The draft avatar is picked ONCE at editor mount (unused-portrait
    // contract), so the editor must not mount while accounts/config are still
    // loading — an empty pool snapshot reads as "everything unused" and can
    // duplicate an existing portrait. Empty-but-loaded data is a valid state
    // (first agent ever), so this gates on loading only, never emptiness.
    if (accounts.resource.isUnavailable || config.resource.isUnavailable || models.resource.isUnavailable) {
      return (
        <ConsolePage flush>
          <ConsolePageState kind="offline" label="AGENT" />
        </ConsolePage>
      );
    }
    if (models.resource.isError) {
      // Without the effective model listing the selector would silently offer nothing.
      return (
        <ConsolePage flush>
          <ConsolePageState kind="error" detail={models.resource.errorText || "MODELS"} />
        </ConsolePage>
      );
    }
    if (accounts.resource.isLoading || config.resource.isLoading || models.resource.isLoading) {
      return (
        <ConsolePage flush>
          <ConsolePageState kind="loading" label="AGENT" />
        </ConsolePage>
      );
    }
    return (
      <ConsolePage flush>
        <NewAgentEditorSurface
          accounts={accounts.resource.data ?? []}
          config={config.config}
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
        // The editor's model selector needs the effective listing as much as the account list.
        resource={combineResourceStates(accounts.resource, models.resource)}
        emptyLabel="NO AGENT ACCOUNT"
        errorLabel="AGENT"
        render={([data]) => {
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
  const processes = consoleWorkProcesses(processResource.data ?? [])
    .filter((process) => ownsProcess(account, process));
  const context = useConsoleAgentContext(account.username);
  const models = useConsoleModels().listing;
  const saveBehavior = useSaveConsoleAgentBehavior();
  const saveContext = useSaveConsoleAgentContext();
  const contextEditable = !context.resource.isLoading
    && !context.resource.isUnavailable
    && !context.resource.isError;
  const behavior = behaviorForAccount(models, config, account.uid, ownerUid);
  const editsUserDefaults = isHumanCrewAccount(account);
  const behaviorEditable = account.runnable;
  const inheritedModelLabel = inheritedModelLabelForAccount(models, config, account.uid, ownerUid);
  const inheritedReasoning = inheritedReasoningForAccount(config, account.uid, ownerUid);
  const resolvedModelOptions = modelOptionsForAccount(modelOptions, behavior.model, inheritedModelLabel);
  const files = editorFilesForAccount({
    contextFiles: context.files,
    contextLoading: context.resource.isLoading,
    contextError: context.resource.isError ? context.resource.errorText : "",
  });
  const editorTasks = isHumanCrewAccount(account) ? [] : tasksForProcesses(processes);

  useLayoutEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const update = () => setWidth(node.clientWidth);
    update();
    if (!globalThis.ResizeObserver) {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new globalThis.ResizeObserver(update);
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
            avatarSrc={avatarForAccount(account, config, accounts)}
            avatarCover={!isHumanCrewAccount(account)}
            containerWidth={width || undefined}
            initialName={account.displayName}
            initialRole={labelForConsoleAccountRelation(account.relation)}
            initialDescription={accountDescription(account, editsUserDefaults)}
            initialModel={behavior.model}
            initialReasoning={behavior.reasoning}
            inheritedReasoning={inheritedReasoning}
            initialPermission={behavior.permission}
            initialApprovalPolicy={behavior.approval}
            approvalPolicySourceLabel={approvalSourceLabel(editsUserDefaults, behavior.approvalInherited)}
            capabilities={account.capabilities}
            toolTargets={[...toolTargets]}
            createdLabel={String(account.uid)}
            metaLabel="UID:"
            status={avatarStatusForProcesses(account, processes)}
            models={resolvedModelOptions}
            tasks={editorTasks}
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
  accounts,
  config,
  modelOptions,
  toolTargets,
  inheritedReasoning,
  defaultApprovalPolicy,
  onAgentCreated,
  onBackToCrew,
}: {
  accounts: readonly ConsoleAccount[];
  config: readonly ConsoleConfigEntry[];
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
  // Picked once per draft: random portrait no current agent shows (repeats
  // only once the pool is exhausted). The preview IS the assigned image.
  const draftAvatar = useMemo(() => pickAgentImage(usedAgentImages(accounts, config)), []);

  useLayoutEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const update = () => setWidth(node.clientWidth);
    update();
    if (!globalThis.ResizeObserver) {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new globalThis.ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <section class="gsv-console-agent">
      <div class="gsv-console-agent-frame">
        <div class="gsv-console-agent-panel" ref={rootRef}>
          <AgentEditor
            key={`new-agent-draft:${normalizedApprovalPolicy(defaultApprovalPolicy)}`}
            mode="new"
            avatarSrc={draftAvatar}
            avatarCover
            containerWidth={width || undefined}
            reservedNames={accounts.flatMap((account) => [account.displayName, account.username])}
            initialRole="AGENT"
            initialDescription=""
            initialApprovalPolicy={defaultApprovalPolicy}
            approvalPolicySourceLabel="Your default"
            createdLabel="DRAFT"
            metaLabel="STATUS:"
            status="idle"
            models={modelOptions}
            toolTargets={[...toolTargets]}
            inheritedReasoning={inheritedReasoning}
            onCreate={async (draft) => {
              const created = await createAgent.mutateAsync(agentDraftToCreateInput(draft, defaultApprovalPolicy, draftAvatar));
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

function agentDraftToCreateInput(draft: AgentEditorDraft, defaultApprovalPolicy: string, avatarSrc?: string) {
  return {
    name: draft.name,
    role: draft.role,
    description: draft.description,
    avatarSrc,
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

function approvalSourceLabel(editsUserDefaults: boolean, inherited: boolean): string {
  if (editsUserDefaults) return "Your default";
  return inherited ? "Inherited default" : "Agent override";
}

function modelOptionsKey(options: readonly AgentEditorModelOption[]): string {
  return options.map((option) => {
    const text = z.string().safeParse(option);
    if (text.success) {
      return text.data;
    }
    const model = z.object({ value: z.string().optional(), label: z.string(), description: z.string().optional() }).safeParse(option);
    return model.success ? `${model.data.value ?? ""}:${model.data.label}:${model.data.description ?? ""}` : "";
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
    return [{ name: "No work yet", status: "idle" }];
  }
  return processes.map((process) => ({
    name: process.label || process.pid,
    status: process.state === "unknown" ? "error" : isRunningProcess(process) || isQueuedProcess(process) ? "running" : "idle",
  }));
}

function editorFilesForAccount({
  contextError,
  contextFiles,
  contextLoading,
}: {
  contextError: string;
  contextFiles: readonly ConsoleAgentContextFile[];
  contextLoading: boolean;
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


function accountDescription(account: ConsoleAccount, editsUserDefaults = false): string {
  if (editsUserDefaults) {
    return "These are your preferences, applied to all your agents.";
  }
  if (account.gecos.trim().length > 0) {
    return account.gecos;
  }
  return `${account.username} / ${labelForConsoleAccountRelation(account.relation)}`;
}
