import { CrewAddTile, CrewTile } from "../../app/components/ui/CrewTile";
import type { Story } from "../story";

const story: Story = {
  title: "CrewTile",
  group: "Composite",
  blurb: "settings and chat crew switcher tile",
  render: () => (
    <div class="ds-col" style={{ maxWidth: "640px" }}>
      <div class="ds-cell">
        <div class="ds-label">Tones · add tile</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", border: "1px solid var(--border)" }}>
          <CrewTile name="Xanadu" tone="live" statusLabel="RUNNING" imageIndex={0} active />
          <CrewTile name="Liger" tone="idle" statusLabel="IDLE" imageIndex={1} />
          <CrewTile name="Bob" tone="error" statusLabel="ERROR" imageIndex={2} />
          <CrewAddTile />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">More tones (online · update · warn)</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", border: "1px solid var(--border)" }}>
          <CrewTile name="Argo" tone="online" statusLabel="ONLINE" imageIndex={3} />
          <CrewTile name="Nell" tone="update" statusLabel="UPDATING" imageIndex={4} />
          <CrewTile name="Vega" tone="warn" statusLabel="DEGRADED" imageIndex={5} />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Cover (full-frame portrait)</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", border: "1px solid var(--border)" }}>
          <CrewTile name="Xanadu" tone="live" statusLabel="RUNNING" imageIndex={0} cover />
          <CrewTile name="Liger" tone="idle" statusLabel="IDLE" imageIndex={1} cover />
        </div>
      </div>
    </div>
  ),
};

export default story;
