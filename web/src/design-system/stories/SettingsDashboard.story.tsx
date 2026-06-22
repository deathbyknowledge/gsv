import { SettingsDashboard } from "../templates/SettingsDashboard";
import type { Story } from "../story";

const story: Story = {
  title: "Settings dashboard",
  group: "Templates",
  blurb: "The Ship · console page · object categories · status rows",
  render: () => (
    <div class="ds-template-frame">
      <SettingsDashboard />
    </div>
  ),
};

export default story;
