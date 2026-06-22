import { Select } from "../../app/components/ui/Select";
import type { Story } from "../story";

const story: Story = {
  title: "Select",
  group: "Forms",
  blurb: "custom dropdown · options array · outside-click close",
  render: () => (
    <div class="ds-grid">
      <div class="ds-cell">
        <div class="ds-label">Sizes</div>
        <div class="ds-col">
          <Select size="small" label="SMALL" />
          <Select size="medium" label="MEDIUM" />
          <Select size="large" label="LARGE" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Options & value</div>
        <div class="ds-col">
          <Select label="DEFAULT (o0/o1/o2)" />
          <Select label="OPTIONS ARRAY" options={["RED", "GREEN", "BLUE", "AMBER"]} value={2} />
          <Select label="PRESELECTED" value={1} />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">States</div>
        <div class="ds-col">
          <Select label="REQUIRED" requirement="required" description="Pick a model." />
          <Select label="OPTIONAL" requirement="optional" />
          <Select label="ERROR" status="error" message="Selection required" />
          <Select label="SUCCESS" status="success" message="Good choice" />
          <Select label="INFO" status="info" message="Defaults to NEMOTRON 3" />
          <Select label="WARNING" status="warning" message="May be slow" />
          <Select label="DISABLED" disabled />
        </div>
      </div>
    </div>
  ),
};

export default story;
