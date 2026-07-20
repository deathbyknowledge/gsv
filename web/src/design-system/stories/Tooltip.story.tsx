import { Hint, Tooltip } from "../../app/components/ui/Tooltip";
import { IconButton } from "../../app/components/ui/IconButton";
import type { Story } from "../story";

const story: Story = {
  title: "Tooltip",
  group: "Feedback",
  blurb: "dashed trigger · black bubble · eight positions · bare-trigger + Hint wrapper",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Sides</div>
        <div class="ds-row" style={{ gap: "48px", padding: "32px 0" }}>
          <Tooltip trigger="TOP" text="A short hint about this control." position="top" />
          <Tooltip trigger="BOTTOM" text="A short hint about this control." position="bottom" />
          <Tooltip trigger="LEFT" text="A short hint about this control." position="left" />
          <Tooltip trigger="RIGHT" text="A short hint about this control." position="right" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Start / end alignment</div>
        <div class="ds-row" style={{ gap: "48px", padding: "32px 0" }}>
          <Tooltip trigger="TOP-START" text="Aligned to the trigger's start edge." position="top-start" />
          <Tooltip trigger="TOP-END" text="Aligned to the trigger's end edge." position="top-end" />
          <Tooltip trigger="BOTTOM-START" text="Aligned to the trigger's start edge." position="bottom-start" />
          <Tooltip trigger="BOTTOM-END" text="Aligned to the trigger's end edge." position="bottom-end" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Bare trigger (children replace the dashed hint)</div>
        <div class="ds-row" style={{ gap: "48px", padding: "16px 0" }}>
          <Tooltip text="Bare content keeps its own styling; only the reveal + help cursor remain." position="top">
            <strong style={{ color: "var(--accent)" }}>CUSTOM TRIGGER</strong>
          </Tooltip>
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Hint wrapper (attaches bubble to an existing control)</div>
        <div class="ds-row" style={{ gap: "48px", padding: "16px 0" }}>
          <Hint text="Refresh the fleet" position="top">
            <IconButton glyph="refresh" ariaLabel="Refresh" />
          </Hint>
          <Hint text="Open in a new tab" position="bottom">
            <IconButton glyph="newTab" ariaLabel="Open in new tab" />
          </Hint>
        </div>
      </div>
    </div>
  ),
};

export default story;
