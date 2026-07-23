import { IconMenu, type IconMenuCell } from "../../app/components/ui/IconMenu";
import type { Story } from "../story";

const GSV_CELLS: IconMenuCell[] = [
  { icon: "cog", label: "OVERVIEW", onClick: () => {}, accent: true },
  { icon: "chat", label: "AGENTS", onClick: () => {} },
  { icon: "stars", label: "MODELS", onClick: () => {} },
  { icon: "list", label: "TASKS", onClick: () => {} },
];

const SYSTEM_CELLS: IconMenuCell[] = [
  { icon: "folder", label: "FILES", onClick: () => {} },
  { icon: "pencil", label: "LIBRARY", onClick: () => {} },
  { icon: "terminal", label: "TERMINAL", onClick: () => {} },
  { icon: "doticons/branch", label: "REPOS", onClick: () => {}, dotMatrix: 16 },
  { icon: "cog", label: "OVERVIEW", onClick: () => {}, accent: true },
];

const story: Story = {
  title: "IconMenu",
  group: "Chrome",
  blurb: "control popover · live dot · configurable cell grid (AGENTS / MODELS / TASKS / SHIP OVERVIEW)",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">GSV picker (4 cells)</div>
        <div class="ds-row">
          <IconMenu cells={GSV_CELLS} />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Custom title · 5 cells</div>
        <div class="ds-row">
          <IconMenu title="GSV // SYSTEMS" cells={SYSTEM_CELLS} />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Narrow (width 300)</div>
        <div class="ds-row">
          <IconMenu width={300} cells={GSV_CELLS} />
        </div>
      </div>
    </div>
  ),
};

export default story;
