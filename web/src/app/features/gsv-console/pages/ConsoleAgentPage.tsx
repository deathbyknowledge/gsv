import { useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  AgentEditor,
  type AgentEditorDraft,
  type AgentEditorFile,
  type AgentEditorTask,
} from "../../../components/ui/AgentEditor";
import type { AvatarStatus } from "../../../components/ui/Avatar";
import type { ConsoleAgentContextFile } from "../backend/consoleService";
import {
  ConsolePage,
  ConsolePageState,
  ConsoleResourceBoundary,
} from "../components/ConsolePageTemplate";
import type {
  ConsoleAccount,
  ConsoleProcess,
  ConsoleResourceState,
} from "../domain/consoleModels";
import { modelLabelsForConfig } from "../domain/consoleAi";
import {
  agentImageSrcForAccount,
  agentImageSrcForIndex,
  labelForConsoleAccountRelation,
} from "../domain/agentPresentation";
import {
  useConsoleAgentContext,
  useConsoleAccounts,
  useConsoleConfig,
  useConsoleProcesses,
  useCreateConsoleAgent,
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
  const modelLabels = modelLabelsForConfig(config.config);

  if (createNew) {
    return (
      <ConsolePage flush>
        <NewAgentEditorSurface
          accountCount={accounts.resource.data?.length ?? 0}
          modelLabels={modelLabels}
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
              modelLabels={modelLabels}
              processResource={processes.resource}
              onBackToCrew={onBackToCrew}
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
  modelLabels,
  processResource,
  onBackToCrew,
}: {
  account: ConsoleAccount;
  accounts: readonly ConsoleAccount[];
  modelLabels: string[];
  processResource: ConsoleResourceState<ConsoleProcess[]>;
  onBackToCrew: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const processes = (processResource.data ?? []).filter((process) => ownsProcess(account, process));
  const context = useConsoleAgentContext(account.username);
  const saveContext = useSaveConsoleAgentContext();
  const contextEditable = context.files.length > 0
    && !context.resource.isLoading
    && !context.resource.isError;
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
    <section class="gsv-console-agent" ref={rootRef}>
      <AgentEditor
        key={`${account.uid}:${context.dataUpdatedAt}:${processes.length}`}
        mode="manage"
        avatarSrc={agentImageSrcForAccount(account, accounts)}
        containerWidth={width || undefined}
        initialName={account.displayName}
        initialRole={labelForConsoleAccountRelation(account.relation)}
        initialDescription={accountDescription(account)}
        createdLabel={String(account.uid)}
        metaLabel="UID:"
        status={avatarStatusForProcesses(account, processes)}
        models={modelLabels}
        tasks={tasksForProcesses(processes)}
        files={files}
        generalReadOnly
        filesReadOnly={!contextEditable}
        onSave={contextEditable ? async (draft) => {
          await saveContext.mutateAsync({
            username: account.username,
            files: draft.files,
          });
        } : undefined}
        onBack={onBackToCrew}
      />
    </section>
  );
}

function NewAgentEditorSurface({
  accountCount,
  modelLabels,
  onAgentCreated,
  onBackToCrew,
}: {
  accountCount: number;
  modelLabels: string[];
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
    <section class="gsv-console-agent" ref={rootRef}>
      <AgentEditor
        key="new-agent-draft"
        mode="new"
        avatarSrc={agentImageSrcForIndex(accountCount)}
        containerWidth={width || undefined}
        initialRole="AGENT"
        initialDescription=""
        createdLabel="DRAFT"
        metaLabel="STATUS:"
        status="idle"
        models={modelLabels}
        onCreate={async (draft) => {
          const created = await createAgent.mutateAsync(agentDraftToCreateInput(draft));
          window.setTimeout(() => {
            if (created.uid !== null) {
              onAgentCreated?.(created.uid);
              return;
            }
            onBackToCrew();
          }, 0);
        }}
        onBack={onBackToCrew}
      />
    </section>
  );
}

function agentDraftToCreateInput(draft: AgentEditorDraft) {
  return {
    name: draft.name,
    role: draft.role,
    description: draft.description,
    files: draft.files.map((file) => ({
      label: file.label,
      content: file.content,
      orig: file.orig,
    })),
  };
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
    return contextFiles.map((file) => ({ ...file }));
  }
  if (contextError.trim().length > 0) {
    return [{
      label: "CONTEXT",
      content: `# Context\n\n${contextError}`,
      orig: `# Context\n\n${contextError}`,
    }];
  }
  return filesForAccount(account, processes, processResource);
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
