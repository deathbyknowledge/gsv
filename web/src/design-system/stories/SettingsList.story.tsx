import { SettingsList } from "../templates/SettingsList";
import type { Story } from "../story";

const story: Story = {
  title: "List page",
  group: "Templates",
  blurb: "single-category object list · MACHINES · console page",
  render: () => (
    <div class="ds-template-frame">
      <SettingsList />
    </div>
  ),
};

export default story;
