import { StatusDot, type StatusTone } from "../../app/components/ui/StatusDot";
import type { Story } from "../story";

const TONES: StatusTone[] = ["online", "error", "idle", "update", "live", "warn"];

const story: Story = {
  title: "StatusDot",
  group: "Feedback",
  blurb: "online · error · idle · update · live · warn",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Tones (size 10)</div>
        <div class="ds-row">
          {TONES.map((tone) => (
            <span key={tone} style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
              <StatusDot tone={tone} size={10} />
              <span class="gsv-sublabel" style={{ letterSpacing: "0.16em", color: "var(--text-dim)", textTransform: "uppercase" }}>
                {tone}
              </span>
            </span>
          ))}
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Sizes (online)</div>
        <div class="ds-row">
          {[6, 8, 10, 14, 20].map((size) => (
            <StatusDot key={size} tone="online" size={size} />
          ))}
        </div>
      </div>
    </div>
  ),
};

export default story;
