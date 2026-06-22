import { ObjectDetail } from "../templates/ObjectDetail";
import type { Story } from "../story";

const story: Story = {
  title: "Object detail",
  group: "Templates",
  blurb: "console page · breadcrumb · object header · details + activity",
  render: () => (
    <div class="ds-template-frame">
      <ObjectDetail />
    </div>
  ),
};

export default story;
