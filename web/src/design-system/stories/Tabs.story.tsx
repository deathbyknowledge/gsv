import { Tabs } from "../../app/components/ui/Tabs";
import type { Story } from "../story";

const story: Story = {
  title: "Tabs",
  group: "Chrome",
  blurb: "chamfered tab rail · continuous glowing top edge",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Default (first selected)</div>
        <div style={{ width: 540 }}>
          <Tabs tabs={["GENERAL", "FILES", "TASKS"]} value={0} />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Middle selected</div>
        <div style={{ width: 540 }}>
          <Tabs tabs={["GENERAL", "FILES", "TASKS"]} value={1} />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Last selected · more tabs</div>
        <div style={{ width: 540 }}>
          <Tabs tabs={["OVERVIEW", "LOGS", "CONFIG", "AUDIT"]} value={3} />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Narrow (&lt; 720px)</div>
        <div style={{ width: 420 }}>
          <Tabs tabs={["GENERAL", "FILES", "TASKS"]} value={0} width={420} />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Uncontrolled (click to switch)</div>
        <div style={{ width: 540 }}>
          <Tabs tabs={["GENERAL", "FILES", "TASKS"]} />
        </div>
      </div>
    </div>
  ),
};

export default story;
