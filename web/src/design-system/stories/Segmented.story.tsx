import { Segmented } from "../../app/components/ui/Segmented";
import type { Story } from "../story";

const story: Story = {
  title: "Segmented",
  group: "Forms",
  blurb: "single-select control · 2–4 segments · field label/status",
  render: () => (
    <div class="ds-grid">
      <div class="ds-cell">
        <div class="ds-label">Sizes</div>
        <div class="ds-col">
          <Segmented size="small" label="SMALL" />
          <Segmented size="medium" label="MEDIUM" />
          <Segmented size="large" label="LARGE" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Segments & value</div>
        <div class="ds-col">
          <Segmented label="TWO (l2 empty)" l0="ON" l1="OFF" l2="" value={0} />
          <Segmented label="THREE (default)" value={1} />
          <Segmented label="FOUR (l3 set)" l0="XS" l1="SM" l2="MD" l3="LG" value={3} />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">States</div>
        <div class="ds-col">
          <Segmented label="REQUIRED" requirement="required" description="Choose a permission." />
          <Segmented label="OPTIONAL" requirement="optional" />
          <Segmented label="ERROR" status="error" message="Selection required" />
          <Segmented label="SUCCESS" status="success" message="Permission set" />
          <Segmented label="INFO" status="info" message="ASK is the default" />
          <Segmented label="WARNING" status="warning" message="DENY blocks the tool" />
          <Segmented label="DISABLED" disabled />
        </div>
      </div>
    </div>
  ),
};

export default story;
