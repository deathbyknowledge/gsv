import { ControlPanelCall } from "../../app/components/ui/ControlPanelCall";
import type { Story } from "../story";

const story: Story = {
  title: "ControlPanelCall",
  group: "Composite",
  blurb: "open-terminal CTA · collapsed-chat size · glowing terminal glyph",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Default (opens the terminal)</div>
        <ControlPanelCall onOpen={() => {}} />
      </div>
      <div class="ds-cell">
        <div class="ds-label">Disabled (no handler)</div>
        <ControlPanelCall />
      </div>
    </div>
  ),
};

export default story;
