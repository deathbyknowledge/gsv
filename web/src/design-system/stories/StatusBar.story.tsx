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
    </div>
  ),
};

export default story;
