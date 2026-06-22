import { Tooltip } from "../../app/components/ui/Tooltip";
import type { Story } from "../story";

const story: Story = {
  title: "Tooltip",
  group: "Feedback",
  blurb: "dashed trigger · black bubble · four positions",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Positions</div>
        <div class="ds-row" style={{ gap: "48px", padding: "32px 0" }}>
          <Tooltip trigger="TOP" text="A short hint about this control." position="top" />
          <Tooltip trigger="BOTTOM" text="A short hint about this control." position="bottom" />
          <Tooltip trigger="LEFT" text="A short hint about this control." position="left" />
          <Tooltip trigger="RIGHT" text="A short hint about this control." position="right" />
        </div>
      </div>
    </div>
  ),
};

export default story;
