import { AgentCard } from "../../../components/ui/AgentCard";
import { Avatar } from "../../../components/ui/Avatar";
import { Icon } from "../../../components/ui/Icon";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import type { ChatAgentViewModel } from "../domain/agent";

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

  const selectAgent = (agentId: string, active: boolean) => {
    if (active) {
      return;
    }
    if (onSelectAgent) {
      onSelectAgent(agentId);
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
              onClick={() => selectAgent(member.id, member.active)}
            >
              <Avatar src={member.imageSrc} status={member.status} size={46} />
              <span class="gsv-chat-agent-crew-name">{member.name}</span>
              <span class="gsv-chat-agent-crew-role">{member.role}</span>
              <span class="gsv-chat-agent-crew-status">{member.statusLabel}</span>
            </button>
          ))}
        </div>
        <button type="button" class="gsv-chat-agent-open-crew" onClick={openCrew}>
          <Icon name="chat" size={14} />
          <span>OPEN CREW</span>
        </button>
      </div>
    </div>
  );
}
