import { CrewPage } from "../templates/CrewPage";
import type { Story } from "../story";

const story: Story = {
  title: "Crew page",
  group: "Templates",
  blurb: "console crew roster · breadcrumb bar · responsive AgentCard grid + NEW AGENT tile",
  render: () => (
    <div class="ds-template-frame">
      <CrewPage />
    </div>
  ),
};

export default story;
