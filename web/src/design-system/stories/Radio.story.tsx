import { Radio } from "../../app/components/ui/Radio";
import type { Story } from "../story";

const story: Story = {
  title: "Radio",
  group: "Forms",
  blurb: "self-selecting group · option set / sizes / label / status",
  render: () => (
    <div class="ds-grid">
      <div class="ds-cell">
        <div class="ds-label">Option set</div>
        <div class="ds-col">
          <Radio o0="ALLOW" o1="ASK" o2="DENY" value={0} />
          <Radio o0="READ" o1="WRITE" o2="ADMIN" o3="OWNER" value={1} label="PERMISSION" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Sizes</div>
        <div class="ds-col">
          <Radio size="small" value={0} />
          <Radio size="medium" value={1} />
          <Radio size="large" value={2} />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Label, desc & status</div>
        <div class="ds-col">
          <Radio label="" value={0} />
          <Radio label="MODE" requirement="required" value={0} />
          <Radio label="MODE" requirement="optional" description="Choose how the agent handles tool calls." value={1} />
          <Radio label="MODE" status="error" message="Selection required" value={0} />
          <Radio label="MODE" status="success" message="Locked in" value={2} />
          <Radio label="MODE" status="info" message="ASK is the default" value={1} />
          <Radio label="MODE" status="warning" message="DENY blocks all tools" value={2} />
          <Radio disabled value={1} />
        </div>
      </div>
    </div>
  ),
};

export default story;
