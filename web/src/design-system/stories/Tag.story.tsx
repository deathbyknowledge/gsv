import { Tag, type TagTone } from "../../app/components/ui/Tag";
import type { Story } from "../story";

const TONES: TagTone[] = ["update", "online", "error", "warn", "info", "accent", "idle"];

const story: Story = {
  title: "Tag",
  group: "Feedback",
  blurb: "badge · boxed / plain · optional dot",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Plain</div>
        <div class="ds-row">
          {TONES.map((tone) => (
            <Tag key={tone} tone={tone} label={tone.toUpperCase()} dot />
          ))}
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Boxed</div>
        <div class="ds-row">
          {TONES.map((tone) => (
            <Tag key={tone} tone={tone} label={tone.toUpperCase()} boxed />
          ))}
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Pulsing dot (in progress)</div>
        <div class="ds-row">
          {(["info", "online", "error"] as TagTone[]).map((tone) => (
            <Tag key={tone} tone={tone} label={tone.toUpperCase()} dot pulse />
          ))}
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Boxed + dot (medium)</div>
        <div class="ds-row">
          {TONES.map((tone) => (
            <Tag key={tone} tone={tone} label={tone.toUpperCase()} boxed dot size="medium" />
          ))}
        </div>
      </div>
    </div>
  ),
};

export default story;
