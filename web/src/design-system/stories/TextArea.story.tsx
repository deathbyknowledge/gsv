import { TextArea } from "../../app/components/ui/TextArea";
import type { Story } from "../story";

const story: Story = {
  title: "TextArea",
  group: "Forms",
  blurb: "multi-line field · label / desc / status / counter",
  render: () => (
    <div class="ds-grid">
      <div class="ds-cell">
        <div class="ds-label">Sizes</div>
        <div class="ds-col">
          <TextArea size="small" label="SMALL" placeholder="small field" />
          <TextArea size="medium" label="MEDIUM" placeholder="medium field" />
          <TextArea size="large" label="LARGE" placeholder="large field" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Status</div>
        <div class="ds-col">
          <TextArea label="ERROR" status="error" message="Description required" value="" />
          <TextArea label="SUCCESS" status="success" message="Looks good" value="A helpful agent." />
          <TextArea label="INFO" status="info" message="Keep it brief" value="Some text" />
          <TextArea label="WARNING" status="warning" message="Getting long" value="A longer description here" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">States & extras</div>
        <div class="ds-col">
          <TextArea label="REQUIRED" requirement="required" description="Shown above the field." placeholder="describe" />
          <TextArea label="OPTIONAL" requirement="optional" placeholder="describe" />
          <TextArea label="WITH COUNTER" maxLength={120} value="hello world" />
          <TextArea label="ROWS=6" rows={6} value="more vertical space" />
          <TextArea label="READONLY" readonly value="locked description value" />
          <TextArea label="DISABLED" disabled value="disabled description value" />
        </div>
      </div>
    </div>
  ),
};

export default story;
