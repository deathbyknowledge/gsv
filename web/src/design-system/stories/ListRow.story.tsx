import { ListRow } from "../../app/components/ui/ListRow";
import type { Story } from "../story";

const story: Story = {
  title: "ListRow",
  group: "Data Display",
  blurb: "status dot · label · sub · tag · chevron · active",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Status</div>
        <div class="ds-col">
          <ListRow label="<HANK-LINUX>" status="online" statusLabel="ONLINE" />
          <ListRow label="<DELL-TOWER>" status="error" statusLabel="CRASHED" />
          <ListRow label="<RPI-EDGE>" status="idle" statusLabel="OFFLINE" />
          <ListRow label="<NO-STATUS>" status="none" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Sub-label · tag · chevron</div>
        <div class="ds-col">
          <ListRow label="<HANK-LINUX>" status="online" sub="192.168.1.42 · 8 CORES" />
          <ListRow label="<DELL-TOWER>" status="online" tag="UPDATE" />
          <ListRow label="<RPI-EDGE>" status="online" statusLabel="ONLINE" chevron />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Active</div>
        <div class="ds-col">
          <ListRow label="<HANK-LINUX>" status="online" statusLabel="ONLINE" active />
        </div>
      </div>
    </div>
  ),
};

export default story;
