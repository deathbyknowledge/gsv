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
          <ListRow label="PRIMARY NODE" status="online" statusLabel="ONLINE" />
          <ListRow label="STREAM NODE" status="live" statusLabel="LIVE" />
          <ListRow label="PATCH NODE" status="update" statusLabel="UPDATE READY" />
          <ListRow label="SPILL NODE" status="warn" statusLabel="DEGRADED" />
          <ListRow label="BUILD NODE" status="error" statusLabel="CRASHED" />
          <ListRow label="EDGE NODE" status="idle" statusLabel="OFFLINE" />
          <ListRow label="<NO-STATUS>" status="none" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Sub-label · tag · chevron (hover a clickable row to reveal the arrow)</div>
        <div class="ds-col">
          <ListRow label="PRIMARY NODE" status="online" sub="192.168.1.42 · 8 CORES" />
          <ListRow label="BUILD NODE" status="online" tag="UPDATE" />
          <ListRow label="EDGE NODE" status="online" statusLabel="ONLINE" chevron onClick={() => {}} />
          <ListRow label="LAST SEEN" labelInfo="Explains what this field means on hover." status="none" sub="2m ago" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Leading node · chevron label (hover)</div>
        <div class="ds-col">
          <ListRow
            leading={
              <span
                style={{
                  width: "30px",
                  height: "30px",
                  borderRadius: "3px",
                  background: "#171436",
                  border: "1px solid var(--border)",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--accent)",
                  fontFamily: "var(--gsv-font-mono)",
                  fontSize: "12px",
                }}
              >
                SA
              </span>
            }
            label="SALETE"
            status="idle"
            statusLabel="IDLE"
            statusDotPlacement="trailing"
            chevron
            chevronLabel="SWITCH AGENT"
            onClick={() => {}}
          />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Icon · tag tone</div>
        <div class="ds-col">
          <ListRow label="PRIMARY NODE" icon="computer" status="online" sub="COMPUTE HOST" />
          <ListRow label="RELAY NODE" icon="satellite" status="live" tag="LIVE" tagTone="online" />
          <ListRow label="EDGE NODE" icon="terminal" status="warn" tag="WARN" tagTone="warn" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Status dot placement (leading · trailing)</div>
        <div class="ds-col">
          <ListRow label="LEADING DOT" status="online" statusLabel="ONLINE" statusDotPlacement="leading" />
          <ListRow label="TRAILING DOT" status="online" statusLabel="ONLINE" statusDotPlacement="trailing" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Active</div>
        <div class="ds-col">
          <ListRow label="PRIMARY NODE" status="online" statusLabel="ONLINE" active />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Density (default · compact — tighter rows for popover lists)</div>
        <div class="ds-col">
          <ListRow label="STREAM NODE" status="live" statusLabel="LIVE" />
          <ListRow label="STREAM NODE" status="live" statusLabel="LIVE" density="compact" />
          <ListRow label="INDEX REBUILD" status="live" statusLabel="CURRENT" density="compact" active onClick={() => {}} />
          <ListRow label="LOG SHIP" icon="terminal" status="error" statusLabel="ERROR" density="compact" onClick={() => {}} />
        </div>
      </div>
    </div>
  ),
};

export default story;
