import { AgentCard } from "../../../components/ui/AgentCard";
import { CrewAddTile, CrewTile } from "../../../components/ui/CrewTile";
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
            <CrewTile
              active={member.active}
              imageSrc={member.imageSrc}
              key={member.id}
              name={member.name}
              onClick={member.active ? undefined : () => selectAgent(member)}
              statusLabel={member.statusLabel}
              tone={member.status}
            />
          ))}
          <CrewAddTile label="NEW AGENT" onClick={openCrew} />
        </div>
      </div>
    </div>
  );
}
