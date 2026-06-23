import { AgentCard } from "../../../components/ui/AgentCard";
import { Avatar } from "../../../components/ui/Avatar";
import { CrewAddTile } from "../../../components/ui/CrewTile";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import type { ChatAgentCrewView, ChatAgentViewModel } from "../domain/agent";

type ActiveAgentPanelProps = {
  agent: ChatAgentViewModel;
  onClose: () => void;
  onOpenCrew: () => void;
  onSelectAgent?: (agentId: string) => void;
};

function ChatAgentCrewTile({
  member,
  onClick,
}: {
  member: ChatAgentCrewView;
  onClick?: () => void;
}) {
  const content = (
    <>
      <Avatar src={member.imageSrc} status={member.status} size={50} />
      <strong>{member.name}</strong>
      <span>{member.statusLabel}</span>
    </>
  );

  return onClick ? (
    <button type="button" class="gsv-chat-agent-crew-tile" onClick={onClick}>
      {content}
    </button>
  ) : (
    <div class="gsv-chat-agent-crew-tile is-active" aria-current="true">
      {content}
    </div>
  );
}

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
          initialModel={agent.modelValue}
          initialPermission={agent.permission}
          modelIsDefault={agent.modelIsDefault}
          tasksTotal={agent.tasksTotal}
          active
          showActions
          models={agent.modelOptions}
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
            <ChatAgentCrewTile
              key={member.id}
              member={member}
              onClick={member.active ? undefined : () => selectAgent(member)}
            />
          ))}
          <CrewAddTile className="gsv-chat-agent-crew-add" label="NEW AGENT" onClick={openCrew} />
        </div>
      </div>
    </div>
  );
}
