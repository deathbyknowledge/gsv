import { IconButton, type IconButtonGlyph } from "../../app/components/ui/IconButton";
import type { Story } from "../story";

const GLYPHS: IconButtonGlyph[] = ["back", "arrowBack", "menu", "max", "min", "close", "plus", "help", "attention", "refresh", "newTab", "attach", "transcribe", "mic", "send", "stop", "sidepanel"];

const story: Story = {
  title: "IconButton",
  group: "Chrome",
  blurb: "back · arrowBack · menu · max · min · close · plus · help · attention · refresh · newTab · attach · transcribe · mic · send · stop · sidepanel",
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
      <div class="ds-cell">
        <div class="ds-label">Floating — borderless, glyph-only (hover to brighten)</div>
        <div class="ds-row">
          {GLYPHS.map((g) => (
            <IconButton key={g} glyph={g} variant="floating" title={g} />
          ))}
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Floating · sizes</div>
        <div class="ds-row">
          <IconButton glyph="send" variant="floating" size="small" />
          <IconButton glyph="send" variant="floating" size="medium" />
          <IconButton glyph="send" variant="floating" size="large" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Floating · disabled</div>
        <div class="ds-row">
          {GLYPHS.map((g) => (
            <IconButton key={g} glyph={g} variant="floating" disabled />
          ))}
        </div>
      </div>
    </div>
  ),
};

export default story;
