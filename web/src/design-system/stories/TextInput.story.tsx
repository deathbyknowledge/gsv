import { TextInput } from "../../app/components/ui/TextInput";
import type { Story } from "../story";

const story: Story = {
  title: "TextInput",
  group: "Forms",
  blurb: "bordered field · label / desc / status / counter / affix",
  render: () => (
    <div class="ds-grid">
      <div class="ds-cell">
        <div class="ds-label">Sizes</div>
        <div class="ds-col">
          <TextInput size="small" label="SMALL" placeholder="small field" />
          <TextInput size="medium" label="MEDIUM" placeholder="medium field" />
          <TextInput size="large" label="LARGE" placeholder="agent name" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Status</div>
        <div class="ds-col">
          <TextInput label="ERROR" status="error" message="Name already taken" value="Primary Agent" />
          <TextInput label="SUCCESS" status="success" message="Looks good" value="Bob" />
          <TextInput label="INFO" status="info" message="Lowercase recommended" value="agent" />
          <TextInput label="WARNING" status="warning" message="Will be truncated" value="A very long name" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">States & extras</div>
        <div class="ds-col">
          <TextInput label="WITH INFO" info="A short help tooltip shown on the ? after the label." placeholder="hover the ?" />
          <TextInput label="REQUIRED" requirement="required" description="Shown above the field." placeholder="role" />
          <TextInput label="OPTIONAL" requirement="optional" placeholder="nickname" />
          <TextInput label="WITH COUNTER" maxLength={24} value="hello" />
          <TextInput label="PREFIX / SUFFIX" prefix="@" suffix=".gsv" value="captain" />
          <TextInput label="CLEARABLE" clearable value="clear me" />
          <TextInput label="PASSWORD" type="password" value="secret" />
          <TextInput label="READONLY" readonly value="locked value" />
          <TextInput label="DISABLED" disabled value="disabled value" />
        </div>
      </div>
    </div>
  ),
};

export default story;
