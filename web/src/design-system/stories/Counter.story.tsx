import { Counter } from "../../app/components/ui/Counter";
import type { Story } from "../story";

const story: Story = {
  title: "Counter",
  group: "Forms",
  blurb: "−/+ numeric stepper · unit / sizes / status",
  render: () => (
    <div class="ds-grid">
      <div class="ds-cell">
        <div class="ds-label">Sizes</div>
        <div class="ds-row">
          <Counter size="small" value={2} />
          <Counter size="medium" value={4} />
          <Counter size="large" value={6} />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Value positions</div>
        <div class="ds-row">
          <Counter value={0} />
          <Counter value={10} />
          <Counter value={50} />
          <Counter value={100} />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">States & extras</div>
        <div class="ds-col">
          <Counter label="REPLICAS" value={3} unit="x" step={1} />
          <Counter label="MEMORY" value={4} unit="GB" min={1} max={64} step={2} />
          <Counter label="REQUIRED" requirement="required" value={1} />
          <Counter
            label="WITH DESCRIPTION"
            description="Number of parallel workers to spin up."
            value={4}
          />
          <Counter label="ERROR" status="error" message="Exceeds quota" value={100} />
          <Counter label="SUCCESS" status="success" message="Within limits" value={8} />
          <Counter label="DISABLED" disabled value={5} />
        </div>
      </div>
    </div>
  ),
};

export default story;
