import { Checkbox } from "../../app/components/ui/Checkbox";
import type { Story } from "../story";

const story: Story = {
  title: "Checkbox",
  group: "Forms",
  blurb: "self-toggling box · check / indeterminate / sizes / status",
  render: () => (
    <div class="ds-grid">
      <div class="ds-cell">
        <div class="ds-label">States</div>
        <div class="ds-col">
          <Checkbox checked={false} label="UNCHECKED" />
          <Checkbox checked label="CHECKED" />
          <Checkbox indeterminate label="INDETERMINATE" />
          <Checkbox label="NO LABEL — unchecked" />
          <Checkbox checked label="" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Sizes</div>
        <div class="ds-col">
          <Checkbox size="small" checked label="SMALL" />
          <Checkbox size="medium" checked label="MEDIUM" />
          <Checkbox size="large" checked label="LARGE" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Disabled & status</div>
        <div class="ds-col">
          <Checkbox disabled label="DISABLED OFF" />
          <Checkbox disabled checked label="DISABLED ON" />
          <Checkbox checked label="WITH DESCRIPTION" description="Runs the agent without holding the foreground session." />
          <Checkbox checked={false} status="error" message="This field is required" label="ERROR" />
          <Checkbox checked status="success" message="Saved" label="SUCCESS" />
        </div>
      </div>
    </div>
  ),
};

export default story;
