import { AgentEditor } from "../../app/components/ui/AgentEditor";
import type { Story } from "../story";

const story: Story = {
  title: "Agent Editor",
  group: "Composite",
  blurb: "agent authoring surface · GENERAL/FILES/TASKS tabs · composes TextInput/TextArea/Select/Segmented/Button",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Manage (existing agent)</div>
        <AgentEditor mode="manage" containerWidth={1100} avatarSrc="img/agent-0.png" />
      </div>
      <div class="ds-cell">
        <div class="ds-label">New (create agent)</div>
        <AgentEditor mode="new" containerWidth={1100} avatarSrc="img/agent-1.png" />
      </div>
    </div>
  ),
};

export default story;
