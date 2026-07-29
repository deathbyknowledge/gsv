import { ListCard, type ListCardRow } from "../../app/components/ui/ListCard";
import type { Story } from "../story";

const machines: ListCardRow[] = [
  { id: "1", label: "hank-linux", status: "online", statusLabel: "ONLINE", onClick: () => {} },
  { id: "2", label: "kawah-oilmachine", status: "idle", statusLabel: "IDLE", onClick: () => {} },
  { id: "3", label: "mac-workstation", status: "idle", statusLabel: "IDLE", onClick: () => {} },
];

const crew: ListCardRow[] = [
  { id: "1", label: "XANADU", sub: "2 open tasks", avatarSrc: "/img/agent-1.png", status: "live", statusLabel: "RUNNING", onClick: () => {} },
  { id: "2", label: "LIGER", sub: "idle", avatarSrc: "/img/agent-2.png", status: "idle", statusLabel: "IDLE", onClick: () => {} },
  { id: "3", label: "BOB", sub: "task interrupted", avatarSrc: "/img/agent-3.png", status: "error", statusLabel: "STOPPED", onClick: () => {} },
];

const many: ListCardRow[] = Array.from({ length: 12 }, (_, i) => ({
  id: String(i),
  label: `whatsapp-update-${i + 1}`,
  sub: "sol / /home/sol",
  icon: "list",
  status: "live" as const,
  statusLabel: "RUNNING",
  onClick: () => {},
}));

const story: Story = {
  title: "ListCard",
  group: "Composite",
  blurb: "list display card · counter · icon/avatar/description rows · hover status · show-more footer",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Counter + icon rows + "new" row (hover a row to reveal its status label)</div>
        <div class="ds-col" style={{ maxWidth: "460px" }}>
          <ListCard
            title="MACHINES"
            meta="3"
            metaWord="TARGETS"
            rows={machines}
            addLabel="NEW MACHINE"
            onAdd={() => {}}
            footer={false}
            onOpen={() => {}}
          />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Avatar rows + description</div>
        <div class="ds-col" style={{ maxWidth: "460px" }}>
          <ListCard title="CREW" meta="3 AGENTS" rows={crew} addLabel="NEW AGENT" onAdd={() => {}} footer={false} onOpen={() => {}} />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Show-more / view-all footer (&gt; 6 rows)</div>
        <div class="ds-col" style={{ maxWidth: "460px" }}>
          <ListCard title="TASKS" meta="12 RUNNING" rows={many} onOpen={() => {}} onViewAll={() => {}} />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Empty state</div>
        <div class="ds-col" style={{ maxWidth: "460px" }}>
          <ListCard title="INTEGRATIONS" rows={[]} emptyLabel="NO INTEGRATIONS" addLabel="NEW INTEGRATION" onAdd={() => {}} footer={false} onOpen={() => {}} />
        </div>
      </div>
    </div>
  ),
};

export default story;
