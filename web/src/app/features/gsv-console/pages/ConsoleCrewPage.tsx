import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { Avatar, type AvatarStatus } from "../../../components/ui/Avatar";
import type { AgentToolTarget } from "../../../components/ui/agentToolApprovalOptions";
import { CrewDefaultsPanel } from "../components/CrewDefaultsPanel";
import { EditDefaultsPanel, type EditDefaultsSection } from "../components/EditDefaultsPanel";
import {
  ConsolePage,
  ConsoleResourceBoundary,
} from "../components/ConsolePageTemplate";
import { ListTemplate, type ListTemplateRow } from "../list-template/ListTemplate";
import type {
  ConsoleAccount,
  ConsoleConfigEntry,
  ConsoleProcess,
  ConsoleResourceState,
  ConsoleTarget,
} from "../domain/consoleModels";
import {
  avatarForAccount,
  isConsoleAgentAccount,
  labelForConsoleAccountRelation,
  orderedCrewAccounts,
} from "../domain/agentPresentation";
import {
  useConsoleAccounts,
  useConsoleConfig,
  useConsoleProcesses,
  useConsoleTargets,
} from "../hooks/useConsoleData";
import "./ConsoleCrewPage.css";

/* The defaults panel collapses to a disclosure once the template's action
   column folds into the horizontal bar (ListTemplate's container breakpoint). */
const COMPACT_BREAKPOINT = 1024;

type ConsoleCrewPageProps = {
  onManageAgent?: (uid: number) => void;
  onCreateAgent?: () => void;
};

export function ConsoleCrewPage({ onManageAgent, onCreateAgent }: ConsoleCrewPageProps) {
  const accounts = useConsoleAccounts();
  const config = useConsoleConfig();
  const processes = useConsoleProcesses();
  const targets = useConsoleTargets();

  return (
    <ConsolePage flush className="is-bounded">
      <ConsoleResourceBoundary
        resource={accounts.resource}
        emptyLabel="NO CREW ACCOUNTS"
        errorLabel="CREW"
        render={(data) => (
          <CrewRoster
            accounts={data}
            config={config.config}
            processResource={processes.resource}
            toolTargets={toolTargetsForConsoleTargets(targets.targets)}
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
  toolTargets,
  onManageAgent,
  onCreateAgent,
}: {
  accounts: readonly ConsoleAccount[];
  config: readonly ConsoleConfigEntry[];
  processResource: ConsoleResourceState<ConsoleProcess[]>;
  toolTargets: readonly AgentToolTarget[];
  onManageAgent?: (uid: number) => void;
  onCreateAgent?: () => void;
}) {
  const [query, setQuery] = useState("");
  // In-body edit surface: when set, the list column shows the defaults editor
  // (opened on this section) instead of the roster; ✕ closes back to the list.
  const [editorSection, setEditorSection] = useState<EditDefaultsSection | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

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

  const processes = processResource.data ?? [];
  const agents = orderedCrewAccounts(accounts).filter(isConsoleAgentAccount);
  const crewMeta = `${agents.length} AGENT${agents.length === 1 ? "" : "S"}`;
  const viewer = viewerAccountForCrew(accounts);
  const compact = width > 0 && width <= COMPACT_BREAKPOINT;

  const q = query.trim().toLowerCase();
  const rows: ListTemplateRow[] = agents
    .filter((account) => {
      if (!q) return true;
      const role = labelForConsoleAccountRelation(account.relation);
      return account.displayName.toLowerCase().includes(q) || role.toLowerCase().includes(q);
    })
    .map((account) => {
      const owned = processes.filter((process) => ownsProcess(account, process));
      const unknown = owned.some((process) => process.state === "unknown");
      const active = owned.some((process) => isRunningProcess(process) || isQueuedProcess(process));
      const status: AvatarStatus = unknown ? "error" : active ? "live" : "idle";
      return {
        id: String(account.uid),
        leading: (
          <Avatar src={avatarForAccount(account, config, accounts)} status={status} size={30} cover />
        ),
        label: account.displayName,
        sub: labelForConsoleAccountRelation(account.relation),
        tone: status,
        statusLabel: unknown ? "ERROR" : active ? "RUNNING" : "IDLE",
        onOpen: onManageAgent ? () => onManageAgent(account.uid) : undefined,
      };
    });

  return (
    <div class="gsv-console-crew" ref={rootRef}>
      <ListTemplate
        listTitle="CREW"
        listMeta={crewMeta}
        rows={rows}
        emptyObject="AGENTS"
        connectLabel="NEW AGENT"
        onConnect={onCreateAgent}
        search={{ value: query, placeholder: "Search agents…", onChange: setQuery }}
        scrollBody
        actionExtra={viewer ? (
          <CrewDefaultsPanel
            viewer={viewer}
            config={config}
            compact={compact}
            onEditDefaults={() => setEditorSection("defaults")}
            onConfigureOverrides={() => setEditorSection("overrides")}
            onManageContext={() => setEditorSection("context")}
          />
        ) : undefined}
        listContent={viewer && editorSection ? (
          <EditDefaultsPanel
            section={editorSection}
            onClose={() => setEditorSection(null)}
            viewer={viewer}
            config={config}
            targets={toolTargets}
          />
        ) : undefined}
      />
    </div>
  );
}

function viewerAccountForCrew(accounts: readonly ConsoleAccount[]): ConsoleAccount | null {
  return accounts.find((account) => account.relation === "self")
    ?? accounts.find((account) => account.uid === 0)
    ?? accounts.find((account) => account.relation === "human")
    ?? null;
}

function toolTargetsForConsoleTargets(targets: readonly ConsoleTarget[]): AgentToolTarget[] {
  return targets.map((target) => ({
    id: target.deviceId,
    label: target.label || target.deviceId,
    online: target.online,
    implements: target.implements,
  }));
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
