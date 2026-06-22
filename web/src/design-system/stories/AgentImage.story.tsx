import { AgentImage } from "../../app/components/ui/AgentImage";
import type { Story } from "../story";

const story: Story = {
  title: "AgentImage",
  group: "Data Display",
  blurb: "pixel crew portrait · size buckets",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Crew (size 50)</div>
        <div class="ds-row">
          <AgentImage agent={0} size={50} />
          <AgentImage agent={1} size={50} />
          <AgentImage agent={2} size={50} />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Sizes (agent 0)</div>
        <div class="ds-row" style={{ alignItems: "center" }}>
          {[28, 44, 50, 60, 80].map((size) => (
            <AgentImage key={size} agent={0} size={size} />
          ))}
        </div>
      </div>
    </div>
  ),
};

export default story;
