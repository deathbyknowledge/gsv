import { PageHeader } from "../../app/components/ui/PageHeader";
import { IconButton } from "../../app/components/ui/IconButton";
import type { Story } from "../story";

const noop = () => {};

const story: Story = {
  title: "PageHeader",
  group: "Chrome",
  blurb: "two-row page header · Breadcrumbs trail over SectionHeader title block",
  render: () => (
    <div class="ds-grid">
      <div class="ds-cell">
        <div class="ds-label">Default · breadcrumbs + title + meta</div>
        <div class="ds-col">
          <PageHeader
            onBack={noop}
            items={[
              { label: "GSV", onClick: noop },
              { label: "SETTINGS", onClick: noop },
              { label: "CREW", onClick: noop },
              { label: "NOVA" },
            ]}
            title="NOVA"
            meta="AGENT · ONLINE"
          />
        </div>
      </div>

      <div class="ds-cell">
        <div class="ds-label">Actions slot · close ✕ on the title row</div>
        <div class="ds-col">
          <PageHeader
            onBack={noop}
            items={[
              { label: "GSV", onClick: noop },
              { label: "FILES", onClick: noop },
              { label: "context.md" },
            ]}
            title="context.md"
            meta="EDITED"
            actions={<IconButton glyph="close" size="small" title="Close" ariaLabel="Close screen" onClick={noop} />}
          />
        </div>
      </div>

      <div class="ds-cell">
        <div class="ds-label">Clickable title · large title size</div>
        <div class="ds-col">
          <PageHeader
            onBack={noop}
            items={[
              { label: "GSV", onClick: noop },
              { label: "THE SHIP" },
            ]}
            title="GENERAL SYSTEMS VEHICLE"
            titleSize="title"
            meta="OVERVIEW"
            onTitleClick={noop}
            chevron
          />
        </div>
      </div>

      <div class="ds-cell">
        <div class="ds-label">Deep path · collapsed (maxVisible=3)</div>
        <div class="ds-col">
          <PageHeader
            onBack={noop}
            maxVisible={3}
            items={[
              { label: "GSV", onClick: noop },
              { label: "SETTINGS", onClick: noop },
              { label: "MACHINES", onClick: noop },
              { label: "FLEET", onClick: noop },
              { label: "PRIMARY NODE" },
            ]}
            title="PRIMARY NODE"
            meta="MACHINE · 4 PROCESSES"
          />
        </div>
      </div>

      <div class="ds-cell">
        <div class="ds-label">Narrow container · both rows clamp, no overflow</div>
        {/* ~340px, like a docked console column squeezed by the chat dock. */}
        <div class="ds-col" style={{ width: "340px" }}>
          <PageHeader
            onBack={noop}
            items={[
              { label: "GSV", onClick: noop },
              { label: "INTEGRATIONS", onClick: noop },
              { label: "a-very-long-integration-endpoint-name" },
            ]}
            title="a-very-long-integration-endpoint-name-that-must-truncate"
            meta="MCP"
            actions={<IconButton glyph="close" size="small" title="Close" ariaLabel="Close screen" onClick={noop} />}
          />
        </div>
      </div>
    </div>
  ),
};

export default story;
