import { AddAction } from "../../app/components/ui/AddAction";
import type { Story } from "../story";

const story: Story = {
  title: "AddAction",
  group: "Chrome",
  blurb: "dashed add affordance · row · tile",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Row</div>
        <div class="ds-col">
          <AddAction variant="row" label="CONNECT NEW MACHINE" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Tile</div>
        <div class="ds-row">
          <AddAction variant="tile" label="NEW AGENT" />
        </div>
      </div>
    </div>
  ),
};

export default story;
