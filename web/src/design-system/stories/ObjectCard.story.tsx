import { ObjectCard } from "../../app/components/ui/ObjectCard";
import { Icon } from "../../app/components/ui/Icon";
import type { Story } from "../story";

const story: Story = {
  title: "ObjectCard",
  group: "Data Display",
  blurb: "object dialog card · header icon + name + status · type · blurb",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Glyph fallback</div>
        <div class="ds-row">
          <ObjectCard
            label="PRIMARY NODE"
            type="COMPUTE HOST"
            glyph="machines"
            status="online"
            blurb="Primary Linux box. Runs heavy jobs and background tasks for the crew."
          />
          <ObjectCard
            label="DISCORD"
            type="MESSENGER"
            glyph="messengers"
            status="live"
            blurb="Bridges crew chat into the GSV. Relays mentions and DMs."
          />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Status</div>
        <div class="ds-row">
          <ObjectCard label="BUILD NODE" type="COMPUTE HOST" status="error" blurb="Lost contact 4m ago. Last heartbeat failed." />
          <ObjectCard label="EDGE NODE" type="EDGE NODE" status="idle" blurb="Powered down overnight. Wakes on schedule." />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Pre-built icon node</div>
        <div class="ds-row">
          <ObjectCard
            label="GMAIL"
            type="INTEGRATION"
            status="online"
            icon={<Icon name="gmail" size={20} color="var(--accent-bright)" />}
            blurb="Reads and sends mail on behalf of the crew. OAuth scope: send + read."
          />
        </div>
      </div>
    </div>
  ),
};

export default story;
