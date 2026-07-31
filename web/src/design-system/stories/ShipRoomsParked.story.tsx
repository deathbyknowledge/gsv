import { ShipSection, type ShipSectionRow } from "../../app/components/ui/ShipSection";
import type { Story } from "../story";

// TEMP — the FILES / LIBRARY / REPOS "ship rooms" section was removed from the
// console overview page (not ready to ship) and parked here so the arrangement
// + placeholder data are not lost. Re-home into ConsoleOverviewPanels' THE SHIP
// block (`.gsv-settings-ship-rooms`) when the real wiring lands.
const FILES_ROWS: ShipSectionRow[] = [
  { id: "local", group: "LOCAL FILES", title: "<gsv-name>", highlight: true },
  { id: "hank", group: "CONNECTED MACHINES", icon: "computer", title: "<hank-linux>", status: "online", statusLabel: "ONLINE" },
  { id: "chrome", group: "CONNECTED MACHINES", icon: "computer", title: "<chrome>", status: "online", statusLabel: "ONLINE" },
];
const LIBRARY_ROWS: ShipSectionRow[] = [
  { id: "manual", group: "RECOMMENDED", title: "GSV Manual", highlight: true },
  { id: "log-xa", group: "LAST OPENED", icon: "bookmark", title: "Logbook: Xanadu", status: "online", statusLabel: "OPENED" },
  { id: "log-li", group: "LAST OPENED", icon: "bookmark", title: "Logbook: Liger", status: "online", statusLabel: "OPENED" },
];
const REPOS_ROWS: ShipSectionRow[] = [
  { id: "root-gsv", group: "PUBLIC", title: "root/gsv", highlight: true },
  { id: "root-gsv-m", group: "PUBLIC", icon: "folder", title: "root/gsv-manual", status: "online", statusLabel: "SYNCED" },
];

const cell = { borderRight: "1px solid var(--rule-inner)", minWidth: 0 } as const;

const story: Story = {
  title: "Ship rooms (parked)",
  group: "Composite",
  blurb: "TEMP — the overview FILES / LIBRARY / REPOS flip-card section, removed from the page and parked here until re-homed",
  render: () => (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
        maxWidth: "1020px",
        border: "1px solid var(--rule-inner)",
      }}
    >
      <div style={cell}>
        <ShipSection className="gsv-settings-room" title="FILES" image="/img/room-files.png" rows={FILES_ROWS} />
      </div>
      <div style={cell}>
        <ShipSection className="gsv-settings-room" title="LIBRARY" image="/img/room-library.png" rows={LIBRARY_ROWS} ctaLabel="Start new" onCta={() => {}} />
      </div>
      <div style={{ minWidth: 0 }}>
        <ShipSection className="gsv-settings-room" title="REPOS" image="/img/room-repos.png" rows={REPOS_ROWS} ctaLabel="Pull" onCta={() => {}} />
      </div>
    </div>
  ),
};

export default story;
