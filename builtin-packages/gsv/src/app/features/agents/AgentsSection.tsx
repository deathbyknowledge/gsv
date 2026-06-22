import { useEffect, useState } from "preact/hooks";
import type { GsvBackend } from "../../backend-contract";
import { ActionButton } from "../../components/ui/ActionButton";
import { ConsoleCard, ObjectHeader } from "../../components/ui/ConsoleCard";
import { Icon } from "../../components/ui/Icon";
import {
  buildCrewAgents,
  buildCrewStackCards,
  findMatchingStackProfile,
  modelDisplayLabel,
  stackDetail,
  type CrewAgent,
  type CrewStackCard,
  type CrewTask,
} from "../../domain/crew";
import { CrewOverview, CrewModelStackList } from "./CrewCards";
import { AI_FIELDS, buildUserAiOverrideKey } from "../settings/config-schema";
import { createModelProfile, modelProfilesConfigKey, profileValuesFromDrafts, serializeModelProfiles } from "../settings/model-profiles-domain";
import {
  APPROVAL_ACTION_OPTIONS,
  parseApprovalPolicy,
  relationLabel,
  serializeApprovalPolicy,
} from "./agents-domain";
import { actionLabel, ruleLabel, summarizePermissions } from "./permissions-domain";
import { useAgents } from "./useAgents";
import type {
  AccountSummary,
  AgentContextFile,
  AgentDetail,
  AgentModelProfile,
  ApprovalPolicy,
  CreateAgentArgs,
} from "./types";
import type { ProcessEntry } from "../runtime/types";

const PERSONA_CONTEXT_FILE = "05-persona.md";
const NEW_CONTEXT_FILE = "__new__";
const INHERIT_STACK = "__inherit__";
const CURRENT_DEFAULT_STACK = "__current_default__";
const CUSTOM_STACK = "__custom__";

type CrewView = "overview" | "agents" | "models";
type AgentCategory = "general" | "files" | "tasks";

export function AgentsSection({ backend }: { backend: GsvBackend }) {
  const agents = useAgents(backend);
  const [view, setView] = useState<CrewView>("overview");
  const [returnView, setReturnView] = useState<CrewView>("agents");
  const [agentCategory, setAgentCategory] = useState<AgentCategory>("general");
  const [createAgentOpen, setCreateAgentOpen] = useState(false);
  const [createModelOpen, setCreateModelOpen] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [defaultModelBusyId, setDefaultModelBusyId] = useState("");
  const [modelError, setModelError] = useState("");

  const stateAgents = agents.state?.agents ?? [];
  const models = agents.state?.modelProfiles ?? [];
  const systemAiValues = agents.state?.systemAiValues ?? {};
  const modelPresetAiValues = agents.state?.viewerAiValues ?? systemAiValues;
  const processes = agents.processes;

  function openAgent(agent: AgentDetail, nextReturnView: CrewView): void {
    setReturnView(nextReturnView);
    setAgentCategory("general");
    agents.selectAgent(agent);
  }

  function closeAgent(): void {
    agents.clearSelection();
    setView(returnView);
  }

  async function createModelProfileFromValues(name: string, values: Record<string, string>): Promise<boolean> {
    const state = agents.state;
    if (!state) return false;
    setModelBusy(true);
    setModelError("");
    try {
      const nextProfiles = createModelProfile(state.modelProfiles, name, values);
      await backend.applyConfigEntries({
        entries: [{
          key: modelProfilesConfigKey(state.viewerUid),
          value: serializeModelProfiles(nextProfiles),
        }],
      });
      await agents.loadState();
      return true;
    } catch (error) {
      setModelError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setModelBusy(false);
    }
  }

  async function makeModelDefault(stack: CrewStackCard): Promise<void> {
    const state = agents.state;
    if (!state || stack.default || !stack.profile) return;
    setDefaultModelBusyId(stack.id);
    setModelError("");
    try {
      const values = profileValuesFromDrafts(stack.profile.values);
      const entries = AI_FIELDS
        .filter((field) => field.kind !== "readonly")
        .map((field) => ({
          key: state.isRoot ? field.key : buildUserAiOverrideKey(state.viewerUid, field.key),
          value: values[field.key] ?? "",
        }));
      await backend.applyConfigEntries({ entries });
      await agents.loadState();
    } catch (error) {
      setModelError(error instanceof Error ? error.message : String(error));
    } finally {
      setDefaultModelBusyId("");
    }
  }

  if (agents.selectedAgent) {
    return (
      <section class="gsv-agents">
        <AgentWorkspace
          agent={agents.selectedAgent}
          category={agentCategory}
          context={agents.context}
          models={models}
          systemAiValues={systemAiValues}
          processes={processes}
          contextLoading={agents.contextLoading}
          busy={agents.busy}
          errorText={agents.errorText}
          onBack={closeAgent}
          onCategoryChange={setAgentCategory}
          onSaveContext={(name, text) => agents.saveContext(agents.selectedAgent!.username, name, text)}
          onSaveBehavior={(aiValues, approval) => agents.setBehavior({ uid: agents.selectedAgent!.uid, aiValues, approval })}
        />
      </section>
    );
  }

  return (
    <section class="gsv-agents">
      {agents.errorText ? <p class="gsv-inline-error">{agents.errorText}</p> : null}
      {modelError ? <p class="gsv-inline-error">{modelError}</p> : null}

      {view === "overview" ? (
        <>
          <CrewOverview
            agents={stateAgents}
            models={models}
            systemAiValues={systemAiValues}
            modelPresetAiValues={modelPresetAiValues}
            processes={processes}
            loading={agents.loading}
            onSelect={(agent) => openAgent(agent, "overview")}
            onOpenAgents={() => setView("agents")}
            onOpenModels={() => setView("models")}
            onCreateAgent={() => setCreateAgentOpen(true)}
            onCreateModel={() => {
              setView("models");
              setCreateModelOpen(true);
            }}
            onMakeDefaultModel={(stack) => void makeModelDefault(stack)}
            defaultModelBusyId={defaultModelBusyId}
          />
          <CreateAgentForm open={createAgentOpen} busy={agents.busy} onOpenChange={setCreateAgentOpen} onCreate={(args) => agents.createAgent(args)} />
        </>
      ) : view === "agents" ? (
        <CrewAgentsView
          agents={stateAgents}
          models={models}
          systemAiValues={systemAiValues}
          processes={processes}
          loading={agents.loading}
          busy={agents.busy}
          humans={agents.state?.humans ?? []}
          viewerUid={agents.state?.viewerUid ?? 0}
          isRoot={agents.state?.isRoot ?? false}
          createAgentOpen={createAgentOpen}
          onCreateAgentOpenChange={setCreateAgentOpen}
          onSelect={(agent) => openAgent(agent, "agents")}
          onBack={() => setView("overview")}
          onCreateAgent={(args) => agents.createAgent(args)}
          onCreateHuman={(args) => agents.createHuman(args)}
        />
      ) : (
        <CrewModelsView
          models={models}
          systemAiValues={modelPresetAiValues}
          busy={modelBusy}
          open={createModelOpen}
          onOpenChange={setCreateModelOpen}
          onBack={() => setView("overview")}
          onCreate={createModelProfileFromValues}
          onMakeDefault={(stack) => void makeModelDefault(stack)}
          defaultModelBusyId={defaultModelBusyId}
        />
      )}
    </section>
  );
}

function CrewAgentsView({
  agents,
  humans,
  models,
  systemAiValues,
  processes,
  loading,
  busy,
  viewerUid,
  isRoot,
  createAgentOpen,
  onCreateAgentOpenChange,
  onSelect,
  onBack,
  onCreateAgent,
  onCreateHuman,
}: {
  agents: AgentDetail[];
  humans: AccountSummary[];
  models: AgentModelProfile[];
  systemAiValues: Record<string, string>;
  processes: ProcessEntry[];
  loading: boolean;
  busy: boolean;
  viewerUid: number;
  isRoot: boolean;
  createAgentOpen: boolean;
  onCreateAgentOpenChange: (open: boolean) => void;
  onSelect: (agent: AgentDetail) => void;
  onBack: () => void;
  onCreateAgent: (args: CreateAgentArgs) => Promise<boolean>;
  onCreateHuman: (args: { username: string; password: string; gecos?: string }) => Promise<boolean>;
}) {
  const crew = buildCrewAgents(agents, processes, models, systemAiValues);

  return (
    <section class="gsv-crew-subview" aria-label="Crew agents">
      <ActionButton class="gsv-agent-back" icon="arrow-left" label="Crew" onClick={onBack} />
      {crew.length === 0 ? (
        <section class="gsv-empty-state">
          <h3>{loading ? "Loading agents" : "No agents yet"}</h3>
          <p>{loading ? "Refreshing crew state." : "Create a custom agent or check that your personal agent is provisioned."}</p>
        </section>
      ) : (
        <div class="gsv-crew-agent-page-grid">
          {crew.map((agent) => (
            <AgentSummaryCard key={agent.username} agent={agent} expanded onManage={() => onSelect(agent.agent)} />
          ))}
          <CreateCrewCard title="Expand crew" subtitle="Create new agent" label="Create new agent" onCreate={() => onCreateAgentOpenChange(true)} />
        </div>
      )}

      <CreateAgentForm open={createAgentOpen} busy={busy} onOpenChange={onCreateAgentOpenChange} onCreate={onCreateAgent} />

      {isRoot ? (
        <section class="gsv-agents-humans" aria-label="Human users">
          <header class="gsv-section-intro">
            <span class="gsv-kicker">Administration</span>
            <h3>Human users</h3>
          </header>
          <div class="gsv-agents-list">
            {humans.map((human) => (
              <div key={human.username} class="gsv-runtime-row is-static">
                <span class="gsv-mark is-neutral" aria-hidden="true"></span>
                <span class="gsv-row-copy">
                  <strong>{human.displayName}</strong>
                  <span>{human.uid === viewerUid ? "You" : "Human user"} / uid {human.uid}</span>
                </span>
                <span class="gsv-row-meta">{human.username}</span>
              </div>
            ))}
          </div>
          <CreateHumanForm busy={busy} onCreate={onCreateHuman} />
        </section>
      ) : null}
    </section>
  );
}

function AgentSummaryCard({
  agent,
  expanded = false,
  onManage,
}: {
  agent: CrewAgent;
  expanded?: boolean;
  onManage: () => void;
}) {
  const firstTasks = agent.activeTasks.slice(0, 3);
  return (
    <ConsoleCard class="gsv-agent-card" tone={agent.tone}>
      <ObjectHeader
        title={agent.displayName}
        eyebrow={agent.roleLabel}
        subtitle={expanded ? agent.description : undefined}
        icon="user"
        tone={agent.tone}
        status={agent.activeTasks.length > 0 ? "good" : "neutral"}
      />
      {expanded ? (
        <>
          <div class="gsv-card-facts">
            <CardFact label="Model" value={agent.modelLabel} detail={agent.modelDetail} />
            <CardFact label="Active tasks" value={String(agent.activeTasks.length)} />
            {firstTasks.length === 0 ? (
              <p class="gsv-agent-idle">Idle</p>
            ) : firstTasks.map((task) => (
              <p key={task.pid} class={`gsv-agent-task-line is-${task.tone}`}>{task.title}</p>
            ))}
            <CardFact label="Permissions" value={agent.permissions.headline} detail={agent.permissions.detail} />
          </div>
          <div class="gsv-card-actions">
            <button type="button" class="gsv-text-action" onClick={onManage}>Manage &gt;</button>
          </div>
        </>
      ) : (
        <div class="gsv-card-actions">
          <span class="gsv-agent-compact-meta">{agent.modelLabel} / {agent.activeTasks.length} active</span>
          <button type="button" class="gsv-text-action" onClick={onManage}>Manage &gt;</button>
        </div>
      )}
    </ConsoleCard>
  );
}

function CardFact({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div class="gsv-card-fact">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}

function CreateCrewCard({
  title,
  subtitle,
  label,
  onCreate,
}: {
  title: string;
  subtitle: string;
  label: string;
  onCreate: () => void;
}) {
  return (
    <ConsoleCard class="gsv-create-card">
      <div class="gsv-create-card-copy">
        <strong>{title}</strong>
        <span>{subtitle}</span>
      </div>
      <ActionButton icon="plus" label={label} size="icon" onClick={onCreate} />
    </ConsoleCard>
  );
}

function CrewModelsView({
  models,
  systemAiValues,
  busy,
  defaultModelBusyId,
  open,
  onOpenChange,
  onBack,
  onCreate,
  onMakeDefault,
}: {
  models: AgentModelProfile[];
  systemAiValues: Record<string, string>;
  busy: boolean;
  defaultModelBusyId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onBack: () => void;
  onCreate: (name: string, values: Record<string, string>) => Promise<boolean>;
  onMakeDefault: (stack: CrewStackCard) => void;
}) {
  const stacks = buildCrewStackCards(systemAiValues, models);

  return (
    <section class="gsv-crew-subview" aria-label="Crew models">
      <ActionButton class="gsv-agent-back" icon="arrow-left" label="Crew" onClick={onBack} />
      <div class="gsv-crew-model-page">
        <section class="gsv-crew-models" aria-label="Available model presets">
          <header class="gsv-crew-column-head">
            <span class="gsv-kicker">Available model presets</span>
          </header>
          <CrewModelStackList stacks={stacks} onMakeDefault={onMakeDefault} busyDefaultId={defaultModelBusyId} />
        </section>
        <section class="gsv-crew-model-create">
          <CreateCrewCard title="Add new model" subtitle="Create model preset" label="Create model preset" onCreate={() => onOpenChange(true)} />
          <CreateModelProfileForm
            open={open}
            busy={busy}
            systemAiValues={systemAiValues}
            onCancel={() => onOpenChange(false)}
            onCreate={async (name, values) => {
              const ok = await onCreate(name, values);
              if (ok) onOpenChange(false);
              return ok;
            }}
          />
        </section>
      </div>
    </section>
  );
}

function CreateModelProfileForm({
  open,
  busy,
  systemAiValues,
  onCancel,
  onCreate,
}: {
  open: boolean;
  busy: boolean;
  systemAiValues: Record<string, string>;
  onCancel: () => void;
  onCreate: (name: string, values: Record<string, string>) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [provider, setProvider] = useState(systemAiValues["config/ai/provider"] ?? "workers-ai");
  const [model, setModel] = useState(systemAiValues["config/ai/model"] ?? "");
  const [reasoning, setReasoning] = useState(systemAiValues["config/ai/reasoning"] ?? "medium");
  const [maxTokens, setMaxTokens] = useState(systemAiValues["config/ai/max_tokens"] ?? "");
  const [maxContext, setMaxContext] = useState(systemAiValues["config/ai/max_context_bytes"] ?? "");

  useEffect(() => {
    if (!open) return;
    setProvider(systemAiValues["config/ai/provider"] ?? "workers-ai");
    setModel(systemAiValues["config/ai/model"] ?? "");
    setReasoning(systemAiValues["config/ai/reasoning"] ?? "medium");
    setMaxTokens(systemAiValues["config/ai/max_tokens"] ?? "");
    setMaxContext(systemAiValues["config/ai/max_context_bytes"] ?? "");
  }, [open, systemAiValues]);

  if (!open) {
    return null;
  }

  return (
    <form
      class="gsv-agents-form"
      onSubmit={async (event) => {
        event.preventDefault();
        const ok = await onCreate(name, {
          ...systemAiValues,
          "config/ai/provider": provider,
          "config/ai/model": model,
          "config/ai/reasoning": reasoning,
          "config/ai/max_tokens": maxTokens,
          "config/ai/max_context_bytes": maxContext,
        });
        if (ok) setName("");
      }}
    >
      <h4>New model preset</h4>
      <label class="gsv-field"><span>Name</span><input value={name} onInput={(event) => setName(event.currentTarget.value)} required /></label>
      <label class="gsv-field"><span>Provider</span><input value={provider} onInput={(event) => setProvider(event.currentTarget.value)} required /></label>
      <label class="gsv-field"><span>Model</span><input value={model} onInput={(event) => setModel(event.currentTarget.value)} required /></label>
      <label class="gsv-field">
        <span>Reasoning</span>
        <select value={reasoning} onChange={(event) => setReasoning(event.currentTarget.value)}>
          {["off", "minimal", "low", "medium", "high", "xhigh"].map((level) => (
            <option key={level} value={level}>{level}</option>
          ))}
        </select>
      </label>
      <label class="gsv-field"><span>Max tokens</span><input value={maxTokens} onInput={(event) => setMaxTokens(event.currentTarget.value)} /></label>
      <label class="gsv-field"><span>Max context</span><input value={maxContext} onInput={(event) => setMaxContext(event.currentTarget.value)} /></label>
      <div class="gsv-detail-actions">
        <ActionButton type="submit" icon="check" label="Save model" busyLabel="Saving" busy={busy} size="compact" disabled={!name.trim() || !model.trim()} />
        <ActionButton type="button" icon="x" label="Cancel" variant="ghost" size="compact" onClick={onCancel} />
      </div>
    </form>
  );
}

function CreateAgentForm({
  open,
  busy,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (args: CreateAgentArgs) => Promise<boolean>;
}) {
  const [username, setUsername] = useState("");
  const [gecos, setGecos] = useState("");
  const [contextFiles, setContextFiles] = useState<AgentContextFile[]>(defaultCreateContextFiles);

  function resetForm(): void {
    setUsername("");
    setGecos("");
    setContextFiles(defaultCreateContextFiles());
  }

  if (!open) {
    return null;
  }

  return (
    <form
      class="gsv-agents-form"
      onSubmit={async (event) => {
        event.preventDefault();
        const persona = contextFiles.find((file) => file.name === PERSONA_CONTEXT_FILE)?.text.trim() || undefined;
        const extraContextFiles = contextFiles.filter((file) => file.name !== PERSONA_CONTEXT_FILE);
        const ok = await onCreate({
          username,
          gecos: gecos || undefined,
          persona,
          contextFiles: extraContextFiles.length > 0 ? extraContextFiles : undefined,
        });
        if (ok) {
          resetForm();
          onOpenChange(false);
        }
      }}
    >
      <h4>New custom agent</h4>
      <label class="gsv-field">
        <span>Username</span>
        <input value={username} onInput={(e) => setUsername(e.currentTarget.value)} placeholder="research-bot" required />
      </label>
      <label class="gsv-field">
        <span>Display name</span>
        <input value={gecos} onInput={(e) => setGecos(e.currentTarget.value)} placeholder="Research Bot" />
      </label>
      <DraftContextFilesEditor files={contextFiles} onChange={setContextFiles} />
      <div class="gsv-detail-actions">
        <ActionButton type="submit" icon="check" label="Create agent" busyLabel="Creating" busy={busy} size="compact" />
        <ActionButton
          type="button"
          icon="x"
          label="Cancel"
          variant="ghost"
          size="compact"
          onClick={() => {
            resetForm();
            onOpenChange(false);
          }}
        />
      </div>
    </form>
  );
}

function defaultCreateContextFiles(): AgentContextFile[] {
  return [{ name: PERSONA_CONTEXT_FILE, text: "" }];
}

function normalizeDraftContextFileName(value: string): string | null {
  const raw = value.trim();
  if (!raw || raw.includes("/") || raw.includes("\\") || raw.includes("\0")) {
    return null;
  }
  const name = raw.endsWith(".md") ? raw : `${raw}.md`;
  const base = name.slice(0, -3);
  if (!base || base === "." || base === "..") {
    return null;
  }
  return name;
}

function DraftContextFilesEditor({
  files,
  onChange,
}: {
  files: AgentContextFile[];
  onChange: (files: AgentContextFile[]) => void;
}) {
  const [selected, setSelected] = useState(PERSONA_CONTEXT_FILE);
  const [draftName, setDraftName] = useState("");
  const [newDraft, setNewDraft] = useState("");

  useEffect(() => {
    if (selected === NEW_CONTEXT_FILE) return;
    if (files.some((file) => file.name === selected)) return;
    setSelected(files[0]?.name ?? PERSONA_CONTEXT_FILE);
  }, [files, selected]);

  function selectFile(name: string): void {
    setSelected(name);
    if (name === NEW_CONTEXT_FILE) {
      setDraftName("");
      setNewDraft("");
    }
  }

  function updateExisting(name: string, text: string): void {
    onChange(files.map((file) => file.name === name ? { ...file, text } : file));
  }

  function addDraftFile(): void {
    const name = normalizeDraftContextFileName(draftName);
    if (!name) return;
    const next = files.some((file) => file.name === name)
      ? files.map((file) => file.name === name ? { ...file, text: newDraft } : file)
      : [...files, { name, text: newDraft }];
    onChange(next);
    setSelected(name);
    setDraftName("");
    setNewDraft("");
  }

  const active = files.find((file) => file.name === selected);
  const normalizedDraftName = normalizeDraftContextFileName(draftName);

  return (
    <section class="gsv-agents-create-context" aria-label="Initial context files">
      <header class="gsv-section-intro">
        <span class="gsv-kicker">Context</span>
        <h3>Persona &amp; context</h3>
        <p>Initial markdown files for the agent's <code>context.d</code>.</p>
      </header>

      <div class="gsv-agents-context-tabs">
        {files.map((file) => (
          <button
            key={file.name}
            type="button"
            class={`gsv-chip${selected === file.name ? " is-active" : ""}`}
            onClick={() => selectFile(file.name)}
          >
            {file.name}
          </button>
        ))}
        <button
          type="button"
          class={`gsv-chip${selected === NEW_CONTEXT_FILE ? " is-active" : ""}`}
          onClick={() => selectFile(NEW_CONTEXT_FILE)}
        >
          + New file
        </button>
      </div>

      {selected === NEW_CONTEXT_FILE ? (
        <>
          <label class="gsv-field">
            <span>File name</span>
            <input
              value={draftName}
              onInput={(e) => setDraftName(e.currentTarget.value)}
              placeholder="20-style.md"
            />
          </label>
          <textarea
            class="gsv-agents-context-area"
            value={newDraft}
            onInput={(e) => setNewDraft(e.currentTarget.value)}
            placeholder="Markdown context for this agent."
            rows={8}
          />
          <div class="gsv-detail-actions">
            <ActionButton
              icon="file"
              label={normalizedDraftName && files.some((file) => file.name === normalizedDraftName) ? "Update file" : "Add file"}
              variant="ghost"
              size="compact"
              disabled={!normalizedDraftName}
              onClick={addDraftFile}
            />
          </div>
        </>
      ) : (
        <textarea
          class="gsv-agents-context-area"
          value={active?.text ?? ""}
          onInput={(e) => updateExisting(selected, e.currentTarget.value)}
          placeholder={selected === PERSONA_CONTEXT_FILE ? "You are a focused research agent..." : "Markdown context for this agent."}
          rows={8}
        />
      )}
    </section>
  );
}

function CreateHumanForm({
  busy,
  onCreate,
}: {
  busy: boolean;
  onCreate: (args: { username: string; password: string; gecos?: string }) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [gecos, setGecos] = useState("");

  if (!open) {
    return (
      <div class="gsv-agents-create-toggle">
        <ActionButton icon="key" label="New user" onClick={() => setOpen(true)} />
      </div>
    );
  }

  return (
    <form
      class="gsv-agents-form"
      onSubmit={async (event) => {
        event.preventDefault();
        const ok = await onCreate({ username, password, gecos: gecos || undefined });
        if (ok) {
          setUsername("");
          setPassword("");
          setGecos("");
          setOpen(false);
        }
      }}
    >
      <h4>New human user</h4>
      <label class="gsv-field">
        <span>Username</span>
        <input value={username} onInput={(e) => setUsername(e.currentTarget.value)} placeholder="alice" required />
      </label>
      <label class="gsv-field">
        <span>Password</span>
        <input type="password" value={password} onInput={(e) => setPassword(e.currentTarget.value)} placeholder="at least 8 characters" required />
      </label>
      <label class="gsv-field">
        <span>Display name</span>
        <input value={gecos} onInput={(e) => setGecos(e.currentTarget.value)} placeholder="Alice" />
      </label>
      <div class="gsv-detail-actions">
        <ActionButton type="submit" icon="check" label="Create user" busyLabel="Creating" busy={busy} size="compact" />
        <ActionButton type="button" icon="x" label="Cancel" variant="ghost" size="compact" onClick={() => setOpen(false)} />
      </div>
    </form>
  );
}

function AgentWorkspace({
  agent,
  category,
  context,
  models,
  systemAiValues,
  processes,
  contextLoading,
  busy,
  errorText,
  onBack,
  onCategoryChange,
  onSaveContext,
  onSaveBehavior,
}: {
  agent: AgentDetail;
  category: AgentCategory;
  context: { name: string; text: string }[];
  models: AgentModelProfile[];
  systemAiValues: Record<string, string>;
  processes: ProcessEntry[];
  contextLoading: boolean;
  busy: boolean;
  errorText: string;
  onBack: () => void;
  onCategoryChange: (category: AgentCategory) => void;
  onSaveContext: (name: string, text: string) => Promise<boolean>;
  onSaveBehavior: (aiValues: Record<string, string> | undefined, approval: string) => Promise<boolean>;
}) {
  const crewAgent = buildCrewAgents([agent], processes, models, systemAiValues)[0] ?? null;
  const tasks = crewAgent?.tasks ?? [];

  return (
    <section class="gsv-agent-object-workspace" aria-label="Agent detail">
      <ActionButton class="gsv-agent-back" icon="arrow-left" label="Crew" onClick={onBack} />
      {errorText ? <p class="gsv-inline-error">{errorText}</p> : null}

      <div class="gsv-agent-object-shell">
        <nav class="gsv-agent-object-nav" aria-label={`${agent.displayName} categories`}>
          {([
            ["general", "General"],
            ["files", "Files"],
            ["tasks", "Tasks"],
          ] as Array<[AgentCategory, string]>).map(([id, label]) => (
            <button key={id} type="button" class={category === id ? "is-active" : ""} onClick={() => onCategoryChange(id)}>
              {label}
            </button>
          ))}
        </nav>

        <section class="gsv-agent-object-panel" aria-label={`${agent.displayName} ${category}`}>
          <AgentObjectHeader agent={agent} />
          {category === "general" ? (
            <AgentGeneralTab
              agent={agent}
              models={models}
              systemAiValues={systemAiValues}
              busy={busy}
              onSave={onSaveBehavior}
            />
          ) : category === "files" ? (
            <ContextEditor
              key={agent.username}
              files={context}
              loading={contextLoading}
              busy={busy}
              editable={agent.contextEditable}
              onSave={onSaveContext}
            />
          ) : (
            <AgentTasksPanel tasks={tasks} />
          )}
        </section>
      </div>
    </section>
  );
}

function AgentObjectHeader({ agent }: { agent: AgentDetail }) {
  return (
    <header class="gsv-agent-object-head">
      <div>
        <h3>{agent.displayName}</h3>
        <p>{relationLabel(agent.relation)}</p>
      </div>
      <div class={`gsv-object-avatar is-${agent.relation === "personal-agent" ? "accent" : "good"}`} aria-hidden="true">
        <Icon name="user" />
        <span class="gsv-object-status is-good"></span>
      </div>
      <dl>
        <div><dt>Username</dt><dd>{agent.username}</dd></div>
        <div><dt>UID</dt><dd>{agent.uid}</dd></div>
      </dl>
    </header>
  );
}

function AgentGeneralTab({
  agent,
  models,
  systemAiValues,
  busy,
  onSave,
}: {
  agent: AgentDetail;
  models: AgentModelProfile[];
  systemAiValues: Record<string, string>;
  busy: boolean;
  onSave: (aiValues: Record<string, string> | undefined, approval: string) => Promise<boolean>;
}) {
  return (
    <section class="gsv-agent-general-tab">
      <dl class="gsv-agent-general-facts">
        <div><dt>Name</dt><dd>{agent.displayName}</dd></div>
        <div><dt>Role</dt><dd>{relationLabel(agent.relation)}</dd></div>
        <div><dt>Description</dt><dd>{agent.gecos || agent.displayName}</dd></div>
      </dl>
      <PermissionsEditor agent={agent} models={models} systemAiValues={systemAiValues} busy={busy} onSave={onSave} />
    </section>
  );
}

function AgentTasksPanel({ tasks }: { tasks: CrewTask[] }) {
  return (
    <section class="gsv-agents-panel" aria-label="Current tasks">
      <header class="gsv-section-intro">
        <span class="gsv-kicker">Tasks</span>
        <h3>Current work</h3>
        <p>Runtime work currently associated with this crew member.</p>
      </header>
      {tasks.length === 0 ? (
        <p class="gsv-agent-panel-note">No active or idle runtime work is currently associated with this agent.</p>
      ) : (
        <div class="gsv-agent-task-list">
          {tasks.map((task) => (
            <div class={`gsv-agent-task-item is-${task.tone}`} key={task.pid}>
              <span class={`gsv-mark is-${task.tone}`} aria-hidden="true"></span>
              <div>
                <strong>{task.title}</strong>
                <span>{task.stateLabel} / {task.pid}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ContextEditor({
  files,
  loading,
  busy,
  editable,
  onSave,
}: {
  files: { name: string; text: string }[];
  loading: boolean;
  busy: boolean;
  editable: boolean;
  onSave: (name: string, text: string) => Promise<boolean>;
}) {
  const NEW_FILE = "__new__";
  const [selected, setSelected] = useState<string>("");
  const [draftName, setDraftName] = useState("");
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (files.length > 0 && !files.some((file) => file.name === selected) && selected !== NEW_FILE) {
      const first = files[0];
      setSelected(first.name);
      setDraft(first.text);
    }
  }, [files, selected]);

  function selectFile(name: string): void {
    setSelected(name);
    if (name === NEW_FILE) {
      setDraftName("");
      setDraft("");
      return;
    }
    setDraft(files.find((file) => file.name === name)?.text ?? "");
  }

  const targetName = selected === NEW_FILE ? draftName : selected;
  const selectedFile = files.find((file) => file.name === selected);

  function resetDraft(): void {
    if (selected === NEW_FILE) {
      setDraftName("");
      setDraft("");
      return;
    }
    setDraft(selectedFile?.text ?? "");
  }

  return (
    <section class="gsv-agent-files-tab" aria-label="Context files">
      <header class="gsv-section-intro">
        <span class="gsv-kicker">Context</span>
        <h3>Persona &amp; context</h3>
        <p>Markdown files in the agent's <code>context.d</code>, layered into every prompt.</p>
      </header>

      <div class="gsv-agent-file-tiles">
        {files.map((file) => (
          <button
            key={file.name}
            type="button"
            class={`gsv-context-file-tile${selected === file.name ? " is-active" : ""}`}
            onClick={() => selectFile(file.name)}
          >
            <Icon name="folder" />
            <span>{contextFileLabel(file.name)}</span>
          </button>
        ))}
        <button
          type="button"
          class={`gsv-context-file-tile${selected === NEW_FILE ? " is-active" : ""}`}
          onClick={() => selectFile(NEW_FILE)}
        >
          <Icon name="folder" />
          <span>Add new</span>
        </button>
      </div>

      {selected === NEW_FILE ? (
        <label class="gsv-field">
          <span>File name</span>
          <input
            value={draftName}
            disabled={!editable}
            onInput={(e) => setDraftName(e.currentTarget.value)}
            placeholder="20-style.md"
          />
        </label>
      ) : null}

      <textarea
        class="gsv-agents-context-area"
        value={draft}
        disabled={loading || (files.length === 0 && selected !== NEW_FILE)}
        readOnly={!editable}
        onInput={(e) => setDraft(e.currentTarget.value)}
        placeholder={loading ? "Loading..." : editable ? "Markdown context for this agent." : "Context is read-only for this viewer."}
        rows={12}
      />

      <div class="gsv-detail-actions">
        <ActionButton
          icon="refresh"
          label="Reset"
          variant="ghost"
          size="compact"
          disabled={!editable || loading}
          onClick={resetDraft}
        />
        <ActionButton
          icon="check"
          label="Save context"
          busyLabel="Saving"
          busy={busy}
          size="compact"
          disabled={!editable || !targetName.trim() || loading}
          onClick={async () => {
            const ok = await onSave(targetName.trim(), draft);
            if (ok && selected === NEW_FILE) {
              setSelected(targetName.trim().endsWith(".md") ? targetName.trim() : `${targetName.trim()}.md`);
            }
          }}
        />
      </div>
    </section>
  );
}

function contextFileLabel(name: string): string {
  return name
    .replace(/^\d+-/, "")
    .replace(/\.md$/, "")
    .replace(/[-_]+/g, " ")
    .trim() || name;
}

function PermissionsEditor({
  agent,
  models,
  systemAiValues,
  busy,
  onSave,
}: {
  agent: AgentDetail;
  models: AgentModelProfile[];
  systemAiValues: Record<string, string>;
  busy: boolean;
  onSave: (aiValues: Record<string, string> | undefined, approval: string) => Promise<boolean>;
}) {
  const [stackSelection, setStackSelection] = useState(() => stackSelectionForAgent(agent, models, systemAiValues));
  const [policy, setPolicy] = useState<ApprovalPolicy>(() => parseApprovalPolicy(agent.approval));
  const summary = summarizePermissions(serializeApprovalPolicy(policy), agent.configEditable);
  const stackSummary = stackSummaryForSelection(stackSelection, agent, models, systemAiValues);
  const hasCustomStack = stackSelectionForAgent(agent, models, systemAiValues) === CUSTOM_STACK;
  const customSelected = stackSelection === CUSTOM_STACK;

  useEffect(() => {
    setStackSelection(stackSelectionForAgent(agent, models, systemAiValues));
    setPolicy(parseApprovalPolicy(agent.approval));
  }, [agent.uid, agent.approval, agent.aiValues, models, systemAiValues]);

  function setDefault(action: ApprovalPolicy["default"]): void {
    setPolicy((prev) => ({ ...prev, default: action }));
  }

  function addRule(): void {
    setPolicy((prev) => ({ ...prev, rules: [...prev.rules, { match: "", action: "ask" }] }));
  }

  function updateRule(index: number, patch: Partial<ApprovalPolicy["rules"][number]>): void {
    setPolicy((prev) => ({
      ...prev,
      rules: prev.rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)),
    }));
  }

  function removeRule(index: number): void {
    setPolicy((prev) => ({ ...prev, rules: prev.rules.filter((_, i) => i !== index) }));
  }

  return (
    <section class="gsv-agents-panel is-permissions" aria-label="Permissions">
      <header class="gsv-section-intro">
        <span class="gsv-kicker">Permissions</span>
        <h3>Model preset &amp; tool permissions</h3>
        <p>{agent.configEditable ? "Choose the account-level model preset for future runs, then set tool approval policy." : "This policy is read-only for the current viewer."}</p>
      </header>

      <div class={`gsv-permission-summary is-${summary.tone}`}>
        <div>
          <span>{summary.mode === "inherited" ? "Inherited policy" : "Custom policy"} / {summary.lockLabel}</span>
          <strong>{summary.headline}</strong>
          <p>{summary.detail}</p>
        </div>
        <div class="gsv-permission-counts" aria-label="Permission rule counts">
          <span>{summary.askCount} ask</span>
          <span>{summary.denyCount} deny</span>
          <span>{summary.autoCount} allow</span>
        </div>
      </div>

      <label class="gsv-field">
        <span>Model preset</span>
        <select
          class="gsv-stack-select"
          value={stackSelection}
          disabled={!agent.configEditable}
          onChange={(e) => setStackSelection(e.currentTarget.value)}
        >
          <option value={INHERIT_STACK}>Inherit default</option>
          <option value={CURRENT_DEFAULT_STACK}>{currentDefaultOptionLabel(systemAiValues, models)}</option>
          {models.map((profile) => (
            <option key={profile.id} value={profile.id}>{profile.name}</option>
          ))}
          {hasCustomStack || customSelected ? <option value={CUSTOM_STACK}>Custom account overrides</option> : null}
        </select>
      </label>
      <div class="gsv-model-preset-summary">
        <span>{stackSummary.kind}</span>
        <strong>{stackSummary.label}</strong>
        <p>{stackSummary.detail}</p>
      </div>
      {models.length === 0 ? (
        <p class="gsv-agent-panel-note">No saved model presets are available for this account yet.</p>
      ) : null}

      <div class="gsv-field">
        <span>Default tool approval</span>
        <div class="gsv-segmented">
          {APPROVAL_ACTION_OPTIONS.map((action) => (
            <button
              key={action}
              type="button"
              class={`gsv-segment${policy.default === action ? " is-active" : ""}`}
              disabled={!agent.configEditable}
              onClick={() => setDefault(action)}
            >
              {actionLabel(action)}
            </button>
          ))}
        </div>
      </div>

      <div class="gsv-agents-rules">
        <div class="gsv-agents-rules-head">
          <span>Tool rules</span>
          <small>{summary.ruleCount === 0 ? "No custom rules." : `${summary.ruleCount} custom rule${summary.ruleCount === 1 ? "" : "s"}.`}</small>
        </div>
        {policy.rules.map((rule, index) => (
          <div class="gsv-agents-rule" key={index}>
            <input
              class="gsv-agents-rule-match"
              value={rule.match}
              disabled={!agent.configEditable}
              onInput={(e) => updateRule(index, { match: e.currentTarget.value })}
              placeholder="fs.delete"
            />
            <select
              value={rule.action}
              disabled={!agent.configEditable}
              onChange={(e) => updateRule(index, { action: e.currentTarget.value as ApprovalPolicy["default"] })}
            >
              {APPROVAL_ACTION_OPTIONS.map((action) => (
                <option key={action} value={action}>{actionLabel(action)}</option>
              ))}
            </select>
            <ActionButton
              icon="x"
              label={`Remove ${ruleLabel(rule)}`}
              size="icon"
              variant="ghost"
              disabled={!agent.configEditable}
              onClick={() => removeRule(index)}
            />
          </div>
        ))}
        {summary.riskyRules.length > 0 ? (
          <div class="gsv-permission-risk-list" aria-label="Sensitive permission rules">
            {summary.riskyRules.slice(0, 3).map((rule) => (
              <span key={`${rule.match}:${rule.action}`}>{ruleLabel(rule)}</span>
            ))}
          </div>
        ) : null}
        <ActionButton icon="file" label="Add rule" variant="ghost" disabled={!agent.configEditable} onClick={addRule} />
      </div>

      <div class="gsv-detail-actions">
        <ActionButton
          icon="check"
          label="Save preset & permissions"
          busyLabel="Saving"
          busy={busy}
          size="compact"
          disabled={!agent.configEditable}
          onClick={() => void onSave(aiValuesForStackSelection(stackSelection, models, systemAiValues), serializeApprovalPolicy(policy))}
        />
      </div>
    </section>
  );
}

function stackSelectionForAgent(
  agent: AgentDetail,
  profiles: AgentModelProfile[],
  systemAiValues: Record<string, string>,
): string {
  if (Object.keys(agent.aiValues).length === 0) {
    return INHERIT_STACK;
  }
  if (profileValuesMatch(agent.aiValues, systemAiValues)) {
    return CURRENT_DEFAULT_STACK;
  }
  return findMatchingStackProfile(profiles, agent.aiValues)?.id ?? CUSTOM_STACK;
}

function aiValuesForStackSelection(
  selection: string,
  profiles: AgentModelProfile[],
  systemAiValues: Record<string, string>,
): Record<string, string> | undefined {
  if (selection === INHERIT_STACK) {
    return {};
  }
  if (selection === CURRENT_DEFAULT_STACK) {
    return profileValuesFromDrafts(systemAiValues);
  }
  if (selection === CUSTOM_STACK) {
    return undefined;
  }
  return profiles.find((profile) => profile.id === selection)?.values;
}

function stackSummaryForSelection(
  selection: string,
  agent: AgentDetail,
  profiles: AgentModelProfile[],
  systemAiValues: Record<string, string>,
): { kind: string; label: string; detail: string } {
  if (selection === INHERIT_STACK) {
    return {
      kind: "Inherited preset",
      label: currentDefaultModelLabel(systemAiValues, profiles),
      detail: stackDetail(systemAiValues),
    };
  }

  if (selection === CURRENT_DEFAULT_STACK) {
    return {
      kind: "Fixed preset",
      label: currentDefaultModelLabel(systemAiValues, profiles),
      detail: stackDetail(systemAiValues),
    };
  }

  const profile = profiles.find((candidate) => candidate.id === selection);
  if (profile) {
    return {
      kind: "Model preset",
      label: profile.name,
      detail: stackDetail(profile.values),
    };
  }

  return {
    kind: "Custom preset",
    label: "Account overrides",
    detail: stackDetail(agent.effectiveAiValues),
  };
}

function profileValuesMatch(left: Record<string, string>, right: Record<string, string>): boolean {
  const normalizedLeft = profileValuesFromDrafts(left);
  const normalizedRight = profileValuesFromDrafts(right);
  return AI_FIELDS.every((field) => (normalizedLeft[field.key] ?? "") === (normalizedRight[field.key] ?? ""));
}

function currentDefaultOptionLabel(
  systemAiValues: Record<string, string>,
  profiles: AgentModelProfile[],
): string {
  return `${currentDefaultModelLabel(systemAiValues, profiles)} (current default)`;
}

function currentDefaultModelLabel(
  systemAiValues: Record<string, string>,
  profiles: AgentModelProfile[],
): string {
  const profile = findMatchingStackProfile(profiles, systemAiValues);
  if (profile) {
    return profile.name;
  }
  const model = profileValuesFromDrafts(systemAiValues)["config/ai/model"]?.trim();
  return model ? modelDisplayLabel(model) : "Default model";
}
