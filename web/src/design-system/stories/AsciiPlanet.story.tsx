import { AsciiPlanet } from "../../app/components/ui/AsciiPlanet";
import type { Story } from "../story";

const story: Story = {
  title: "AsciiPlanet",
  group: "Data Display",
  blurb: "procedural ASCII ship and planet scans",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Moon scan</div>
        <AsciiPlanet variant="moon" formDuration={3.4} />
      </div>
      <div class="ds-cell">
        <div class="ds-label">Ringed variants (orbit · giant)</div>
        <div class="ds-row" style={{ alignItems: "center" }}>
          <AsciiPlanet variant="orbit" animate={false} />
          <AsciiPlanet variant="giant" animate={false} />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Compact variants</div>
        <div class="ds-row" style={{ alignItems: "center" }}>
          <AsciiPlanet variant="disc" animate={false} />
          <AsciiPlanet variant="terminator" animate={false} />
          <AsciiPlanet variant="crescent" animate={false} />
          <AsciiPlanet variant="orb" size={60} animate={false} />
        </div>
      </div>
    </div>
  ),
};

export default story;
