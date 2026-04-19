import type { ControlTabId } from "./types";

type TabsProps = {
  activeTab: ControlTabId;
  onChange: (tab: ControlTabId) => void;
};

const TABS: Array<{ id: ControlTabId; label: string; description: string }> = [
  { id: "config", label: "Config", description: "System and user configuration." },
  { id: "access", label: "Access", description: "Tokens and identity links." },
  { id: "advanced", label: "Advanced", description: "Raw config entry editor." },
];

export function Tabs({ activeTab, onChange }: TabsProps) {
  return (
    <nav class="control-tabs" aria-label="Control panels">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          class={`control-tab${tab.id === activeTab ? " is-active" : ""}`}
          onClick={() => onChange(tab.id)}
        >
          <span>{tab.label}</span>
          <small>{tab.description}</small>
        </button>
      ))}
    </nav>
  );
}
