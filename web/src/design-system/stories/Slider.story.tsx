import { Slider } from "../../app/components/ui/Slider";
import type { Story } from "../story";

const story: Story = {
  title: "Slider",
  group: "Forms",
  blurb: "draggable value track · label / value / status",
  render: () => (
    <div class="ds-grid">
      <div class="ds-cell">
        <div class="ds-label">Value positions</div>
        <div class="ds-col">
          <Slider label="EMPTY" value={0} />
          <Slider label="QUARTER" value={25} />
          <Slider label="HALF" value={50} />
          <Slider label="FULL" value={100} />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">States</div>
        <div class="ds-col">
          <Slider label="NO VALUE READOUT" showValue={false} value={60} />
          <Slider label="REQUIRED" requirement="required" value={40} />
          <Slider label="OPTIONAL" requirement="optional" value={40} />
          <Slider
            label="WITH DESCRIPTION"
            description="Higher values increase randomness of output."
            value={70}
          />
          <Slider label="DISABLED" disabled value={30} />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Status</div>
        <div class="ds-col">
          <Slider label="ERROR" status="error" message="Out of safe range" value={95} />
          <Slider label="SUCCESS" status="success" message="Optimal" value={50} />
          <Slider label="INFO" status="info" message="Default is 40" value={40} />
          <Slider label="WARNING" status="warning" message="High creativity" value={85} />
        </div>
      </div>
    </div>
  ),
};

export default story;
