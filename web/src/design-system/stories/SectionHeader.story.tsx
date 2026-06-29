import { SectionHeader } from "../../app/components/ui/SectionHeader";
import { IconButton } from "../../app/components/ui/IconButton";
import type { Story } from "../story";

const story: Story = {
  title: "SectionHeader",
  group: "Chrome",
  blurb: "header bar · accent dot · optional meta / divider",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Default</div>
        <div class="ds-row">
          <SectionHeader title="THE SHIP" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">With meta</div>
        <div class="ds-row">
          <SectionHeader title="THE SHIP" meta="4 NODES" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Divider</div>
        <div class="ds-row">
          <SectionHeader title="CREW" meta="ONLINE" divider />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Compact clickable</div>
        <div class="ds-row">
          <SectionHeader title="MACHINES" density="compact" divider chevron onClick={() => {}} />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Title size · section (default)</div>
        <div class="ds-row">
          <SectionHeader title="THE SHIP" titleSize="section" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Title size · title</div>
        <div class="ds-row">
          <SectionHeader title="GENERAL SYSTEMS VEHICLE" titleSize="title" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Heading level (h3)</div>
        <div class="ds-row">
          <SectionHeader title="SUBSYSTEM" headingLevel={3} />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Actions slot (close)</div>
        <div class="ds-row">
          <SectionHeader title="THE SHIP" actions={<IconButton glyph="close" size="small" ariaLabel="Close" onClick={() => {}} />} />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Meta + actions</div>
        <div class="ds-row">
          <SectionHeader
            title="CREW"
            meta="ONLINE"
            actions={<IconButton glyph="refresh" size="small" ariaLabel="Refresh" onClick={() => {}} />}
          />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Clickable heading + independent actions</div>
        <div class="ds-row">
          <SectionHeader
            title="MACHINES"
            onClick={() => {}}
            actions={<IconButton glyph="plus" size="small" ariaLabel="Add machine" onClick={() => {}} />}
          />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Truncation (long title pinned next to meta)</div>
        <div class="ds-row" style={{ maxWidth: "260px" }}>
          <SectionHeader title="A VERY LONG SECTION TITLE THAT SHOULD ELLIPSIZE" meta="9 NODES" />
        </div>
      </div>
    </div>
  ),
};

export default story;
