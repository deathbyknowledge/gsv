import { AgentCard } from "../../../components/ui/AgentCard";
import { AddAction } from "../../../components/ui/AddAction";
import { Avatar } from "../../../components/ui/Avatar";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import type { ChatAgentCrewView, ChatAgentViewModel } from "../domain/agent";

type ActiveAgentPanelProps = {
  agent: ChatAgentViewModel;
  onClose: () => void;
  onOpenCrew: () => void;
  onSelectAgent?: (agentId: string) => void;
};

export function ActiveAgentPanel({
  agent,
  onClose,
  onOpenCrew,
  onSelectAgent,
}: ActiveAgentPanelProps) {
  const openCrew = () => {
    onClose();
    onOpenCrew();
  };

  const selectAgent = (member: ChatAgentCrewView) => {
    if (member.active) {
      return;
    }
    if (member.processId && onSelectAgent) {
      onSelectAgent(member.processId);
      onClose();
      return;
    }
    openCrew();
  };

  return (
    <div class="gsv-chat-agent-panel" role="dialog" aria-label="Active agent">
      <div class="gsv-chat-agent-panel-card">
        <AgentCard
          agentName={agent.name}
          agentRole={agent.role}
          description={agent.description}
          imgSrc={agent.imageSrc}
          status={agent.status}
          modelIsDefault={agent.modelIsDefault}
          tasksTotal={agent.tasksTotal}
          active
          showActions
          models={[agent.modelLabel]}
          tasks={agent.tasks}
          readOnly
          onManage={openCrew}
          onClose={onClose}
          onAvatarClick={onClose}
        />
      </div>

      <div class="gsv-chat-agent-panel-crew">
        <SectionHeader
          title="CREW"
          meta={agent.hasCrewData ? `${agent.crew.length} AGENTS` : "PROCESS"}
          divider
        />
        <div class="gsv-chat-agent-crew-list">
          {agent.crew.map((member) => (
            <button
              key={member.id}
              type="button"
              class={`gsv-chat-agent-crew-tile${member.active ? " is-active" : ""}`}
              onClick={() => selectAgent(member)}
            >
              <Avatar src={member.imageSrc} status={member.status} size={46} />
              <span class="gsv-chat-agent-crew-name">{member.name}</span>
              <span class="gsv-chat-agent-crew-status">{member.statusLabel}</span>
            </button>
          ))}
          <button
            type="button"
            class="gsv-chat-agent-crew-tile gsv-chat-agent-crew-tile-add"
            onClick={openCrew}
          >
            <AddAction variant="tile" label="NEW AGENT" />
          </button>
        </div>
      </div>
    </div>
  );
}
