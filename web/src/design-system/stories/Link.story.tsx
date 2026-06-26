import { Link } from "../../app/components/ui/Link";
import type { Story } from "../story";

const story: Story = {
  title: "Link",
  group: "Chrome",
  blurb: "text link · real <a href> · external / internal · arrow variant",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">External (opens in new tab)</div>
        <div class="ds-row">
          <Link href="https://example.com">Open BotFather</Link>
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">With arrow</div>
        <div class="ds-row">
          <Link href="https://example.com" arrow>Read the docs</Link>
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Internal route</div>
        <div class="ds-row">
          <Link href="/settings" external={false}>Go to settings</Link>
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Inline in prose</div>
        <div class="ds-row" style={{ maxWidth: "420px", lineHeight: 1.7 }}>
          Generate a token, then{" "}
          <Link href="https://example.com" arrow>find help here</Link>{" "}
          if you get stuck.
        </div>
      </div>
    </div>
  ),
};

export default story;
