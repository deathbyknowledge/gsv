import { Toggle } from "../../app/components/ui/Toggle";
import type { Story } from "../story";

const story: Story = {
  title: "Toggle",
  group: "Forms",
  blurb: "self-toggling switch · on / off / sizes / status",
  render: () => (
    <div class="ds-grid">
      <div class="ds-cell">
        <div class="ds-label">States</div>
        <div class="ds-col">
          <Toggle on={false} label="OFF" />
          <Toggle on label="ON" />
          <Toggle on label="" />
          <Toggle on={false} label="" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Sizes</div>
        <div class="ds-col">
          <Toggle size="small" on label="SMALL" />
          <Toggle size="medium" on label="MEDIUM" />
          <Toggle size="large" on label="LARGE" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Disabled, desc & status</div>
        <div class="ds-col">
          <Toggle disabled label="DISABLED OFF" />
          <Toggle disabled on label="DISABLED ON" />
          <Toggle on label="WITH DESCRIPTION" description="Keeps the agent running after you close the session." />
          <Toggle on={false} status="error" message="Could not enable" label="ERROR" />
          <Toggle on status="success" message="Enabled" label="SUCCESS" />
        </div>
      </div>
    </div>
  ),
};

export default story;
