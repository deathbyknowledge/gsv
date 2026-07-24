import { Tile } from "../../app/components/ui/Tile";
import type { Story } from "../story";

const story: Story = {
  title: "Tile",
  group: "Data Display",
  blurb: "96px object tile · glyph · corner status dot (hover for its meaning) · selected · anchor",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Glyphs</div>
        <div class="ds-row">
          <Tile label="MACHINES" glyph="machines" />
          <Tile label="MESSENGERS" glyph="messengers" />
          <Tile label="INTEGRATIONS" glyph="integrations" />
          <Tile label="APPLICATIONS" glyph="applications" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Status</div>
        <div class="ds-row">
          <Tile label="ONLINE" status="online" />
          <Tile label="ERROR" status="error" />
          <Tile label="IDLE" status="idle" />
          <Tile label="WARN" status="warn" />
          <Tile label="LIVE" status="live" />
          <Tile label="UPDATE" status="update" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Selected</div>
        <div class="ds-row">
          <Tile label="MACHINES" glyph="machines" selected />
          <Tile label="INTEGRATIONS" glyph="integrations" selected status="live" />
          <Tile label="SELECTOR" glyph="machines" selected status="accent" statusHint="Select MAC" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Anchor</div>
        <div class="ds-row">
          <Tile label="GSV" anchor />
        </div>
      </div>
    </div>
  ),
};

export default story;
