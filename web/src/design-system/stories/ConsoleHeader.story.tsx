import { ConsoleHeader } from "../../app/components/ui/ConsoleHeader";
import type { Story } from "../story";

const story: Story = {
  title: "ConsoleHeader",
  group: "Chrome",
  blurb: "back chevron · live dot · breadcrumb trail · tail label",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Default (c0 / c1 / c2)</div>
        <div class="ds-row">
          <ConsoleHeader />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Single crumb</div>
        <div class="ds-row">
          <ConsoleHeader c0="DASHBOARD" c1="" c2="" tail="GSV · ROOT" />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Dynamic clickable crumbs</div>
        <div class="ds-row">
          <ConsoleHeader
            crumbs={[
              { label: "FLEET", onClick: () => {} },
              { label: "NODES", onClick: () => {} },
              { label: "PRIMARY NODE" },
            ]}
            tail="GSV · PRIMARY NODE"
          />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Back enabled + close (onBack · onClose)</div>
        <div class="ds-row">
          <ConsoleHeader
            c0="FLEET"
            c1="PRIMARY NODE"
            c2=""
            tail="GSV · PRIMARY NODE"
            onBack={() => {}}
            onClose={() => {}}
          />
        </div>
      </div>
    </div>
  ),
};

export default story;
