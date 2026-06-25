import { Stepper } from "../../app/components/ui/Stepper";
import type { Story } from "../story";

const story: Story = {
  title: "Stepper",
  group: "Forms",
  blurb: "step / wizard indicator · numbered dots / labels / sizes",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Sizes</div>
        <div class="ds-col">
          <Stepper size="small" count={4} current={1} />
          <Stepper size="medium" count={4} current={1} />
          <Stepper size="large" count={4} current={1} />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Progress</div>
        <div class="ds-col">
          <Stepper count={5} current={0} />
          <Stepper count={5} current={2} />
          <Stepper count={5} current={4} />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">With labels</div>
        <div class="ds-col">
          <Stepper
            current={2}
            l0="CONFIG"
            l1="BUILD"
            l2="DEPLOY"
            l3="VERIFY"
            l4="DONE"
            width={520}
          />
        </div>
      </div>
    </div>
  ),
};

export default story;
