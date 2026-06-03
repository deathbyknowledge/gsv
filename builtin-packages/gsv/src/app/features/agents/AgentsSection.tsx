import { useEffect, useState } from "preact/hooks";
import type { GsvBackend } from "../../backend-contract";
import { ActionButton } from "../../components/ui/ActionButton";
import {
  APPROVAL_ACTION_OPTIONS,
  approvalSummary,
  parseApprovalPolicy,
  relationLabel,
  relationTone,
  serializeApprovalPolicy,
} from "./agents-domain";
import { useAgents } from "./useAgents";
import type {
  AccountSummary,
  AgentDetail,
  ApprovalPolicy,
} from "./types";

export function AgentsSection({ backend }: { backend: GsvBackend }) {
  const agents = useAgents(backend);

  if (agents.selectedAgent) {
    return (
      <section class="gsv-agents">
        <AgentWorkspace
          agent={agents.selectedAgent}
          context={agents.context}
          contextLoading={agents.contextLoading}
          busy={agents.busy}
          errorText={agents.errorText}
          onBack={agents.clearSelection}
          onSaveContext={(name, text) => agents.saveContext(agents.selectedAgent!.username, name, text)}
          onSaveBehavior={(model, approval) => agents.setBehavior({ uid: agents.selectedAgent!.uid, model, approval })}
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
  viewerUid: number;
  isRoot: boolean;
  onRefresh: () => void;
  onSelect: (agent: AgentDetail) => void;
  onCreateAgent: (args: { username: string; gecos?: string; persona?: string }) => Promise<boolean>;
  onCreateHuman: (args: { username: string; password: string; gecos?: string }) => Promise<boolean>;
}) {
  return (
    <section class="gsv-agents-roster" aria-label="Agents">
      <div class="gsv-agents-toolbar">
        <p class="gsv-runtime-meta" aria-live="polite">
          {loading ? "Loading agents." : `${agents.length} agent${agents.length === 1 ? "" : "s"} you can run.`}
        </p>
        <ActionButton icon="refresh" label="Refresh" busy={loading} size="icon" onClick={onRefresh} />
      </div>
      {errorText ? <p class="gsv-inline-error">{errorText}</p> : null}

      <div class="gsv-agents-list">
        {agents.length === 0 ? (
          <section class="gsv-empty-state">
            <h3>No agents yet</h3>
            <p>Create a custom agent or check that your personal agent is provisioned.</p>
          </section>
        ) : agents.map((agent) => (
          <button
            key={agent.username}
            class="gsv-runtime-row"
            type="button"
            onClick={() => onSelect(agent)}
          >
            <span class={`gsv-mark is-${relationTone(agent.relation)}`} aria-hidden="true"></span>
            <span class="gsv-row-copy">
              <strong>{agent.displayName}</strong>
              <span>{relationLabel(agent.relation)} / {agent.model || "default model"} / {approvalSummary(agent.approval)}</span>
            </span>
            <span class="gsv-row-meta">{agent.username}</span>
          </button>
        ))}
      </div>

      <CreateAgentForm busy={busy} onCreate={onCreateAgent} />

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
  busy,
  onCreate,
}: {
  busy: boolean;
  onCreate: (args: { username: string; gecos?: string; persona?: string }) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [gecos, setGecos] = useState("");
  const [persona, setPersona] = useState("");

  if (!open) {
    return (
      <div class="gsv-agents-create-toggle">
        <ActionButton icon="user" label="New agent" onClick={() => setOpen(true)} />
      </div>
    );
  }

  return (
    <form
      class="gsv-agents-form"
      onSubmit={async (event) => {
        event.preventDefault();
        const ok = await onCreate({ username, gecos: gecos || undefined, persona: persona || undefined });
        if (ok) {
          setUsername("");
          setGecos("");
          setPersona("");
          setOpen(false);
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
      <label class="gsv-field">
        <span>Persona</span>
        <textarea value={persona} onInput={(e) => setPersona(e.currentTarget.value)} placeholder="You are a focused research agent..." rows={4} />
      </label>
      <div class="gsv-detail-actions">
        <ActionButton type="submit" icon="check" label="Create agent" busyLabel="Creating" busy={busy} />
        <ActionButton type="button" icon="x" label="Cancel" variant="ghost" onClick={() => setOpen(false)} />
      </div>
    </form>
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
  contextLoading,
  busy,
  errorText,
  onBack,
  onSaveContext,
  onSaveBehavior,
}: {
  agent: AgentDetail;
  context: { name: string; text: string }[];
  contextLoading: boolean;
  busy: boolean;
  errorText: string;
  onBack: () => void;
  onSaveContext: (name: string, text: string) => Promise<boolean>;
  onSaveBehavior: (model: string, approval: string) => Promise<boolean>;
}) {
  return (
    <section class="gsv-agents-workspace" aria-label="Agent detail">
      <header class="gsv-runtime-detail-head">
        <ActionButton icon="arrow-left" label="Agents" onClick={onBack} />
        <div>
          <span class="gsv-kicker">{relationLabel(agent.relation)}</span>
          <h3>{agent.displayName}</h3>
          <p>{agent.username} / uid {agent.uid}</p>
        </div>
      </header>

      {errorText ? <p class="gsv-inline-error">{errorText}</p> : null}

      <ContextEditor
        key={agent.username}
        files={context}
        loading={contextLoading}
        busy={busy}
        onSave={onSaveContext}
      />

      <BehaviorEditor agent={agent} busy={busy} onSave={onSaveBehavior} />
    </section>
  );
}

function ContextEditor({
  files,
  loading,
  busy,
  onSave,
}: {
  files: { name: string; text: string }[];
  loading: boolean;
  busy: boolean;
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
            onInput={(e) => setDraftName(e.currentTarget.value)}
            placeholder="20-style.md"
          />
        </label>
      ) : null}

      <textarea
        class="gsv-agents-context-area"
        value={draft}
        disabled={loading || (files.length === 0 && selected !== NEW_FILE)}
        onInput={(e) => setDraft(e.currentTarget.value)}
        placeholder={loading ? "Loading..." : "Markdown context for this agent."}
        rows={12}
      />

      <div class="gsv-detail-actions">
        <ActionButton
          icon="check"
          label="Save context"
          busyLabel="Saving"
          busy={busy}
          disabled={!targetName.trim() || loading}
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

function BehaviorEditor({
  agent,
  busy,
  onSave,
}: {
  agent: AgentDetail;
  busy: boolean;
  onSave: (model: string, approval: string) => Promise<boolean>;
}) {
  const [model, setModel] = useState(agent.model);
  const [policy, setPolicy] = useState<ApprovalPolicy>(() => parseApprovalPolicy(agent.approval));

  useEffect(() => {
    setModel(agent.model);
    setPolicy(parseApprovalPolicy(agent.approval));
  }, [agent.uid, agent.model, agent.approval]);

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
    <section class="gsv-agents-panel" aria-label="Behavior">
      <header class="gsv-section-intro">
        <span class="gsv-kicker">Behavior</span>
        <h3>Model &amp; approvals</h3>
        <p>Overrides applied whenever this agent runs. Leave the model blank to inherit the system default.</p>
      </header>

      <label class="gsv-field">
        <span>Model override</span>
        <input value={model} onInput={(e) => setModel(e.currentTarget.value)} placeholder="inherit default" />
      </label>

      <div class="gsv-field">
        <span>Default tool approval</span>
        <div class="gsv-segmented">
          {APPROVAL_ACTION_OPTIONS.map((action) => (
            <button
              key={action}
              type="button"
              class={`gsv-segment${policy.default === action ? " is-active" : ""}`}
              onClick={() => setDefault(action)}
            >
              {action}
            </button>
          ))}
        </div>
      </div>

      <div class="gsv-agents-rules">
        {policy.rules.map((rule, index) => (
          <div class="gsv-agents-rule" key={index}>
            <input
              class="gsv-agents-rule-match"
              value={rule.match}
              onInput={(e) => updateRule(index, { match: e.currentTarget.value })}
              placeholder="fs.delete"
            />
            <select
              value={rule.action}
              onChange={(e) => updateRule(index, { action: e.currentTarget.value as ApprovalPolicy["default"] })}
            >
              {APPROVAL_ACTION_OPTIONS.map((action) => (
                <option key={action} value={action}>{action}</option>
              ))}
            </select>
            <ActionButton icon="x" label="Remove" size="icon" variant="ghost" onClick={() => removeRule(index)} />
          </div>
        ))}
        <ActionButton icon="file" label="Add rule" variant="ghost" onClick={addRule} />
      </div>

      <div class="gsv-detail-actions">
        <ActionButton
          icon="check"
          label="Save behavior"
          busyLabel="Saving"
          busy={busy}
          onClick={() => void onSave(model.trim(), serializeApprovalPolicy(policy))}
        />
      </div>
    </section>
  );
}
