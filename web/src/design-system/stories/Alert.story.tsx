import { Alert } from "../../app/components/ui/Alert";
import type { Story } from "../story";

const story: Story = {
  title: "Alert",
  group: "Feedback",
  blurb: "inline status banner · six variants · default or custom icon",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Variants</div>
        <div style={{ maxWidth: "440px", display: "flex", flexDirection: "column", gap: "12px" }}>
          <Alert
            variant="info"
            title="Heads up"
            text="There's something here worth knowing before you continue."
          />
          <Alert
            variant="attention"
            title="Action needed"
            text="Review the pending changes to finish setting things up."
          />
          <Alert
            variant="warning"
            title="Caution"
            text="This step can't be undone once you confirm it."
          />
          <Alert
            variant="neutral"
            title="Note"
            text="A quiet aside that adds a little extra context."
          />
          <Alert
            variant="success"
            title="All set"
            text="Your changes were saved and everything looks good."
          />
          <Alert
            variant="error"
            title="Something went wrong"
            text="We couldn't complete the request. Please try again."
          />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Dismissible</div>
        <div style={{ maxWidth: "440px", display: "flex", flexDirection: "column", gap: "12px" }}>
          <Alert
            variant="error"
            title="Something went wrong"
            text="We couldn't complete the request. Dismiss to clear."
            onDismiss={() => {}}
          />
          <Alert
            variant="success"
            text="Saved. This notice can be dismissed."
            onDismiss={() => {}}
          />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Icon options</div>
        <div style={{ maxWidth: "440px", display: "flex", flexDirection: "column", gap: "12px" }}>
          <Alert
            variant="info"
            title="Default icon"
            text="Uses the sensible glyph for the variant."
          />
          <Alert
            variant="info"
            icon="none"
            title="No icon"
            text="The leading glyph is suppressed entirely."
          />
          <Alert
            variant="info"
            icon={<span style={{ fontSize: "16px", color: "var(--accent)" }}>★</span>}
            title="Custom icon"
            text="Any inline node can stand in for the glyph."
          />
        </div>
      </div>
    </div>
  ),
};

export default story;
