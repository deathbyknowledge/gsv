import { ShipSection } from "../../app/components/ui/ShipSection";
import type { Story } from "../story";

const story: Story = {
  title: "ShipSection",
  group: "Composite",
  blurb: "room flip card (files / library / repos) · cover front → detail back · highlight item + list · hover CTA",
  render: () => (
    <div class="ds-col" style={{ flexDirection: "row", gap: "16px", flexWrap: "wrap" }}>
      <div style={{ width: "300px" }}>
        <ShipSection
          title="FILES"
          image="/img/room-files.png"
          rows={[
            { id: "1", group: "LOCAL FILES", title: "<gsv-name>", highlight: true, onClick: () => {} },
            { id: "2", group: "CONNECTED MACHINES", icon: "computer", title: "<hank-linux>", status: "online", statusLabel: "ONLINE", onClick: () => {} },
            { id: "3", group: "CONNECTED MACHINES", icon: "computer", title: "<chrome>", status: "online", statusLabel: "ONLINE", onClick: () => {} },
          ]}
        />
      </div>
      <div style={{ width: "300px" }}>
        <ShipSection
          title="LIBRARY"
          image="/img/room-library.png"
          rows={[
            { id: "1", group: "RECOMMENDED", title: "GSV Manual", highlight: true, onClick: () => {} },
            { id: "2", group: "LAST OPENED", icon: "bookmark", title: "Logbook: Xanadu", status: "online", statusLabel: "OPENED", onClick: () => {} },
            { id: "3", group: "LAST OPENED", icon: "bookmark", title: "Logbook: Liger", status: "online", statusLabel: "OPENED", onClick: () => {} },
          ]}
          ctaLabel="Start new"
          onCta={() => {}}
        />
      </div>
      <div style={{ width: "300px" }}>
        <ShipSection
          title="REPOS"
          image="/img/room-repos.png"
          rows={[
            { id: "1", group: "PUBLIC", title: "root/gsv", highlight: true, onClick: () => {} },
            { id: "2", group: "PUBLIC", icon: "folder", title: "root/gsv-manual", status: "online", statusLabel: "SYNCED", onClick: () => {} },
          ]}
          emptyGroups={[{ group: "PRIVATE", message: "Nothing here yet!" }]}
          ctaLabel="Pull"
          onCta={() => {}}
        />
      </div>
    </div>
  ),
};

export default story;
