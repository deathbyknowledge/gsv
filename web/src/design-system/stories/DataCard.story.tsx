import { DataCard } from "../../app/components/ui/DataCard";
import type { DataCardRow } from "../../app/components/ui/DataCard";
import type { Story } from "../story";

const settingsRows: DataCardRow[] = [
  { label: "CHAT MODEL", value: "GLM 5 2", description: "0 saved models", linkLabel: "manage", onLink: () => {} },
  { label: "AGENT PERMISSIONS", value: "ALWAYS ALLOW", description: "39 overrides", linkLabel: "manage", onLink: () => {} },
  { label: "AGENT INSTRUCTIONS", value: "UNDEFINED", linkLabel: "edit files", linkExternal: true, onLink: () => {} },
];

const story: Story = {
  title: "DataCard",
  group: "Composite",
  blurb: "data display card · >>> title / >> LABEL: value / (description) / hover CTA · white / yellow · glowing terminal screen · hugs content",
  render: () => (
    <div class="ds-col" style={{ flexDirection: "row", gap: "24px", flexWrap: "wrap" }}>
      <div class="ds-cell">
        <div class="ds-label">White</div>
        <DataCard title="SETTINGS" variant="white" rows={settingsRows} />
      </div>
      <div class="ds-cell">
        <div class="ds-label">Yellow</div>
        <DataCard title="SETTINGS" variant="yellow" rows={settingsRows} />
      </div>
      <div class="ds-cell">
        <div class="ds-label">Read-only values (SPECS)</div>
        <DataCard
          title="SPECS"
          variant="white"
          rows={[
            { label: "CURRENT VERSION", value: "gsv v0.4.1" },
            { label: "TIMEZONE", value: "EUROPE/LISBON" },
          ]}
        />
      </div>
    </div>
  ),
};

export default story;
