import { AgentDetail } from "../templates/AgentDetail";
import type { Story } from "../story";

const story: Story = {
  title: "Detail page (agent)",
  group: "Templates",
  blurb: "canonical detail-page template · breadcrumb header + framed AgentEditor (General/Files/Tasks)",
  render: () => (
    <div class="ds-template-frame">
      <AgentDetail />
    </div>
  ),
};

export default story;
