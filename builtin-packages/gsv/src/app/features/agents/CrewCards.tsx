import { buildCrewAgents } from "../../domain/crew";
import { ActionButton } from "../../components/ui/ActionButton";
import {
  ConsoleCard,
  DisclosureLine,
  MetadataItem,
  MetadataStack,
  ObjectHeader,
} from "../../components/ui/ConsoleCard";
import type { ProcessEntry } from "../runtime/types";
import type { AgentDetail, AgentModelProfile } from "./types";

export function CrewOverview({
  agents,
  models,
  processes,
  loading,
  onSelect,
  onCreateAgent,
}: {
  agents: AgentDetail[];
  models: AgentModelProfile[];
  processes: ProcessEntry[];
  loading: boolean;
  onSelect: (agent: AgentDetail) => void;
  onCreateAgent: () => void;
}) {
  const crew = buildCrewAgents(agents, processes, models);

  return (
    <div class="gsv-crew-layout">
      <section class="gsv-crew-models" aria-label="Available LLM models">
        <header class="gsv-crew-column-head">
          <span class="gsv-kicker">Available LLM models</span>
        </header>
        {models.length === 0 ? (
          <ConsoleCard>
            <ObjectHeader title="No model data" eyebrow="Configuration" icon="settings" status="neutral" />
            <p class="gsv-crew-card-note">{loading ? "Loading model configuration." : "Model configuration is not visible to this account."}</p>
          </ConsoleCard>
        ) : models.map((model) => (
          <ModelCard key={model.id} model={model} />
        ))}
        <ConsoleCard class="gsv-create-card">
          <div class="gsv-create-card-copy">
            <strong>Add new model</strong>
            <span>Model profile</span>
          </div>
          <ActionButton icon="plus" label="Add model" size="icon" disabled />
        </ConsoleCard>
      </section>

      <section class="gsv-crew-agents" aria-label="Crew members">
        <header class="gsv-crew-column-head">
          <span class="gsv-kicker">Crew members</span>
        </header>
        <div class="gsv-crew-agent-grid">
          {crew.length === 0 ? (
            <section class="gsv-empty-state">
              <h3>No agents yet</h3>
              <p>Create a custom agent or check that your personal agent is provisioned.</p>
            </section>
          ) : crew.map((agent) => (
            <AgentObjectCard
              key={agent.username}
              agent={agent}
              expanded={agent.activeTasks.length > 0 || agent.agent.relation === "personal-agent"}
              onManage={() => onSelect(agent.agent)}
            />
          ))}
          <ConsoleCard class="gsv-create-card">
            <div class="gsv-create-card-copy">
              <strong>Expand crew</strong>
              <span>Create new agent</span>
            </div>
            <ActionButton icon="plus" label="Create new agent" size="icon" onClick={onCreateAgent} />
          </ConsoleCard>
        </div>
      </section>
    </div>
  );
}

function ModelCard({ model }: { model: AgentModelProfile }) {
  return (
    <ConsoleCard class="gsv-model-card" tone={model.default ? "accent" : "neutral"}>
      <ObjectHeader
        title={model.label}
        eyebrow={model.default ? "Default" : "Available"}
        icon="server"
        tone={model.default ? "accent" : "neutral"}
        status={model.default ? "good" : "neutral"}
        compact
      />
      <MetadataStack>
        <MetadataItem label="Provider" value={model.provider} />
        <MetadataItem label="Model" value={model.model} />
        <MetadataItem label="Reasoning" value={model.reasoning} />
        <MetadataItem label="Max tokens" value={model.maxTokens} />
        <MetadataItem label="Context" value={model.maxContext} />
      </MetadataStack>
      {model.default ? (
        <label class="gsv-model-default">
          <input type="checkbox" checked disabled />
          <span>Default model</span>
        </label>
      ) : null}
    </ConsoleCard>
  );
}

function AgentObjectCard({
  agent,
  expanded,
  onManage,
}: {
  agent: ReturnType<typeof buildCrewAgents>[number];
  expanded: boolean;
  onManage: () => void;
}) {
  const status = agent.activeTasks.length > 0 ? "good" : "neutral";
  const firstTasks = agent.activeTasks.slice(0, 3);

  return (
    <ConsoleCard class="gsv-agent-card" tone={agent.tone}>
      <ObjectHeader
        title={agent.displayName}
        eyebrow={agent.roleLabel}
        subtitle={expanded ? agent.description : undefined}
        icon="user"
        tone={agent.tone}
        status={status}
      />

      {expanded ? (
        <>
          <div class="gsv-agent-card-lines">
            <DisclosureLine label="Model" detail={agent.modelLabel} open />
            <DisclosureLine label={agent.modelDetail} muted />
            <DisclosureLine
              label={`Active tasks (${agent.activeTasks.length})`}
              open={firstTasks.length > 0}
              tone={agent.activeTasks.length > 0 ? "good" : "neutral"}
            />
            {firstTasks.length === 0 ? (
              <DisclosureLine label="Idle" muted />
            ) : firstTasks.map((task) => (
              <DisclosureLine key={task.pid} label={task.title} muted tone={task.tone} />
            ))}
            <DisclosureLine label="Permissions" detail={agent.permissionLabel} open />
          </div>
          <div class="gsv-card-actions">
            <button type="button" class="gsv-text-action" onClick={onManage}>Manage &gt;</button>
          </div>
        </>
      ) : (
        <div class="gsv-card-actions">
          <span class="gsv-agent-compact-meta">{agent.activeTasks.length} active</span>
          <button type="button" class="gsv-text-action" onClick={onManage}>Manage &gt;</button>
        </div>
      )}
    </ConsoleCard>
  );
}
