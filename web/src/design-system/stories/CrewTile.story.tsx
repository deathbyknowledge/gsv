import { CrewAddTile, CrewTile } from "../../app/components/ui/CrewTile";
import type { Story } from "../story";

const story: Story = {
  title: "CrewTile",
  group: "Composite",
  blurb: "settings and chat crew switcher tile",
  render: () => (
    <div style={{ maxWidth: "640px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", border: "1px solid var(--border)" }}>
        <CrewTile name="Xanadu" tone="live" statusLabel="RUNNING" imageIndex={0} active />
        <CrewTile name="Liger" tone="idle" statusLabel="IDLE" imageIndex={1} />
        <CrewTile name="Bob" tone="error" statusLabel="ERROR" imageIndex={2} />
        <CrewAddTile />
      </div>
    </div>
  ),
};

export default story;
