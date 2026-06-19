import { useEffect, useState } from "preact/hooks";
import type { GsvBackend } from "../../backend-contract";
import { ActionButton } from "../../components/ui/ActionButton";
import { buildCrewAgents, findMatchingStackProfile, stackDetail } from "../../domain/crew";
import { CrewOverview } from "./CrewCards";
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
const CUSTOM_STACK = "__custom__";

export function AgentsSection({ backend }: { backend: GsvBackend }) {
  const agents = useAgents(backend);

  if (agents.selectedAgent) {
    return (
      <section class="gsv-agents">
        <AgentWorkspace
          agent={agents.selectedAgent}
          context={agents.context}
          models={agents.state?.modelProfiles ?? []}
          systemAiValues={agents.state?.systemAiValues ?? {}}
          processes={agents.processes}
          contextLoading={agents.contextLoading}
          busy={agents.busy}
          errorText={agents.errorText}
          onBack={agents.clearSelection}
          onSaveContext={(name, text) => agents.saveContext(agents.selectedAgent!.username, name, text)}
          onSaveBehavior={(aiValues, approval) => agents.setBehavior({ uid: agents.selectedAgent!.uid, aiValues, approval })}
        />
      </section>
    );
  }

  return (
    <section class="gsv-agents">
      <AgentRoster
        loading={agents.loading}
        busy={agents.busy}
        errorText={agents.errorText}
        agents={agents.state?.agents ?? []}
        humans={agents.state?.humans ?? []}
        models={agents.state?.modelProfiles ?? []}
        systemAiValues={agents.state?.systemAiValues ?? {}}
        processes={agents.processes}
        viewerUid={agents.state?.viewerUid ?? 0}
        isRoot={agents.state?.isRoot ?? false}
        onRefresh={() => void agents.loadState()}
        onSelect={agents.selectAgent}
        onCreateAgent={(args) => agents.createAgent(args)}
        onCreateHuman={(args) => agents.createHuman(args)}
      />
    </section>
  );
}

function AgentRoster({
  loading,
  busy,
  errorText,
  agents,
  humans,
  models,
  systemAiValues,
  processes,
  viewerUid,
  isRoot,
  onRefresh,
  onSelect,
  onCreateAgent,
  onCreateHuman,
}: {
  loading: boolean;
  busy: boolean;
  errorText: string;
  agents: AgentDetail[];
  humans: AccountSummary[];
  models: AgentModelProfile[];
  systemAiValues: Record<string, string>;
  processes: ProcessEntry[];
  viewerUid: number;
  isRoot: boolean;
  onRefresh: () => void;
  onSelect: (agent: AgentDetail) => void;
  onCreateAgent: (args: CreateAgentArgs) => Promise<boolean>;
  onCreateHuman: (args: { username: string; password: string; gecos?: string }) => Promise<boolean>;
}) {
  const [createAgentOpen, setCreateAgentOpen] = useState(false);

  return (
    <section class="gsv-agents-roster" aria-label="Crew">
      <div class="gsv-agents-toolbar">
        <p class="gsv-runtime-meta" aria-live="polite">
          {loading ? "Loading agents." : `${agents.length} agent${agents.length === 1 ? "" : "s"} you can run.`}
        </p>
        <ActionButton icon="refresh" label="Refresh" busy={loading} size="icon" onClick={onRefresh} />
      </div>
      {errorText ? <p class="gsv-inline-error">{errorText}</p> : null}

      <CrewOverview
        agents={agents}
        models={models}
        systemAiValues={systemAiValues}
        processes={processes}
        loading={loading}
        onSelect={onSelect}
        onCreateAgent={() => setCreateAgentOpen(true)}
      />

      <CreateAgentForm open={createAgentOpen} busy={busy} onOpenChange={setCreateAgentOpen} onCreate={onCreateAgent} />

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
        <ActionButton type="submit" icon="check" label="Create agent" busyLabel="Creating" busy={busy} />
        <ActionButton
          type="button"
          icon="x"
          label="Cancel"
          variant="ghost"
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
        <ActionButton type="submit" icon="check" label="Create user" busyLabel="Creating" busy={busy} />
        <ActionButton type="button" icon="x" label="Cancel" variant="ghost" onClick={() => setOpen(false)} />
      </div>
    </form>
  );
}

function AgentWorkspace({
  agent,
  context,
  models,
  systemAiValues,
  processes,
  contextLoading,
  busy,
  errorText,
  onBack,
  onSaveContext,
  onSaveBehavior,
}: {
  agent: AgentDetail;
  context: { name: string; text: string }[];
  models: AgentModelProfile[];
  systemAiValues: Record<string, string>;
  processes: ProcessEntry[];
  contextLoading: boolean;
  busy: boolean;
  errorText: string;
  onBack: () => void;
  onSaveContext: (name: string, text: string) => Promise<boolean>;
  onSaveBehavior: (aiValues: Record<string, string> | undefined, approval: string) => Promise<boolean>;
}) {
  const crewAgent = buildCrewAgents([agent], processes, models, systemAiValues)[0] ?? null;
  const tasks = crewAgent?.tasks ?? [];

  return (
    <section class="gsv-agents-workspace" aria-label="Agent detail">
      <header class="gsv-runtime-detail-head">
        <ActionButton icon="arrow-left" label="Crew" onClick={onBack} />
        <div>
          <span class="gsv-kicker">{relationLabel(agent.relation)}</span>
          <h3>{agent.displayName}</h3>
          <p>{agent.username} / uid {agent.uid}</p>
        </div>
      </header>

      {errorText ? <p class="gsv-inline-error">{errorText}</p> : null}

      <div class="gsv-agent-detail-grid">
        <PermissionsEditor
          agent={agent}
          models={models}
          systemAiValues={systemAiValues}
          busy={busy}
          onSave={onSaveBehavior}
        />

        <AgentTasksPanel tasks={tasks} />

        <ContextEditor
          key={agent.username}
          files={context}
          loading={contextLoading}
          busy={busy}
          editable={agent.contextEditable}
          onSave={onSaveContext}
        />

        <AgentAdvancedPanel agent={agent} />
      </div>
    </section>
  );
}

function AgentTasksPanel({ tasks }: { tasks: NonNullable<ReturnType<typeof buildCrewAgents>[number]>["tasks"] }) {
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

function AgentAdvancedPanel({ agent }: { agent: AgentDetail }) {
  return (
    <section class="gsv-agents-panel" aria-label="Advanced agent metadata">
      <header class="gsv-section-intro">
        <span class="gsv-kicker">Advanced</span>
        <h3>Identity</h3>
        <p>Low-level account fields used for routing and configuration.</p>
      </header>
      <dl class="gsv-agent-advanced-list">
        <div>
          <dt>Username</dt>
          <dd>{agent.username}</dd>
        </div>
        <div>
          <dt>UID</dt>
          <dd>{agent.uid}</dd>
        </div>
        <div>
          <dt>Relation</dt>
          <dd>{relationLabel(agent.relation)}</dd>
        </div>
        <div>
          <dt>Config</dt>
          <dd>{agent.configEditable ? "Editable" : "Read-only"}</dd>
        </div>
      </dl>
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

  return (
    <section class="gsv-agents-panel" aria-label="Context files">
      <header class="gsv-section-intro">
        <span class="gsv-kicker">Context</span>
        <h3>Persona &amp; context</h3>
        <p>Markdown files in the agent's <code>context.d</code>, layered into every prompt.</p>
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
          class={`gsv-chip${selected === NEW_FILE ? " is-active" : ""}`}
          onClick={() => selectFile(NEW_FILE)}
        >
          + New file
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
          icon="check"
          label="Save context"
          busyLabel="Saving"
          busy={busy}
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
  const [stackSelection, setStackSelection] = useState(() => stackSelectionForAgent(agent, models));
  const [policy, setPolicy] = useState<ApprovalPolicy>(() => parseApprovalPolicy(agent.approval));
  const summary = summarizePermissions(serializeApprovalPolicy(policy), agent.configEditable);
  const stackSummary = stackSummaryForSelection(stackSelection, agent, models, systemAiValues);
  const hasCustomStack = stackSelectionForAgent(agent, models) === CUSTOM_STACK;
  const customSelected = stackSelection === CUSTOM_STACK;

  useEffect(() => {
    setStackSelection(stackSelectionForAgent(agent, models));
    setPolicy(parseApprovalPolicy(agent.approval));
  }, [agent.uid, agent.approval, agent.aiValues, models]);

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
        <h3>AI stack &amp; tool permissions</h3>
        <p>{agent.configEditable ? "Choose the account-level AI stack for future runs, then set tool approval policy." : "This policy is read-only for the current viewer."}</p>
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
        <span>AI stack</span>
        <select
          class="gsv-stack-select"
          value={stackSelection}
          disabled={!agent.configEditable}
          onChange={(e) => setStackSelection(e.currentTarget.value)}
        >
          <option value={INHERIT_STACK}>Inherit system defaults</option>
          {models.map((profile) => (
            <option key={profile.id} value={profile.id}>{profile.name}</option>
          ))}
          {hasCustomStack || customSelected ? <option value={CUSTOM_STACK}>Custom account overrides</option> : null}
        </select>
      </label>
      <div class="gsv-ai-stack-summary">
        <span>{stackSummary.kind}</span>
        <strong>{stackSummary.label}</strong>
        <p>{stackSummary.detail}</p>
      </div>
      {models.length === 0 ? (
        <p class="gsv-agent-panel-note">No saved AI stack profiles are available for this account yet.</p>
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
          label="Save stack & permissions"
          busyLabel="Saving"
          busy={busy}
          disabled={!agent.configEditable}
          onClick={() => void onSave(aiValuesForStackSelection(stackSelection, models), serializeApprovalPolicy(policy))}
        />
      </div>
    </section>
  );
}

function stackSelectionForAgent(agent: AgentDetail, profiles: AgentModelProfile[]): string {
  if (Object.keys(agent.aiValues).length === 0) {
    return INHERIT_STACK;
  }
  return findMatchingStackProfile(profiles, agent.aiValues)?.id ?? CUSTOM_STACK;
}

function aiValuesForStackSelection(selection: string, profiles: AgentModelProfile[]): Record<string, string> | undefined {
  if (selection === INHERIT_STACK) {
    return {};
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
      kind: "Inherited stack",
      label: "System defaults",
      detail: stackDetail(systemAiValues),
    };
  }

  const profile = profiles.find((candidate) => candidate.id === selection);
  if (profile) {
    return {
      kind: "Saved stack",
      label: profile.name,
      detail: stackDetail(profile.values),
    };
  }

  return {
    kind: "Custom stack",
    label: "Account overrides",
    detail: stackDetail(agent.effectiveAiValues),
  };
}
