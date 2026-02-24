import { useState } from "react";
import { PairingView } from "./PairingView";
import { ConfigView } from "./ConfigView";
import { DebugView } from "./DebugView";

type SettingsTab = "pairing" | "config" | "debug";

const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: "pairing", label: "Pairing" },
  { id: "config", label: "Config" },
  { id: "debug", label: "Debug" },
];

export function SettingsView() {
  const [activeTab, setActiveTab] = useState<SettingsTab>("config");

  return (
    <div className="view-container">
      <div className="tabs">
        {SETTINGS_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`tab ${activeTab === tab.id ? "active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {activeTab === "pairing" && <PairingView />}
      {activeTab === "config" && <ConfigView />}
      {activeTab === "debug" && <DebugView />}
    </div>
  );
}
