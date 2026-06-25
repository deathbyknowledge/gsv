import { AsciiGalaxyScan } from "../../app/components/ui/AsciiGalaxyScan";
import type { Story } from "../story";

const story: Story = {
  title: "AsciiGalaxyScan",
  group: "Data Display",
  blurb: "procedural ASCII galaxy scan and GSV morph",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Default</div>
        <AsciiGalaxyScan showReplay />
      </div>
      <div class="ds-cell">
        <div class="ds-label">CRT texture opt-in</div>
        <AsciiGalaxyScan showTexture showReplay />
      </div>
    </div>
  ),
};

export default story;
