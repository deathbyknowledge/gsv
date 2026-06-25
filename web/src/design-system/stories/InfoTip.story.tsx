import { InfoTip } from "../../app/components/ui/InfoTip";
import type { Story } from "../story";

const story: Story = {
  title: "InfoTip",
  group: "Feedback",
  blurb: "borderless help icon · reveals a hint on hover/focus",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">After a label</div>
        <div class="ds-row" style={{ alignItems: "center", gap: "6px" }}>
          <span
            style={{
              fontFamily: "var(--gsv-font-mono)",
              fontSize: "11px",
              letterSpacing: "0.32em",
              textTransform: "uppercase",
              color: "var(--label)",
            }}
          >
            Admin security
          </span>
          <InfoTip text="eg, deleting files, adding or removing users" position="top" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Positions</div>
        <div class="ds-row" style={{ gap: "30px" }}>
          <InfoTip text="Opens on top" position="top" />
          <InfoTip text="Opens on the right" position="right" />
          <InfoTip text="Opens on the bottom" position="bottom" />
          <InfoTip text="Opens on the left" position="left" />
        </div>
      </div>
    </div>
  ),
};

export default story;
