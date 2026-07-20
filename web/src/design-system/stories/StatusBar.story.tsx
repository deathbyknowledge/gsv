import { StatusBar } from "../../app/components/ui/StatusBar";
import type { Story } from "../story";

const story: Story = {
  title: "StatusBar",
  group: "Chrome",
  blurb: "system strip · online · model / context · clock / power",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Default</div>
        <div class="ds-row" style={{ width: "760px", maxWidth: "100%" }}>
          <StatusBar />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Custom values</div>
        <div class="ds-row" style={{ width: "760px", maxWidth: "100%" }}>
          <StatusBar model="DEFAULT MODEL" context="CTX 92%" clock="03:14:00" power="2 RUNS" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Status tones (statusLabel / statusTone)</div>
        <div class="ds-col" style={{ width: "760px", maxWidth: "100%" }}>
          <StatusBar statusLabel="GSV ONLINE" statusTone="online" />
          <StatusBar statusLabel="SYNCING" statusTone="loading" />
          <StatusBar statusLabel="GSV OFFLINE" statusTone="offline" />
          <StatusBar statusLabel="LINK FAULT" statusTone="error" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Hide model / status (showModel · showStatus)</div>
        <div class="ds-col" style={{ width: "760px", maxWidth: "100%" }}>
          <StatusBar showModel={false} />
          <StatusBar showStatus={false} />
          <StatusBar showModel={false} showStatus={false} />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Alignment (align: center · between)</div>
        <div class="ds-col" style={{ width: "760px", maxWidth: "100%" }}>
          <StatusBar align="center" />
          <StatusBar label="GENERAL SYSTEMS VEHICLE · SECURE TERMINAL" align="between" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Custom label (centered)</div>
        <div class="ds-row" style={{ width: "760px", maxWidth: "100%" }}>
          <StatusBar label="GENERAL SYSTEMS VEHICLE · SECURE TERMINAL" />
        </div>
      </div>
    </div>
  ),
};

export default story;
