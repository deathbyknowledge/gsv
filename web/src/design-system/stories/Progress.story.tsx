import { Progress } from "../../app/components/ui/Progress";
import type { Story } from "../story";

const story: Story = {
  title: "Progress",
  group: "Feedback",
  blurb: "determinate · indeterminate · sizes · label/value",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Values</div>
        <div class="ds-col">
          <Progress value={0} label="CONTEXT" />
          <Progress value={25} label="CONTEXT" />
          <Progress value={60} label="CONTEXT" />
          <Progress value={100} label="CONTEXT" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Indeterminate</div>
        <div class="ds-col">
          <Progress indeterminate label="LOADING" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Sizes</div>
        <div class="ds-col">
          <Progress value={60} size="small" label="SMALL" />
          <Progress value={60} size="medium" label="MEDIUM" />
          <Progress value={60} size="large" label="LARGE" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Label / value</div>
        <div class="ds-col">
          <Progress value={42} label="UPLOAD" showValue />
          <Progress value={42} label="UPLOAD" showValue={false} />
          <Progress value={42} label="" showValue />
        </div>
      </div>
    </div>
  ),
};

export default story;
