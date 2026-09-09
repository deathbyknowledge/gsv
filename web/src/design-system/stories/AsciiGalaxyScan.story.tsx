import { AsciiGalaxyScan } from "../../app/components/ui/AsciiGalaxyScan";
import { AsciiAnimation } from "../../app/components/ui/AsciiAnimation";
import { createAsciiOrbit } from "../../app/components/ui/asciiOrbit";
import type { Story } from "../story";

const orbit = createAsciiOrbit();

const story: Story = {
  title: "AsciiGalaxyScan",
  group: "Data Display",
  blurb: "one glyph host · galaxy and orbit scenes · dark and light palettes",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Galaxy · dark</div>
        <AsciiGalaxyScan palette="dark" showReplay />
      </div>
      <div class="ds-cell">
        <div class="ds-label">Galaxy · light</div>
        <AsciiGalaxyScan palette="light" showReplay />
      </div>
      <div class="ds-cell">
        <div class="ds-label">Wire sphere · dark</div>
        <AsciiAnimation scene={orbit} label="Rotating ASCII wire sphere" palette="dark" />
      </div>
      <div class="ds-cell">
        <div class="ds-label">Wire sphere · light</div>
        <AsciiAnimation scene={orbit} label="Rotating ASCII wire sphere" palette="light" />
      </div>
      <div class="ds-cell">
        <div class="ds-label">CRT texture opt-in · dark</div>
        <AsciiGalaxyScan palette="dark" showTexture showReplay />
      </div>
    </div>
  ),
};

export default story;
