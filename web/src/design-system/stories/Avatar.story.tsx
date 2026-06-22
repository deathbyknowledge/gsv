import { Avatar, type AvatarStatus } from "../../app/components/ui/Avatar";
import type { Story } from "../story";

const STATUSES: AvatarStatus[] = ["online", "idle", "error", "live"];

const story: Story = {
  title: "Avatar",
  group: "Data Display",
  blurb: "agent portrait · status corner-dot",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Statuses (agent 0, size 44)</div>
        <div class="ds-row">
          {STATUSES.map((status) => (
            <span key={status} style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: "6px" }}>
              <Avatar agent={0} size={44} status={status} />
              <span style={{ fontSize: "9px", letterSpacing: "0.16em", color: "var(--text-dim)", textTransform: "uppercase" }}>
                {status}
              </span>
            </span>
          ))}
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Sizes (online)</div>
        <div class="ds-row" style={{ alignItems: "center" }}>
          <Avatar agent={0} size={28} status="online" />
          <Avatar agent={1} size={44} status="online" />
          <Avatar agent={2} size={60} status="online" />
          <Avatar agent={0} size={80} status="online" />
        </div>
      </div>
    </div>
  ),
};

export default story;
