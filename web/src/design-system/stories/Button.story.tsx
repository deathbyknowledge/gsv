import { Button } from "../../app/components/ui/Button";
import type { Story } from "../story";

const story: Story = {
  title: "Button",
  group: "Forms",
  blurb: "primary · secondary · success · danger · dangerGhost · link",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Variants</div>
        <div class="ds-row">
          <Button variant="primary" label="SAVE" />
          <Button variant="secondary" label="CANCEL" />
          <Button variant="success" label="ADD" />
          <Button variant="danger" label="DELETE" />
          <Button variant="dangerGhost" label="REMOVE" />
          <Button variant="link" label="LEARN MORE" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Disabled</div>
        <div class="ds-row">
          <Button variant="primary" label="SAVE" disabled />
          <Button variant="secondary" label="CANCEL" disabled />
          <Button variant="success" label="ADD" disabled />
          <Button variant="danger" label="DELETE" disabled />
          <Button variant="dangerGhost" label="REMOVE" disabled />
          <Button variant="link" label="LEARN MORE" disabled />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Block</div>
        <div class="ds-col" style={{ width: "220px" }}>
          <Button variant="primary" label="SAVE" block />
          <Button variant="primary" label="SAVE A VERY LONG LABEL THAT OVERFLOWS" block />
          <Button variant="link" label="LEARN MUCH MORE ABOUT THIS LONG TOPIC" block />
        </div>
      </div>
    </div>
  ),
};

export default story;
