import type { Story } from "../story";
import { DesktopHint } from "../../app/features/gsv-shell/desktop/DesktopHint";

/**
 * Desktop hint — HUD terminal readout below the desktop nodes. On landing it
 * types its lines once, then minimizes to a small amber footer (it also
 * minimizes immediately when a node is clicked). Shown here inside a relative
 * void panel; the live version is absolutely positioned in the desktop.
 */

const LINES = ["> CLICK A NODE TO EXPLORE", "> CLICK GSV FOR CONTROLS"];
const MIN = "CLICK A NODE TO EXPLORE · CLICK GSV FOR CONTROLS";

function Stage({ played }: { played?: boolean }) {
  return (
    <div
      style={{
        position: "relative",
        height: "150px",
        background: "var(--void)",
        border: "1px solid var(--border)",
        borderRadius: "4px",
        overflow: "hidden",
      }}
    >
      <DesktopHint lines={LINES} minimizedText={MIN} played={played} />
    </div>
  );
}

const story: Story = {
  title: "Desktop Hint",
  group: "Chrome",
  blurb: "HUD terminal readout · types once on landing, then minimizes · amber",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label" style={{ marginBottom: "12px" }}>
          Intro · types once per login, then shrinks to the footer
        </div>
        <Stage />
      </div>
      <div class="ds-cell" style={{ marginTop: "10px" }}>
        <div class="ds-label" style={{ marginBottom: "12px" }}>
          Already played · minimized amber footer (revisits skip the intro)
        </div>
        <Stage played />
      </div>
    </div>
  ),
};

export default story;
