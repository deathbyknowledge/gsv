import { Breadcrumbs } from "../../app/components/ui/Breadcrumbs";
import type { Story } from "../story";

const noop = () => {};

const story: Story = {
  title: "Breadcrumbs",
  group: "Chrome",
  blurb: "directory/path trail · optional back button · collapse + ellipsis truncation",
  render: () => (
    <div class="ds-grid">
      <div class="ds-cell">
        <div class="ds-label">Short path · back button</div>
        <div class="ds-col">
          <Breadcrumbs
            onBack={noop}
            items={[
              { label: "root", onClick: noop },
              { label: "src", onClick: noop },
              { label: "config.json" },
            ]}
          />
        </div>
      </div>

      <div class="ds-cell">
        <div class="ds-label">Deep path · collapsed (maxVisible=4)</div>
        <div class="ds-col">
          <Breadcrumbs
            onBack={noop}
            maxVisible={4}
            items={[
              { label: "root", onClick: noop },
              { label: "Users", onClick: noop },
              { label: "jessicat", onClick: noop },
              { label: "Repos", onClick: noop },
              { label: "gsv", onClick: noop },
              { label: "web", onClick: noop },
              { label: "Breadcrumbs.tsx" },
            ]}
          />
        </div>
      </div>

      <div class="ds-cell">
        <div class="ds-label">No back button</div>
        <div class="ds-col">
          <Breadcrumbs
            items={[
              { label: "app", onClick: noop },
              { label: "components", onClick: noop },
              { label: "ui" },
            ]}
          />
        </div>
      </div>

      <div class="ds-cell">
        <div class="ds-label">Sizes</div>
        <div class="ds-col">
          <Breadcrumbs
            size="small"
            onBack={noop}
            items={[{ label: "root", onClick: noop }, { label: "src", onClick: noop }, { label: "SMALL" }]}
          />
          <Breadcrumbs
            size="medium"
            onBack={noop}
            items={[{ label: "root", onClick: noop }, { label: "src", onClick: noop }, { label: "MEDIUM" }]}
          />
          <Breadcrumbs
            size="large"
            onBack={noop}
            items={[{ label: "root", onClick: noop }, { label: "src", onClick: noop }, { label: "LARGE" }]}
          />
        </div>
      </div>

      <div class="ds-cell">
        <div class="ds-label">Long label · truncation</div>
        <div class="ds-col" style={{ maxWidth: "360px" }}>
          <Breadcrumbs
            onBack={noop}
            items={[
              { label: "root", onClick: noop },
              { label: "a-very-long-directory-name-that-overflows-its-container", onClick: noop },
              { label: "another-extremely-long-current-file-name-to-truncate.json" },
            ]}
          />
        </div>
      </div>
    </div>
  ),
};

export default story;
