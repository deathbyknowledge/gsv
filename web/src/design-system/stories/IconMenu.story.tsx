import { IconMenu } from "../../app/components/ui/IconMenu";
import type { Story } from "../story";

const story: Story = {
  title: "IconMenu",
  group: "Chrome",
  blurb: "control popover · live dot · FILES / LIBRARY / TERMINAL / SETTINGS grid",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Default</div>
        <div class="ds-row">
          <IconMenu />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Custom title</div>
        <div class="ds-row">
          <IconMenu title="GSV // SYSTEMS" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Narrow (width 300)</div>
        <div class="ds-row">
          <IconMenu width={300} />
        </div>
      </div>
    </div>
  ),
};

export default story;
