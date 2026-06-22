import { SectionHeader } from "../../app/components/ui/SectionHeader";
import type { Story } from "../story";

const story: Story = {
  title: "SectionHeader",
  group: "Chrome",
  blurb: "header bar · accent dot · optional meta / divider",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Default</div>
        <div class="ds-row">
          <SectionHeader title="THE SHIP" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">With meta</div>
        <div class="ds-row">
          <SectionHeader title="THE SHIP" meta="4 NODES" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Divider</div>
        <div class="ds-row">
          <SectionHeader title="CREW" meta="ONLINE" divider />
        </div>
      </div>
    </div>
  ),
};

export default story;
