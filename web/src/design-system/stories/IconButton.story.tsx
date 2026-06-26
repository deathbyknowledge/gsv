import { IconButton, type IconButtonGlyph } from "../../app/components/ui/IconButton";
import type { Story } from "../story";

const GLYPHS: IconButtonGlyph[] = ["back", "arrowBack", "menu", "max", "min", "close", "plus", "help", "attention", "refresh", "newTab"];

const story: Story = {
  title: "IconButton",
  group: "Chrome",
  blurb: "back · arrowBack · menu · max · min · close · plus · help · attention · refresh · newTab",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Glyphs</div>
        <div class="ds-row">
          {GLYPHS.map((g) => (
            <IconButton key={g} glyph={g} title={g} />
          ))}
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Sizes</div>
        <div class="ds-row">
          <IconButton glyph="menu" size="small" />
          <IconButton glyph="menu" size="medium" />
          <IconButton glyph="menu" size="large" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Disabled</div>
        <div class="ds-row">
          {GLYPHS.map((g) => (
            <IconButton key={g} glyph={g} disabled />
          ))}
        </div>
      </div>
    </div>
  ),
};

export default story;
