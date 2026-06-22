import { Spinner } from "../../app/components/ui/Spinner";
import type { Story } from "../story";

const story: Story = {
  title: "Spinner",
  group: "Feedback",
  blurb: "rotating loading ring · sizes",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Sizes</div>
        <div class="ds-row">
          <Spinner size={12} />
          <Spinner size={18} />
          <Spinner size={22} />
          <Spinner size={32} />
          <Spinner size={48} />
        </div>
      </div>
    </div>
  ),
};

export default story;
